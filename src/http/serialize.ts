// Response money format: every whole-cents number keeps its cents and gets a "184.00" string next to it.
// `priceCents: 18400` -> also `price: "184.00"`; a bare `cents` -> also `amount`. Dates become ISO strings.

import { isCents, toPayPal } from "../money.js";

function usdKey(key: string): string | null {
  if (key === "cents") return "amount";
  const m = /^(.+)Cents$/.exec(key);
  return m ? m[1]! : null;
}

export function withUsd(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(withUsd);
  if (value === null || typeof value !== "object") return value;
  const src = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(src)) {
    out[k] = withUsd(v);
    const target = usdKey(k);
    // Never overwrite a real field of the same name.
    if (target === null || target in src || target in out) continue;
    if (v === null) out[target] = null;
    else if (isCents(v)) out[target] = toPayPal(v);
  }
  return out;
}
