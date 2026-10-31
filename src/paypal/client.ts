// Thin PayPal REST client on fetch. Sandbox only (live is refused by decision); every money POST carries a
// PayPal-Request-Id; network errors, timeouts, 429 and 5xx are retried with the same id and the same body.

import { assertCents, usd } from "../money.js";
import { GuardError, PayPalError } from "./errors.js";
import type { CallRecord, CallSink } from "./journal.js";
import { parseAuthorization, parseCapture, parseOrder, type ParsedAuthorization, type ParsedCapture, type ParsedOrder } from "./parse.js";

export const SANDBOX_BASE_URL = "https://api-m.sandbox.paypal.com";
const SANDBOX_ORIGIN = new URL(SANDBOX_BASE_URL).origin;

const TOKEN_PATH = "/v1/oauth2/token";
const VERIFY_PATH = "/v1/notifications/verify-webhook-signature";
const NO_REQUEST_ID = new Set([TOKEN_PATH, VERIFY_PATH]);

/** 1–108 visible ASCII characters (PayPal's limit for PayPal-Request-Id). */
export const REQUEST_ID_PATTERN = /^[\x21-\x7e]{1,108}$/;
const RESOURCE_ID = /^[A-Za-z0-9-]{1,64}$/;

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<Response>;

/** No HTTP answer after all retries (network error or timeout). The outcome at PayPal is unknown. */
export class PayPalNetworkError extends Error {
  override name = "PayPalNetworkError";
}

export interface PayPalClientOptions {
  clientId: string;
  clientSecret: string;
  /** Shown to the payer on the PayPal approval page. */
  brandName: string;
  baseUrl?: string;
  fetch?: FetchLike;
  /** Epoch milliseconds. */
  now?: () => number;
  onCall?: CallSink;
  /** Retries after the first attempt for network errors, timeouts, 429 and 5xx. Default 3. */
  maxRetries?: number;
  retryDelayMs?: number;
  timeoutMs?: number;
}

export type ItemCategory = "PHYSICAL_GOODS" | "DIGITAL_GOODS";
export type UserAction = "PAY_NOW" | "CONTINUE";

export interface OrderItemInput {
  name: string;
  unitCents: number;
  quantity?: 1;
  category: ItemCategory;
}

export interface CreateAuthorizeOrderInput {
  requestId: string;
  referenceId: string;
  customId: string;
  description: string;
  items: OrderItemInput[];
  returnUrl: string;
  cancelUrl: string;
  /**
   * CONTINUE by default (button "Review Order"). Compared live on the sandbox mobile approval page on 2026-10-31
   * (orders 8T156436WD862622X and 8CP24276UU357154W, $186): both modes list the item, its description and the exact
   * amount, and neither shows an "up to" amount; PAY_NOW only labels the button "Pay", which misdescribes a hold.
   */
  userAction?: UserAction;
}

export interface WebhookInfo {
  id: string;
  url: string;
  eventTypes: string[];
}

export interface PayPalClient {
  createAuthorizeOrder(input: CreateAuthorizeOrderInput): Promise<ParsedOrder>;
  getOrder(orderId: string): Promise<ParsedOrder>;
  authorizeOrder(input: { orderId: string; requestId: string }): Promise<ParsedOrder>;
  getAuthorization(authorizationId: string): Promise<ParsedAuthorization>;
  captureAuthorization(input: { authorizationId: string; requestId: string; cents: number; finalCapture: boolean; invoiceId?: string }): Promise<ParsedCapture>;
  /** Returns the voided authorization when PayPal sends it back, null on an empty 2xx. */
  voidAuthorization(input: { authorizationId: string; requestId: string }): Promise<ParsedAuthorization | null>;
  reauthorize(input: { authorizationId: string; requestId: string; cents: number }): Promise<ParsedAuthorization>;
  verifyWebhookSignature(input: { headers: Record<string, string | undefined>; rawBody: string; webhookId: string }): Promise<boolean>;
  createWebhook(input: { url: string; eventTypes: string[]; requestId: string }): Promise<WebhookInfo>;
  listWebhooks(): Promise<WebhookInfo[]>;
}

interface Raw {
  status: number;
  text: string;
  debugId: string | null;
}

function requireRequestId(requestId: string | undefined, what: string): string {
  if (requestId === undefined || requestId === "") throw new GuardError(`${what}: PayPal-Request-Id is required`);
  if (!REQUEST_ID_PATTERN.test(requestId)) throw new GuardError(`${what}: PayPal-Request-Id must be 1-108 visible ASCII characters`);
  return requestId;
}

function resourceId(id: string, what: string): string {
  if (typeof id !== "string" || !RESOURCE_ID.test(id)) throw new GuardError(`${what}: bad id ${JSON.stringify(id)}`);
  return id;
}

function text(value: string, max: number, what: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new GuardError(`${what} is required`);
  if (value.length > max) throw new GuardError(`${what} is longer than ${max} characters`);
  return value;
}

function httpUrl(value: string, what: string): string {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw new GuardError(`${what} is not a URL`);
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new GuardError(`${what} must be http(s)`);
  return value;
}

function retryable(status: number): boolean {
  return status === 429 || status >= 500;
}

function peek(textBody: string): { id: string | null; issue: string | null } {
  try {
    const o = JSON.parse(textBody) as { id?: unknown; details?: { issue?: unknown }[] };
    const issue = Array.isArray(o.details) && typeof o.details[0]?.issue === "string" ? o.details[0].issue : null;
    return { id: typeof o.id === "string" ? o.id : null, issue };
  } catch {
    return { id: null, issue: null };
  }
}

function lastPathId(path: string): string | null {
  const segs = path.split("?")[0]!.split("/").filter(Boolean);
  for (let i = segs.length - 1; i >= 0; i--) {
    const s = segs[i]!;
    if (/^[A-Z0-9]{10,}$/.test(s)) return s;
  }
  return null;
}

export function createPayPalClient(opts: PayPalClientOptions): PayPalClient {
  const base = opts.baseUrl ?? SANDBOX_BASE_URL;
  let baseOrigin: string;
  try {
    baseOrigin = new URL(base).origin;
  } catch {
    throw new GuardError(`not a URL: ${base}`);
  }
  if (baseOrigin !== SANDBOX_ORIGIN) throw new GuardError(`only the PayPal sandbox is allowed (${SANDBOX_ORIGIN}), got ${baseOrigin}`);
  if (!opts.clientId || !opts.clientSecret) throw new GuardError("PayPal sandbox client id and secret are required");
  const brandName = text(opts.brandName, 127, "brandName");

  const doFetch: FetchLike = opts.fetch ?? ((url, init) => fetch(url, init));
  const now = opts.now ?? Date.now;
  const maxRetries = opts.maxRetries ?? 3;
  const retryDelayMs = opts.retryDelayMs ?? 500;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const sleep = (ms: number) => (ms > 0 ? new Promise<void>((r) => setTimeout(r, ms)) : Promise.resolve());

  async function record(r: CallRecord): Promise<void> {
    if (!opts.onCall) return;
    try {
      await opts.onCall(r);
    } catch (e) {
      console.error(`paypal call journal failed: ${(e as Error).message}`);
    }
  }

  function urlFor(path: string): string {
    if (!path.startsWith("/") || path.startsWith("//")) throw new GuardError(`bad PayPal path ${path}`);
    const u = new URL(path, SANDBOX_BASE_URL);
    if (u.origin !== SANDBOX_ORIGIN) throw new GuardError(`refusing non-sandbox origin ${u.origin}`);
    return u.toString();
  }

  async function once(url: string, method: "GET" | "POST", headers: Record<string, string>, body: string | undefined): Promise<Raw> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(new Error(`timeout after ${timeoutMs} ms`)), timeoutMs);
    try {
      const init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal } = { method, headers, signal: ctl.signal };
      if (body !== undefined) init.body = body;
      const res = await doFetch(url, init);
      const t = await res.text();
      return { status: res.status, text: t, debugId: res.headers.get("paypal-debug-id") };
    } finally {
      clearTimeout(timer);
    }
  }

  /** One logical call with retries. The same headers (PayPal-Request-Id included) and body go out every time. */
  async function send(op: string, method: "GET" | "POST", path: string, headers: Record<string, string>, body: string | undefined): Promise<Raw> {
    const url = urlFor(path);
    const requestId = headers["PayPal-Request-Id"] ?? null;
    for (let attempt = 0; ; attempt++) {
      let raw: Raw | undefined;
      let failure: unknown;
      try {
        raw = await once(url, method, headers, body);
      } catch (e) {
        failure = e;
      }
      if (raw) {
        const p = peek(raw.text);
        await record({ at: new Date(now()), op, method, path, requestId, httpStatus: raw.status, debugId: raw.debugId ?? null, resourceId: p.id ?? lastPathId(path), issue: p.issue });
        if (!retryable(raw.status) || attempt >= maxRetries) return raw;
      } else {
        const timedOut = failure instanceof Error && /timeout/i.test(failure.message);
        await record({ at: new Date(now()), op, method, path, requestId, httpStatus: null, debugId: null, resourceId: lastPathId(path), issue: timedOut ? "TIMEOUT" : "NETWORK" });
        if (attempt >= maxRetries) throw new PayPalNetworkError(`${op}: no answer from PayPal after ${attempt + 1} attempts (${(failure as Error)?.message ?? String(failure)})`);
      }
      await sleep(retryDelayMs * (attempt + 1));
    }
  }

  let token: { value: string; expiresAt: number } | null = null;
  let pendingToken: Promise<string> | null = null;

  async function fetchToken(): Promise<string> {
    const basic = Buffer.from(`${opts.clientId}:${opts.clientSecret}`).toString("base64");
    const raw = await send(
      "oauth.token",
      "POST",
      TOKEN_PATH,
      { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      "grant_type=client_credentials",
    );
    if (raw.status < 200 || raw.status >= 300) throw PayPalError.fromResponse(raw.status, raw.text, raw.debugId);
    let body: { access_token?: unknown; expires_in?: unknown };
    try {
      body = JSON.parse(raw.text) as typeof body;
    } catch {
      throw new PayPalError({ httpStatus: raw.status, name: "BAD_TOKEN_RESPONSE" });
    }
    if (typeof body.access_token !== "string" || typeof body.expires_in !== "number") throw new PayPalError({ httpStatus: raw.status, name: "BAD_TOKEN_RESPONSE" });
    token = { value: body.access_token, expiresAt: now() + Math.max(0, body.expires_in - 60) * 1000 };
    return body.access_token;
  }

  /** Cached until expires_in − 60 s; parallel callers share one token request. */
  function getToken(): Promise<string> {
    if (token && now() < token.expiresAt) return Promise.resolve(token.value);
    if (!pendingToken) pendingToken = fetchToken().finally(() => (pendingToken = null));
    return pendingToken;
  }

  async function rest(op: string, method: "GET" | "POST", path: string, o: { body?: unknown; rawBody?: string; requestId?: string } = {}): Promise<unknown> {
    urlFor(path);
    if (method === "POST" && !NO_REQUEST_ID.has(path)) requireRequestId(o.requestId, op);
    const body = o.rawBody ?? (o.body === undefined ? undefined : JSON.stringify(o.body));
    const call = async (tok: string) => {
      const headers: Record<string, string> = { Authorization: `Bearer ${tok}`, Accept: "application/json" };
      if (method === "POST") {
        headers["Content-Type"] = "application/json";
        headers.Prefer = "return=representation";
        if (o.requestId) headers["PayPal-Request-Id"] = o.requestId;
      }
      return send(op, method, path, headers, body);
    };
    let tok = await getToken();
    let raw = await call(tok);
    if (raw.status === 401) {
      // The token was revoked or the clock drifted: drop it and try once more with a fresh one.
      if (token?.value === tok) token = null;
      tok = await getToken();
      raw = await call(tok);
    }
    if (raw.status < 200 || raw.status >= 300) throw PayPalError.fromResponse(raw.status, raw.text, raw.debugId);
    if (raw.text.trim() === "") return null;
    try {
      return JSON.parse(raw.text);
    } catch {
      throw new PayPalError({ httpStatus: raw.status, name: "BAD_RESPONSE", description: `${op}: answer is not JSON`, debugId: raw.debugId ?? undefined });
    }
  }

  const client: PayPalClient = {
    async createAuthorizeOrder(i) {
      const requestId = requireRequestId(i.requestId, "createAuthorizeOrder");
      if (!Array.isArray(i.items) || i.items.length === 0) throw new GuardError("createAuthorizeOrder: at least one item is required");
      let total = 0;
      const items = i.items.map((it, n) => {
        assertCents(it.unitCents, `items[${n}].unitCents`);
        if (it.unitCents === 0) throw new GuardError(`items[${n}]: a zero-priced item is not sent to PayPal`);
        if ((it.quantity ?? 1) !== 1) throw new GuardError(`items[${n}]: quantity must be 1`);
        if (it.category !== "PHYSICAL_GOODS" && it.category !== "DIGITAL_GOODS") throw new GuardError(`items[${n}]: bad category`);
        total += it.unitCents;
        return { name: text(it.name, 127, `items[${n}].name`), quantity: "1", unit_amount: usd(it.unitCents), category: it.category };
      });
      assertCents(total, "order total");
      const userAction = i.userAction ?? "CONTINUE";
      if (userAction !== "PAY_NOW" && userAction !== "CONTINUE") throw new GuardError("bad userAction");
      const body = {
        intent: "AUTHORIZE",
        purchase_units: [
          {
            reference_id: text(i.referenceId, 256, "referenceId"),
            custom_id: text(i.customId, 127, "customId"),
            description: text(i.description, 127, "description"),
            amount: { ...usd(total), breakdown: { item_total: usd(total) } },
            items,
          },
        ],
        payment_source: {
          paypal: {
            experience_context: {
              user_action: userAction,
              shipping_preference: "NO_SHIPPING",
              brand_name: brandName,
              return_url: httpUrl(i.returnUrl, "returnUrl"),
              cancel_url: httpUrl(i.cancelUrl, "cancelUrl"),
            },
          },
        },
      };
      return parseOrder(await rest("orders.create", "POST", "/v2/checkout/orders", { body, requestId }));
    },

    async getOrder(orderId) {
      return parseOrder(await rest("orders.get", "GET", `/v2/checkout/orders/${resourceId(orderId, "getOrder")}`));
    },

    async authorizeOrder({ orderId, requestId }) {
      const id = resourceId(orderId, "authorizeOrder");
      const res = parseOrder(await rest("orders.authorize", "POST", `/v2/checkout/orders/${id}/authorize`, { body: {}, requestId: requireRequestId(requestId, "authorizeOrder") }));
      // An idempotent replay may come back without the payments block: read the order then.
      return res.authorizations.length > 0 ? res : client.getOrder(id);
    },

    async getAuthorization(authorizationId) {
      return parseAuthorization(await rest("authorizations.get", "GET", `/v2/payments/authorizations/${resourceId(authorizationId, "getAuthorization")}`));
    },

    async captureAuthorization(i) {
      const id = resourceId(i.authorizationId, "captureAuthorization");
      const requestId = requireRequestId(i.requestId, "captureAuthorization");
      assertCents(i.cents, "capture amount");
      if (i.cents === 0) throw new GuardError("captureAuthorization: amount must be above zero");
      if (typeof i.finalCapture !== "boolean") throw new GuardError("captureAuthorization: finalCapture must be true or false");
      const body: Record<string, unknown> = { amount: usd(i.cents), final_capture: i.finalCapture };
      if (i.invoiceId !== undefined) body.invoice_id = text(i.invoiceId, 127, "invoiceId");
      return parseCapture(await rest("authorizations.capture", "POST", `/v2/payments/authorizations/${id}/capture`, { body, requestId }));
    },

    async voidAuthorization(i) {
      const id = resourceId(i.authorizationId, "voidAuthorization");
      const res = await rest("authorizations.void", "POST", `/v2/payments/authorizations/${id}/void`, { requestId: requireRequestId(i.requestId, "voidAuthorization") });
      if (res === null) return null;
      try {
        return parseAuthorization(res);
      } catch {
        return null; // the void went through (2xx); the caller reads the authorization live
      }
    },

    async reauthorize(i) {
      const id = resourceId(i.authorizationId, "reauthorize");
      const requestId = requireRequestId(i.requestId, "reauthorize");
      assertCents(i.cents, "reauthorize amount");
      if (i.cents === 0) throw new GuardError("reauthorize: amount must be above zero");
      const res = await rest("authorizations.reauthorize", "POST", `/v2/payments/authorizations/${id}/reauthorize`, { body: { amount: usd(i.cents) }, requestId });
      // A replay can come back without the amount: read the NEW authorization by the id in the body.
      const o = (res ?? {}) as { id?: unknown; amount?: unknown };
      if (o.amount === undefined && typeof o.id === "string") return client.getAuthorization(o.id);
      return parseAuthorization(res);
    },

    async verifyWebhookSignature({ headers, rawBody, webhookId }) {
      const h: Record<string, string | undefined> = {};
      for (const [k, v] of Object.entries(headers)) h[k.toLowerCase()] = v;
      const fields = {
        auth_algo: h["paypal-auth-algo"],
        cert_url: h["paypal-cert-url"],
        transmission_id: h["paypal-transmission-id"],
        transmission_sig: h["paypal-transmission-sig"],
        transmission_time: h["paypal-transmission-time"],
        webhook_id: webhookId,
      };
      if (Object.values(fields).some((v) => typeof v !== "string" || v === "")) return false;
      try {
        JSON.parse(rawBody);
      } catch {
        return false;
      }
      // The event goes in byte for byte: re-serializing it can change it and fail the signature check.
      const body = `${JSON.stringify(fields).slice(0, -1)},"webhook_event":${rawBody}}`;
      const res = (await rest("webhooks.verify", "POST", VERIFY_PATH, { rawBody: body })) as { verification_status?: unknown } | null;
      return res?.verification_status === "SUCCESS";
    },

    async createWebhook({ url, eventTypes, requestId }) {
      const res = await rest("webhooks.create", "POST", "/v1/notifications/webhooks", {
        body: { url: httpUrl(url, "webhook url"), event_types: eventTypes.map((name) => ({ name })) },
        requestId: requireRequestId(requestId, "createWebhook"),
      });
      return parseWebhook(res);
    },

    async listWebhooks() {
      const res = (await rest("webhooks.list", "GET", "/v1/notifications/webhooks")) as { webhooks?: unknown } | null;
      return Array.isArray(res?.webhooks) ? res.webhooks.map(parseWebhook) : [];
    },
  };
  return client;
}

function parseWebhook(raw: unknown): WebhookInfo {
  const o = (raw ?? {}) as { id?: unknown; url?: unknown; event_types?: unknown };
  if (typeof o.id !== "string") throw new PayPalError({ httpStatus: 200, name: "BAD_RESPONSE", description: "webhook without id" });
  const types = Array.isArray(o.event_types) ? o.event_types : [];
  return {
    id: o.id,
    url: typeof o.url === "string" ? o.url : "",
    eventTypes: types.map((t) => (t && typeof t === "object" && typeof (t as { name?: unknown }).name === "string" ? (t as { name: string }).name : "")).filter(Boolean),
  };
}
