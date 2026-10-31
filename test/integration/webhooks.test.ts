import { afterEach, describe, expect, it, vi } from "vitest";
import { addLine, createEstimateOrder, decide, getRepairOrder, pickup } from "../../src/core/index.js";
import type { Db } from "../../src/db/db.js";
import { MAX_WEBHOOK_ATTEMPTS, WEBHOOK_STALE_MS } from "../../src/webhooks/paypal.js";
import { approvedEstimate, call, CONSENT, estimateRo, makeAppEnv, PUBLIC_BASE, WEBHOOK_ID, type AppEnv } from "../helpers.js";

const HEADERS = {
  "paypal-auth-algo": "SHA256withRSA",
  "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-placeholder",
  "paypal-transmission-id": "transmission-placeholder-1",
  "paypal-transmission-sig": "signature-placeholder==",
  "paypal-transmission-time": "2026-11-02T15:00:00Z",
};

const VERIFY = "/v1/notifications/verify-webhook-signature";

function event(id: string, type: string, resource: Record<string, unknown>): string {
  return JSON.stringify({ id, event_version: "1.0", create_time: "2026-11-02T15:00:05.000Z", resource_type: "x", event_type: type, summary: "placeholder", resource });
}

function deliver(t: AppEnv, raw: string, headers: Record<string, string> = HEADERS) {
  return call(t.app, "POST", "/api/webhooks/paypal", raw, { "content-type": "application/json", ...headers });
}

async function eventRow(db: Db, id: string) {
  return (await db.query<{ verified: boolean; processed_at: Date | null; outcome: string | null; resource_id: string | null; event_type: string }>(`SELECT * FROM webhook_events WHERE id = $1`, [id])).rows[0];
}

/** Everything except the webhook table and the call journal (a verify call is journaled). */
async function businessTables(db: Db): Promise<string> {
  const out: Record<string, unknown> = {};
  for (const t of ["repair_orders", "lines", "consents", "paypal_orders", "authorizations", "captures", "ops"]) out[t] = (await db.query(`SELECT * FROM ${t} ORDER BY 1`)).rows;
  return JSON.stringify(out);
}

/** Estimate approved, one partial pickup: an authorization, a capture, a void. */
async function withCapture(t: AppEnv) {
  const est = await approvedEstimate(t);
  const r = await pickup(t.deps, est.ro.id, [{ lineId: est.lines[0]!.id, performedCents: 26800 }]);
  const captureId = (r.authorizations[0]!.executed.find((s) => s.kind === "capture") as { captureId: string }).captureId;
  return { ...est, captureId };
}

afterEach(() => vi.restoreAllMocks());

describe("webhook route: verification and dedup", () => {
  it("signature not SUCCESS -> 400, recorded verified=false, nothing else changes", async () => {
    const t = await makeAppEnv();
    const { authorization } = await approvedEstimate(t);
    const before = await businessTables(t.db);
    t.fake.verifyStatus = "FAILURE";
    const r = await deliver(t, event("WH-EVT-1", "PAYMENT.AUTHORIZATION.VOIDED", { id: authorization.id, status: "VOIDED" }));
    expect(r.status).toBe(400);
    expect(r.json).toEqual({ error: "webhook signature not verified", code: "BAD_SIGNATURE" });
    await t.webhooks.idle();
    expect(await businessTables(t.db)).toBe(before);
    expect(await eventRow(t.db, "WH-EVT-1")).toMatchObject({ verified: false, processed_at: null, event_type: "PAYMENT.AUTHORIZATION.VOIDED" });
    expect(t.fake.posts(VERIFY)).toHaveLength(1);
  });

  it("missing PayPal headers -> 400 without calling PayPal; not JSON -> 400 and no record", async () => {
    const t = await makeAppEnv();
    const noHeaders = await deliver(t, event("WH-EVT-2", "PAYMENT.CAPTURE.COMPLETED", { id: "CAP1" }), {});
    expect(noHeaders.status).toBe(400);
    expect(noHeaders.json.code).toBe("BAD_SIGNATURE");
    expect(t.fake.posts(VERIFY)).toHaveLength(0);
    expect(await eventRow(t.db, "WH-EVT-2")).toMatchObject({ verified: false });

    const notJson = await deliver(t, "{not json");
    expect(notJson.status).toBe(400);
    expect(notJson.json.code).toBe("BAD_WEBHOOK");
    const noId = await deliver(t, JSON.stringify({ event_type: "PAYMENT.CAPTURE.COMPLETED" }));
    expect(noId.status).toBe(400);
    expect((await t.db.query(`SELECT id FROM webhook_events`)).rows).toEqual([{ id: "WH-EVT-2" }]);
  });

  it("without PAYPAL_WEBHOOK_ID the route answers 503 and accepts nothing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const t = await makeAppEnv({ webhookId: null });
    const r = await deliver(t, event("WH-EVT-3", "PAYMENT.CAPTURE.COMPLETED", { id: "CAP1" }));
    expect(r.status).toBe(503);
    expect(r.json.code).toBe("WEBHOOK_NOT_CONFIGURED");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("PAYPAL_WEBHOOK_ID"));
    expect(t.fake.posts(VERIFY)).toHaveLength(0);
    expect((await t.db.query(`SELECT id FROM webhook_events`)).rows).toEqual([]);
  });

  it("puts the raw body into verify-webhook-signature byte for byte", async () => {
    const t = await makeAppEnv();
    // Spacing, key order and 1.0 would all change if the event were parsed and serialized again.
    const raw = `{ "event_type" : "PAYMENT.CAPTURE.COMPLETED",\n  "id":"WH-EVT-4", "resource": {"id":"CAP1", "amount": {"value": "1.50"}}, "n": 1.0 }`;
    const r = await deliver(t, raw);
    expect(r.status).toBe(200);
    const sent = t.fake.posts(VERIFY)[0]!;
    expect(sent.body).toBe(
      `{"auth_algo":"${HEADERS["paypal-auth-algo"]}","cert_url":"${HEADERS["paypal-cert-url"]}","transmission_id":"${HEADERS["paypal-transmission-id"]}","transmission_sig":"${HEADERS["paypal-transmission-sig"]}","transmission_time":"${HEADERS["paypal-transmission-time"]}","webhook_id":"${WEBHOOK_ID}","webhook_event":${raw}}`,
    );
    expect(sent.headers["PayPal-Request-Id"]).toBeUndefined();
  });

  it("a repeated event id is processed once", async () => {
    const t = await makeAppEnv();
    const { ro } = await estimateRo(t);
    const { order } = await createEstimateOrder(t.deps, ro.id, CONSENT);
    t.fake.approve(order.id);
    const raw = event("WH-EVT-5", "CHECKOUT.ORDER.APPROVED", { id: order.id, status: "APPROVED" });
    const first = await deliver(t, raw);
    expect(first).toMatchObject({ status: 200, json: { received: true, duplicate: false } });
    await t.webhooks.idle();
    const row = await eventRow(t.db, "WH-EVT-5");
    expect(row).toMatchObject({ verified: true, resource_id: order.id });
    expect(row!.outcome).toMatch(/^authorized /);
    const second = await deliver(t, raw);
    expect(second).toMatchObject({ status: 200, json: { received: true, duplicate: true } });
    await t.webhooks.idle();
    expect(t.fake.posts(VERIFY)).toHaveLength(1);
    expect(t.fake.posts(`/v2/checkout/orders/${order.id}/authorize`)).toHaveLength(1);
    expect((await eventRow(t.db, "WH-EVT-5"))!.processed_at!.getTime()).toBe(row!.processed_at!.getTime());
  });

  it("an event refused once (bad signature) is accepted when a verified copy comes", async () => {
    const t = await makeAppEnv();
    const { authorization } = await approvedEstimate(t);
    const raw = event("WH-EVT-6", "PAYMENT.AUTHORIZATION.CREATED", { id: authorization.id, status: "CREATED" });
    t.fake.verifyStatus = "FAILURE";
    expect((await deliver(t, raw)).status).toBe(400);
    t.fake.verifyStatus = "SUCCESS";
    expect((await deliver(t, raw)).json).toEqual({ received: true, duplicate: false });
    await t.webhooks.idle();
    expect(await eventRow(t.db, "WH-EVT-6")).toMatchObject({ verified: true, outcome: `authorization ${authorization.id} confirmed` });
  });

  it("no verdict from PayPal (network) -> 502, nothing recorded, so PayPal sends it again", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const t = await makeAppEnv();
    t.fake.script((c) => c.path === VERIFY, { kind: "network" }, 4);
    const r = await deliver(t, event("WH-EVT-7", "PAYMENT.CAPTURE.COMPLETED", { id: "CAP1" }));
    expect(r.status).toBe(502);
    expect(r.json.code).toBe("PAYPAL");
    expect(err).toHaveBeenCalled();
    expect((await t.db.query(`SELECT id FROM webhook_events`)).rows).toEqual([]);
  });
});

describe("webhook processing (second layer)", () => {
  it("CHECKOUT.ORDER.APPROVED authorizes when the return redirect never came; the late return does not authorize again", async () => {
    const t = await makeAppEnv();
    const { ro } = await approvedEstimate(t);
    const rotor = await addLine(t.deps, ro.id, { title: "Front brake rotors", priceCents: 18600, source: "mechanic" });
    const { order } = await decide(t.deps, ro.id, { approve: [rotor.id], ...CONSENT });
    t.fake.approve(order!.id);
    await deliver(t, event("WH-EVT-10", "CHECKOUT.ORDER.APPROVED", { id: order!.id, status: "APPROVED" }));
    await t.webhooks.idle();
    const state = await getRepairOrder(t.deps, ro.id);
    expect(state.lines.find((l) => l.id === rotor.id)!.status).toBe("approved");
    const auth = state.authorizations.find((a) => a.paypalOrderId === order!.id)!;
    expect((await eventRow(t.db, "WH-EVT-10"))!.outcome).toBe(`authorized ${auth.id}`);

    const back = await call(t.app, "GET", `/api/paypal/return?token=${order!.id}`);
    expect(back.status).toBe(303);
    expect(back.headers.get("location")).toBe(`${PUBLIC_BASE}/c/${ro.id}?paypal=approved&order=${order!.id}`);
    expect(t.fake.posts(`/v2/checkout/orders/${order!.id}/authorize`)).toHaveLength(1);

    // Another delivery of the same news under a new event id: no new authorize.
    await deliver(t, event("WH-EVT-11", "CHECKOUT.ORDER.APPROVED", { id: order!.id }));
    await t.webhooks.idle();
    expect((await eventRow(t.db, "WH-EVT-11"))!.outcome).toBe(`already authorized (${auth.id})`);
    expect(t.fake.posts(`/v2/checkout/orders/${order!.id}/authorize`)).toHaveLength(1);
  });

  it("an approval PayPal does not confirm is recorded as not authorized; unknown orders are ignored", async () => {
    const t = await makeAppEnv();
    const { ro } = await estimateRo(t);
    const { order } = await createEstimateOrder(t.deps, ro.id, CONSENT);
    await deliver(t, event("WH-EVT-12", "CHECKOUT.ORDER.APPROVED", { id: order.id }));
    await deliver(t, event("WH-EVT-13", "CHECKOUT.ORDER.APPROVED", { id: "NOTOURORDER123" }));
    await t.webhooks.idle();
    expect((await eventRow(t.db, "WH-EVT-12"))!.outcome).toMatch(/^not authorized: PAYPAL .*ORDER_NOT_APPROVED/);
    expect((await eventRow(t.db, "WH-EVT-13"))!.outcome).toBe("ignored: not our order");
    expect((await getRepairOrder(t.deps, ro.id)).authorizations).toEqual([]);
  });

  it("PAYMENT.AUTHORIZATION.CREATED only confirms; VOIDED writes the status", async () => {
    const t = await makeAppEnv();
    const { ro, lines, authorization } = await approvedEstimate(t);
    await pickup(t.deps, ro.id, [{ lineId: lines[0]!.id, performedCents: 26800 }]);
    // pickup voided the rest and read VOIDED live; pretend our row was still behind
    await t.db.query(`UPDATE authorizations SET status = 'PARTIALLY_CAPTURED' WHERE id = $1`, [authorization.id]);
    await deliver(t, event("WH-EVT-20", "PAYMENT.AUTHORIZATION.CREATED", { id: authorization.id, status: "CREATED" }));
    await t.webhooks.idle();
    let a = (await getRepairOrder(t.deps, ro.id)).authorizations[0]!;
    expect(a.status).toBe("PARTIALLY_CAPTURED");
    expect(a.confirmedAt).toEqual(t.clock.now());
    await deliver(t, event("WH-EVT-21", "PAYMENT.AUTHORIZATION.VOIDED", { id: authorization.id, status: "VOIDED" }));
    await deliver(t, event("WH-EVT-22", "PAYMENT.AUTHORIZATION.VOIDED", { id: "UNKNOWNAUTH123" }));
    await t.webhooks.idle();
    a = (await getRepairOrder(t.deps, ro.id)).authorizations[0]!;
    expect(a.status).toBe("VOIDED");
    expect((await eventRow(t.db, "WH-EVT-22"))!.outcome).toBe("ignored: unknown authorization");
  });

  it("capture events confirm, move statuses forward only, and handle refunds and reversals", async () => {
    const t = await makeAppEnv();
    const { ro, captureId } = await withCapture(t);
    const cap = async () => (await getRepairOrder(t.deps, ro.id)).captures.find((c) => c.id === captureId)!;
    expect((await cap()).confirmedAt).toBeNull();

    await deliver(t, event("WH-EVT-30", "PAYMENT.CAPTURE.COMPLETED", { id: captureId, status: "COMPLETED" }));
    await t.webhooks.idle();
    expect(await cap()).toMatchObject({ status: "COMPLETED", confirmedAt: t.clock.now() });

    t.clock.advance(60_000);
    await deliver(t, event("WH-EVT-31", "PAYMENT.CAPTURE.PENDING", { id: captureId, status: "PENDING" }));
    await t.webhooks.idle();
    expect((await eventRow(t.db, "WH-EVT-31"))!.outcome).toMatch(/^stale: /);
    expect((await cap()).status).toBe("COMPLETED");

    const refund = (id: string, value: string, total: string) => ({
      id,
      status: "COMPLETED",
      amount: { currency_code: "USD", value },
      seller_payable_breakdown: { total_refunded_amount: { currency_code: "USD", value: total } },
      links: [
        { href: `https://api.sandbox.paypal.com/v2/payments/refunds/${id}`, rel: "self", method: "GET" },
        { href: `https://api.sandbox.paypal.com/v2/payments/captures/${captureId}`, rel: "up", method: "GET" },
      ],
    });
    await deliver(t, event("WH-EVT-32", "PAYMENT.CAPTURE.REFUNDED", refund("REFUND1", "10.00", "10.00")));
    await t.webhooks.idle();
    expect((await cap()).status).toBe("PARTIALLY_REFUNDED");
    await deliver(t, event("WH-EVT-33", "PAYMENT.CAPTURE.REFUNDED", refund("REFUND2", "258.00", "268.00")));
    await t.webhooks.idle();
    expect((await cap()).status).toBe("REFUNDED");
    // Money columns are never touched by a webhook.
    expect((await getRepairOrder(t.deps, ro.id)).authorizations[0]!.capturedCents).toBe(26800);

    await deliver(t, event("WH-EVT-34", "PAYMENT.CAPTURE.DECLINED", { id: "UNKNOWNCAP123" }));
    await deliver(t, event("WH-EVT-35", "CUSTOMER.DISPUTE.CREATED", { id: "PP-D-1", buyer: "placeholder" }));
    await t.webhooks.idle();
    expect((await eventRow(t.db, "WH-EVT-34"))!.outcome).toBe("ignored: unknown capture");
    expect(await eventRow(t.db, "WH-EVT-35")).toMatchObject({ outcome: "ignored: CUSTOMER.DISPUTE.CREATED is not handled", resource_id: null });
  });

  it("a reversal moves the capture to REVERSED", async () => {
    const t = await makeAppEnv();
    const { ro, captureId } = await withCapture(t);
    await deliver(t, event("WH-EVT-40", "PAYMENT.CAPTURE.REVERSED", { id: captureId, status: "REVERSED" }));
    await t.webhooks.idle();
    expect((await getRepairOrder(t.deps, ro.id)).captures[0]!.status).toBe("REVERSED");
  });
});

describe("webhook retries: an event is done only once it was processed", () => {
  /** An estimate order the payer approved, whose return redirect never reached us. */
  async function approvedWithoutReturn(t: AppEnv) {
    const { ro } = await estimateRo(t);
    const { order } = await createEstimateOrder(t.deps, ro.id, CONSENT);
    t.fake.approve(order.id);
    return { ro, order };
  }

  it("PayPal 503 while authorizing: kept open; a redelivery processes it and the hold is recorded", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const t = await makeAppEnv();
    const { ro, order } = await approvedWithoutReturn(t);
    t.fake.script((c) => c.method === "POST" && c.path.endsWith("/authorize"), { kind: "respond", status: 503, body: { name: "SERVICE_UNAVAILABLE" } }, 4);
    const raw = event("WH-EVT-50", "CHECKOUT.ORDER.APPROVED", { id: order.id, status: "APPROVED" });
    expect((await deliver(t, raw)).json).toEqual({ received: true, duplicate: false });
    await t.webhooks.idle();
    expect(await eventRow(t.db, "WH-EVT-50")).toMatchObject({ verified: true, processed_at: null, outcome: expect.stringMatching(/^retry: not authorized yet: PAYPAL .*503/) });

    const again = await deliver(t, raw);
    expect(again.json).toEqual({ received: true, duplicate: false });
    await t.webhooks.idle();
    const row = await eventRow(t.db, "WH-EVT-50");
    const auth = (await getRepairOrder(t.deps, ro.id)).authorizations[0]!;
    expect(auth.amountCents).toBe(41200);
    expect(row).toMatchObject({ outcome: `authorized ${auth.id}` });
    expect(row!.processed_at).not.toBeNull();
    // Done now: a third copy is a duplicate.
    expect((await deliver(t, raw)).json).toEqual({ received: true, duplicate: true });
  });

  it("the return redirect is authorizing at the same moment (IN_PROGRESS): kept open, the sweep finishes it", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const t = await makeAppEnv();
    const { order } = await approvedWithoutReturn(t);
    const at = t.clock.now().toISOString();
    await t.db.query(`INSERT INTO ops (request_id, op, entity_id, state, result, created_at, updated_at) VALUES ($1, 'authorize', $2, 'started', $3::jsonb, $4, $4)`, [
      `lbl:authorize:${order.id}:1`,
      order.id,
      JSON.stringify({ intent: { orderId: order.id } }),
      at,
    ]);
    await deliver(t, event("WH-EVT-51", "CHECKOUT.ORDER.APPROVED", { id: order.id }));
    await t.webhooks.idle();
    expect((await eventRow(t.db, "WH-EVT-51"))!.outcome).toMatch(/^retry: not authorized yet: IN_PROGRESS/);
    // That redirect died: after the stale time its operation may be taken over, and the sweep authorizes.
    t.clock.advance(WEBHOOK_STALE_MS);
    expect(await t.webhooks.retryPending()).toBe(1);
    await t.webhooks.idle();
    expect((await eventRow(t.db, "WH-EVT-51"))!.outcome).toMatch(/^authorized /);
    expect(await t.webhooks.retryPending()).toBe(0);
  });

  it("processing cut off after the 200 (process died): a fresh claim is a duplicate, a stale one is taken over", async () => {
    const t = await makeAppEnv();
    const { order } = await approvedWithoutReturn(t);
    const raw = event("WH-EVT-52", "CHECKOUT.ORDER.APPROVED", { id: order.id });
    const at = t.clock.now().toISOString();
    await t.db.query(`INSERT INTO webhook_events (id, event_type, resource_id, verified, received_at, claimed_at, attempts) VALUES ($1, 'CHECKOUT.ORDER.APPROVED', $2, true, $3, $3, 1)`, [
      "WH-EVT-52",
      order.id,
      at,
    ]);
    expect((await deliver(t, raw)).json).toEqual({ received: true, duplicate: true }); // may still be running
    expect(t.fake.posts(VERIFY)).toHaveLength(0);
    t.clock.advance(WEBHOOK_STALE_MS);
    expect((await deliver(t, raw)).json).toEqual({ received: true, duplicate: false });
    await t.webhooks.idle();
    expect(await eventRow(t.db, "WH-EVT-52")).toMatchObject({ outcome: expect.stringMatching(/^authorized /) });
    expect(t.fake.posts(`/v2/checkout/orders/${order.id}/authorize`)).toHaveLength(1);
  });

  it("gives up after the attempt cap; a definite refusal is not retried at all", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const t = await makeAppEnv();
    const { order } = await approvedWithoutReturn(t);
    t.fake.script((c) => c.method === "POST" && c.path.endsWith("/authorize"), { kind: "respond", status: 503, body: { name: "SERVICE_UNAVAILABLE" } }, 1000);
    await deliver(t, event("WH-EVT-53", "CHECKOUT.ORDER.APPROVED", { id: order.id }));
    await t.webhooks.idle();
    for (let i = 1; i < MAX_WEBHOOK_ATTEMPTS; i++) {
      expect(await t.webhooks.retryPending()).toBe(1);
      await t.webhooks.idle();
    }
    const row = await eventRow(t.db, "WH-EVT-53");
    expect(row!.outcome).toMatch(new RegExp(`^gave up after ${MAX_WEBHOOK_ATTEMPTS} attempts: not authorized yet: PAYPAL`));
    expect(row!.processed_at).not.toBeNull();
    expect(await t.webhooks.retryPending()).toBe(0);

    const other = await makeAppEnv();
    const { order: notApproved } = await approvedWithoutReturn(other);
    other.fake.orders.get(notApproved.id)!.status = "PAYER_ACTION_REQUIRED";
    await deliver(other, event("WH-EVT-54", "CHECKOUT.ORDER.APPROVED", { id: notApproved.id }));
    await other.webhooks.idle();
    expect(await eventRow(other.db, "WH-EVT-54")).toMatchObject({ outcome: expect.stringMatching(/^not authorized: PAYPAL .*ORDER_NOT_APPROVED/) });
    expect((await eventRow(other.db, "WH-EVT-54"))!.processed_at).not.toBeNull();
    expect(await other.webhooks.retryPending()).toBe(0);
  });
});
