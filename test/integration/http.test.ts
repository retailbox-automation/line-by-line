import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/http/app.js";
import { createWebhookReceiver } from "../../src/webhooks/paypal.js";
import { PAYER, PAYER_MARKERS } from "../fake-paypal.js";
import { call, CONSENT, JOB_TOKEN, makeAppEnv, PUBLIC_BASE, type AppEnv, type Reply } from "../helpers.js";

const DAY = 24 * 60 * 60 * 1000;

const NEW_RO = {
  customerLabel: "Dana Demo (made-up)",
  estimateLines: [
    { title: "Front brake pads", priceCents: 26800, source: "desk", urgency: "safety" },
    { title: "Brake fluid flush", priceCents: 14400, source: "desk", urgency: "soon" },
  ],
};

async function newRo(t: AppEnv) {
  const r = await call(t.app, "POST", "/api/ro", NEW_RO);
  expect(r.status).toBe(201);
  return { roId: r.json.repairOrder.id as string, lineIds: (r.json.lines as { id: string }[]).map((l) => l.id), body: r.json };
}

/** Estimate approved over HTTP (approval link, PayPal approval in the fake, return redirect). */
async function approvedRo(t: AppEnv) {
  const ro = await newRo(t);
  const a = await call(t.app, "POST", `/api/ro/${ro.roId}/estimate/approval`, CONSENT);
  t.fake.approve(a.json.order.id);
  const back = await call(t.app, "GET", `/api/paypal/return?token=${a.json.order.id}`);
  expect(back.status).toBe(303);
  const state = await call(t.app, "GET", `/api/ro/${ro.roId}`);
  return { ...ro, orderId: a.json.order.id as string, authId: state.json.authorizations[0].id as string };
}

function expectError(r: Reply, status: number, code: string) {
  expect(r.status).toBe(status);
  expect(r.json).toMatchObject({ code, error: expect.any(String) });
}

afterEach(() => vi.restoreAllMocks());

describe("HTTP API: the demo story", () => {
  it("estimate -> decision -> return -> pickup -> live check; money as cents and strings; no payer data", async () => {
    const t = await makeAppEnv();
    const replies: Reply[] = [];
    const go = async (method: string, path: string, body?: unknown) => {
      const r = await call(t.app, method, path, body);
      replies.push(r);
      return r;
    };

    const created = await go("POST", "/api/ro", NEW_RO);
    expect(created.status).toBe(201);
    const roId = created.json.repairOrder.id as string;
    const [pads, flush] = created.json.lines as { id: string }[];
    expect(created.json.lines[0]).toMatchObject({ title: "Front brake pads", priceCents: 26800, price: "268.00", status: "proposed", kind: "estimate" });
    expect(created.json.fl).toMatchObject({
      estimateCents: 41200,
      estimate: "412.00",
      estimateRequired: true,
      approvedTotalCents: 0,
      toleranceCents: 4120,
      tolerance: "41.20",
      ceilingCents: 45320,
      ceiling: "453.20",
      newLineNeedsConsent: true,
    });

    const approval = await go("POST", `/api/ro/${roId}/estimate/approval`, CONSENT);
    expect(approval.status).toBe(201);
    expect(approval.json).toMatchObject({ created: true, order: { amountCents: 41200, amount: "412.00", purpose: "estimate" } });
    const estOrder = approval.json.order.id as string;
    expect(approval.json.approveUrl).toBe(`https://www.sandbox.paypal.com/checkoutnow?token=${estOrder}`);
    const again = await go("POST", `/api/ro/${roId}/estimate/approval`, CONSENT);
    expect(again.status).toBe(200);
    expect(again.json).toMatchObject({ created: false, order: { id: estOrder } });

    t.fake.approve(estOrder);
    // PayPal adds the payer id to the return URL; it must not travel any further.
    const back = await go("GET", `/api/paypal/return?token=${estOrder}&PayerID=${PAYER.payerId}`);
    expect(back.status).toBe(303);
    expect(back.headers.get("location")).toBe(`${PUBLIC_BASE}/c/${roId}?paypal=approved&order=${estOrder}`);

    const rotor = await go("POST", `/api/ro/${roId}/lines`, { title: "Front brake rotors", priceCents: 18600, urgency: "safety", source: "mechanic" });
    expect(rotor.status).toBe(201);
    expect(rotor.json.line).toMatchObject({ kind: "added", price: "186.00", status: "proposed" });
    t.clock.advance(1000); // lines are listed in creation order
    const filter = await go("POST", `/api/ro/${roId}/lines`, { title: "Cabin air filter", priceCents: 3900, urgency: "can_wait", source: "mechanic" });
    const pending = await go("GET", `/api/ro/${roId}`);
    expect(pending.json.fl).toMatchObject({ approvedTotalCents: 41200, toleranceCents: 4120, pendingTotalCents: 22500, pendingExceedsTolerance: true });
    expect(pending.json.fl.pendingLines).toEqual([
      { lineId: rotor.json.line.id, exceedsTolerance: true },
      { lineId: filter.json.line.id, exceedsTolerance: false },
    ]);

    const d = await go("POST", `/api/ro/${roId}/decisions`, { approve: [rotor.json.line.id], decline: [filter.json.line.id], ...CONSENT });
    expect(d.status).toBe(200);
    expect(d.json).toMatchObject({ declined: [filter.json.line.id], order: { amountCents: 18600, amount: "186.00", lineIds: [rotor.json.line.id] } });
    expect(d.json.approveUrl).toContain(d.json.order.id);
    t.fake.approve(d.json.order.id);
    expect((await go("GET", `/api/paypal/return?token=${d.json.order.id}`)).status).toBe(303);

    const state = await go("GET", `/api/ro/${roId}`);
    expect(state.status).toBe(200);
    expect(state.json.lines.map((l: { status: string }) => l.status)).toEqual(["approved", "approved", "approved", "declined"]);
    expect(state.json.authorizations).toHaveLength(2);
    expect(state.json.consents.find((c: { lineId: string }) => c.lineId === filter.json.line.id)).toMatchObject({ decision: "declined", paypalOrderId: null });
    expect(state.json.fl).toMatchObject({ approvedTotalCents: 59800, approvedTotal: "598.00", pendingLines: [] });
    const estAuth = state.json.authorizations.find((a: { paypalOrderId: string }) => a.paypalOrderId === estOrder).id as string;

    const body = { performed: [{ lineId: pads!.id, performedCents: 26800 }, { lineId: flush!.id, performedCents: 13000 }, { lineId: rotor.json.line.id, performedCents: 18600 }] };
    const p = await go("POST", `/api/ro/${roId}/pickup`, body);
    expect(p.status).toBe(200);
    const est = p.json.authorizations.find((a: { authorizationId: string }) => a.authorizationId === estAuth);
    expect(est).toMatchObject({ outcome: "done", billableCents: 39800, billable: "398.00", plan: [{ kind: "capture", cents: 39800, amount: "398.00", finalCapture: false }, { kind: "void" }] });
    expect(est.executed[0]).toMatchObject({ kind: "capture", cents: 39800, amount: "398.00", feeCents: expect.any(Number), fee: expect.stringMatching(/^\d+\.\d\d$/) });
    // A repeated pickup (double click) captures nothing new.
    const captures = t.fake.posts("/capture").length;
    const p2 = await go("POST", `/api/ro/${roId}/pickup`, body);
    expect(p2.status).toBe(200);
    expect(t.fake.posts("/capture")).toHaveLength(captures);

    const live = await go("GET", `/api/authorizations/${estAuth}`);
    expect(live.status).toBe(200);
    expect(live.json).toMatchObject({ ok: true, diffs: [], live: { status: "VOIDED", capturedCents: 39800, captured: "398.00" }, authorization: { id: estAuth, status: "VOIDED" } });

    for (const r of replies) {
      for (const m of PAYER_MARKERS) expect(r.text + (r.headers.get("location") ?? "")).not.toContain(m);
    }
  });
});

describe("HTTP API: each route, success and error", () => {
  it("GET /healthz: 200, and 503 when the database is down", async () => {
    const t = await makeAppEnv();
    expect(await call(t.app, "GET", "/healthz")).toMatchObject({ status: 200, json: { ok: true } });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const broken = { ...t.deps, db: { ...t.db, query: async () => Promise.reject(new Error("connection refused")) } };
    const app = createApp({ deps: broken, publicBaseUrl: PUBLIC_BASE, jobToken: JOB_TOKEN, webhooks: createWebhookReceiver(broken, undefined) });
    expectError(await call(app, "GET", "/healthz"), 503, "UNAVAILABLE");
  });

  it("POST /api/ro: validation, bad JSON, wrong media type", async () => {
    const t = await makeAppEnv();
    const empty = await call(t.app, "POST", "/api/ro", { customerLabel: "X", estimateLines: [] });
    expectError(empty, 400, "VALIDATION");
    expect(empty.json.details.issues[0].path).toBe("estimateLines");
    expectError(await call(t.app, "POST", "/api/ro", { ...NEW_RO, estimateLines: [{ title: "Pads", priceCents: 12.5, source: "desk" }] }), 400, "VALIDATION");
    expectError(await call(t.app, "POST", "/api/ro", "{oops", { "content-type": "application/json" }), 400, "VALIDATION");
    expectError(await call(t.app, "POST", "/api/ro", JSON.stringify(NEW_RO), { "content-type": "text/plain" }), 415, "UNSUPPORTED_MEDIA_TYPE");
    expectError(await call(t.app, "POST", "/api/ro", JSON.stringify(NEW_RO)), 415, "UNSUPPORTED_MEDIA_TYPE");
  });

  it("GET /api/ro/:id: 404 for an unknown id, 400 for a malformed one", async () => {
    const t = await makeAppEnv();
    expectError(await call(t.app, "GET", "/api/ro/ro_doesnotexist"), 404, "NOT_FOUND");
    expectError(await call(t.app, "GET", "/api/ro/bad%20id%21"), 400, "VALIDATION");
  });

  it("POST /api/ro/:id/estimate/approval: phone approval needs e-records consent; unknown repair order", async () => {
    const t = await makeAppEnv();
    const { roId } = await newRo(t);
    expectError(await call(t.app, "POST", `/api/ro/${roId}/estimate/approval`, { ...CONSENT, esignConsent: false }), 400, "VALIDATION");
    expectError(await call(t.app, "POST", `/api/ro/ro_missing/estimate/approval`, CONSENT), 404, "NOT_FOUND");
    expect(t.fake.posts("/v2/checkout/orders")).toHaveLength(0);
  });

  it("POST /api/ro/:id/lines: zero price refused; no new lines after pickup", async () => {
    const t = await makeAppEnv();
    const { roId, lineIds } = await approvedRo(t);
    expectError(await call(t.app, "POST", `/api/ro/${roId}/lines`, { title: "Wipers", priceCents: 0, source: "desk" }), 400, "VALIDATION");
    await call(t.app, "POST", `/api/ro/${roId}/pickup`, { performed: lineIds.map((lineId) => ({ lineId, performedCents: 100 })) });
    expectError(await call(t.app, "POST", `/api/ro/${roId}/lines`, { title: "Wipers", priceCents: 2500, source: "desk" }), 409, "CONFLICT");
  });

  it("POST /api/ro/:id/decisions: a second decision on the same line is refused; estimate lines are not decided here", async () => {
    const t = await makeAppEnv();
    const { roId, lineIds } = await approvedRo(t);
    const line = await call(t.app, "POST", `/api/ro/${roId}/lines`, { title: "Cabin air filter", priceCents: 3900, source: "mechanic" });
    expect((await call(t.app, "POST", `/api/ro/${roId}/decisions`, { decline: [line.json.line.id], ...CONSENT })).json).toEqual({ declined: [line.json.line.id], order: null, approveUrl: null });
    expectError(await call(t.app, "POST", `/api/ro/${roId}/decisions`, { approve: [line.json.line.id], ...CONSENT }), 409, "CONFLICT");
    expectError(await call(t.app, "POST", `/api/ro/${roId}/decisions`, { approve: [lineIds[0]], ...CONSENT }), 400, "VALIDATION");
    expectError(await call(t.app, "POST", `/api/ro/${roId}/decisions`, { ...CONSENT }), 400, "VALIDATION");
  });

  it("POST /api/orders/:orderId/refresh: fresh link kept, expired link replaced, unknown order 404", async () => {
    const t = await makeAppEnv();
    const { roId } = await newRo(t);
    const a = await call(t.app, "POST", `/api/ro/${roId}/estimate/approval`, CONSENT);
    const fresh = await call(t.app, "POST", `/api/orders/${a.json.order.id}/refresh`);
    expect(fresh).toMatchObject({ status: 200, json: { refreshed: false, order: { id: a.json.order.id } } });
    t.clock.advance(3 * 60 * 60 * 1000 + 1000);
    const renewed = await call(t.app, "POST", `/api/orders/${a.json.order.id}/refresh`);
    expect(renewed.json.refreshed).toBe(true);
    expect(renewed.json.order.id).not.toBe(a.json.order.id);
    expect(renewed.json.approveUrl).toContain(renewed.json.order.id);
    const old = (await call(t.app, "GET", `/api/ro/${roId}`)).json.orders.find((o: { id: string }) => o.id === a.json.order.id);
    expect(old.supersededBy).toBe(renewed.json.order.id);
    expectError(await call(t.app, "POST", `/api/orders/NOTOURS123/refresh`), 404, "NOT_FOUND");
  });

  it("GET /api/paypal/return: missing token 400, unknown order 404, PayPal refusal and a running authorize redirect with a status", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const t = await makeAppEnv();
    expectError(await call(t.app, "GET", "/api/paypal/return"), 400, "VALIDATION");
    expectError(await call(t.app, "GET", "/api/paypal/return?token=NOTOURS123"), 404, "NOT_FOUND");
    const { roId } = await newRo(t);
    const a = await call(t.app, "POST", `/api/ro/${roId}/estimate/approval`, CONSENT);
    const orderId = a.json.order.id as string;
    // Not approved at PayPal: authorize is refused (ORDER_NOT_APPROVED).
    const refused = await call(t.app, "GET", `/api/paypal/return?token=${orderId}`);
    expect(refused.status).toBe(303);
    expect(refused.headers.get("location")).toBe(`${PUBLIC_BASE}/c/${roId}?paypal=error&order=${orderId}&code=PAYPAL`);
    // The same authorize is running right now (a webhook took it): pending.
    t.fake.approve(orderId);
    const at = t.clock.now().toISOString();
    await t.db.query(`INSERT INTO ops (request_id, op, entity_id, state, result, created_at, updated_at) VALUES ($1, 'authorize', $2, 'started', $3::jsonb, $4, $4)`, [
      `lbl:authorize:${orderId}:2`,
      orderId,
      JSON.stringify({ intent: { orderId } }),
      at,
    ]);
    const pending = await call(t.app, "GET", `/api/paypal/return?token=${orderId}`);
    expect(pending.headers.get("location")).toBe(`${PUBLIC_BASE}/c/${roId}?paypal=pending&order=${orderId}`);
  });

  it("GET /api/paypal/cancel: lines go back to sent; missing token 400; an authorized order is not cancelled", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const t = await makeAppEnv();
    expectError(await call(t.app, "GET", "/api/paypal/cancel"), 400, "VALIDATION");
    const { roId, orderId } = await approvedRo(t);
    const line = await call(t.app, "POST", `/api/ro/${roId}/lines`, { title: "Front brake rotors", priceCents: 18600, source: "mechanic" });
    const d = await call(t.app, "POST", `/api/ro/${roId}/decisions`, { approve: [line.json.line.id], ...CONSENT });
    const r = await call(t.app, "GET", `/api/paypal/cancel?token=${d.json.order.id}`);
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe(`${PUBLIC_BASE}/c/${roId}?paypal=cancelled&order=${d.json.order.id}`);
    const state = (await call(t.app, "GET", `/api/ro/${roId}`)).json;
    expect(state.lines.find((l: { id: string }) => l.id === line.json.line.id).status).toBe("sent");
    expect(state.orders.find((o: { id: string }) => o.id === d.json.order.id).status).toBe("CANCELLED");
    const late = await call(t.app, "GET", `/api/paypal/cancel?token=${orderId}`);
    expect(late.headers.get("location")).toBe(`${PUBLIC_BASE}/c/${roId}?paypal=error&order=${orderId}&code=CONFLICT`);
  });

  it("POST /api/ro/:id/pickup: unknown line 404, bad bodies 400", async () => {
    const t = await makeAppEnv();
    const { roId, lineIds } = await approvedRo(t);
    expectError(await call(t.app, "POST", `/api/ro/${roId}/pickup`, { performed: [{ lineId: "ln_nope", performedCents: 100 }] }), 404, "NOT_FOUND");
    expectError(await call(t.app, "POST", `/api/ro/${roId}/pickup`, {}), 400, "VALIDATION");
    expectError(await call(t.app, "POST", `/api/ro/${roId}/pickup`, { performed: [{ lineId: lineIds[0], performedCents: -1 }] }), 400, "VALIDATION");
    expectError(await call(t.app, "POST", `/api/ro/${roId}/pickup`, [{ lineId: lineIds[0], performedCents: 100 }]), 400, "VALIDATION");
    expect(t.fake.posts("/capture")).toHaveLength(0);
  });

  it("GET /api/authorizations/:id: unknown 404; PayPal not answering 502", async () => {
    const t = await makeAppEnv();
    const { authId } = await approvedRo(t);
    expectError(await call(t.app, "GET", `/api/authorizations/NOTOURS123`), 404, "NOT_FOUND");
    t.fake.script((c) => c.method === "GET" && c.path.startsWith("/v2/payments/authorizations/"), { kind: "network" }, 4);
    const r = await call(t.app, "GET", `/api/authorizations/${authId}`);
    expectError(r, 502, "PAYPAL");
  });

  it("POST /api/jobs/reauthorize: 401 without or with a wrong token, runs with the right one, 503 when not configured", async () => {
    const t = await makeAppEnv();
    const { authId } = await approvedRo(t);
    const none = await call(t.app, "POST", "/api/jobs/reauthorize");
    expectError(none, 401, "UNAUTHORIZED");
    expect(none.headers.get("www-authenticate")).toBe("Bearer");
    expectError(await call(t.app, "POST", "/api/jobs/reauthorize", undefined, { authorization: `Bearer ${JOB_TOKEN}x` }), 401, "UNAUTHORIZED");
    expectError(await call(t.app, "POST", "/api/jobs/reauthorize", undefined, { authorization: JOB_TOKEN }), 401, "UNAUTHORIZED");
    expect(t.fake.posts("/reauthorize")).toHaveLength(0);

    t.clock.advance(4 * DAY + 11 * 60 * 1000);
    const ok = await call(t.app, "POST", "/api/jobs/reauthorize", undefined, { authorization: `Bearer ${JOB_TOKEN}` });
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ reauthorized: [{ parentId: authId, amountCents: 41200, amount: "412.00" }], skipped: [], askCustomer: [] });

    const off = await makeAppEnv({ jobToken: null });
    expectError(await call(off.app, "POST", "/api/jobs/reauthorize", undefined, { authorization: `Bearer ${JOB_TOKEN}` }), 503, "JOB_DISABLED");
  });

  it("unknown routes are JSON 404; oversized bodies are 413", async () => {
    const t = await makeAppEnv();
    expectError(await call(t.app, "GET", "/api/nothing-here"), 404, "NOT_FOUND");
    const big = JSON.stringify({ customerLabel: "x".repeat(300 * 1024), estimateLines: [] });
    expectError(await call(t.app, "POST", "/api/ro", big, { "content-type": "application/json" }), 413, "TOO_LARGE");
  });
});
