// Pickup: per authorization of the repair order — plan (pure) -> PayPal calls -> record captures -> live GET.

import { z } from "zod";
import type { Queryable } from "../db/db.js";
import { MoneyError } from "../money.js";
import { classify, describeError, GuardError, isDefiniteFailure } from "../paypal/errors.js";
import type { ParsedAuthorization, ParsedCapture } from "../paypal/parse.js";
import type { CoreDeps } from "./deps.js";
import { CoreError } from "./errors.js";
import { runOp } from "./ops.js";
import { billable, MoneyGuardError, planPickup, type PlanStep } from "./plan.js";
import { parseInput } from "./repairOrders.js";
import { AUTH_COLS, LINE_COLS, loadRepairOrder, ORDER_COLS, type Authorization, type Line, type PaypalOrder } from "./rows.js";

export const PerformedSchema = z
  .array(z.object({ lineId: z.string().min(1).max(64), performedCents: z.number().int().nonnegative() }))
  .max(200)
  .refine((a) => new Set(a.map((p) => p.lineId)).size === a.length, { message: "a line id appears twice" });
export type PerformedInput = z.input<typeof PerformedSchema>;

const COUNTED = new Set(["COMPLETED", "PENDING"]);
export const NOT_BILLED = "not billed — no PayPal authorization for this line";

export type ExecutedStep =
  | { kind: "capture"; authorizationId: string; requestId: string; captureId: string; cents: number; finalCapture: boolean; status: string; feeCents: number | null; netCents: number | null }
  | { kind: "void"; authorizationId: string; requestId: string; status: string };

export type PickupOutcome = "done" | "nothing_to_do" | "needs_attention" | "in_progress" | "retry";

export interface PickupAuthorizationResult {
  paypalOrderId: string;
  /** The original authorization: void always goes here. */
  authorizationId: string;
  /** The authorization captured: the original, or its reauthorization. */
  captureAuthorizationId: string;
  approvedCents: number;
  billableCents: number;
  capturedBeforeCents: number;
  plan: PlanStep[];
  executed: ExecutedStep[];
  outcome: PickupOutcome;
  reason: string | null;
  warnings: string[];
  /** Status from a live GET after the steps, per authorization id; null when the GET failed. */
  live: Record<string, string | null>;
}

export interface PickupResult {
  roId: string;
  authorizations: PickupAuthorizationResult[];
  notBilled: { lineId: string; reason: string }[];
  overruns: { lineId: string; approvedCents: number; performedCents: number }[];
  /** Set when pickup stopped early (a guard bug); the remaining authorizations were not touched. */
  stopped: string | null;
}

interface Work {
  order: PaypalOrder;
  root: Authorization | null;
  effective: Authorization | null;
  lines: Line[];
}

async function setAttention(q: Queryable, authorizationId: string, reason: string): Promise<void> {
  await q.query(`UPDATE authorizations SET needs_attention = $2 WHERE id = $1`, [authorizationId, reason]);
}

/**
 * Phase 1 (one transaction): fix what was performed. The first pickup writes performed / not_performed on every
 * approved line (an approved line not listed counts as not performed) and marks the repair order picked up. A
 * repeated pickup must send the same numbers; it then only finishes money steps that did not complete.
 */
async function preparePickup(deps: CoreDeps, roId: string, performed: z.output<typeof PerformedSchema>) {
  return deps.db.tx(async (q) => {
    const ro = await loadRepairOrder(q, roId, true);
    const lines = (await q.query<Line>(`SELECT ${LINE_COLS} FROM lines WHERE ro_id = $1 ORDER BY created_at, id`, [roId])).rows;
    const byId = new Map(lines.map((l) => [l.id, l]));
    const given = new Map<string, number>();
    const missing: string[] = [];
    for (const p of performed) {
      if (!byId.has(p.lineId)) missing.push(p.lineId);
      given.set(p.lineId, p.performedCents);
    }
    if (missing.length) throw new CoreError("NOT_FOUND", `lines not on repair order ${roId}: ${missing.join(", ")}`, { roId, missing });

    const billed = new Set(["approved", "performed", "not_performed"]);
    const notBilled = performed.filter((p) => !billed.has(byId.get(p.lineId)!.status)).map((p) => ({ lineId: p.lineId, reason: NOT_BILLED }));

    if (ro.status === "open") {
      for (const l of lines.filter((x) => x.status === "approved")) {
        const cents = given.get(l.id) ?? 0;
        await q.query(`UPDATE lines SET status = $2, performed_cents = $3 WHERE id = $1`, [l.id, cents > 0 ? "performed" : "not_performed", cents]);
      }
      await q.query(`UPDATE repair_orders SET status = 'picked_up' WHERE id = $1`, [roId]);
    } else {
      const diff = lines.filter((l) => (l.status === "performed" || l.status === "not_performed") && (l.performedCents ?? 0) !== (given.get(l.id) ?? 0));
      if (diff.length) throw new CoreError("CONFLICT", `repair order ${roId} was already picked up with other amounts (${diff.map((l) => l.id).join(", ")})`, { roId, lines: diff.map((l) => l.id) });
    }

    const fresh = (await q.query<Line>(`SELECT ${LINE_COLS} FROM lines WHERE ro_id = $1`, [roId])).rows;
    const freshById = new Map(fresh.map((l) => [l.id, l]));
    const orders = (await q.query<PaypalOrder>(`SELECT ${ORDER_COLS} FROM paypal_orders WHERE ro_id = $1 AND status = 'COMPLETED' AND superseded_by IS NULL ORDER BY created_at, id`, [roId])).rows;
    const auths = (await q.query<Authorization>(`SELECT ${AUTH_COLS} FROM authorizations WHERE ro_id = $1`, [roId])).rows;
    const authById = new Map(auths.map((a) => [a.id, a]));
    const work: Work[] = orders.map((order) => {
      const root = auths.find((a) => a.paypalOrderId === order.id && a.parentId === null) ?? null;
      let effective = root;
      // Follow reauthorizations to the newest id: that is the one we capture.
      for (let i = 0; effective?.reauthorizedTo && i < 30; i++) effective = authById.get(effective.reauthorizedTo) ?? effective;
      const orderLines = order.lineIds.map((id) => freshById.get(id)).filter((l): l is Line => !!l && (l.status === "performed" || l.status === "not_performed"));
      return { order, root, effective, lines: orderLines };
    });
    return { work, notBilled };
  });
}

/** Captures what was performed on approved lines, voids the rest. Never more than approved, never more than held. */
export async function pickup(deps: CoreDeps, roId: string, performedInput: PerformedInput): Promise<PickupResult> {
  const performed = parseInput(PerformedSchema, performedInput);
  const { work, notBilled } = await preparePickup(deps, roId, performed);
  const result: PickupResult = { roId, authorizations: [], notBilled, overruns: [], stopped: null };
  for (const w of work) {
    const b = billable(w.lines.map((l) => ({ lineId: l.id, priceCents: l.priceCents, performedCents: l.performedCents ?? 0 })));
    result.overruns.push(...b.overruns);
    if (result.stopped) continue;
    const r = await settle(deps, w, b.approvedCents, b.billableCents);
    result.authorizations.push(r.result);
    if (r.stop) result.stopped = r.stop;
  }
  return result;
}

async function settle(deps: CoreDeps, w: Work, approvedCents: number, billableCents: number): Promise<{ result: PickupAuthorizationResult; stop: string | null }> {
  const { root, effective: eff } = w;
  const res: PickupAuthorizationResult = {
    paypalOrderId: w.order.id,
    authorizationId: root?.id ?? "",
    captureAuthorizationId: eff?.id ?? "",
    approvedCents,
    billableCents,
    capturedBeforeCents: eff?.capturedCents ?? 0,
    plan: [],
    executed: [],
    outcome: "nothing_to_do",
    reason: null,
    warnings: [],
    live: {},
  };
  if (!root || !eff) {
    res.outcome = "needs_attention";
    res.reason = `order ${w.order.id} is COMPLETED but no authorization is recorded`;
    return { result: res, stop: null };
  }
  const attention = root.needsAttention ?? eff.needsAttention;
  if (attention) {
    res.outcome = "needs_attention";
    res.reason = `needs attention: ${attention}`;
    return { result: res, stop: null };
  }

  // Capture only what is still due: a repeated pickup after a crash must not capture the same amount again.
  const already = eff.capturedCents;
  let plan;
  try {
    plan = planPickup({ amountCents: eff.amountCents, capturedCents: already, status: eff.status }, Math.max(0, approvedCents - already), Math.max(0, billableCents - already));
  } catch (e) {
    const reason = `pickup guard: ${describeError(e)}`;
    await setAttention(deps.db, eff.id, reason);
    res.outcome = "needs_attention";
    res.reason = reason;
    return { result: res, stop: null };
  }
  res.warnings.push(...plan.warnings);
  // The original was already voided (an earlier pickup): nothing left to release.
  res.plan = root.status === "VOIDED" ? plan.steps.filter((s) => s.kind !== "void") : plan.steps;
  if (!res.plan.length) {
    res.reason = plan.reason ?? (root.status === "VOIDED" ? "already voided" : null);
    await readLive(deps, res, [root.id, eff.id]);
    return { result: res, stop: null };
  }

  let stop: string | null = null;
  res.outcome = "done";
  for (const step of res.plan) {
    const target = step.kind === "capture" ? eff.id : root.id;
    try {
      if (step.kind === "capture") {
        // Capture goes to the CURRENT id: after a reauthorization that is the new one.
        // verified live: pending — capture on a reauthorized (child) id; checked by the lane in the sandbox e2e.
        const { requestId, result: c } = await runOp<ParsedCapture>(
          deps,
          { op: "capture", entityId: eff.id, intent: { cents: step.cents, finalCapture: step.finalCapture } },
          (rid) => deps.paypal.captureAuthorization({ authorizationId: eff.id, requestId: rid, cents: step.cents, finalCapture: step.finalCapture }),
          async (q, cap, rid) => {
            const amount = cap.amountCents ?? step.cents;
            const ins = await q.query(
              `INSERT INTO captures (id, authorization_id, amount_cents, final_capture, status, fee_cents, net_cents, request_id, created_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz) ON CONFLICT (id) DO NOTHING RETURNING id`,
              [cap.id, eff.id, amount, cap.finalCapture ?? step.finalCapture, cap.status, cap.feeCents, cap.netCents, rid, deps.now().toISOString()],
            );
            if (ins.rows.length && COUNTED.has(cap.status)) {
              await q.query(`UPDATE authorizations SET captured_cents = captured_cents + $2, status = $3 WHERE id = $1`, [eff.id, amount, step.finalCapture ? "CAPTURED" : "PARTIALLY_CAPTURED"]);
            }
          },
        );
        res.executed.push({ kind: "capture", authorizationId: eff.id, requestId, captureId: c.id, cents: c.amountCents ?? step.cents, finalCapture: c.finalCapture ?? step.finalCapture, status: c.status, feeCents: c.feeCents, netCents: c.netCents });
        if (!COUNTED.has(c.status)) {
          const reason = `capture ${c.id} came back ${c.status}; the rest of the hold was not voided`;
          await setAttention(deps.db, eff.id, reason);
          res.outcome = "needs_attention";
          res.reason = reason;
          break;
        }
      } else {
        // Void always goes to the ORIGINAL id: a reauthorization cannot be voided (finding 5, CANNOT_BE_VOIDED).
        // verified live: pending — void of the parent after a reauthorization, and what it does to the child.
        const { requestId, result: v } = await runOp<ParsedAuthorization | null>(
          deps,
          { op: "void", entityId: root.id, intent: {} },
          (rid) => deps.paypal.voidAuthorization({ authorizationId: root.id, requestId: rid }),
          async (q, a) => {
            await q.query(`UPDATE authorizations SET status = $2 WHERE id = $1`, [root.id, a?.status ?? "VOIDED"]);
          },
        );
        res.executed.push({ kind: "void", authorizationId: root.id, requestId, status: v?.status ?? "VOIDED" });
      }
    } catch (e) {
      const outcome = classify(e);
      if (e instanceof CoreError && (e.code === "IN_PROGRESS" || e.code === "CONFLICT")) {
        res.outcome = "in_progress";
        res.reason = e.message;
      } else if (outcome === "MAX_CAPTURE_COUNT_EXCEEDED") {
        // Not retried, not voided automatically: the service desk decides.
        res.outcome = "needs_attention";
        res.reason = `MAX_CAPTURE_COUNT_EXCEEDED on ${target}: ${describeError(e)}`;
        await setAttention(deps.db, eff.id, res.reason);
      } else if (outcome === "MAX_CAPTURE_AMOUNT_EXCEEDED") {
        // Our guard should have made this impossible: stop the whole pickup.
        res.outcome = "needs_attention";
        res.reason = `guard bug, MAX_CAPTURE_AMOUNT_EXCEEDED on ${target}: ${describeError(e)}`;
        await setAttention(deps.db, eff.id, res.reason);
        stop = res.reason;
      } else if (outcome === "PREVIOUSLY_CAPTURED" || outcome === "PREVIOUSLY_VOIDED") {
        // Already in that state at PayPal: read the live status (below) and do not fail.
        res.warnings.push(`${outcome} on ${target}; recorded the live status`);
      } else if (isDefiniteFailure(e) || e instanceof GuardError || e instanceof MoneyError || e instanceof MoneyGuardError) {
        res.outcome = "needs_attention";
        res.reason = describeError(e);
        await setAttention(deps.db, target, res.reason);
      } else {
        // No definite answer (network, 5xx, timeout): the operation stays open and the next pickup retries it with
        // the same PayPal-Request-Id. Not flagged, so that retry is not blocked.
        res.outcome = "retry";
        res.reason = `no definite answer from PayPal, retry the pickup: ${describeError(e)}`;
      }
      break;
    }
  }
  await readLive(deps, res, [root.id, eff.id]);
  return { result: res, stop };
}

/** Live GET of each authorization; the status from PayPal is written back. Money columns are not touched. */
async function readLive(deps: CoreDeps, res: PickupAuthorizationResult, ids: string[]): Promise<void> {
  for (const id of [...new Set(ids)]) {
    try {
      const live = await deps.paypal.getAuthorization(id);
      res.live[id] = live.status;
      await deps.db.query(`UPDATE authorizations SET status = $2 WHERE id = $1`, [id, live.status]);
    } catch (e) {
      res.live[id] = null;
      res.warnings.push(`live read of ${id} failed: ${describeError(e)}`);
    }
  }
}
