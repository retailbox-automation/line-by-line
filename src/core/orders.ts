// Approval orders: the estimate is one AUTHORIZE order; each batch of new lines the customer approves in one tap
// is its own AUTHORIZE order (a hold cannot be raised after authorize). A declined line never gets an order.

import { createHash } from "node:crypto";
import { z } from "zod";
import type { Queryable } from "../db/db.js";
import { classify, PayPalError } from "../paypal/errors.js";
import type { ParsedOrder } from "../paypal/parse.js";
import { DISCLOSURE_VERSION } from "../rules/florida.js";
import { approvalTtlMs, opStaleMs, type CoreDeps } from "./deps.js";
import { CoreError, wrapPayPal } from "./errors.js";
import { canonicalJson, claimOp, executeOp, runOp, type OpName } from "./ops.js";
import { newId, parseInput } from "./repairOrders.js";
import { ACTIVE_ORDER_SQL, AUTH_COLS, LINE_COLS, loadOrder, loadRepairOrder, ORDER_COLS, type Authorization, type Line, type LineKind, type PaypalOrder } from "./rows.js";

const LineIdSchema = z.string().min(1).max(64);

const consentFields = {
  approverName: z.string().trim().min(1).max(200),
  channel: z.enum(["qr_page", "link", "desk"]),
  esignConsent: z.boolean(),
  disclosureVersion: z.string().trim().min(1).max(64).optional(),
  // Fla. Stat. 559.905(2): the statement the customer checked; flLimitCents only with "limit" (the dollar cap they wrote).
  flChoice: z.enum(["written", "limit", "none"]).optional(),
  flLimitCents: z.number().int().positive().max(100_000_000).optional(),
};

// UETA (FL 668.50(5)(b)): an electronic approval counts only after the customer agreed to electronic records.
const esignRule = (v: { esignConsent: boolean; channel: string }) => v.esignConsent || v.channel === "desk";
const esignMessage = { message: "an approval on the phone needs the e-records consent first (esignConsent: true)", path: ["esignConsent"] };
const flRule = (v: { flChoice?: string | undefined; flLimitCents?: number | undefined }) => (v.flChoice === "limit") === (v.flLimitCents !== undefined);
const flMessage = { message: 'flLimitCents goes with flChoice "limit" and only with it', path: ["flLimitCents"] };

export const ConsentInputSchema = z.object(consentFields).refine(esignRule, esignMessage).refine(flRule, flMessage);
export type ConsentInput = z.input<typeof ConsentInputSchema>;

export const DecideInputSchema = z
  .object({
    approve: z.array(LineIdSchema).max(50).default([]),
    decline: z.array(LineIdSchema).max(50).default([]),
    ...consentFields,
  })
  .refine((v) => v.approve.length + v.decline.length > 0, { message: "approve or decline at least one line" })
  .refine((v) => new Set([...v.approve, ...v.decline]).size === v.approve.length + v.decline.length, { message: "a line id appears twice" })
  .refine(esignRule, esignMessage)
  .refine(flRule, flMessage);
export type DecideInput = z.input<typeof DecideInputSchema>;

interface ConsentRecord {
  approverName: string;
  channel: "qr_page" | "link" | "desk";
  esignConsent: boolean;
  disclosureVersion: string;
  flChoice: "written" | "limit" | "none" | null;
  flLimitCents: number | null;
  newTotalCents: number;
  decidedAt: Date;
}

const LINES_PARAM = `(SELECT jsonb_array_elements_text($2::jsonb))`;

function batchKey(roId: string, lineIds: string[]): string {
  return `${roId}.${createHash("sha256").update(lineIds.join(",")).digest("hex").slice(0, 12)}`;
}

function opFor(roId: string, purpose: LineKind, lineIds: string[]): { op: OpName; entityId: string } {
  return purpose === "estimate" ? { op: "order-est", entityId: roId } : { op: "order-add", entityId: batchKey(roId, lineIds) };
}

function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 3)}...`;
}

function sum(lines: { priceCents: number }[]): number {
  return lines.reduce((a, l) => a + l.priceCents, 0);
}

async function approvedTotal(q: Queryable, roId: string): Promise<number> {
  const r = await q.query<{ total: number }>(`SELECT COALESCE(sum(price_cents), 0)::int AS total FROM lines WHERE ro_id = $1 AND status = 'approved'`, [roId]);
  return r.rows[0]?.total ?? 0;
}

async function loadLines(q: Queryable, roId: string, ids: string[]): Promise<Line[]> {
  const r = await q.query<Line>(`SELECT ${LINE_COLS} FROM lines WHERE ro_id = $1 AND id IN ${LINES_PARAM} ORDER BY created_at, id`, [roId, JSON.stringify(ids)]);
  const found = new Set(r.rows.map((l) => l.id));
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length) throw new CoreError("NOT_FOUND", `lines not on repair order ${roId}: ${missing.join(", ")}`, { roId, missing });
  return r.rows;
}

/** Refuses lines that already have a live approval link, a hold, or a request in flight for another batch. */
async function assertNoActiveOrder(deps: CoreDeps, q: Queryable, roId: string, lineIds: string[]): Promise<void> {
  const orders = await q.query<{ id: string }>(`SELECT id FROM paypal_orders WHERE ro_id = $1 AND ${ACTIVE_ORDER_SQL} AND line_ids ?| ARRAY${LINES_PARAM}`, [
    roId,
    JSON.stringify(lineIds),
  ]);
  if (orders.rows.length) throw new CoreError("CONFLICT", `these lines already have a PayPal order (${orders.rows.map((o) => o.id).join(", ")})`, { roId, orders: orders.rows.map((o) => o.id) });
  const inflight = await q.query<{ request_id: string; result: { intent?: { lineIds?: string[] }; unknownOutcome?: boolean } | null; updated_ms: number }>(
    `SELECT request_id, result, (extract(epoch FROM updated_at) * 1000)::float8 AS updated_ms FROM ops
      WHERE op IN ('order-est', 'order-add') AND state = 'started' AND (result -> 'intent' -> 'lineIds') ?| ARRAY${LINES_PARAM}
        AND (entity_id = $1 OR starts_with(entity_id, $1 || '.'))`,
    [roId, JSON.stringify(lineIds)],
  );
  const now = deps.now().getTime();
  const mine = canonicalJson([...lineIds].sort());
  for (const r of inflight.rows) {
    const abandoned = r.result?.unknownOutcome === true || now - Number(r.updated_ms) >= opStaleMs(deps);
    if (!abandoned && canonicalJson([...(r.result?.intent?.lineIds ?? [])].sort()) !== mine) {
      throw new CoreError("IN_PROGRESS", `an approval link for some of these lines is being created (${r.request_id})`, { requestId: r.request_id });
    }
  }
}

/** Phases 2–3: create the PayPal order and record it (and the consents, or the replacement of an old order). */
async function placeOrder(
  deps: CoreDeps,
  a: {
    roId: string;
    purpose: LineKind;
    lines: Line[];
    claimed: { requestId: string; attempt: number };
    intent: Record<string, unknown>;
    consent?: ConsentRecord;
    supersedes?: string;
  },
): Promise<PaypalOrder> {
  const lineIds = a.lines.map((l) => l.id).sort();
  const amountCents = sum(a.lines);
  const titles = a.lines.map((l) => l.title).join(", ");
  const order = await executeOp(
    deps,
    a.claimed,
    a.intent,
    (requestId) =>
      deps.paypal.createAuthorizeOrder({
        requestId,
        referenceId: a.roId,
        customId: requestId,
        description: clip(`${a.purpose === "estimate" ? "Estimate" : "Added work"}: ${titles}`, 127),
        items: a.lines.map((l) => ({ name: clip(l.title, 127), unitCents: l.priceCents, quantity: 1, category: "PHYSICAL_GOODS" })),
        returnUrl: deps.config.returnUrl,
        cancelUrl: deps.config.cancelUrl,
        ...(deps.config.userAction ? { userAction: deps.config.userAction } : {}),
      }),
    async (q, o: ParsedOrder, requestId) => {
      const now = deps.now().toISOString();
      // A refresh: the customer may have approved the old link while the new one was being created. The old order
      // is locked first (as in onApproved's claim, so the two serialize). If its authorization was claimed, or it is
      // no longer waiting, the old order stays and the new one is recorded as replaced by it: never used, no hold.
      let oldWon = false;
      if (a.supersedes) {
        const old = await loadOrder(q, a.supersedes, true);
        const authorizing = await q.query(`SELECT 1 FROM ops WHERE op = 'authorize' AND entity_id = $1 AND state IN ('started', 'done') LIMIT 1`, [old.id]);
        oldWon = old.supersededBy !== null || ["APPROVED", "COMPLETED", "CANCELLED"].includes(old.status) || authorizing.rows.length > 0;
      }
      await q.query(
        `INSERT INTO paypal_orders (id, ro_id, purpose, line_ids, amount_cents, status, approve_url, request_id, attempt, superseded_by, created_at)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11::timestamptz) ON CONFLICT (id) DO NOTHING`,
        [o.id, a.roId, a.purpose, JSON.stringify(lineIds), amountCents, o.status, o.approveUrl, requestId, a.claimed.attempt, oldWon ? a.supersedes : null, now],
      );
      if (oldWon) return;
      await q.query(`UPDATE lines SET status = 'sent' WHERE ro_id = $1 AND id IN ${LINES_PARAM} AND status = 'proposed'`, [a.roId, JSON.stringify(lineIds)]);
      if (a.consent) {
        const c = a.consent;
        for (const l of a.lines) {
          await q.query(
            `INSERT INTO consents (id, ro_id, line_id, decision, decided_at, channel, approver_name, esign_consent, disclosure_version,
                                   amount_cents, new_total_cents, paypal_order_id, fl_choice, fl_limit_cents)
             VALUES ($1, $2, $3, 'approved', $4::timestamptz, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
            [newId("cn"), a.roId, l.id, c.decidedAt.toISOString(), c.channel, c.approverName, c.esignConsent, c.disclosureVersion, l.priceCents, c.newTotalCents, o.id, c.flChoice, c.flLimitCents],
          );
        }
      }
      if (a.supersedes) {
        await q.query(`UPDATE paypal_orders SET superseded_by = $2 WHERE id = $1`, [a.supersedes, o.id]);
        await q.query(`UPDATE consents SET paypal_order_id = $2 WHERE paypal_order_id = $1`, [a.supersedes, o.id]);
      }
    },
  ).catch((e: unknown) => {
    throw wrapPayPal(e, "creating the PayPal order");
  });
  return loadOrder(deps.db, order.id);
}

function consentRecord(
  input: { approverName: string; channel: "qr_page" | "link" | "desk"; esignConsent: boolean; disclosureVersion?: string | undefined; flChoice?: "written" | "limit" | "none" | undefined; flLimitCents?: number | undefined },
  newTotalCents: number,
  decidedAt: Date,
): ConsentRecord {
  return {
    approverName: input.approverName,
    channel: input.channel,
    esignConsent: input.esignConsent,
    disclosureVersion: input.disclosureVersion ?? DISCLOSURE_VERSION,
    flChoice: input.flChoice ?? null,
    flLimitCents: input.flLimitCents ?? null,
    newTotalCents,
    decidedAt,
  };
}

/**
 * One AUTHORIZE order for all estimate lines. The customer's approval of the estimate is recorded per line. If a
 * live estimate order already exists it is returned (re-created first when its link is older than the TTL).
 */
export async function createEstimateOrder(deps: CoreDeps, roId: string, consentInput: ConsentInput): Promise<{ order: PaypalOrder; created: boolean }> {
  const consent = parseInput(ConsentInputSchema, consentInput);
  const now = deps.now();
  const prep = await deps.db.tx(async (q) => {
    const ro = await loadRepairOrder(q, roId, true);
    if (ro.status !== "open") throw new CoreError("CONFLICT", `repair order ${roId} is already picked up`, { roId });
    const lines = (await q.query<Line>(`SELECT ${LINE_COLS} FROM lines WHERE ro_id = $1 AND kind = 'estimate' ORDER BY created_at, id`, [roId])).rows;
    if (!lines.length) throw new CoreError("CONFLICT", `repair order ${roId} has no estimate lines`, { roId });
    const existing = (await q.query<PaypalOrder>(`SELECT ${ORDER_COLS} FROM paypal_orders WHERE ro_id = $1 AND purpose = 'estimate' AND ${ACTIVE_ORDER_SQL}`, [roId])).rows[0];
    if (existing) {
      if (existing.status === "COMPLETED") throw new CoreError("CONFLICT", `the estimate of ${roId} is already approved`, { roId, orderId: existing.id });
      return { existing };
    }
    const decided = lines.filter((l) => l.status !== "proposed" && l.status !== "sent");
    if (decided.length) throw new CoreError("CONFLICT", `estimate lines already decided: ${decided.map((l) => l.id).join(", ")}`, { roId });
    const lineIds = lines.map((l) => l.id).sort();
    await assertNoActiveOrder(deps, q, roId, lineIds);
    const intent = { lineIds, amountCents: sum(lines) };
    const claimed = await claimOp(q, { ...opFor(roId, "estimate", lineIds), intent }, now, opStaleMs(deps));
    const newTotal = (await approvedTotal(q, roId)) + sum(lines);
    return { lines, intent, claimed, newTotal };
  });
  if ("existing" in prep) {
    const ex = prep.existing!;
    if (now.getTime() - ex.createdAt.getTime() < approvalTtlMs(deps)) return { order: ex, created: false };
    const r = await refreshApproval(deps, ex.id);
    return { order: r.order, created: r.refreshed };
  }
  const order = await placeOrder(deps, {
    roId,
    purpose: "estimate",
    lines: prep.lines,
    claimed: prep.claimed,
    intent: prep.intent,
    consent: consentRecord(consent, prep.newTotal, now),
  });
  return { order, created: true };
}

export interface DecideResult {
  declined: string[];
  /** The one AUTHORIZE order for the approved lines; null when nothing was approved. */
  order: PaypalOrder | null;
}

/**
 * The customer's decision on new lines. Declined: line `declined` + consent record, no PayPal order. Approved in
 * one tap: ONE AUTHORIZE order with these lines as items. A line that already has a decision or a live order is
 * refused, so a repeated decision never creates a second order.
 */
export async function decide(deps: CoreDeps, roId: string, input: DecideInput): Promise<DecideResult> {
  const data = parseInput(DecideInputSchema, input);
  const now = deps.now();
  const prep = await deps.db.tx(async (q) => {
    const ro = await loadRepairOrder(q, roId, true);
    if (ro.status !== "open") throw new CoreError("CONFLICT", `repair order ${roId} is already picked up`, { roId });
    const all = await loadLines(q, roId, [...data.approve, ...data.decline]);
    for (const l of all) {
      if (l.kind !== "added") throw new CoreError("VALIDATION", `line ${l.id} is an estimate line; the estimate is approved as a whole`, { lineId: l.id });
      if (l.status !== "proposed" && l.status !== "sent") throw new CoreError("CONFLICT", `line ${l.id} is already ${l.status}`, { lineId: l.id, status: l.status });
    }
    await assertNoActiveOrder(deps, q, roId, all.map((l) => l.id));
    const approveLines = all.filter((l) => data.approve.includes(l.id));
    const declineLines = all.filter((l) => data.decline.includes(l.id));
    const newTotal = (await approvedTotal(q, roId)) + sum(approveLines);
    const record = consentRecord(data, newTotal, now);
    for (const l of declineLines) {
      await q.query(`UPDATE lines SET status = 'declined' WHERE id = $1`, [l.id]);
      await q.query(
        `INSERT INTO consents (id, ro_id, line_id, decision, decided_at, channel, approver_name, esign_consent, disclosure_version, amount_cents, new_total_cents,
                              fl_choice, fl_limit_cents)
         VALUES ($1, $2, $3, 'declined', $4::timestamptz, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [newId("cn"), roId, l.id, now.toISOString(), record.channel, record.approverName, record.esignConsent, record.disclosureVersion, l.priceCents, newTotal, record.flChoice, record.flLimitCents],
      );
    }
    const declined = declineLines.map((l) => l.id);
    if (!approveLines.length) return { declined, record, batch: null };
    const lineIds = approveLines.map((l) => l.id).sort();
    const intent = { lineIds, amountCents: sum(approveLines) };
    const claimed = await claimOp(q, { ...opFor(roId, "added", lineIds), intent }, now, opStaleMs(deps));
    return { declined, record, batch: { lines: approveLines, intent, claimed } };
  });
  if (!prep.batch) return { declined: prep.declined, order: null };
  const order = await placeOrder(deps, { roId, purpose: "added", ...prep.batch, consent: prep.record });
  return { declined: prep.declined, order };
}

/**
 * The approval link expired (not approved for longer than the TTL): a new order with the same lines, attempt + 1;
 * the old one gets `superseded_by`. A link that is still fresh, or already approved at PayPal, is left alone.
 */
export async function refreshApproval(deps: CoreDeps, orderId: string): Promise<{ order: PaypalOrder; refreshed: boolean }> {
  const old = await loadOrder(deps.db, orderId);
  const assertRefreshable = (o: PaypalOrder) => {
    if (o.supersededBy) throw new CoreError("CONFLICT", `order ${o.id} was already replaced by ${o.supersededBy}`, { orderId: o.id, supersededBy: o.supersededBy });
    if (o.status === "COMPLETED") throw new CoreError("CONFLICT", `order ${o.id} is already authorized`, { orderId: o.id });
    if (o.status === "CANCELLED") throw new CoreError("CONFLICT", `order ${o.id} was cancelled by the customer; ask for a new decision`, { orderId: o.id });
  };
  assertRefreshable(old);
  const now = deps.now();
  if (now.getTime() - old.createdAt.getTime() < approvalTtlMs(deps)) return { order: old, refreshed: false };

  try {
    const live = await deps.paypal.getOrder(old.id);
    if (live.status === "APPROVED" || live.status === "COMPLETED") {
      await deps.db.query(`UPDATE paypal_orders SET status = $2 WHERE id = $1 AND status <> 'COMPLETED'`, [old.id, live.status]);
      return { order: await loadOrder(deps.db, old.id), refreshed: false };
    }
  } catch (e) {
    // An expired order may simply be gone (404); anything else is a real failure.
    if (!(e instanceof PayPalError && e.httpStatus === 404)) throw wrapPayPal(e, `reading order ${old.id}`);
  }

  const prep = await deps.db.tx(async (q) => {
    const ro = await loadRepairOrder(q, old.roId, true);
    if (ro.status !== "open") throw new CoreError("CONFLICT", `repair order ${ro.id} is already picked up`, { roId: ro.id });
    const cur = await loadOrder(q, old.id, true);
    assertRefreshable(cur);
    const lines = await loadLines(q, cur.roId, cur.lineIds);
    const lineIds = [...cur.lineIds].sort();
    const intent = { lineIds, amountCents: sum(lines), supersedes: cur.id };
    const claimed = await claimOp(q, { ...opFor(cur.roId, cur.purpose, lineIds), intent }, now, opStaleMs(deps));
    return { cur, lines, intent, claimed };
  });
  const order = await placeOrder(deps, { roId: prep.cur.roId, purpose: prep.cur.purpose, lines: prep.lines, claimed: prep.claimed, intent: prep.intent, supersedes: prep.cur.id });
  // The old link was approved (or cancelled) while the new order was being created: the old one stays.
  if (order.supersededBy) return { order: await loadOrder(deps.db, prep.cur.id), refreshed: false };
  return { order, refreshed: true };
}

/**
 * The payer came back from PayPal (or the CHECKOUT.ORDER.APPROVED webhook arrived): authorize the order,
 * idempotently. ORDER_ALREADY_AUTHORIZED reads the order and takes the authorization from it.
 */
export async function onApproved(deps: CoreDeps, orderId: string): Promise<{ order: PaypalOrder; authorization: Authorization; replayed: boolean }> {
  const order = await loadOrder(deps.db, orderId);
  assertAuthorizable(order);
  const existing = await findRootAuthorization(deps.db, orderId);
  if (existing) return { order, authorization: existing, replayed: true };

  await runOp(
    deps,
    { op: "authorize", entityId: orderId, intent: { orderId } },
    async (requestId) => {
      try {
        return await deps.paypal.authorizeOrder({ orderId, requestId });
      } catch (e) {
        if (classify(e) === "ORDER_ALREADY_AUTHORIZED") return deps.paypal.getOrder(orderId);
        throw e;
      }
    },
    async (q, live) => {
      const auth = live.authorizations[0];
      if (!auth) throw new CoreError("PAYPAL", `order ${orderId} came back without an authorization`, { orderId });
      const cur = await loadOrder(q, orderId, true);
      const created = (auth.createTime ?? deps.now()).toISOString();
      const mismatch = auth.amountCents !== cur.amountCents ? `authorized ${auth.amountCents} cents but the approved lines total ${cur.amountCents}` : null;
      await q.query(
        `INSERT INTO authorizations (id, paypal_order_id, ro_id, amount_cents, status, payment_source, expiration_time, created_at, needs_attention)
         VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8::timestamptz, $9) ON CONFLICT (id) DO NOTHING`,
        [auth.id, orderId, cur.roId, auth.amountCents, auth.status, live.paymentSource, auth.expirationTime?.toISOString() ?? null, created, mismatch],
      );
      await q.query(`UPDATE paypal_orders SET status = $2 WHERE id = $1`, [orderId, live.status]);
      await q.query(`UPDATE lines SET status = 'approved' WHERE ro_id = $1 AND id IN ${LINES_PARAM} AND status IN ('proposed', 'sent')`, [cur.roId, JSON.stringify(cur.lineIds)]);
      await q.query(`UPDATE consents SET paypal_authorization_id = $2 WHERE paypal_order_id = $1 AND decision = 'approved'`, [orderId, auth.id]);
    },
    async (q) => {
      // Claimed under the repair order and order locks, so pickup, cancel and refresh cannot slip in between this
      // check and the hold: pickup refuses while this operation is started, cancel and refresh see it and stay out.
      // A link approved after the car was picked up must not become a hold nobody will capture or void.
      const ro = await loadRepairOrder(q, order.roId, true);
      if (ro.status !== "open") throw new CoreError("CONFLICT", `repair order ${ro.id} is already picked up; this approval is not authorized`, { orderId, roId: ro.id });
      assertAuthorizable(await loadOrder(q, orderId, true));
    },
  ).catch((e: unknown) => {
    throw wrapPayPal(e, `authorizing order ${orderId}`);
  });
  const authorization = await findRootAuthorization(deps.db, orderId);
  if (!authorization) throw new CoreError("PAYPAL", `order ${orderId}: authorization not recorded`, { orderId });
  return { order: await loadOrder(deps.db, orderId), authorization, replayed: false };
}

function assertAuthorizable(o: PaypalOrder): void {
  if (o.supersededBy) throw new CoreError("CONFLICT", `order ${o.id} was replaced by ${o.supersededBy}; the customer approves the new link`, { orderId: o.id, supersededBy: o.supersededBy });
  if (o.status === "CANCELLED") throw new CoreError("CONFLICT", `order ${o.id} was cancelled`, { orderId: o.id });
}

function assertNotApproved(o: PaypalOrder): void {
  if (o.status === "COMPLETED" || o.status === "APPROVED") throw new CoreError("CONFLICT", `order ${o.id} is already ${o.status === "COMPLETED" ? "authorized" : "approved at PayPal"}`, { orderId: o.id });
}

/**
 * The payer cancelled on PayPal: the order is CANCELLED and its lines wait for a new decision (`sent`). The cancel
 * link carries only the order id, so it is checked first: PayPal must not show the order approved, and no authorize
 * for it may be running or done. Otherwise the customer's approval would be thrown away, or a second order for the
 * same lines would become a second hold.
 */
export async function onCancelled(deps: CoreDeps, orderId: string): Promise<PaypalOrder> {
  const order = await loadOrder(deps.db, orderId);
  assertNotApproved(order);
  if (order.supersededBy || order.status === "CANCELLED") return order;
  try {
    const live = await deps.paypal.getOrder(orderId);
    if (live.status === "APPROVED" || live.status === "COMPLETED") {
      throw new CoreError("CONFLICT", `the payer approved order ${orderId} at PayPal (${live.status}); it is not cancelled`, { orderId, paypalStatus: live.status });
    }
  } catch (e) {
    if (e instanceof CoreError) throw e;
    // An order PayPal no longer knows (404) can never be approved: cancelling it is safe. Anything else: no verdict.
    if (!(e instanceof PayPalError && e.httpStatus === 404)) throw wrapPayPal(e, `reading order ${orderId}`);
  }
  return deps.db.tx(async (q) => {
    const cur = await loadOrder(q, orderId, true);
    assertNotApproved(cur);
    if (cur.supersededBy || cur.status === "CANCELLED") return cur;
    const authorizing = (await q.query<{ state: string }>(`SELECT state FROM ops WHERE op = 'authorize' AND entity_id = $1 AND state IN ('started', 'done') LIMIT 1`, [orderId])).rows[0];
    if (authorizing) throw new CoreError("CONFLICT", `order ${orderId} is ${authorizing.state === "done" ? "authorized" : "being authorized"}; it is not cancelled`, { orderId });
    await q.query(`UPDATE paypal_orders SET status = 'CANCELLED' WHERE id = $1`, [orderId]);
    await q.query(`UPDATE lines SET status = 'sent' WHERE ro_id = $1 AND id IN ${LINES_PARAM} AND status IN ('proposed', 'sent')`, [cur.roId, JSON.stringify(cur.lineIds)]);
    return loadOrder(q, orderId);
  });
}

async function findRootAuthorization(q: Queryable, orderId: string): Promise<Authorization | null> {
  const r = await q.query<Authorization>(`SELECT ${AUTH_COLS} FROM authorizations WHERE paypal_order_id = $1 AND parent_id IS NULL ORDER BY created_at LIMIT 1`, [orderId]);
  return r.rows[0] ?? null;
}
