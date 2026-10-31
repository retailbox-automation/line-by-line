// Florida Motor Vehicle Repair Act, Fla. Stat. 559.905 and 559.909(1)(b),(3). Not legal advice.
// Formula copied from the knowledge base (KB 2.2) without changes.

const FL = { floorCents: 1000, pct: 0.1, capCents: 5000, estimateRequiredOverCents: 15000 };

/** Allowed overrun before new consent: $10 or 10 percent, whichever is greater, but not more than $50. */
export function flToleranceCents(estimateCents: number): number {
  const tenPct = Math.floor(estimateCents * FL.pct);
  return Math.min(Math.max(FL.floorCents, tenPct), FL.capCents);
}

/** 559.909: the customer must be told and consent when the total exceeds the estimate by MORE than the tolerance. */
export function flNeedsNewAuthorization(lastApprovedTotalCents: number, proposedTotalCents: number): boolean {
  return proposedTotalCents > lastApprovedTotalCents + flToleranceCents(lastApprovedTotalCents); // "more than"
}

/** 559.905(1): a written estimate is required when the work will exceed $150. */
export function flEstimateRequired(expectedCostCents: number): boolean {
  return expectedCostCents > FL.estimateRequiredOverCents;
}

/**
 * Demo policy (stricter than the statute, 559.920(2)): a NEW line item always asks for approval; the tolerance
 * only explains the badge. The hold equals the estimate, so an overrun cannot be captured without a new hold.
 */
export function flNewLineNeedsConsent(): true {
  return true;
}

/** Version tag of the 559.905(2) disclosure and e-records consent text the customer page shows. */
export const DISCLOSURE_VERSION = "FL-559.905-2026-10-31";
