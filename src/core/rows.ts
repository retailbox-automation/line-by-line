// Row shapes as the service functions return them (camelCase). SQL column lists live next to them.

import type { Queryable } from "../db/db.js";
import { CoreError } from "./errors.js";

export type LineKind = "estimate" | "added";
export type LineStatus = "proposed" | "sent" | "approved" | "declined" | "performed" | "not_performed";
export type Urgency = "safety" | "soon" | "can_wait";
export type LineSource = "desk" | "mechanic";
export type Channel = "qr_page" | "link" | "desk";
export type PaymentSource = "paypal" | "card" | "unknown";

export interface RepairOrder {
  id: string;
  customerLabel: string;
  state: string;
  status: "open" | "picked_up";
  /** `pool`: made by scripts/seed-pool.ts around an aged hold for the judges. */
  kind: "shop" | "pool";
  createdAt: Date;
}

export interface Line {
  id: string;
  roId: string;
  kind: LineKind;
  title: string;
  description: string;
  priceCents: number;
  urgency: Urgency | null;
  source: LineSource;
  status: LineStatus;
  performedCents: number | null;
  /** Price-list code when the line came from the list (its price and title are the list's). */
  priceCode: string | null;
  createdAt: Date;
}

export interface Consent {
  id: string;
  roId: string;
  lineId: string;
  decision: "approved" | "declined";
  decidedAt: Date;
  channel: Channel;
  approverName: string;
  esignConsent: boolean;
  disclosureVersion: string;
  amountCents: number;
  newTotalCents: number;
  paypalOrderId: string | null;
  paypalAuthorizationId: string | null;
  /** Fla. Stat. 559.905(2): the statement the customer checked (null: not asked, older record, desk). */
  flChoice: "written" | "limit" | "none" | null;
  flLimitCents: number | null;
}

export interface PaypalOrder {
  id: string;
  roId: string;
  purpose: LineKind;
  lineIds: string[];
  amountCents: number;
  status: string;
  approveUrl: string | null;
  requestId: string;
  attempt: number;
  supersededBy: string | null;
  createdAt: Date;
}

export interface Authorization {
  id: string;
  paypalOrderId: string;
  roId: string;
  parentId: string | null;
  amountCents: number;
  capturedCents: number;
  status: string;
  paymentSource: PaymentSource;
  expirationTime: Date | null;
  createdAt: Date;
  reauthorizedTo: string | null;
  reauthorizedAt: Date | null;
  needsAttention: string | null;
  confirmedAt: Date | null;
}

export interface Capture {
  id: string;
  authorizationId: string;
  amountCents: number;
  finalCapture: boolean;
  status: string;
  feeCents: number | null;
  netCents: number | null;
  requestId: string;
  createdAt: Date;
  confirmedAt: Date | null;
}

export const RO_COLS = `id, customer_label AS "customerLabel", state, status, kind, created_at AS "createdAt"`;
export const LINE_COLS = `id, ro_id AS "roId", kind, title, description, price_cents AS "priceCents", urgency, source, status,
  performed_cents AS "performedCents", price_code AS "priceCode", created_at AS "createdAt"`;
export const CONSENT_COLS = `id, ro_id AS "roId", line_id AS "lineId", decision, decided_at AS "decidedAt", channel,
  approver_name AS "approverName", esign_consent AS "esignConsent", disclosure_version AS "disclosureVersion",
  amount_cents AS "amountCents", new_total_cents AS "newTotalCents", paypal_order_id AS "paypalOrderId",
  paypal_authorization_id AS "paypalAuthorizationId", fl_choice AS "flChoice", fl_limit_cents AS "flLimitCents"`;
export const ORDER_COLS = `id, ro_id AS "roId", purpose, line_ids AS "lineIds", amount_cents AS "amountCents", status,
  approve_url AS "approveUrl", request_id AS "requestId", attempt, superseded_by AS "supersededBy", created_at AS "createdAt"`;
export const AUTH_COLS = `id, paypal_order_id AS "paypalOrderId", ro_id AS "roId", parent_id AS "parentId",
  amount_cents AS "amountCents", captured_cents AS "capturedCents", status, payment_source AS "paymentSource",
  expiration_time AS "expirationTime", created_at AS "createdAt", reauthorized_to AS "reauthorizedTo",
  reauthorized_at AS "reauthorizedAt", needs_attention AS "needsAttention", confirmed_at AS "confirmedAt"`;
export const CAPTURE_COLS = `id, authorization_id AS "authorizationId", amount_cents AS "amountCents",
  final_capture AS "finalCapture", status, fee_cents AS "feeCents", net_cents AS "netCents", request_id AS "requestId",
  created_at AS "createdAt", confirmed_at AS "confirmedAt"`;

/** Order statuses that still hold or may still hold the lines (not cancelled, not replaced). */
export const ACTIVE_ORDER_SQL = `superseded_by IS NULL AND status <> 'CANCELLED'`;

export async function loadRepairOrder(q: Queryable, roId: string, forUpdate = false): Promise<RepairOrder> {
  const r = await q.query<RepairOrder>(`SELECT ${RO_COLS} FROM repair_orders WHERE id = $1${forUpdate ? " FOR UPDATE" : ""}`, [roId]);
  const ro = r.rows[0];
  if (!ro) throw new CoreError("NOT_FOUND", `repair order ${roId} not found`, { roId });
  return ro;
}

export async function loadOrder(q: Queryable, orderId: string, forUpdate = false): Promise<PaypalOrder> {
  const r = await q.query<PaypalOrder>(`SELECT ${ORDER_COLS} FROM paypal_orders WHERE id = $1${forUpdate ? " FOR UPDATE" : ""}`, [orderId]);
  const o = r.rows[0];
  if (!o) throw new CoreError("NOT_FOUND", `PayPal order ${orderId} is not one of ours`, { orderId });
  return o;
}

export async function loadAuthorization(q: Queryable, id: string): Promise<Authorization> {
  const r = await q.query<Authorization>(`SELECT ${AUTH_COLS} FROM authorizations WHERE id = $1`, [id]);
  const a = r.rows[0];
  if (!a) throw new CoreError("NOT_FOUND", `authorization ${id} not found`, { authorizationId: id });
  return a;
}
