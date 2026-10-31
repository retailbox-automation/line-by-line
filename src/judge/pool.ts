// The pool of aged holds for the judges. A hold gives one reauthorization, from day 4 until it expires, so a judge
// who has three minutes needs a hold that is already older than 4 days. scripts/seed-pool.ts records existing
// sandbox holds (explicit ids only, never a search) as repair orders of kind 'pool'; a judge then reauthorizes the
// oldest free one for real through the core's reauthorize step.

import { z } from "zod";
import { opStaleMs } from "../core/deps.js";
import { AUTH_COLS, claimOp, CoreError, executeReauthorize, parseInput, REAUTH_MIN_AGE_MS, reauthSpec, wrapPayPal, type Authorization, type CoreDeps } from "../core/index.js";
import type { Queryable } from "../db/db.js";
import { HttpError } from "../http/errors.js";
import { classify, describeError, GuardError, isDefiniteFailure } from "../paypal/errors.js";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Live GETs run this many at a time when the pool is listed. */
const LIVE_READS_AT_ONCE = 5;

export type PoolPurpose = "judge" | "reserved";

export const PoolSeedSchema = z.object({
  purpose: z.enum(["judge", "reserved"]),
  wave: z.number().int().min(0).max(1000),
  label: z.string().trim().min(1).max(100),
  note: z.string().trim().max(500).default(""),
  ids: z
    .array(z.string().regex(/^[A-Z0-9]{10,64}$/, "not a PayPal authorization id"))
    .min(1)
    .max(50)
    .refine((ids) => new Set(ids).size === ids.length, { message: "an authorization id appears twice" }),
});
export type PoolSeedInput = z.input<typeof PoolSeedSchema>;

export interface SeedResult {
  authorizationId: string;
  outcome: "added" | "updated" | "refused";
  reason: string | null;
  roId: string | null;
  amountCents: number | null;
}

/**
 * Records each given sandbox hold in the pool. Per id: live GET of the authorization and of its order; only a CREATED
 * hold paid from a PayPal wallet is taken. A new hold becomes a repair order of kind 'pool' (lines from the order's
 * items with PayPal's prices), its order and its authorization, shaped like our own so pickup, reconcile and the
 * reauthorize step work on it. An id seen before only gets its pool row updated (label, purpose, wave, note).
 */
export async function seedPool(deps: CoreDeps, input: PoolSeedInput): Promise<SeedResult[]> {
  const o = parseInput(PoolSeedSchema, input);
  const out: SeedResult[] = [];
  for (const id of o.ids) out.push(await seedOne(deps, o, id));
  return out;
}

async function upsertPool(q: Queryable, id: string, o: z.output<typeof PoolSeedSchema>, at: Date): Promise<void> {
  await q.query(
    `INSERT INTO judge_pool (authorization_id, label, purpose, wave, note, added_at) VALUES ($1, $2, $3, $4, $5, $6::timestamptz)
     ON CONFLICT (authorization_id) DO UPDATE SET label = EXCLUDED.label, purpose = EXCLUDED.purpose, wave = EXCLUDED.wave, note = EXCLUDED.note`,
    [id, o.label, o.purpose, o.wave, o.note, at.toISOString()],
  );
}

async function seedOne(deps: CoreDeps, o: z.output<typeof PoolSeedSchema>, id: string): Promise<SeedResult> {
  const refused = (reason: string): SeedResult => ({ authorizationId: id, outcome: "refused", reason, roId: null, amountCents: null });
  let live, order;
  try {
    live = await deps.paypal.getAuthorization(id);
    if (live.status !== "CREATED") return refused(`status ${live.status}; only a CREATED hold is seeded`);
    if (!live.orderId) return refused("PayPal did not name the order of this authorization");
    order = await deps.paypal.getOrder(live.orderId);
  } catch (e) {
    return refused(`PayPal: ${describeError(e)}`);
  }
  if (order.paymentSource !== "paypal") return refused(`paid by ${order.paymentSource}; only a hold paid from a PayPal wallet can be reauthorized`);
  if (!order.authorizations.some((a) => a.id === id)) return refused(`order ${order.id} does not list this authorization`);
  const now = deps.now();

  const known = (await deps.db.query<{ ro_id: string; kind: string; amount_cents: number }>(`SELECT a.ro_id, r.kind, a.amount_cents FROM authorizations a JOIN repair_orders r ON r.id = a.ro_id WHERE a.id = $1`, [id])).rows[0];
  if (known) {
    if (known.kind !== "pool") return refused(`already a hold of repair order ${known.ro_id}, which is not a pool repair order`);
    await upsertPool(deps.db, id, o, now);
    return { authorizationId: id, outcome: "updated", reason: null, roId: known.ro_id, amountCents: known.amount_cents };
  }

  if (order.authorizations.length !== 1) return refused(`order ${order.id} carries ${order.authorizations.length} authorizations (reauthorized already?); only a fresh hold is seeded`);
  const ourOrder = (await deps.db.query<{ ro_id: string }>(`SELECT ro_id FROM paypal_orders WHERE id = $1`, [order.id])).rows[0];
  if (ourOrder) return refused(`order ${order.id} is already an order of repair order ${ourOrder.ro_id}`);
  if (order.items === null) return refused(`the items of order ${order.id} cannot be read`);
  if (order.items.length === 0) return refused(`order ${order.id} has no items to make lines from`);
  if (order.items.some((it) => it.unitCents === 0)) return refused(`order ${order.id} has an item priced 0`);
  const lines = order.items.map((it) => ({ title: (it.quantity === 1 ? it.name : `${it.name} x ${it.quantity}`).slice(0, 127), cents: it.unitCents * it.quantity }));
  const total = lines.reduce((a, l) => a + l.cents, 0);
  if (total !== live.amountCents) return refused(`the items of order ${order.id} total ${total} cents but the hold is ${live.amountCents}`);
  if (!live.createTime || !live.expirationTime) return refused("PayPal did not send the create and expiration time of the hold");

  const roId = `ro_pool_${id}`;
  const created = live.createTime;
  const lineIds = lines.map((_, i) => `ln_pool_${id}_${i}`);
  await deps.db.tx(async (q) => {
    await q.query(`INSERT INTO repair_orders (id, customer_label, state, status, kind, created_at) VALUES ($1, $2, 'FL', 'open', 'pool', $3::timestamptz) ON CONFLICT (id) DO NOTHING`, [
      roId,
      o.label,
      created.toISOString(),
    ]);
    for (const [i, l] of lines.entries()) {
      await q.query(
        `INSERT INTO lines (id, ro_id, kind, title, description, price_cents, urgency, source, status, created_at)
         VALUES ($1, $2, 'estimate', $3, '', $4, NULL, 'desk', 'approved', $5::timestamptz) ON CONFLICT (id) DO NOTHING`,
        [lineIds[i], roId, l.title, l.cents, new Date(created.getTime() + i).toISOString()],
      );
    }
    // Not created by us, so there is no PayPal-Request-Id: the column gets a marker that cannot collide with ours.
    await q.query(
      `INSERT INTO paypal_orders (id, ro_id, purpose, line_ids, amount_cents, status, approve_url, request_id, attempt, superseded_by, created_at)
       VALUES ($1, $2, 'estimate', $3::jsonb, $4, $5, NULL, $6, 1, NULL, $7::timestamptz) ON CONFLICT (id) DO NOTHING`,
      [order.id, roId, JSON.stringify([...lineIds].sort()), live.amountCents, order.status, `pool:${order.id}`, created.toISOString()],
    );
    await q.query(
      `INSERT INTO authorizations (id, paypal_order_id, ro_id, amount_cents, status, payment_source, expiration_time, created_at)
       VALUES ($1, $2, $3, $4, $5, 'paypal', $6::timestamptz, $7::timestamptz) ON CONFLICT (id) DO NOTHING`,
      [id, order.id, roId, live.amountCents, live.status, live.expirationTime!.toISOString(), created.toISOString()],
    );
    await upsertPool(q, id, o, now);
  });
  return { authorizationId: id, outcome: "added", reason: null, roId, amountCents: live.amountCents };
}

// --- listing ---

interface PoolRow {
  authorization_id: string;
  label: string;
  purpose: PoolPurpose;
  wave: number;
  note: string;
  ro_id: string;
  ro_status: string;
  amount_cents: number;
  captured_cents: number;
  status: string;
  needs_attention: string | null;
  created_at: Date;
  expiration_time: Date | null;
  reauthorized_to: string | null;
  reauthorized_at: Date | null;
  child_expiration: Date | null;
}

interface LiveRead {
  status: string;
  expirationTime: Date | null;
}

export interface PoolHold {
  authorizationId: string;
  label: string;
  purpose: PoolPurpose;
  wave: number;
  note: string;
  roId: string;
  amountCents: number;
  createdAt: Date;
  ageDays: number;
  expirationTime: Date | null;
  /** Status in our records after the live read. */
  status: string;
  live: LiveRead | null;
  liveError: string | null;
  window: { opensAt: Date; closesAt: Date | null; open: boolean };
  reauthorized: { at: Date | null; newId: string; expirationTime: Date | null; live: LiveRead | null; liveError: string | null } | null;
  /** True when a judge's reauthorize-next could take this hold now. */
  available: boolean;
  /** Why it is not available. */
  reason: string | null;
}

async function readLive(deps: CoreDeps, id: string): Promise<{ live: LiveRead | null; error: string | null }> {
  try {
    const a = await deps.paypal.getAuthorization(id);
    // The status is PayPal's; money columns are never touched by a read.
    await deps.db.query(`UPDATE authorizations SET status = $2 WHERE id = $1 AND status <> $2`, [id, a.status]);
    return { live: { status: a.status, expirationTime: a.expirationTime }, error: null };
  } catch (e) {
    return { live: null, error: describeError(e) };
  }
}

function ageDays(createdAt: Date, now: Date): number {
  return Math.floor(((now.getTime() - createdAt.getTime()) / DAY_MS) * 10) / 10;
}

/** Every pool hold with a live GET of it (and of its reauthorization), oldest first. Reserved holds are marked. */
export async function listPool(deps: CoreDeps): Promise<PoolHold[]> {
  const rows = (
    await deps.db.query<PoolRow>(
      `SELECT p.authorization_id, p.label, p.purpose, p.wave, p.note, a.ro_id, r.status AS ro_status, a.amount_cents, a.captured_cents,
              a.needs_attention, a.created_at, a.expiration_time, a.reauthorized_to, a.reauthorized_at, c.expiration_time AS child_expiration
         FROM judge_pool p JOIN authorizations a ON a.id = p.authorization_id JOIN repair_orders r ON r.id = a.ro_id
         LEFT JOIN authorizations c ON c.id = a.reauthorized_to
        ORDER BY a.created_at, a.id`,
    )
  ).rows;
  const ids = rows.flatMap((r) => [r.authorization_id, ...(r.reauthorized_to ? [r.reauthorized_to] : [])]);
  const reads = new Map<string, Awaited<ReturnType<typeof readLive>>>();
  for (let i = 0; i < ids.length; i += LIVE_READS_AT_ONCE) {
    const batch = ids.slice(i, i + LIVE_READS_AT_ONCE);
    const got = await Promise.all(batch.map((id) => readLive(deps, id)));
    batch.forEach((id, j) => reads.set(id, got[j]!));
  }
  const now = deps.now();
  return rows.map((r) => {
    const read = reads.get(r.authorization_id)!;
    const status = read.live?.status ?? r.status;
    const opensAt = new Date(r.created_at.getTime() + REAUTH_MIN_AGE_MS);
    const open = opensAt <= now && r.expiration_time !== null && r.expiration_time > now;
    const child = r.reauthorized_to ? reads.get(r.reauthorized_to)! : null;
    const reason =
      r.purpose === "reserved"
        ? "reserved for a test or a recording; never handed out"
        : r.reauthorized_to
          ? `already reauthorized${r.reauthorized_at ? ` on ${r.reauthorized_at.toISOString()}` : ""}, new id ${r.reauthorized_to}`
          : status !== "CREATED"
            ? `status ${status}`
            : r.needs_attention
              ? `needs attention: ${r.needs_attention}`
              : r.ro_status !== "open" || r.captured_cents > 0
                ? "already picked up"
                : !open
                  ? opensAt > now
                    ? `too young: the reauthorize window opens ${opensAt.toISOString()}`
                    : "expired"
                  : null;
    return {
      authorizationId: r.authorization_id,
      label: r.label,
      purpose: r.purpose,
      wave: r.wave,
      note: r.note,
      roId: r.ro_id,
      amountCents: r.amount_cents,
      createdAt: r.created_at,
      ageDays: ageDays(r.created_at, now),
      expirationTime: r.expiration_time,
      status,
      live: read.live,
      liveError: read.error,
      window: { opensAt, closesAt: r.expiration_time, open },
      reauthorized: r.reauthorized_to
        ? { at: r.reauthorized_at, newId: r.reauthorized_to, expirationTime: r.child_expiration, live: child?.live ?? null, liveError: child?.error ?? null }
        : null,
      available: reason === null,
      reason,
    };
  });
}

// --- reauthorize-next ---

export interface ReauthorizeNextResult {
  label: string;
  parentId: string;
  newId: string;
  requestId: string;
  amountCents: number;
  ageDays: number;
  expirationTime: Date | null;
  /** Live GET of the new authorization; null (with liveError) when that read failed. */
  live: (LiveRead & { amountCents: number }) | null;
  liveError: string | null;
}

/** Free 'judge' holds whose reauthorize window is open, oldest first (the same conditions as the job's window). */
async function freeJudgeHolds(q: Queryable, now: Date): Promise<(Authorization & { label: string })[]> {
  const cutoff = new Date(now.getTime() - REAUTH_MIN_AGE_MS).toISOString();
  return (
    await q.query<Authorization & { label: string }>(
      `SELECT ${AUTH_COLS}, (SELECT label FROM judge_pool WHERE authorization_id = authorizations.id) AS label FROM authorizations WHERE id IN (
         SELECT a.id FROM authorizations a JOIN repair_orders r ON r.id = a.ro_id JOIN judge_pool p ON p.authorization_id = a.id
          WHERE p.purpose = 'judge' AND a.payment_source = 'paypal' AND a.status = 'CREATED' AND a.captured_cents = 0 AND a.parent_id IS NULL
            AND a.reauthorized_to IS NULL AND a.needs_attention IS NULL
            AND a.created_at <= $1::timestamptz AND a.expiration_time > $2::timestamptz AND r.status <> 'picked_up')
       ORDER BY created_at, id`,
      [cutoff, now.toISOString()],
    )
  ).rows;
}

/** The pool hold reauthorized last, with a live GET of its new id (the fallback when the pool is empty). */
async function lastReauthorized(deps: CoreDeps) {
  const r = (
    await deps.db.query<{ label: string; purpose: PoolPurpose; parent_id: string; new_id: string; reauthorized_at: Date | null; expiration_time: Date | null; amount_cents: number }>(
      `SELECT p.label, p.purpose, a.id AS parent_id, c.id AS new_id, a.reauthorized_at, c.expiration_time, c.amount_cents
         FROM judge_pool p JOIN authorizations a ON a.id = p.authorization_id JOIN authorizations c ON c.id = a.reauthorized_to
        ORDER BY a.reauthorized_at DESC NULLS LAST, a.id LIMIT 1`,
    )
  ).rows[0];
  if (!r) return null;
  const read = await readLive(deps, r.new_id);
  return {
    label: r.label,
    purpose: r.purpose,
    parentId: r.parent_id,
    newId: r.new_id,
    reauthorizedAt: r.reauthorized_at,
    amountCents: r.amount_cents,
    expirationTime: r.expiration_time,
    live: read.live,
    liveError: read.error,
  };
}

/**
 * One reauthorization per judge session, on the oldest free 'judge' hold with an open window, through the core's
 * reauthorize step (same amount, PayPal-Request-Id lbl:reauth:<id>:<attempt>). 409 ALREADY_USED on a second call
 * of the session; 409 POOL_EMPTY, with the hold reauthorized last and a live GET of it, when no hold is free.
 * If PayPal refuses or does not answer, the session gets its one use back: after no answer the next call retries
 * the same hold with the same PayPal-Request-Id; a hold PayPal refused for good (not "too soon") is flagged
 * (`needs_attention`) so the next call takes the next hold.
 */
export async function reauthorizeNext(deps: CoreDeps, sessionId: string): Promise<ReauthorizeNextResult> {
  const now = deps.now();
  const claim = await deps.db.tx(async (q) => {
    const s = (await q.query<{ reauthorized: boolean }>(`SELECT reauthorized FROM judge_sessions WHERE id = $1 AND expires_at > $2::timestamptz FOR UPDATE`, [sessionId, now.toISOString()])).rows[0];
    if (!s) throw new HttpError(401, "UNAUTHORIZED", "the judge session has expired; start a new one");
    if (s.reauthorized) throw new HttpError(409, "ALREADY_USED", "this judge session has already reauthorized a hold; start a new session to do it again");
    for (const a of await freeJudgeHolds(q, now)) {
      try {
        // The claim (a row in ops) is the lock: another judge at the same moment gets IN_PROGRESS and takes the next hold.
        const claimed = await claimOp(q, reauthSpec(a), now, opStaleMs(deps));
        await q.query(`UPDATE judge_sessions SET reauthorized = true WHERE id = $1`, [sessionId]);
        return { a, claimed };
      } catch (e) {
        if (e instanceof CoreError && (e.code === "IN_PROGRESS" || e.code === "CONFLICT")) continue;
        throw e;
      }
    }
    return null;
  });
  if (!claim) {
    throw new HttpError(409, "POOL_EMPTY", "no free aged hold right now; showing the hold reauthorized last instead", { lastReauthorized: await lastReauthorized(deps) });
  }

  const { a, claimed } = claim;
  let child;
  try {
    child = await executeReauthorize(deps, a, claimed);
  } catch (e) {
    await deps.db.query(`UPDATE judge_sessions SET reauthorized = false WHERE id = $1`, [sessionId]);
    if ((isDefiniteFailure(e) || e instanceof GuardError) && classify(e) !== "REAUTHORIZATION_TOO_SOON") {
      await deps.db.query(`UPDATE authorizations SET needs_attention = $2 WHERE id = $1 AND needs_attention IS NULL`, [a.id, `judge reauthorize refused: ${describeError(e)}`]);
    }
    throw wrapPayPal(e, `reauthorizing pool hold ${a.id}`);
  }
  if (child.id === a.id) {
    // The core flagged the hold (PayPal answered with the same id); the session gets its one use back.
    await deps.db.query(`UPDATE judge_sessions SET reauthorized = false WHERE id = $1`, [sessionId]);
    throw new CoreError("PAYPAL", `reauthorize of ${a.id} came back with the same id; the hold is flagged, try again for the next one`, { authorizationId: a.id });
  }
  let live: ReauthorizeNextResult["live"] = null;
  let liveError: string | null = null;
  try {
    const n = await deps.paypal.getAuthorization(child.id);
    live = { status: n.status, amountCents: n.amountCents, expirationTime: n.expirationTime };
  } catch (e) {
    liveError = describeError(e);
  }
  return {
    label: a.label,
    parentId: a.id,
    newId: child.id,
    requestId: claimed.requestId,
    amountCents: child.amountCents,
    ageDays: ageDays(a.createdAt, now),
    expirationTime: child.expirationTime ?? a.expirationTime,
    live,
    liveError,
  };
}
