import { describe, expect, it } from "vitest";
import { createPayPalClient, PayPalNetworkError, type FetchLike } from "./client.js";
import { GuardError, PayPalError } from "./errors.js";
import type { CallRecord } from "./journal.js";

type Call = { url: string; method: string; headers: Record<string, string>; body?: string | undefined };
const json = (status: number, body: unknown) => new Response(body === null ? "" : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const AUTH = { id: "A1", status: "CREATED", amount: { currency_code: "USD", value: "50.00" }, expiration_time: "2026-11-18T04:09:32Z", create_time: "2026-10-20T04:09:31Z" };
const CAPTURE = { id: "C1", status: "COMPLETED", amount: { currency_code: "USD", value: "31.20" }, final_capture: false, seller_receivable_breakdown: { paypal_fee: { currency_code: "USD", value: "1.58" }, net_amount: { currency_code: "USD", value: "29.62" } } };

function stub(handler: (c: Call, n: number, signal?: AbortSignal) => Response | Promise<Response>, o: { expiresIn?: number } = {}) {
  const calls: Call[] = [];
  const records: CallRecord[] = [];
  let tokens = 0;
  let clock = Date.parse("2026-11-02T15:00:00Z");
  const fetch: FetchLike = async (url, init) => {
    const c: Call = { url, method: init.method, headers: init.headers, body: init.body };
    calls.push(c);
    if (url.endsWith("/v1/oauth2/token")) return json(200, { access_token: `t${++tokens}`, token_type: "Bearer", expires_in: o.expiresIn ?? 32400 });
    return handler(c, calls.filter((x) => !x.url.endsWith("/v1/oauth2/token")).length, init.signal);
  };
  const pp = createPayPalClient({ clientId: "cid", clientSecret: "csecret", brandName: "Line by Line demo shop", fetch, retryDelayMs: 0, timeoutMs: 50, now: () => clock, onCall: (r) => void records.push(r) });
  return {
    pp,
    calls,
    records,
    api: () => calls.filter((c) => !c.url.endsWith("/v1/oauth2/token")),
    tokenCalls: () => calls.filter((c) => c.url.endsWith("/v1/oauth2/token")).length,
    advance: (ms: number) => (clock += ms),
  };
}

const hang = (signal?: AbortSignal) => new Promise<Response>((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason)));

describe("guards before the network", () => {
  it("refuses a non-sandbox origin", () => {
    for (const baseUrl of ["https://api-m.paypal.com", "https://api.paypal.com", "http://localhost:8080", "not a url"]) {
      expect(() => createPayPalClient({ clientId: "c", clientSecret: "s", brandName: "b", baseUrl })).toThrow(GuardError);
    }
    expect(() => createPayPalClient({ clientId: "c", clientSecret: "s", brandName: "b", baseUrl: "https://api-m.sandbox.paypal.com" })).not.toThrow();
  });

  it("refuses missing credentials", () => {
    expect(() => createPayPalClient({ clientId: "", clientSecret: "s", brandName: "b" })).toThrow(GuardError);
  });

  it("every money POST needs a PayPal-Request-Id", async () => {
    const s = stub(() => json(201, CAPTURE));
    await expect(s.pp.captureAuthorization({ authorizationId: "A1", requestId: "", cents: 100, finalCapture: false })).rejects.toBeInstanceOf(GuardError);
    await expect(s.pp.voidAuthorization({ authorizationId: "A1", requestId: undefined as unknown as string })).rejects.toBeInstanceOf(GuardError);
    await expect(s.pp.reauthorize({ authorizationId: "A1", requestId: "", cents: 100 })).rejects.toBeInstanceOf(GuardError);
    await expect(s.pp.authorizeOrder({ orderId: "O1", requestId: "" })).rejects.toBeInstanceOf(GuardError);
    await expect(s.pp.createWebhook({ url: "https://x.example/h", eventTypes: [], requestId: "" })).rejects.toBeInstanceOf(GuardError);
    expect(s.calls).toHaveLength(0);
  });

  for (const bad of ["lbl capture 1", "заказ-1", "x".repeat(109), "tab\there"]) {
    it(`refuses request id ${JSON.stringify(bad.slice(0, 14))}`, async () => {
      const s = stub(() => json(200, AUTH));
      await expect(s.pp.voidAuthorization({ authorizationId: "A1", requestId: bad })).rejects.toBeInstanceOf(GuardError);
      expect(s.calls).toHaveLength(0);
    });
  }

  it("accepts a 108-character request id", async () => {
    const s = stub(() => json(200, AUTH));
    await expect(s.pp.voidAuthorization({ authorizationId: "A1", requestId: "x".repeat(108) })).resolves.toMatchObject({ id: "A1" });
  });

  it("refuses ids that could change the path", async () => {
    const s = stub(() => json(200, AUTH));
    for (const id of ["../orders", "A1/void", "A1?x=1", ""]) await expect(s.pp.getAuthorization(id)).rejects.toBeInstanceOf(GuardError);
    expect(s.calls).toHaveLength(0);
  });

  it("refuses bad capture amounts without calling PayPal", async () => {
    const s = stub(() => json(201, CAPTURE));
    for (const cents of [0, -1, 1.5, Number.NaN]) {
      await expect(s.pp.captureAuthorization({ authorizationId: "A1", requestId: "r1", cents, finalCapture: false })).rejects.toThrow();
    }
    expect(s.calls).toHaveLength(0);
  });
});

describe("retries keep the same PayPal-Request-Id and body", () => {
  it("503 then 201", async () => {
    const s = stub((c, n) => (n === 1 ? json(503, { name: "SERVICE_UNAVAILABLE" }) : json(201, CAPTURE)));
    await expect(s.pp.captureAuthorization({ authorizationId: "A1", requestId: "lbl:capture:A1:1", cents: 3120, finalCapture: false })).resolves.toMatchObject({ id: "C1", feeCents: 158 });
    const posts = s.api();
    expect(posts).toHaveLength(2);
    expect(posts.map((p) => p.headers["PayPal-Request-Id"])).toEqual(["lbl:capture:A1:1", "lbl:capture:A1:1"]);
    expect(posts[0]!.body).toBe(posts[1]!.body);
    expect(JSON.parse(posts[0]!.body!)).toEqual({ amount: { currency_code: "USD", value: "31.20" }, final_capture: false });
  });

  it("network error, then timeout, then 429, then success", async () => {
    const s = stub((c, n, signal) => {
      if (n === 1) throw new TypeError("fetch failed");
      if (n === 2) return hang(signal);
      if (n === 3) return json(429, { name: "RATE_LIMIT_REACHED" });
      return json(201, CAPTURE);
    });
    await expect(s.pp.captureAuthorization({ authorizationId: "A1", requestId: "r-1", cents: 3120, finalCapture: false })).resolves.toMatchObject({ id: "C1" });
    expect(new Set(s.api().map((p) => p.headers["PayPal-Request-Id"]))).toEqual(new Set(["r-1"]));
    expect(s.records.filter((r) => r.op === "authorizations.capture").map((r) => r.issue ?? r.httpStatus)).toEqual(["NETWORK", "TIMEOUT", 429, 201]);
  });

  it("gives up after 3 retries with a network error (outcome unknown)", async () => {
    const s = stub(() => {
      throw new TypeError("fetch failed");
    });
    await expect(s.pp.getAuthorization("A1")).rejects.toBeInstanceOf(PayPalNetworkError);
    expect(s.api()).toHaveLength(4);
  });

  it("gives up after 3 retries on 5xx with the PayPal error", async () => {
    const s = stub(() => json(500, { name: "INTERNAL_SERVER_ERROR", debug_id: "dbg" }));
    await expect(s.pp.getAuthorization("A1")).rejects.toMatchObject({ httpStatus: 500, debugId: "dbg" });
    expect(s.api()).toHaveLength(4);
  });

  it("does not retry a 4xx", async () => {
    const s = stub(() => json(422, { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "MAX_CAPTURE_COUNT_EXCEEDED" }] }));
    await expect(s.pp.captureAuthorization({ authorizationId: "A1", requestId: "r1", cents: 1, finalCapture: false })).rejects.toMatchObject({ issue: "MAX_CAPTURE_COUNT_EXCEEDED" });
    expect(s.api()).toHaveLength(1);
  });
});

describe("OAuth token", () => {
  it("401 drops the token and retries once with a new one", async () => {
    const s = stub((c) => (c.headers.Authorization === "Bearer t1" ? json(401, { name: "AUTHENTICATION_FAILURE" }) : json(200, AUTH)));
    await expect(s.pp.getAuthorization("A1")).resolves.toMatchObject({ id: "A1" });
    expect(s.tokenCalls()).toBe(2);
  });

  it("a second 401 is reported, not looped", async () => {
    const s = stub(() => json(401, { name: "AUTHENTICATION_FAILURE" }));
    await expect(s.pp.getAuthorization("A1")).rejects.toMatchObject({ httpStatus: 401 });
    expect(s.tokenCalls()).toBe(2);
  });

  it("is cached, shared by parallel calls, and renewed 60 s before expiry", async () => {
    const s = stub(() => json(200, AUTH), { expiresIn: 3600 });
    await Promise.all([s.pp.getAuthorization("A1"), s.pp.getAuthorization("A2"), s.pp.getAuthorization("A3")]);
    expect(s.tokenCalls()).toBe(1);
    s.advance((3600 - 61) * 1000);
    await s.pp.getAuthorization("A1");
    expect(s.tokenCalls()).toBe(1);
    s.advance(2000);
    await s.pp.getAuthorization("A1");
    expect(s.tokenCalls()).toBe(2);
    const tokenCall = s.calls.find((c) => c.url.endsWith("/v1/oauth2/token"))!;
    expect(tokenCall.headers.Authorization).toBe(`Basic ${Buffer.from("cid:csecret").toString("base64")}`);
    expect(tokenCall.body).toBe("grant_type=client_credentials");
  });

  it("a failed token request is a PayPalError", async () => {
    const calls: string[] = [];
    const pp = createPayPalClient({
      clientId: "c",
      clientSecret: "s",
      brandName: "b",
      retryDelayMs: 0,
      fetch: async (url) => {
        calls.push(url);
        return json(401, { error: "invalid_client", error_description: "Client Authentication failed" });
      },
    });
    await expect(pp.getOrder("O1")).rejects.toBeInstanceOf(PayPalError);
    expect(calls).toHaveLength(1);
  });
});

describe("call journal", () => {
  it("records status, request id and resource id, never bodies, tokens or payer data", async () => {
    const order = {
      id: "O1",
      status: "COMPLETED",
      payment_source: { paypal: { email_address: "payer.placeholder@example.test", account_id: "PAYERPLACEHOLDER1", name: { given_name: "PlaceholderGiven" } } },
      purchase_units: [{ payments: { authorizations: [AUTH] } }],
      payer: { email_address: "payer.placeholder@example.test", payer_id: "PAYERPLACEHOLDER1" },
    };
    const s = stub(() => json(201, order));
    await s.pp.authorizeOrder({ orderId: "O1", requestId: "lbl:authorize:O1:1" });
    const text = JSON.stringify(s.records);
    for (const secret of ["payer.placeholder@example.test", "PAYERPLACEHOLDER1", "PlaceholderGiven", "t1", "csecret", "grant_type"]) expect(text).not.toContain(secret);
    const rec = s.records.find((r) => r.op === "orders.authorize")!;
    expect(rec).toMatchObject({ method: "POST", path: "/v2/checkout/orders/O1/authorize", requestId: "lbl:authorize:O1:1", httpStatus: 201, resourceId: "O1", issue: null });
    expect(Object.keys(rec).sort()).toEqual(["at", "debugId", "httpStatus", "issue", "method", "op", "path", "requestId", "resourceId"]);
  });

  it("records the issue and debug id of an error", async () => {
    const s = stub(
      () =>
        new Response(JSON.stringify({ name: "UNPROCESSABLE_ENTITY", debug_id: "f195459185888", details: [{ issue: "CANNOT_BE_VOIDED" }] }), {
          status: 422,
          headers: { "paypal-debug-id": "f195459185888" },
        }),
    );
    await expect(s.pp.voidAuthorization({ authorizationId: "2G84834775966423X", requestId: "lbl:void:2G84834775966423X:1" })).rejects.toMatchObject({ issue: "CANNOT_BE_VOIDED" });
    expect(s.records.at(-1)).toMatchObject({ httpStatus: 422, issue: "CANNOT_BE_VOIDED", debugId: "f195459185888", resourceId: "2G84834775966423X" });
  });

  it("a failing journal never breaks the call", async () => {
    const pp = createPayPalClient({
      clientId: "c",
      clientSecret: "s",
      brandName: "b",
      fetch: async (url) => (url.endsWith("/token") ? json(200, { access_token: "t", expires_in: 3600 }) : json(200, AUTH)),
      onCall: () => {
        throw new Error("journal down");
      },
    });
    const err = console.error;
    console.error = () => undefined;
    try {
      await expect(pp.getAuthorization("A1")).resolves.toMatchObject({ id: "A1" });
    } finally {
      console.error = err;
    }
  });
});

describe("operations", () => {
  const order = (n = 1) => ({ requestId: `lbl:order-add:ro_1.abc:${n}`, referenceId: "ro_1", customId: `lbl:order-add:ro_1.abc:${n}`, description: "Added work: rotors", items: [{ name: "Front brake rotors", unitCents: 18600, category: "PHYSICAL_GOODS" as const }, { name: "Shop supplies", unitCents: 1250, category: "PHYSICAL_GOODS" as const }], returnUrl: "https://lbl.example.test/r", cancelUrl: "https://lbl.example.test/c" });

  it("creates an AUTHORIZE order with items, item_total, NO_SHIPPING and CONTINUE by default", async () => {
    const s = stub(() => json(200, { id: "O1", status: "PAYER_ACTION_REQUIRED", links: [{ rel: "payer-action", href: "https://www.sandbox.paypal.com/checkoutnow?token=O1" }] }));
    await expect(s.pp.createAuthorizeOrder(order())).resolves.toMatchObject({ id: "O1", approveUrl: "https://www.sandbox.paypal.com/checkoutnow?token=O1" });
    await s.pp.createAuthorizeOrder({ ...order(2), userAction: "CONTINUE" });
    const posts = s.api();
    const b = JSON.parse(posts[0]!.body!);
    expect(b).toEqual({
      intent: "AUTHORIZE",
      purchase_units: [
        {
          reference_id: "ro_1",
          custom_id: "lbl:order-add:ro_1.abc:1",
          description: "Added work: rotors",
          amount: { currency_code: "USD", value: "198.50", breakdown: { item_total: { currency_code: "USD", value: "198.50" } } },
          items: [
            { name: "Front brake rotors", quantity: "1", unit_amount: { currency_code: "USD", value: "186.00" }, category: "PHYSICAL_GOODS" },
            { name: "Shop supplies", quantity: "1", unit_amount: { currency_code: "USD", value: "12.50" }, category: "PHYSICAL_GOODS" },
          ],
        },
      ],
      payment_source: { paypal: { experience_context: { user_action: "CONTINUE", shipping_preference: "NO_SHIPPING", brand_name: "Line by Line demo shop", return_url: "https://lbl.example.test/r", cancel_url: "https://lbl.example.test/c" } } },
    });
    expect(JSON.parse(posts[1]!.body!).payment_source.paypal.experience_context.user_action).toBe("CONTINUE");
    expect(posts[0]!.headers).toMatchObject({ Prefer: "return=representation", "PayPal-Request-Id": "lbl:order-add:ro_1.abc:1", "Content-Type": "application/json" });
  });

  it("refuses bad orders before the network", async () => {
    const s = stub(() => json(200, { id: "O1", status: "CREATED" }));
    await expect(s.pp.createAuthorizeOrder({ ...order(), items: [] })).rejects.toBeInstanceOf(GuardError);
    await expect(s.pp.createAuthorizeOrder({ ...order(), items: [{ name: "x", unitCents: 0, category: "PHYSICAL_GOODS" }] })).rejects.toBeInstanceOf(GuardError);
    await expect(s.pp.createAuthorizeOrder({ ...order(), items: [{ name: "x".repeat(128), unitCents: 100, category: "PHYSICAL_GOODS" }] })).rejects.toBeInstanceOf(GuardError);
    await expect(s.pp.createAuthorizeOrder({ ...order(), description: "x".repeat(128) })).rejects.toBeInstanceOf(GuardError);
    await expect(s.pp.createAuthorizeOrder({ ...order(), returnUrl: "javascript:alert(1)" })).rejects.toBeInstanceOf(GuardError);
    expect(s.calls).toHaveLength(0);
  });

  it("an authorize replay without the payments block reads the order", async () => {
    const s = stub((c) => (c.method === "POST" ? json(200, { id: "O1", status: "COMPLETED" }) : json(200, { id: "O1", status: "COMPLETED", purchase_units: [{ payments: { authorizations: [AUTH] } }] })));
    await expect(s.pp.authorizeOrder({ orderId: "O1", requestId: "r1" })).resolves.toMatchObject({ authorizations: [{ id: "A1" }] });
    expect(s.api().map((c) => c.method)).toEqual(["POST", "GET"]);
  });

  it("a reauthorize replay without the amount reads the NEW authorization", async () => {
    const s = stub((c) => (c.method === "POST" ? json(200, { id: "A2", status: "CREATED" }) : json(200, { ...AUTH, id: "A2" })));
    await expect(s.pp.reauthorize({ authorizationId: "A1", requestId: "lbl:reauth:A1:1", cents: 5000 })).resolves.toMatchObject({ id: "A2", amountCents: 5000 });
    expect(s.api().at(-1)!.url).toMatch(/\/v2\/payments\/authorizations\/A2$/);
    expect(JSON.parse(s.api()[0]!.body!)).toEqual({ amount: { currency_code: "USD", value: "50.00" } });
  });

  it("void returns null on an empty 2xx and the authorization otherwise", async () => {
    const s = stub((c, n) => (n === 1 ? new Response(null, { status: 204 }) : json(200, { ...AUTH, status: "VOIDED" })));
    await expect(s.pp.voidAuthorization({ authorizationId: "A1", requestId: "v1" })).resolves.toBeNull();
    await expect(s.pp.voidAuthorization({ authorizationId: "A1", requestId: "v2" })).resolves.toMatchObject({ status: "VOIDED" });
  });

  it("capture sends invoice_id only when given", async () => {
    const s = stub(() => json(201, CAPTURE));
    await s.pp.captureAuthorization({ authorizationId: "A1", requestId: "r1", cents: 3120, finalCapture: true, invoiceId: "RO-1" });
    expect(JSON.parse(s.api()[0]!.body!)).toEqual({ amount: { currency_code: "USD", value: "31.20" }, final_capture: true, invoice_id: "RO-1" });
  });

  it("a non-JSON 2xx is an error, not a silent success", async () => {
    const s = stub(() => new Response("<html>", { status: 200 }));
    await expect(s.pp.getOrder("O1")).rejects.toMatchObject({ httpStatus: 200, paypalName: "BAD_RESPONSE" });
  });
});

describe("webhooks", () => {
  const headers = {
    "PAYPAL-AUTH-ALGO": "SHA256withRSA",
    "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1",
    "paypal-transmission-id": "tid-1",
    "paypal-transmission-sig": "sig==",
    "paypal-transmission-time": "2026-11-02T15:00:00Z",
  };

  it("splices the raw event body byte for byte", async () => {
    const s = stub(() => json(200, { verification_status: "SUCCESS" }));
    const rawBody = '{ "id":"WH-1",  "event_type":"PAYMENT.CAPTURE.COMPLETED", "resource":{"amount":{"value":"1.10"}},"z":1,"a":"é\\u00e9" }';
    await expect(s.pp.verifyWebhookSignature({ headers, rawBody, webhookId: "WHID-1" })).resolves.toBe(true);
    const sent = s.api()[0]!;
    expect(sent.url).toBe("https://api-m.sandbox.paypal.com/v1/notifications/verify-webhook-signature");
    expect(sent.headers["PayPal-Request-Id"]).toBeUndefined();
    expect(sent.body).toBe(
      `{"auth_algo":"SHA256withRSA","cert_url":"https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1","transmission_id":"tid-1","transmission_sig":"sig==","transmission_time":"2026-11-02T15:00:00Z","webhook_id":"WHID-1","webhook_event":${rawBody}}`,
    );
  });

  it("is false without calling PayPal when a header is missing or the body is not JSON", async () => {
    const s = stub(() => json(200, { verification_status: "SUCCESS" }));
    const { "paypal-transmission-sig": _, ...missing } = headers;
    await expect(s.pp.verifyWebhookSignature({ headers: missing, rawBody: "{}", webhookId: "W" })).resolves.toBe(false);
    await expect(s.pp.verifyWebhookSignature({ headers, rawBody: "not json", webhookId: "W" })).resolves.toBe(false);
    await expect(s.pp.verifyWebhookSignature({ headers, rawBody: "{}", webhookId: "" })).resolves.toBe(false);
    expect(s.calls).toHaveLength(0);
  });

  it("is false when PayPal says FAILURE", async () => {
    const s = stub(() => json(200, { verification_status: "FAILURE" }));
    await expect(s.pp.verifyWebhookSignature({ headers, rawBody: "{}", webhookId: "W" })).resolves.toBe(false);
  });

  it("creates and lists webhooks", async () => {
    const s = stub((c) =>
      c.method === "POST" ? json(201, { id: "WH1", url: "https://x.example/h", event_types: [{ name: "PAYMENT.CAPTURE.COMPLETED" }] }) : json(200, { webhooks: [{ id: "WH1", url: "https://x.example/h", event_types: [{ name: "*" }] }] }),
    );
    await expect(s.pp.createWebhook({ url: "https://x.example/h", eventTypes: ["PAYMENT.CAPTURE.COMPLETED"], requestId: "lbl:webhook:1" })).resolves.toEqual({ id: "WH1", url: "https://x.example/h", eventTypes: ["PAYMENT.CAPTURE.COMPLETED"] });
    await expect(s.pp.listWebhooks()).resolves.toEqual([{ id: "WH1", url: "https://x.example/h", eventTypes: ["*"] }]);
    expect(JSON.parse(s.api()[0]!.body!)).toEqual({ url: "https://x.example/h", event_types: [{ name: "PAYMENT.CAPTURE.COMPLETED" }] });
  });
});
