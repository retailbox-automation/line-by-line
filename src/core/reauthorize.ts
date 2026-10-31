// Reauthorize: only holds paid from a PayPal account (OpenAPI: "Reauthorizes an authorized PayPal account
// payment"), once, from day 4 (finding 3: day 0 -> REAUTHORIZATION_TOO_SOON) to day 29, for the same amount. The
// new authorization keeps the old expiry (finding 4), its id is taken from the body, not from `links` (finding 6),
// and the parent stays the one we void (finding 5). A card hold is not extended: the customer approves again.

import type { Queryable } from "../db/db.js";
import { classify, describeError } from "../paypal/errors.js";
import type { ParsedAuthorization } from "../paypal/parse.js";
import type { CoreDeps } from "./deps.js";
import { CoreError } from "./errors.js";
import { runOp } from "./ops.js";
import { AUTH_COLS, type Authorization } from "./rows.js";

/** 4 days and 10 minutes: a safety margin over PayPal's "from Day 4". */
export const REAUTH_MIN_AGE_MS = (4 * 24 * 60 + 10) * 60 * 1000;

function windowSql(paymentSourceCondition: string): string {
  return `SELECT ${AUTH_COLS} FROM authorizations WHERE id IN (
      SELECT a.id FROM authorizations a JOIN repair_orders r ON r.id = a.ro_id
       WHERE ${paymentSourceCondition} AND a.status = 'CREATED' AND a.captured_cents = 0 AND a.parent_id IS NULL
         AND a.reauthorized_to IS NULL AND a.needs_attention IS NULL
         AND a.created_at <= $1::timestamptz AND a.expiration_time > $2::timestamptz
         AND r.status <> 'picked_up')
    ORDER BY ro_id, created_at, id`;
}

async function inWindow(q: Queryable, now: Date, paymentSourceCondition: string): Promise<Authorization[]> {
  const cutoff = new Date(now.getTime() - REAUTH_MIN_AGE_MS).toISOString();
  return (await q.query<Authorization>(windowSql(paymentSourceCondition), [cutoff, now.toISOString()])).rows;
}

/**
 * Wallet holds due for reauthorization: payment_source paypal, CREATED, nothing captured, not a reauthorization,
 * not already reauthorized, at least 4 days 10 minutes old, not expired, repair order not picked up.
 */
export async function findReauthorizable(deps: Pick<CoreDeps, "db">, now: Date): Promise<Authorization[]> {
  return inWindow(deps.db, now, `a.payment_source = 'paypal'`);
}

export interface ReauthorizeRunResult {
  reauthorized: { parentId: string; newId: string; roId: string; amountCents: number; expirationTime: Date | null }[];
  skipped: { authorizationId: string; roId: string; reason: string }[];
  /** Card (or unknown source) holds of the same age: cannot be extended, ask the customer to approve again. */
  askCustomer: { authorizationId: string; roId: string; paymentSource: string }[];
}

/** The scheduled job: every due wallet hold of every repair order, same amount. Never throws on a single hold. */
export async function runReauthorize(deps: CoreDeps, now: Date = deps.now()): Promise<ReauthorizeRunResult> {
  const due = await findReauthorizable(deps, now);
  const others = await inWindow(deps.db, now, `a.payment_source <> 'paypal'`);
  const out: ReauthorizeRunResult = {
    reauthorized: [],
    skipped: [],
    askCustomer: others.map((a) => ({ authorizationId: a.id, roId: a.roId, paymentSource: a.paymentSource })),
  };
  for (const a of due) {
    try {
      const { result: child } = await runOp<ParsedAuthorization>(
        deps,
        { op: "reauth", entityId: a.id, intent: { cents: a.amountCents } },
        (requestId) => deps.paypal.reauthorize({ authorizationId: a.id, requestId, cents: a.amountCents }),
        async (q, n) => {
          const at = deps.now().toISOString();
          if (n.id === a.id) {
            // Should not happen (finding 6 is about links, the body id is new); never overwrite the parent.
            await q.query(`UPDATE authorizations SET needs_attention = $2 WHERE id = $1`, [a.id, `reauthorize returned the same id ${n.id}`]);
            return;
          }
          await q.query(
            `INSERT INTO authorizations (id, paypal_order_id, ro_id, parent_id, amount_cents, status, payment_source, expiration_time, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9::timestamptz) ON CONFLICT (id) DO NOTHING`,
            [n.id, a.paypalOrderId, a.roId, a.id, n.amountCents, n.status, a.paymentSource, (n.expirationTime ?? a.expirationTime)?.toISOString() ?? null, (n.createTime ?? deps.now()).toISOString()],
          );
          await q.query(`UPDATE authorizations SET reauthorized_to = $2, reauthorized_at = $3::timestamptz WHERE id = $1`, [a.id, n.id, at]);
        },
      );
      if (child.id === a.id) out.skipped.push({ authorizationId: a.id, roId: a.roId, reason: `reauthorize returned the same id ${child.id}` });
      else out.reauthorized.push({ parentId: a.id, newId: child.id, roId: a.roId, amountCents: child.amountCents, expirationTime: child.expirationTime ?? a.expirationTime });
    } catch (e) {
      const outcome = classify(e);
      const reason = e instanceof CoreError ? e.message : outcome === "REAUTHORIZATION_TOO_SOON" ? `REAUTHORIZATION_TOO_SOON: ${describeError(e)}` : describeError(e);
      out.skipped.push({ authorizationId: a.id, roId: a.roId, reason });
    }
  }
  return out;
}
