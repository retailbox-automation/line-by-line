// Errors of the PayPal REST client.

/** Refused before any network call: non-sandbox origin, missing or malformed PayPal-Request-Id, bad id. */
export class GuardError extends Error {
  override name = "GuardError";
}

export interface PayPalErrorInfo {
  httpStatus: number;
  /** PayPal error name, e.g. UNPROCESSABLE_ENTITY, RESOURCE_NOT_FOUND, invalid_client. */
  name?: string | undefined;
  /** details[0].issue, e.g. MAX_CAPTURE_COUNT_EXCEEDED. */
  issue?: string | undefined;
  description?: string | undefined;
  debugId?: string | undefined;
}

/** An HTTP error answer from PayPal (status >= 400). */
export class PayPalError extends Error {
  readonly httpStatus: number;
  readonly paypalName: string | undefined;
  readonly issue: string | undefined;
  readonly description: string | undefined;
  readonly debugId: string | undefined;

  constructor(info: PayPalErrorInfo) {
    const label = info.issue ?? info.name ?? `HTTP ${info.httpStatus}`;
    super(info.description ? `PayPal ${info.httpStatus} ${label}: ${info.description}` : `PayPal ${info.httpStatus} ${label}`);
    this.name = "PayPalError";
    this.httpStatus = info.httpStatus;
    this.paypalName = info.name;
    this.issue = info.issue;
    this.description = info.description;
    this.debugId = info.debugId;
  }

  /** Builds the error from a REST v1/v2 error body or an OAuth error body. Non-JSON bodies keep the status only. */
  static fromResponse(httpStatus: number, bodyText: string, debugHeader?: string | null): PayPalError {
    let body: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(bodyText);
      if (parsed && typeof parsed === "object") body = parsed as Record<string, unknown>;
    } catch {
      // gateway HTML or empty body
    }
    const str = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : undefined);
    const details = Array.isArray(body.details) ? (body.details as unknown[]) : [];
    const first = (details[0] && typeof details[0] === "object" ? details[0] : {}) as { issue?: unknown; description?: unknown };
    return new PayPalError({
      httpStatus,
      name: str(body.name) ?? str(body.error),
      issue: str(first.issue),
      description: str(first.description) ?? str(body.message) ?? str(body.error_description),
      debugId: str(body.debug_id) ?? str(debugHeader) ?? undefined,
    });
  }
}

/** The outcome classes the core acts on. Anything else is UNKNOWN and keeps its text on the error. */
export type PayPalOutcome =
  | "MAX_CAPTURE_COUNT_EXCEEDED"
  | "MAX_CAPTURE_AMOUNT_EXCEEDED"
  | "PREVIOUSLY_CAPTURED"
  | "PREVIOUSLY_VOIDED"
  | "AUTHORIZATION_EXPIRED"
  | "REAUTHORIZATION_TOO_SOON"
  | "CANNOT_BE_VOIDED"
  | "ORDER_NOT_APPROVED"
  | "ORDER_ALREADY_AUTHORIZED"
  | "INSTRUMENT_DECLINED"
  | "DUPLICATE_REQUEST_ID"
  | "UNKNOWN";

const ISSUE_TO_OUTCOME: Record<string, PayPalOutcome> = {
  MAX_CAPTURE_COUNT_EXCEEDED: "MAX_CAPTURE_COUNT_EXCEEDED",
  MAX_CAPTURE_AMOUNT_EXCEEDED: "MAX_CAPTURE_AMOUNT_EXCEEDED",
  PREVIOUSLY_CAPTURED: "PREVIOUSLY_CAPTURED",
  AUTHORIZATION_ALREADY_CAPTURED: "PREVIOUSLY_CAPTURED",
  PREVIOUSLY_VOIDED: "PREVIOUSLY_VOIDED",
  AUTHORIZATION_VOIDED: "PREVIOUSLY_VOIDED",
  AUTHORIZATION_EXPIRED: "AUTHORIZATION_EXPIRED",
  REAUTHORIZATION_TOO_SOON: "REAUTHORIZATION_TOO_SOON",
  CANNOT_BE_VOIDED: "CANNOT_BE_VOIDED",
  ORDER_NOT_APPROVED: "ORDER_NOT_APPROVED",
  ORDER_ALREADY_AUTHORIZED: "ORDER_ALREADY_AUTHORIZED",
  INSTRUMENT_DECLINED: "INSTRUMENT_DECLINED",
  DUPLICATE_REQUEST_ID: "DUPLICATE_REQUEST_ID",
};

export function classify(err: unknown): PayPalOutcome {
  if (!(err instanceof PayPalError)) return "UNKNOWN";
  if (err.issue && ISSUE_TO_OUTCOME[err.issue]) return ISSUE_TO_OUTCOME[err.issue]!;
  return "UNKNOWN";
}

/** One line for logs and `needs_attention`: issue or name, description, debug id. Never a response body. */
export function describeError(err: unknown): string {
  if (err instanceof PayPalError) {
    const parts = [`HTTP ${err.httpStatus}`, err.issue ?? err.paypalName ?? "no issue", err.description, err.debugId ? `debug_id ${err.debugId}` : undefined];
    return parts.filter(Boolean).join(" · ");
  }
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

/**
 * True when PayPal gave a definite answer, so the operation did not happen and a new attempt may use a new
 * PayPal-Request-Id. Network failures, timeouts and 5xx are not definite: the money may have moved, so the
 * retry must reuse the same PayPal-Request-Id. 408, 409 (a request with this id may still be running) and 429
 * are treated as not definite too.
 */
export function isDefiniteFailure(err: unknown): boolean {
  if (!(err instanceof PayPalError)) return false;
  const s = err.httpStatus;
  return s >= 400 && s < 500 && s !== 408 && s !== 409 && s !== 429;
}
