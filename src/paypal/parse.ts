// Reads PayPal JSON into the few fields we keep. Ids come from the body, never from `links`
// (finding 6: after reauthorize the `links` still point to the old id). Payer data (name, e-mail,
// address, payer_id) is never copied out of a response.

import { fromPayPalAmount } from "../money.js";

export class PayPalParseError extends Error {
  override name = "PayPalParseError";
}

export type PaymentSourceKind = "paypal" | "card" | "unknown";

export interface ParsedAuthorization {
  id: string;
  status: string;
  amountCents: number;
  expirationTime: Date | null;
  createTime: Date | null;
  /** supplementary_data.related_ids.order_id, or the order the authorization was read from. */
  orderId: string | null;
}

export interface ParsedCapture {
  id: string;
  status: string;
  /** null when the amount could not be read; the caller then trusts the amount it asked for. */
  amountCents: number | null;
  finalCapture: boolean | null;
  feeCents: number | null;
  netCents: number | null;
  /** From the capture's `up` link when present (captures listed inside an order). */
  authorizationId: string | null;
}

export interface ParsedOrder {
  id: string;
  status: string;
  amountCents: number | null;
  /** The `payer-action` link the customer opens to approve. */
  approveUrl: string | null;
  paymentSource: PaymentSourceKind;
  authorizations: ParsedAuthorization[];
  captures: ParsedCapture[];
}

type Obj = Record<string, unknown>;

function obj(v: unknown): Obj | undefined {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function date(v: unknown): Date | null {
  if (typeof v !== "string") return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function required(o: Obj, key: string, what: string): string {
  const v = str(o[key]);
  if (!v) throw new PayPalParseError(`${what}: missing ${key}`);
  return v;
}

function lenientCents(v: unknown): number | null {
  try {
    return fromPayPalAmount(v);
  } catch {
    return null;
  }
}

const AUTH_UP = /\/v2\/payments\/authorizations\/([A-Za-z0-9]+)$/;

function upAuthorizationId(links: unknown): string | null {
  if (!Array.isArray(links)) return null;
  for (const l of links) {
    const link = obj(l);
    if (link?.rel === "up" && typeof link.href === "string") {
      const m = AUTH_UP.exec(link.href);
      if (m) return m[1]!;
    }
  }
  return null;
}

export function parseAuthorization(raw: unknown, orderId: string | null = null): ParsedAuthorization {
  const o = obj(raw);
  if (!o) throw new PayPalParseError("authorization: not an object");
  let amountCents: number;
  try {
    amountCents = fromPayPalAmount(o.amount);
  } catch (e) {
    throw new PayPalParseError(`authorization: ${(e as Error).message}`);
  }
  const related = obj(obj(obj(o.supplementary_data)?.related_ids));
  return {
    id: required(o, "id", "authorization"),
    status: required(o, "status", "authorization"),
    amountCents,
    expirationTime: date(o.expiration_time),
    createTime: date(o.create_time),
    orderId: str(related?.order_id) ?? orderId,
  };
}

/**
 * A capture that PayPal accepted must never be lost because a side field is odd: only id and status are
 * required; amount, fee and net become null when unreadable.
 */
export function parseCapture(raw: unknown): ParsedCapture {
  const o = obj(raw);
  if (!o) throw new PayPalParseError("capture: not an object");
  const breakdown = obj(o.seller_receivable_breakdown);
  return {
    id: required(o, "id", "capture"),
    status: required(o, "status", "capture"),
    amountCents: lenientCents(o.amount),
    finalCapture: typeof o.final_capture === "boolean" ? o.final_capture : null,
    feeCents: breakdown ? lenientCents(breakdown.paypal_fee) : null,
    netCents: breakdown ? lenientCents(breakdown.net_amount) : null,
    authorizationId: upAuthorizationId(o.links),
  };
}

export function paymentSourceKind(raw: unknown): PaymentSourceKind {
  const ps = obj(raw);
  if (!ps) return "unknown";
  if (obj(ps.paypal)) return "paypal";
  if (obj(ps.card)) return "card";
  return "unknown";
}

export function parseOrder(raw: unknown): ParsedOrder {
  const o = obj(raw);
  if (!o) throw new PayPalParseError("order: not an object");
  const id = required(o, "id", "order");
  const units = Array.isArray(o.purchase_units) ? o.purchase_units : [];
  const unit = obj(units[0]);
  const payments = obj(unit?.payments);
  const auths = Array.isArray(payments?.authorizations) ? payments.authorizations : [];
  const caps = Array.isArray(payments?.captures) ? payments.captures : [];
  let approveUrl: string | null = null;
  if (Array.isArray(o.links)) {
    for (const l of o.links) {
      const link = obj(l);
      if ((link?.rel === "payer-action" || link?.rel === "approve") && typeof link.href === "string") {
        approveUrl = link.href;
        break;
      }
    }
  }
  return {
    id,
    status: required(o, "status", "order"),
    amountCents: unit ? lenientCents(unit.amount) : null,
    approveUrl,
    paymentSource: paymentSourceKind(o.payment_source),
    authorizations: auths.map((a) => parseAuthorization(a, id)),
    captures: caps.map((c) => parseCapture(c)),
  };
}
