// PayPal webhooks: the SECOND layer only. Money moves on API answers and live GETs; a webhook can arrive minutes
// to hours late (PayPal: "usually within 30 mins, but can be up to 3 hours"), so it only confirms statuses and,
// for CHECKOUT.ORDER.APPROVED, authorizes an order whose return redirect never reached us (idempotently).
//
// The raw body goes to verify-webhook-signature byte for byte. Nothing changes unless PayPal says SUCCESS.

import { CoreError } from "../core/errors.js";
import { onApproved } from "../core/orders.js";
import type { CoreDeps } from "../core/deps.js";
import { fromPayPalAmount } from "../money.js";
import { describeError } from "../paypal/errors.js";

/** The event types we subscribe to and act on. */
export const WEBHOOK_EVENT_TYPES = [
  "CHECKOUT.ORDER.APPROVED",
  "PAYMENT.AUTHORIZATION.CREATED",
  "PAYMENT.AUTHORIZATION.VOIDED",
  "PAYMENT.CAPTURE.COMPLETED",
  "PAYMENT.CAPTURE.DECLINED",
  "PAYMENT.CAPTURE.PENDING",
  "PAYMENT.CAPTURE.REFUNDED",
  "PAYMENT.CAPTURE.REVERSED",
] as const;

const HANDLED = new Set<string>(WEBHOOK_EVENT_TYPES);
const EVENT_ID = /^[A-Za-z0-9_-]{1,128}$/;
const EVENT_TYPE = /^[A-Z0-9_.-]{1,128}$/;
const RESOURCE_ID = /^[A-Za-z0-9-]{1,64}$/;
const CAPTURE_UP = /\/v2\/payments\/captures\/([A-Za-z0-9]+)$/;

export interface WebhookResponse {
  status: 200 | 400 | 502 | 503;
  body: Record<string, unknown>;
}

export interface WebhookReceiver {
  receive(rawBody: string, headers: Record<string, string | undefined>): Promise<WebhookResponse>;
  /** Resolves when every event accepted so far has been processed (tests, graceful shutdown). */
  idle(): Promise<void>;
}

type Obj = Record<string, unknown>;

function obj(v: unknown): Obj | undefined {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : undefined;
}

function resourceIdOf(event: Obj): string | null {
  const id = obj(event.resource)?.id;
  return typeof id === "string" && RESOURCE_ID.test(id) ? id : null;
}

function clip(s: string, max = 500): string {
  return s.length <= max ? s : `${s.slice(0, max - 3)}...`;
}

/**
 * `webhookId` is PAYPAL_WEBHOOK_ID. Without it the route answers 503: an event we cannot verify is never accepted.
 */
export function createWebhookReceiver(deps: CoreDeps, webhookId: string | undefined): WebhookReceiver {
  const inflight = new Set<Promise<void>>();
  let warned = false;

  async function processAndRecord(eventId: string, event: Obj): Promise<void> {
    let outcome: string;
    try {
      outcome = await processEvent(deps, event);
    } catch (e) {
      outcome = `error: ${describeError(e)}`;
      console.error(`webhook ${eventId} failed: ${describeError(e)}`);
    }
    try {
      await deps.db.query(`UPDATE webhook_events SET processed_at = $2::timestamptz, outcome = $3 WHERE id = $1`, [eventId, deps.now().toISOString(), clip(outcome)]);
    } catch (e) {
      console.error(`webhook ${eventId}: could not record the outcome: ${describeError(e)}`);
    }
  }

  return {
    async receive(rawBody, headers) {
      if (!webhookId) {
        if (!warned) console.warn("PAYPAL_WEBHOOK_ID is not set: PayPal webhooks are refused with 503");
        warned = true;
        return { status: 503, body: { error: "webhooks are not configured (PAYPAL_WEBHOOK_ID is not set)", code: "WEBHOOK_NOT_CONFIGURED" } };
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawBody);
      } catch {
        return { status: 400, body: { error: "webhook body is not JSON", code: "BAD_WEBHOOK" } };
      }
      const event = obj(parsed);
      if (!event || typeof event.id !== "string" || !EVENT_ID.test(event.id) || typeof event.event_type !== "string" || !EVENT_TYPE.test(event.event_type)) {
        return { status: 400, body: { error: "webhook body has no valid id or event_type", code: "BAD_WEBHOOK" } };
      }
      const eventId = event.id;
      const eventType = event.event_type;
      // Only ids of the resources we handle (orders, authorizations, captures, refunds) are kept.
      const resourceId = HANDLED.has(eventType) ? resourceIdOf(event) : null;

      const seen = await deps.db.query<{ verified: boolean }>(`SELECT verified FROM webhook_events WHERE id = $1`, [eventId]);
      if (seen.rows[0]?.verified) return { status: 200, body: { received: true, duplicate: true } };

      let verified: boolean;
      try {
        // verified live: pending — a real sandbox delivery checked with PAYPAL_WEBHOOK_ID (simulator events never verify).
        verified = await deps.paypal.verifyWebhookSignature({ headers, rawBody, webhookId });
      } catch (e) {
        // No verdict from PayPal: answer 5xx so PayPal delivers the event again later.
        console.error(`webhook ${eventId}: signature check did not complete: ${describeError(e)}`);
        return { status: 502, body: { error: "could not verify the webhook signature with PayPal", code: "PAYPAL" } };
      }
      const at = deps.now().toISOString();
      if (!verified) {
        await deps.db.query(
          `INSERT INTO webhook_events (id, event_type, resource_id, verified, received_at, outcome)
           VALUES ($1, $2, $3, false, $4::timestamptz, 'signature not verified') ON CONFLICT (id) DO NOTHING`,
          [eventId, eventType, resourceId, at],
        );
        return { status: 400, body: { error: "webhook signature not verified", code: "BAD_SIGNATURE" } };
      }
      // A row left by an unverified copy is taken over; a verified row means a duplicate (also under concurrency).
      const claimed = await deps.db.query(
        `INSERT INTO webhook_events (id, event_type, resource_id, verified, received_at) VALUES ($1, $2, $3, true, $4::timestamptz)
         ON CONFLICT (id) DO UPDATE SET verified = true, event_type = EXCLUDED.event_type, resource_id = EXCLUDED.resource_id,
                                        received_at = EXCLUDED.received_at, outcome = NULL
         WHERE webhook_events.verified = false RETURNING id`,
        [eventId, eventType, resourceId, at],
      );
      if (!claimed.rows.length) return { status: 200, body: { received: true, duplicate: true } };

      // Answer at once; process in the background.
      const p = processAndRecord(eventId, event).finally(() => inflight.delete(p));
      inflight.add(p);
      return { status: 200, body: { received: true, duplicate: false } };
    },

    async idle() {
      while (inflight.size) await Promise.allSettled([...inflight]);
    },
  };
}

/** Acts on one verified event and returns a short outcome for `webhook_events.outcome`. */
export async function processEvent(deps: CoreDeps, event: Obj): Promise<string> {
  const type = String(event.event_type);
  if (!HANDLED.has(type)) return `ignored: ${type} is not handled`;
  const resource = obj(event.resource) ?? {};
  const id = resourceIdOf(event);
  if (!id) return "ignored: no resource id";
  switch (type) {
    case "CHECKOUT.ORDER.APPROVED":
      return orderApproved(deps, id);
    case "PAYMENT.AUTHORIZATION.CREATED":
      return authorizationEvent(deps, id, null);
    case "PAYMENT.AUTHORIZATION.VOIDED":
      return authorizationEvent(deps, id, "VOIDED");
    case "PAYMENT.CAPTURE.COMPLETED":
    case "PAYMENT.CAPTURE.DECLINED":
    case "PAYMENT.CAPTURE.PENDING":
      return setCaptureStatus(deps, id, type.slice("PAYMENT.CAPTURE.".length));
    default:
      return refundEvent(deps, resource, id, type === "PAYMENT.CAPTURE.REVERSED");
  }
}

async function orderApproved(deps: CoreDeps, orderId: string): Promise<string> {
  const order = (await deps.db.query<{ id: string }>(`SELECT id FROM paypal_orders WHERE id = $1`, [orderId])).rows[0];
  if (!order) return "ignored: not our order";
  const auth = (await deps.db.query<{ id: string }>(`SELECT id FROM authorizations WHERE paypal_order_id = $1 AND parent_id IS NULL LIMIT 1`, [orderId])).rows[0];
  if (auth) return `already authorized (${auth.id})`;
  try {
    const r = await onApproved(deps, orderId);
    return r.replayed ? `already authorized (${r.authorization.id})` : `authorized ${r.authorization.id}`;
  } catch (e) {
    if (e instanceof CoreError) return `not authorized: ${e.code} ${e.message}`;
    throw e;
  }
}

/** CREATED only confirms (our status may already be further along); VOIDED is final and is written. */
async function authorizationEvent(deps: CoreDeps, id: string, status: "VOIDED" | null): Promise<string> {
  const at = deps.now().toISOString();
  const r = status
    ? await deps.db.query(`UPDATE authorizations SET status = $2, confirmed_at = $3::timestamptz WHERE id = $1 RETURNING id`, [id, status, at])
    : await deps.db.query(`UPDATE authorizations SET confirmed_at = $2::timestamptz WHERE id = $1 RETURNING id`, [id, at]);
  if (!r.rows.length) return "ignored: unknown authorization";
  return status ? `authorization ${id} ${status}, confirmed` : `authorization ${id} confirmed`;
}

// Events can arrive out of order: a status only moves forward.
const CAPTURE_RANK: Record<string, number> = { PENDING: 1, COMPLETED: 2, DECLINED: 2, FAILED: 2, PARTIALLY_REFUNDED: 3, REFUNDED: 4, REVERSED: 4 };

async function setCaptureStatus(deps: CoreDeps, captureId: string, status: string): Promise<string> {
  const cur = (await deps.db.query<{ status: string }>(`SELECT status FROM captures WHERE id = $1`, [captureId])).rows[0];
  if (!cur) return "ignored: unknown capture";
  const at = deps.now().toISOString();
  if (cur.status === status) {
    await deps.db.query(`UPDATE captures SET confirmed_at = $2::timestamptz WHERE id = $1`, [captureId, at]);
    return `capture ${captureId} ${status}, confirmed`;
  }
  if ((CAPTURE_RANK[status] ?? 0) > (CAPTURE_RANK[cur.status] ?? 0)) {
    await deps.db.query(`UPDATE captures SET status = $2, confirmed_at = $3::timestamptz WHERE id = $1`, [captureId, status, at]);
    return `capture ${captureId} ${cur.status} -> ${status}, confirmed`;
  }
  return `stale: capture ${captureId} is already ${cur.status}, event says ${status}`;
}

function lenientCents(v: unknown): number | null {
  try {
    return fromPayPalAmount(v);
  } catch {
    return null;
  }
}

/**
 * REFUNDED / REVERSED: the resource is usually the refund, linked to its capture by `rel: up`; when it is the capture
 * itself, its own status is used.
 */
async function refundEvent(deps: CoreDeps, resource: Obj, resourceId: string, reversed: boolean): Promise<string> {
  // verified live: pending — the REFUNDED/REVERSED resource shape (refund with rel:up to the capture) is from the docs.
  let captureId: string | null = null;
  for (const l of Array.isArray(resource.links) ? resource.links : []) {
    const link = obj(l);
    const m = link?.rel === "up" && typeof link.href === "string" ? CAPTURE_UP.exec(link.href) : null;
    if (m) captureId = m[1]!;
  }
  if (reversed) return setCaptureStatus(deps, captureId ?? resourceId, "REVERSED");
  if (!captureId) {
    const own = typeof resource.status === "string" && ["REFUNDED", "PARTIALLY_REFUNDED"].includes(resource.status) ? resource.status : "REFUNDED";
    return setCaptureStatus(deps, resourceId, own);
  }
  const cap = (await deps.db.query<{ amount_cents: number }>(`SELECT amount_cents FROM captures WHERE id = $1`, [captureId])).rows[0];
  if (!cap) return "ignored: unknown capture";
  const refunded = lenientCents(obj(resource.seller_payable_breakdown)?.total_refunded_amount) ?? lenientCents(resource.amount);
  return setCaptureStatus(deps, captureId, refunded !== null && refunded < cap.amount_cents ? "PARTIALLY_REFUNDED" : "REFUNDED");
}
