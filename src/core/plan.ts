// Pickup plan: pure functions, no network, no database. The guard runs here, before any PayPal call.

import { assertCents } from "../money.js";

export class MoneyGuardError extends Error {
  override name = "MoneyGuardError";
}

export type PlanStep = { kind: "capture"; cents: number; finalCapture: boolean } | { kind: "void" };

export interface PickupPlan {
  steps: PlanStep[];
  /** X: what this plan captures (0 when it only voids or does nothing). */
  captureCents: number;
  warnings: string[];
  /** Why the plan is empty. */
  reason: string | null;
}

export interface PlanAuthorization {
  amountCents: number;
  capturedCents: number;
  status: string;
}

const CAPTURABLE = new Set(["CREATED", "PARTIALLY_CAPTURED"]);

/**
 * X = min(performed, approved). Never more than approved, never more than what is left on the hold.
 * - X == left and X > 0 -> capture X with final_capture: true, no void (void would get PREVIOUSLY_CAPTURED)
 * - 0 < X < left       -> capture X with final_capture: false, then void (the pair tested in the sandbox)
 * - X == 0             -> void
 * - nothing left on the hold -> nothing
 * - VOIDED, CAPTURED, EXPIRED (any non-capturable status) -> nothing, with the reason
 */
export function planPickup(auth: PlanAuthorization, approvedCents: number, performedCents: number): PickupPlan {
  assertCents(auth.amountCents, "authorization amount");
  assertCents(auth.capturedCents, "already captured");
  assertCents(approvedCents, "approved amount");
  assertCents(performedCents, "performed amount");
  if (auth.capturedCents > auth.amountCents) throw new MoneyGuardError(`captured ${auth.capturedCents} is more than the authorization ${auth.amountCents}`);

  if (!CAPTURABLE.has(auth.status)) return { steps: [], captureCents: 0, warnings: [], reason: `authorization is ${auth.status}` };

  const warnings: string[] = [];
  if (performedCents > approvedCents) warnings.push(`performed ${performedCents} is more than approved ${approvedCents}: the overrun needs a new consent and is not captured`);
  const x = Math.min(performedCents, approvedCents);
  const left = auth.amountCents - auth.capturedCents;
  if (x > approvedCents) throw new MoneyGuardError(`capture ${x} is more than approved ${approvedCents}`);
  if (x > left) throw new MoneyGuardError(`capture ${x} is more than what is left on the authorization (${left})`);

  if (left === 0) return { steps: [], captureCents: 0, warnings, reason: "nothing is left on the authorization" };
  if (x > 0 && x === left) return { steps: [{ kind: "capture", cents: x, finalCapture: true }], captureCents: x, warnings, reason: null };
  if (x > 0) return { steps: [{ kind: "capture", cents: x, finalCapture: false }, { kind: "void" }], captureCents: x, warnings, reason: null };
  return { steps: [{ kind: "void" }], captureCents: 0, warnings, reason: null };
}

export interface BillableLine {
  lineId: string;
  priceCents: number;
  performedCents: number;
}

/**
 * Per line, the billable part is min(performed, approved price): an overrun on one line is never paid out of
 * savings on another line. Returns the approved total, the billable total and the overruns.
 */
export function billable(lines: BillableLine[]): { approvedCents: number; billableCents: number; overruns: { lineId: string; approvedCents: number; performedCents: number }[] } {
  let approvedCents = 0;
  let billableCents = 0;
  const overruns: { lineId: string; approvedCents: number; performedCents: number }[] = [];
  for (const l of lines) {
    assertCents(l.priceCents, `price of ${l.lineId}`);
    assertCents(l.performedCents, `performed amount of ${l.lineId}`);
    approvedCents += l.priceCents;
    billableCents += Math.min(l.priceCents, l.performedCents);
    if (l.performedCents > l.priceCents) overruns.push({ lineId: l.lineId, approvedCents: l.priceCents, performedCents: l.performedCents });
  }
  return { approvedCents, billableCents, overruns };
}
