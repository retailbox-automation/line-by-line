import { PayPalNetworkError } from "../paypal/client.js";
import { classify, describeError, GuardError, PayPalError, type PayPalOutcome } from "../paypal/errors.js";
import { PayPalParseError } from "../paypal/parse.js";

/**
 * NOT_FOUND -> 404, VALIDATION -> 400, CONFLICT -> 409 (state does not allow it), IN_PROGRESS -> 409 (the same
 * PayPal operation is running right now; retry shortly), PAYPAL -> 502 (PayPal refused or did not answer).
 */
export type CoreErrorCode = "NOT_FOUND" | "VALIDATION" | "CONFLICT" | "IN_PROGRESS" | "PAYPAL";

export class CoreError extends Error {
  override name = "CoreError";
  constructor(
    readonly code: CoreErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/** PayPal-side failures become CoreError PAYPAL; our own CoreErrors pass through; anything else (a bug) is rethrown as is. */
export function wrapPayPal(err: unknown, what: string): unknown {
  if (err instanceof CoreError) return err;
  if (err instanceof PayPalError || err instanceof PayPalNetworkError || err instanceof PayPalParseError || err instanceof GuardError) return paypalFailure(err, what);
  return err;
}

/** Wraps a PayPal failure for callers; keeps the outcome class, issue and debug id, never a body. */
export function paypalFailure(err: unknown, what: string): CoreError {
  const outcome: PayPalOutcome = classify(err);
  const details: Record<string, unknown> = { outcome, text: describeError(err) };
  if (err instanceof PayPalError) {
    details.httpStatus = err.httpStatus;
    details.issue = err.issue ?? null;
    details.debugId = err.debugId ?? null;
  }
  return new CoreError("PAYPAL", `${what}: ${describeError(err)}`, details);
}
