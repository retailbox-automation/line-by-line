// An in-memory PayPal sandbox on the fetch seam. Response shapes follow our recorded sandbox calls
// (docs/2026-10-20-storm-full/work/sandbox-spike-calls-2026-10-20.jsonl, …-2026-10-24.jsonl,
// docs/build-2026-10-29/hold-pool-calls.jsonl); e-mails, names and payer ids are replaced by placeholders.
// Behaviour PayPal has not shown us yet is marked "assumed".

import type { FetchLike } from "../src/paypal/client.js";

export const PAYER = { email: "payer.placeholder@example.test", given: "PlaceholderGiven", surname: "PlaceholderSurname", payerId: "PAYERPLACEHOLDER1" };
export const MERCHANT = { email: "merchant.placeholder@example.test", merchantId: "MERCHANTPLACEHLD" };
/** Strings that must never reach our database or call journal. */
export const PAYER_MARKERS = [PAYER.email, PAYER.given, PAYER.surname, PAYER.payerId, MERCHANT.email];

export interface Call {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string | undefined;
}

type Action = { kind: "respond"; status: number; body: unknown } | { kind: "network" } | { kind: "hang" } | { kind: "dropResponse" };

interface FakeOrder {
  id: string;
  req: { purchase_units: { reference_id: string; custom_id: string; description: string; amount: { value: string }; items: unknown[] }[]; payment_source: { paypal: { experience_context: { brand_name: string } } } };
  amountCents: number;
  status: "PAYER_ACTION_REQUIRED" | "APPROVED" | "COMPLETED";
  source: "paypal" | "card";
  authIds: string[];
  createTime: number;
}

interface FakeAuth {
  id: string;
  orderId: string;
  parentId: string | null;
  childId: string | null;
  status: string;
  amountCents: number;
  capturedCents: number;
  captureIds: string[];
  createTime: number;
  expiration: number;
}

interface FakeCapture {
  id: string;
  authId: string;
  amountCents: number;
  final: boolean;
  status: string;
  feeCents: number;
  createTime: number;
}

const API = "https://api.sandbox.paypal.com";
const DAY = 24 * 60 * 60 * 1000;

function iso(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function money(cents: number) {
  return { currency_code: "USD", value: `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}` };
}

function cents(value: string): number {
  const [w, f = "0"] = value.split(".");
  return Number(w) * 100 + Number(f.padEnd(2, "0"));
}

const SELLER_PROTECTION = { status: "ELIGIBLE", dispute_categories: ["ITEM_NOT_RECEIVED", "UNAUTHORIZED_TRANSACTION"] };

export class FakePayPal {
  readonly calls: Call[] = [];
  readonly orders = new Map<string, FakeOrder>();
  readonly auths = new Map<string, FakeAuth>();
  readonly captures = new Map<string, FakeCapture>();
  /** PayPal-Request-Id -> first successful answer (replayed on a repeat, no side effects). */
  readonly idem = new Map<string, { status: number; body: unknown }>();
  maxCaptureCount = 10;
  verifyStatus = "SUCCESS";
  readonly rejectedTokens = new Set<string>();
  readonly webhooks: { id: string; url: string; event_types: { name: string }[] }[] = [];
  private seq = 0;
  private tokenSeq = 0;
  private scripted: { match: (c: Call) => boolean; action: Action; times: number }[] = [];

  constructor(private readonly clock: { now(): Date }) {}

  /** Next matching call(s) get this action instead of normal handling. */
  script(match: (c: Call) => boolean, action: Action, times = 1): void {
    this.scripted.push({ match, action, times });
  }

  /** The buyer approves the order on PayPal. */
  approve(orderId: string, source: "paypal" | "card" = "paypal"): void {
    const o = this.orders.get(orderId);
    if (!o) throw new Error(`fake: no order ${orderId}`);
    o.status = "APPROVED";
    o.source = source;
  }

  posts(fragment: string): Call[] {
    return this.calls.filter((c) => c.method === "POST" && c.path.includes(fragment));
  }

  requestIds(fragment: string): string[] {
    return this.posts(fragment).map((c) => c.headers["PayPal-Request-Id"] ?? "");
  }

  readonly fetch: FetchLike = async (url, init) => {
    const u = new URL(url);
    const call: Call = { method: init.method, path: u.pathname + u.search, headers: { ...init.headers }, body: init.body };
    this.calls.push(call);
    const s = this.scripted.find((x) => x.times > 0 && x.match(call));
    if (s) {
      s.times--;
      if (s.action.kind === "network") throw new TypeError("fetch failed");
      if (s.action.kind === "hang") {
        return new Promise<Response>((_, reject) => {
          const sig = init.signal;
          if (sig?.aborted) reject(sig.reason);
          sig?.addEventListener("abort", () => reject(sig.reason));
        });
      }
      if (s.action.kind === "respond") return this.json(s.action.status, s.action.body);
      // dropResponse: PayPal did the work, but the answer is lost on the way back.
      this.handle(call);
      throw new TypeError("fetch failed after the request was sent");
    }
    const r = this.handle(call);
    return this.json(r.status, r.body);
  };

  private json(status: number, body: unknown): Response {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (status >= 400) headers["paypal-debug-id"] = `fakedebug${this.seq}`;
    return new Response(body === null ? "" : JSON.stringify(body), { status, headers });
  }

  private id(prefix: string): string {
    return `${prefix}${String(++this.seq).padStart(16, "0")}`;
  }

  private err(status: number, name: string, issue: string, description: string) {
    return {
      status,
      body: {
        name,
        message: "The requested action could not be performed, semantically incorrect, or failed business validation.",
        debug_id: `fakedebug${this.seq}`,
        details: [{ issue, description }],
        links: [{ href: `https://developer.paypal.com/docs/api/payments/v2/#error-${issue}`, rel: "information_link" }],
      },
    };
  }

  private unprocessable(issue: string, description: string) {
    return this.err(422, "UNPROCESSABLE_ENTITY", issue, description);
  }

  private handle(call: Call): { status: number; body: unknown } {
    const { method, path } = call;
    if (path === "/v1/oauth2/token") return { status: 200, body: { scope: "https://uri.paypal.com/services/payments/payment", access_token: `tok${++this.tokenSeq}`, token_type: "Bearer", app_id: "APP-FAKE", expires_in: 32400, nonce: "fake" } };
    const bearer = call.headers.Authorization ?? "";
    if (!bearer.startsWith("Bearer ") || this.rejectedTokens.has(bearer.slice(7))) return { status: 401, body: { name: "AUTHENTICATION_FAILURE", message: "Authentication failed due to invalid authentication credentials or a missing Authorization header." } };
    const rid = call.headers["PayPal-Request-Id"];
    if (method === "POST" && rid && this.idem.has(rid)) return this.idem.get(rid)!;
    const r = this.route(call);
    if (method === "POST" && rid && r.status < 300) this.idem.set(rid, r);
    return r;
  }

  private route(call: Call): { status: number; body: unknown } {
    const { method, path } = call;
    const body = call.body ? (JSON.parse(call.body) as Record<string, unknown>) : {};
    let m: RegExpExecArray | null;
    if (method === "POST" && path === "/v2/checkout/orders") return this.createOrder(body);
    if ((m = /^\/v2\/checkout\/orders\/([A-Z0-9]+)$/.exec(path)) && method === "GET") {
      const o = this.orders.get(m[1]!);
      return o ? { status: 200, body: this.orderFull(o) } : this.err(404, "RESOURCE_NOT_FOUND", "INVALID_RESOURCE_ID", "Specified resource ID does not exist.");
    }
    if ((m = /^\/v2\/checkout\/orders\/([A-Z0-9]+)\/authorize$/.exec(path)) && method === "POST") return this.authorize(m[1]!);
    if ((m = /^\/v2\/payments\/authorizations\/([A-Z0-9]+)$/.exec(path)) && method === "GET") {
      const a = this.auths.get(m[1]!);
      return a ? { status: 200, body: this.authFull(a) } : this.err(404, "RESOURCE_NOT_FOUND", "INVALID_RESOURCE_ID", "Specified resource ID does not exist.");
    }
    if ((m = /^\/v2\/payments\/authorizations\/([A-Z0-9]+)\/capture$/.exec(path)) && method === "POST") return this.capture(m[1]!, body);
    if ((m = /^\/v2\/payments\/authorizations\/([A-Z0-9]+)\/void$/.exec(path)) && method === "POST") return this.void(m[1]!);
    if ((m = /^\/v2\/payments\/authorizations\/([A-Z0-9]+)\/reauthorize$/.exec(path)) && method === "POST") return this.reauthorize(m[1]!, body);
    if (path === "/v1/notifications/verify-webhook-signature" && method === "POST") return { status: 200, body: { verification_status: this.verifyStatus } };
    if (path === "/v1/notifications/webhooks" && method === "GET") return { status: 200, body: { webhooks: this.webhooks } };
    if (path === "/v1/notifications/webhooks" && method === "POST") {
      const w = { id: this.id("WH"), url: String(body.url), event_types: (body.event_types as { name: string }[]) ?? [] };
      this.webhooks.push(w);
      return { status: 201, body: w };
    }
    return this.err(404, "RESOURCE_NOT_FOUND", "INVALID_RESOURCE_ID", `fake: no route ${method} ${path}`);
  }

  private createOrder(body: Record<string, unknown>) {
    const req = body as unknown as FakeOrder["req"] & { intent: string };
    if (req.intent !== "AUTHORIZE") return this.err(400, "INVALID_REQUEST", "INVALID_PARAMETER_VALUE", "intent");
    const pu = req.purchase_units[0]! as unknown as { amount: { value: string; breakdown?: { item_total?: { value: string } } }; items: { unit_amount: { value: string }; quantity: string }[] };
    const total = cents(pu.amount.value);
    const itemTotal = pu.amount.breakdown?.item_total ? cents(pu.amount.breakdown.item_total.value) : NaN;
    const itemsSum = pu.items.reduce((a: number, it) => a + cents(it.unit_amount.value) * Number(it.quantity), 0);
    if (total !== itemTotal || total !== itemsSum) return this.unprocessable("ITEM_TOTAL_MISMATCH", "Should equal sum of (unit_amount * quantity) across all items for a given purchase_unit.");
    const o: FakeOrder = { id: this.id("O"), req, amountCents: total, status: "PAYER_ACTION_REQUIRED", source: "paypal", authIds: [], createTime: this.clock.now().getTime() };
    this.orders.set(o.id, o);
    return {
      status: 200,
      body: {
        id: o.id,
        intent: "AUTHORIZE",
        status: o.status,
        payment_source: { paypal: {} },
        purchase_units: [this.unit(o, false)],
        links: [
          { href: `${API}/v2/checkout/orders/${o.id}`, rel: "self", method: "GET" },
          { href: `https://www.sandbox.paypal.com/checkoutnow?token=${o.id}`, rel: "payer-action", method: "GET" },
        ],
      },
    };
  }

  private unit(o: FakeOrder, withPayments: boolean) {
    const pu = o.req.purchase_units[0]!;
    const u: Record<string, unknown> = {
      reference_id: pu.reference_id,
      amount: { currency_code: "USD", value: pu.amount.value, breakdown: { item_total: { currency_code: "USD", value: pu.amount.value } } },
      payee: { email_address: MERCHANT.email, merchant_id: MERCHANT.merchantId, display_data: { brand_name: o.req.payment_source.paypal.experience_context.brand_name } },
      description: pu.description,
      custom_id: pu.custom_id,
      items: pu.items,
    };
    if (withPayments && o.authIds.length) {
      const auths = o.authIds.map((id) => this.auths.get(id)!);
      const caps = auths.flatMap((a) => a.captureIds.map((c) => this.captures.get(c)!));
      u.payments = { authorizations: auths.map((a) => this.authEmbedded(a)), ...(caps.length ? { captures: caps.map((c) => this.captureBody(c)) } : {}) };
    }
    return u;
  }

  private orderFull(o: FakeOrder) {
    const approved = o.status !== "PAYER_ACTION_REQUIRED";
    const source = !approved
      ? { paypal: {} }
      : o.source === "paypal"
        ? { paypal: { email_address: PAYER.email, account_id: PAYER.payerId, account_status: "VERIFIED", name: { given_name: PAYER.given, surname: PAYER.surname }, address: { country_code: "US" } } }
        : { card: { name: `${PAYER.given} ${PAYER.surname}`, last_digits: "1881", brand: "VISA", type: "CREDIT" } };
    const body: Record<string, unknown> = {
      id: o.id,
      intent: "AUTHORIZE",
      status: o.status,
      payment_source: source,
      purchase_units: [this.unit(o, true)],
      create_time: iso(o.createTime),
      update_time: iso(this.clock.now().getTime()),
      links: [{ href: `${API}/v2/checkout/orders/${o.id}`, rel: "self", method: "GET" }],
    };
    if (approved) body.payer = { name: { given_name: PAYER.given, surname: PAYER.surname }, email_address: PAYER.email, payer_id: PAYER.payerId, address: { country_code: "US" } };
    return body;
  }

  private authLinks(id: string, orderId: string) {
    return [
      { href: `${API}/v2/payments/authorizations/${id}`, rel: "self", method: "GET" },
      { href: `${API}/v2/payments/authorizations/${id}/capture`, rel: "capture", method: "POST" },
      { href: `${API}/v2/payments/authorizations/${id}/void`, rel: "void", method: "POST" },
      { href: `${API}/v2/payments/authorizations/${id}/reauthorize`, rel: "reauthorize", method: "POST" },
      { href: `${API}/v2/checkout/orders/${orderId}`, rel: "up", method: "GET" },
    ];
  }

  private authEmbedded(a: FakeAuth) {
    return {
      status: a.status,
      id: a.id,
      amount: money(a.amountCents),
      seller_protection: SELLER_PROTECTION,
      expiration_time: iso(a.expiration),
      links: this.authLinks(a.id, a.orderId),
      create_time: iso(a.createTime),
      update_time: iso(a.createTime),
    };
  }

  private authFull(a: FakeAuth, linksFor: string = a.id) {
    return {
      id: a.id,
      status: a.status,
      amount: money(a.amountCents),
      seller_protection: SELLER_PROTECTION,
      supplementary_data: { related_ids: { order_id: a.orderId } },
      payee: { email_address: MERCHANT.email, merchant_id: MERCHANT.merchantId },
      expiration_time: iso(a.expiration),
      create_time: iso(a.createTime),
      update_time: iso(this.clock.now().getTime()),
      links: this.authLinks(linksFor, a.orderId),
    };
  }

  private captureBody(c: FakeCapture) {
    return {
      id: c.id,
      amount: money(c.amountCents),
      final_capture: c.final,
      seller_protection: SELLER_PROTECTION,
      seller_receivable_breakdown: { gross_amount: money(c.amountCents), paypal_fee: money(c.feeCents), net_amount: money(c.amountCents - c.feeCents), exchange_rate: {} },
      status: c.status,
      create_time: iso(c.createTime),
      update_time: iso(c.createTime),
      links: [
        { href: `${API}/v2/payments/captures/${c.id}`, rel: "self", method: "GET" },
        { href: `${API}/v2/payments/captures/${c.id}/refund`, rel: "refund", method: "POST" },
        { href: `${API}/v2/payments/authorizations/${c.authId}`, rel: "up", method: "GET" },
      ],
    };
  }

  private authorize(orderId: string) {
    const o = this.orders.get(orderId);
    if (!o) return this.err(404, "RESOURCE_NOT_FOUND", "INVALID_RESOURCE_ID", "Specified resource ID does not exist.");
    if (o.status === "PAYER_ACTION_REQUIRED") return this.unprocessable("ORDER_NOT_APPROVED", "Payer has not yet approved the Order for payment.");
    if (o.status === "COMPLETED") return this.unprocessable("ORDER_ALREADY_AUTHORIZED", "Order already authorized. If 'intent=AUTHORIZE' only one authorization per order is allowed.");
    const now = this.clock.now().getTime();
    const a: FakeAuth = { id: this.id("A"), orderId, parentId: null, childId: null, status: "CREATED", amountCents: o.amountCents, capturedCents: 0, captureIds: [], createTime: now, expiration: now + 29 * DAY };
    this.auths.set(a.id, a);
    o.authIds.push(a.id);
    o.status = "COMPLETED";
    return { status: 201, body: this.orderFull(o) };
  }

  private capture(authId: string, body: Record<string, unknown>) {
    const a = this.auths.get(authId);
    if (!a) return this.err(404, "RESOURCE_NOT_FOUND", "INVALID_RESOURCE_ID", "Specified resource ID does not exist.");
    if (a.status === "CAPTURED") return this.unprocessable("AUTHORIZATION_ALREADY_CAPTURED", "Authorization has been previously captured and hence cannot be captured again.");
    if (a.status === "VOIDED") return this.unprocessable("AUTHORIZATION_VOIDED", "A voided authorization cannot be captured or reauthorized.");
    if (a.status === "EXPIRED") return this.unprocessable("AUTHORIZATION_EXPIRED", "An expired authorization cannot be captured.");
    if (a.captureIds.length >= this.maxCaptureCount) return this.unprocessable("MAX_CAPTURE_COUNT_EXCEEDED", "Maximum number of allowable captures has been reached. No additional captures are possible for this authorization.");
    const amount = cents((body.amount as { value: string }).value);
    if (amount > a.amountCents - a.capturedCents) return this.unprocessable("MAX_CAPTURE_AMOUNT_EXCEEDED", "Capture amount exceeds allowable limit.");
    const final = body.final_capture === true;
    const c: FakeCapture = { id: this.id("C"), authId, amountCents: amount, final, status: "COMPLETED", feeCents: Math.round(amount * 0.0349) + 49, createTime: this.clock.now().getTime() };
    this.captures.set(c.id, c);
    a.captureIds.push(c.id);
    a.capturedCents += amount;
    a.status = final || a.capturedCents === a.amountCents ? "CAPTURED" : "PARTIALLY_CAPTURED";
    return { status: 201, body: this.captureBody(c) };
  }

  private void(authId: string) {
    const a = this.auths.get(authId);
    if (!a) return this.err(404, "RESOURCE_NOT_FOUND", "INVALID_RESOURCE_ID", "Specified resource ID does not exist.");
    if (a.parentId) return this.unprocessable("CANNOT_BE_VOIDED", "A reauthorization cannot be voided. Please void the original parent authorization.");
    if (a.status === "CAPTURED") return this.unprocessable("PREVIOUSLY_CAPTURED", "Authorization has been previously captured and hence cannot be voided.");
    if (a.status === "VOIDED") return this.unprocessable("PREVIOUSLY_VOIDED", "Authorization has been previously voided and hence cannot be voided again.");
    a.status = "VOIDED";
    // assumed: voiding the parent also releases its reauthorization (not yet seen live).
    if (a.childId) this.auths.get(a.childId)!.status = "VOIDED";
    return { status: 200, body: { id: a.id, status: "VOIDED", amount: money(a.amountCents), seller_protection: SELLER_PROTECTION, expiration_time: "2026-11-17T20:08:43-08:00", create_time: "2026-10-19T21:08:43-07:00", update_time: "2026-10-19T21:09:07-07:00", links: this.authLinks(a.id, a.orderId) } };
  }

  private reauthorize(authId: string, body: Record<string, unknown>) {
    const a = this.auths.get(authId);
    if (!a) return this.err(404, "RESOURCE_NOT_FOUND", "INVALID_RESOURCE_ID", "Specified resource ID does not exist.");
    const now = this.clock.now().getTime();
    if (now - a.createTime < 4 * DAY) return this.unprocessable("REAUTHORIZATION_TOO_SOON", "A reauthorization is only allowed once from Day 4 to Day 29 since the date of the original authorization.");
    // assumed issue name for a second reauthorization; the sandbox only told us "once".
    if (a.parentId || a.childId) return this.unprocessable("REAUTHORIZATION_NOT_ALLOWED", "A reauthorization is only allowed once.");
    const amount = cents((body.amount as { value: string }).value);
    const child: FakeAuth = { id: this.id("A"), orderId: a.orderId, parentId: a.id, childId: null, status: "CREATED", amountCents: amount, capturedCents: 0, captureIds: [], createTime: now, expiration: a.expiration };
    this.auths.set(child.id, child);
    a.childId = child.id;
    this.orders.get(a.orderId)!.authIds.push(child.id);
    // Finding 6: the links in this answer point to the OLD id; the body id is the new one.
    const out = this.authFull(child, a.id) as Record<string, unknown>;
    delete out.payee;
    return { status: 201, body: out };
  }
}
