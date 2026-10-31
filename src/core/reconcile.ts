// Reconciliation: live PayPal against our database. Reports differences and takes statuses from PayPal; it never
// moves money and never rewrites amounts.

import type { CoreDeps } from "./deps.js";
import { wrapPayPal } from "./errors.js";
import { CAPTURE_COLS, loadAuthorization, type Authorization, type Capture } from "./rows.js";

const CAPTURED_STATES = new Set(["COMPLETED", "PENDING", "PARTIALLY_REFUNDED", "REFUNDED"]);

export interface ReconcileDiff {
  field: string;
  db: string | number | null;
  paypal: string | number | null;
}

export interface ReconcileResult {
  ok: boolean;
  diffs: ReconcileDiff[];
  live: { status: string; amountCents: number; capturedCents: number; expirationTime: Date | null };
  /** Our row after the status update. */
  authorization: Authorization;
}

export async function reconcile(deps: CoreDeps, authorizationId: string): Promise<ReconcileResult> {
  const row = await loadAuthorization(deps.db, authorizationId);
  const ours = (await deps.db.query<Capture>(`SELECT ${CAPTURE_COLS} FROM captures WHERE authorization_id = $1`, [authorizationId])).rows;
  let live, order;
  try {
    live = await deps.paypal.getAuthorization(authorizationId);
    order = await deps.paypal.getOrder(row.paypalOrderId);
  } catch (e) {
    throw wrapPayPal(e, `reading authorization ${authorizationId}`);
  }
  const ourIds = new Set(ours.map((c) => c.id));
  // Captures of this authorization: by the `up` link of each capture in the order, plus the ids we recorded.
  const liveCaptures = order.captures.filter((c) => c.authorizationId === authorizationId || ourIds.has(c.id));
  const liveCaptured = liveCaptures.filter((c) => CAPTURED_STATES.has(c.status)).reduce((a, c) => a + (c.amountCents ?? 0), 0);

  const diffs: ReconcileDiff[] = [];
  if (live.status !== row.status) diffs.push({ field: "status", db: row.status, paypal: live.status });
  if (live.amountCents !== row.amountCents) diffs.push({ field: "amount_cents", db: row.amountCents, paypal: live.amountCents });
  if (liveCaptured !== row.capturedCents) diffs.push({ field: "captured_cents", db: row.capturedCents, paypal: liveCaptured });
  const liveById = new Map(liveCaptures.map((c) => [c.id, c]));
  for (const c of ours) {
    const l = liveById.get(c.id);
    if (!l) diffs.push({ field: `capture ${c.id}`, db: c.status, paypal: null });
    else if (l.status !== c.status) diffs.push({ field: `capture ${c.id} status`, db: c.status, paypal: l.status });
  }
  for (const l of liveCaptures) if (!ourIds.has(l.id)) diffs.push({ field: `capture ${l.id}`, db: null, paypal: l.status });

  await deps.db.tx(async (q) => {
    if (live.status !== row.status) await q.query(`UPDATE authorizations SET status = $2 WHERE id = $1`, [authorizationId, live.status]);
    for (const c of ours) {
      const l = liveById.get(c.id);
      if (l && l.status !== c.status) await q.query(`UPDATE captures SET status = $2 WHERE id = $1`, [c.id, l.status]);
    }
  });
  return {
    ok: diffs.length === 0,
    diffs,
    live: { status: live.status, amountCents: live.amountCents, capturedCents: liveCaptured, expirationTime: live.expirationTime },
    authorization: await loadAuthorization(deps.db, authorizationId),
  };
}
