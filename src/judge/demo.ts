// The judge's demo repair order: the $412 estimate of the demo story, made of price-list lines, tied to the session.

import { ConsentInputSchema, createEstimateOrder, CoreError, insertRepairOrder, parseInput, type ConsentInput, type CoreDeps, type LineInput, type PaypalOrder } from "../core/index.js";
import { HttpError } from "../http/errors.js";

export const MAX_DEMO_REPAIR_ORDERS = 5;
export const DEMO_ESTIMATE_CENTS = 41200;

/**
 * No two or three price-list items add up to $412, so the estimate has four: front brake pads $189, check engine
 * light diagnosis $129, front wiper blades $49 and engine air filter $45. Every price comes from the list.
 */
export const DEMO_ESTIMATE: LineInput[] = [
  { priceCode: "BRK-PAD-F", urgency: "safety", source: "desk" },
  { priceCode: "DIAG-CEL", urgency: "soon", source: "desk" },
  { priceCode: "WIPER-F", urgency: "can_wait", source: "desk" },
  { priceCode: "FLT-ENGINE", urgency: "can_wait", source: "desk" },
];

/**
 * Creates the demo repair order in the judge's session (at most 5 per session, 429 DEMO_LIMIT beyond) and the
 * PayPal order of its estimate with the judge's consent record. A PayPal failure leaves the repair order in place:
 * the error names it (`details.roId`) and the estimate approval can be asked for again on it.
 */
export async function createJudgeDemo(deps: CoreDeps, sessionId: string, consentInput: ConsentInput): Promise<{ roId: string; order: PaypalOrder }> {
  const consent = parseInput(ConsentInputSchema, consentInput);
  const now = deps.now();
  const roId = await deps.db.tx(async (q) => {
    const taken = await q.query(`UPDATE judge_sessions SET ro_count = ro_count + 1 WHERE id = $1 AND expires_at > $2::timestamptz AND ro_count < $3 RETURNING ro_count`, [
      sessionId,
      now.toISOString(),
      MAX_DEMO_REPAIR_ORDERS,
    ]);
    if (!taken.rows.length) {
      const alive = await q.query(`SELECT 1 FROM judge_sessions WHERE id = $1 AND expires_at > $2::timestamptz`, [sessionId, now.toISOString()]);
      if (!alive.rows.length) throw new HttpError(401, "UNAUTHORIZED", "the judge session has expired; start a new one");
      throw new HttpError(429, "DEMO_LIMIT", `a judge session creates at most ${MAX_DEMO_REPAIR_ORDERS} demo repair orders; start a new session for more`);
    }
    const { repairOrder, lines } = await insertRepairOrder(q, { customerLabel: "Judge demo (made-up)", estimateLines: DEMO_ESTIMATE }, now, sessionId);
    const total = lines.reduce((a, l) => a + l.priceCents, 0);
    if (total !== DEMO_ESTIMATE_CENTS) throw new Error(`the demo estimate totals ${total} cents, not ${DEMO_ESTIMATE_CENTS}: the price list changed`);
    return repairOrder.id;
  });
  try {
    const { order } = await createEstimateOrder(deps, roId, consent);
    return { roId, order };
  } catch (e) {
    if (e instanceof CoreError) throw new CoreError(e.code, `${e.message} (demo repair order ${roId} was created; ask for its estimate approval again)`, { ...e.details, roId });
    throw e;
  }
}
