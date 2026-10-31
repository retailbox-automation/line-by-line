// Money is whole US cents in a plain number. Only USD exists in this app.

export const CURRENCY = "USD" as const;

export class MoneyError extends Error {
  override name = "MoneyError";
}

export function isCents(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Throws unless `value` is a safe, non-negative integer number of cents. */
export function assertCents(value: unknown, label = "amount"): number {
  if (!isCents(value)) throw new MoneyError(`${label} must be a non-negative whole number of cents, got ${String(value)}`);
  return value;
}

/** 18400 -> "184.00" (the string PayPal expects in `value`). */
export function toPayPal(cents: number): string {
  assertCents(cents);
  const whole = Math.floor(cents / 100);
  const rest = cents % 100;
  return `${whole}.${rest < 10 ? "0" : ""}${rest}`;
}

const PAYPAL_VALUE = /^(0|[1-9][0-9]*)(?:\.([0-9]{1,2}))?$/;

/** "184.00" -> 18400. Strict: no sign, no spaces, no exponent, at most two decimals. */
export function fromPayPal(value: string): number {
  if (typeof value !== "string") throw new MoneyError(`not a money string: ${String(value)}`);
  const m = PAYPAL_VALUE.exec(value);
  if (!m) throw new MoneyError(`not a USD amount: ${JSON.stringify(value)}`);
  const whole = Number(m[1]);
  const frac = m[2] === undefined ? 0 : Number(m[2].padEnd(2, "0"));
  const cents = whole * 100 + frac;
  if (!Number.isSafeInteger(cents)) throw new MoneyError(`amount too large: ${JSON.stringify(value)}`);
  return cents;
}

/** Reads a PayPal `{currency_code, value}` object; refuses anything that is not USD. */
export function fromPayPalAmount(amount: unknown): number {
  if (!amount || typeof amount !== "object") throw new MoneyError("missing amount");
  const { currency_code, value } = amount as { currency_code?: unknown; value?: unknown };
  if (currency_code !== CURRENCY) throw new MoneyError(`unexpected currency ${String(currency_code)}`);
  if (typeof value !== "string") throw new MoneyError("amount value is not a string");
  return fromPayPal(value);
}

export function usd(cents: number): { currency_code: typeof CURRENCY; value: string } {
  return { currency_code: CURRENCY, value: toPayPal(cents) };
}
