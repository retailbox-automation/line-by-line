// HTTP API for the screens (desk, mechanic, customer page). Contract: docs/api.md.
// JSON in and out; errors are {error, code[, details]}; money is cents plus a "184.00" string; no payer data.
// Bodies are validated by the zod schemas of the core functions (the casts below only satisfy the compiler).
// Access: the desk and mechanic screens send DESK_TOKEN; the customer page sends its repair order's own token (from
// the customer link), which opens only that repair order and only the customer's steps. PayPal's redirects and
// webhooks need no token (the webhook is checked by its signature).

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import {
  addLine,
  CoreError,
  createEstimateOrder,
  createRepairOrder,
  decide,
  getRepairOrder,
  loadOrder,
  onApproved,
  onCancelled,
  parseInput,
  PerformedSchema,
  pickup,
  reconcile,
  refreshApproval,
  runReauthorize,
  type ConsentInput,
  type CoreDeps,
  type CoreErrorCode,
  type CreateRepairOrderInput,
  type DecideInput,
  type LineInput,
  type RepairOrderState,
} from "../core/index.js";
import { DISCLOSURE_VERSION, flEstimateRequired, flNeedsNewAuthorization, flNewLineNeedsConsent, flToleranceCents } from "../rules/florida.js";
import type { WebhookReceiver } from "../webhooks/paypal.js";
import { withUsd } from "./serialize.js";

/** Largest request body (a repair order with 50 estimate lines and long descriptions fits). */
export const MAX_BODY_BYTES = 256 * 1024;

const STATUS: Record<CoreErrorCode, ContentfulStatusCode> = { NOT_FOUND: 404, VALIDATION: 400, CONFLICT: 409, IN_PROGRESS: 409, PAYPAL: 502 };

/** Errors of the HTTP layer itself (auth, media type, configuration). */
class HttpError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const IdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "not a valid id");
const OrderIdSchema = z.string({ error: "token is required" }).regex(/^[A-Za-z0-9-]{1,64}$/, "token is not a PayPal order id");
const PickupBodySchema = z.object({ performed: PerformedSchema });

export interface AppOptions {
  deps: CoreDeps;
  /** Public origin of the app (no trailing slash needed): the customer page is PUBLIC_BASE_URL/c/:roId. */
  publicBaseUrl: string;
  /** DESK_TOKEN: bearer token of the desk and mechanic screens, and the key of the customer page tokens. */
  deskToken: string;
  /** JOB_TOKEN: bearer token of POST /api/jobs/reauthorize. Unset = the job route answers 503. */
  jobToken?: string | undefined;
  webhooks: WebhookReceiver;
}

function sameToken(given: string, expected: string): boolean {
  // Hash both sides so the comparison is constant-time whatever the lengths.
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * The customer page's token for one repair order: HMAC-SHA256 of its id under DESK_TOKEN, 128 bits in hex. Nothing
 * is stored; a new DESK_TOKEN invalidates every customer link. The bare repair order id is never a credential.
 */
export function customerToken(deskToken: string, roId: string): string {
  return createHmac("sha256", deskToken).update(`lbl-customer-link:v1:${roId}`).digest("hex").slice(0, 32);
}

function bearer(c: Context): string | null {
  return /^Bearer (\S+)$/.exec(c.req.header("authorization") ?? "")?.[1] ?? null;
}

function unauthorized(c: Context, message: string): HttpError {
  c.header("WWW-Authenticate", "Bearer");
  return new HttpError(401, "UNAUTHORIZED", message);
}

/** The customer page may decide only as the customer: a decision "made at the desk" needs the desk token. */
function refuseDeskChannel(caller: "desk" | "customer", body: unknown): void {
  if (caller === "customer" && body && typeof body === "object" && (body as { channel?: unknown }).channel === "desk") {
    throw new HttpError(403, "FORBIDDEN", "the customer page cannot record a decision as made at the desk");
  }
}

async function readJson(c: Context): Promise<unknown> {
  if (!/^application\/json(;|$)/i.test((c.req.header("content-type") ?? "").trim())) {
    throw new HttpError(415, "UNSUPPORTED_MEDIA_TYPE", "send the body as application/json");
  }
  const text = await c.req.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new CoreError("VALIDATION", "body is not valid JSON");
  }
}

function param(c: Context, name: string): string {
  const r = IdSchema.safeParse(c.req.param(name));
  if (!r.success) throw new CoreError("VALIDATION", `${name}: not a valid id`, { [name]: c.req.param(name) ?? null });
  return r.data;
}

const sum = (xs: { priceCents: number }[]) => xs.reduce((a, l) => a + l.priceCents, 0);

/** Florida badges for the screens (Fla. Stat. 559.905, 559.909; not legal advice). Null outside FL. */
export function flFlags(state: RepairOrderState) {
  if (state.repairOrder.state !== "FL") return null;
  const estimateCents = sum(state.lines.filter((l) => l.kind === "estimate"));
  const approvedTotalCents = sum(state.lines.filter((l) => l.status === "approved" || l.status === "performed" || l.status === "not_performed"));
  // The tolerance is measured from the last approved total ("final estimate"), or from the estimate before that.
  const baseCents = approvedTotalCents > 0 ? approvedTotalCents : estimateCents;
  const toleranceCents = flToleranceCents(baseCents);
  const pending = state.lines.filter((l) => l.kind === "added" && (l.status === "proposed" || l.status === "sent"));
  const pendingTotalCents = sum(pending);
  return {
    estimateCents,
    estimateRequired: flEstimateRequired(estimateCents),
    approvedTotalCents,
    toleranceBaseCents: baseCents,
    toleranceCents,
    ceilingCents: baseCents + toleranceCents,
    newLineNeedsConsent: flNewLineNeedsConsent(),
    disclosureVersion: DISCLOSURE_VERSION,
    pendingTotalCents,
    pendingExceedsTolerance: flNeedsNewAuthorization(baseCents, baseCents + pendingTotalCents),
    pendingLines: pending.map((l) => ({ lineId: l.id, exceedsTolerance: flNeedsNewAuthorization(baseCents, baseCents + l.priceCents) })),
  };
}

export function createApp(o: AppOptions): Hono {
  const { deps, webhooks, deskToken } = o;
  if (!deskToken || deskToken.length < 16) throw new Error("createApp: a deskToken of at least 16 characters is required");
  const base = new URL(o.publicBaseUrl).toString().replace(/\/+$/, "");
  const app = new Hono();

  const customerPage = (roId: string, params: Record<string, string>) => {
    const u = new URL(`${base}/c/${encodeURIComponent(roId)}`);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    return u.toString();
  };

  const isDesk = (c: Context) => {
    const t = bearer(c);
    return t !== null && sameToken(t, deskToken);
  };
  const requireDesk = (c: Context) => {
    if (!isDesk(c)) throw unauthorized(c, "the desk token is required");
  };
  /** The desk, or the customer page of this repair order. */
  const requireRoAccess = (c: Context, roId: string): "desk" | "customer" => {
    if (isDesk(c)) return "desk";
    const t = bearer(c);
    if (t !== null && sameToken(t, customerToken(deskToken, roId))) return "customer";
    throw unauthorized(c, "the desk token or this repair order's customer token is required");
  };

  /** The desk also gets the customer link (QR / text message) with the repair order's customer token. */
  const stateBody = (state: RepairOrderState, caller: "desk" | "customer"): unknown =>
    withUsd({
      ...state,
      fl: flFlags(state),
      ...(caller === "desk" ? { customerUrl: customerPage(state.repairOrder.id, { k: customerToken(deskToken, state.repairOrder.id) }) } : {}),
    });

  app.use("*", bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => c.json({ error: `body larger than ${MAX_BODY_BYTES} bytes`, code: "TOO_LARGE" }, 413) }));

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message, code: err.code }, err.status);
    if (err instanceof CoreError) return c.json({ error: err.message, code: err.code, ...(err.details ? { details: withUsd(err.details) } : {}) }, STATUS[err.code]);
    // Path only: the PayPal return URL carries the payer id in its query string.
    console.error(`unhandled error on ${c.req.method} ${c.req.path}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    return c.json({ error: "internal error", code: "INTERNAL" }, 500);
  });

  app.notFound((c) => c.json({ error: `no route ${c.req.method} ${c.req.path}`, code: "NOT_FOUND" }, 404));

  app.get("/healthz", async (c) => {
    try {
      await deps.db.query("SELECT 1");
      return c.json({ ok: true });
    } catch (e) {
      console.error(`healthz: database check failed: ${(e as Error).message}`);
      return c.json({ ok: false, error: "database unavailable", code: "UNAVAILABLE" }, 503);
    }
  });

  app.post("/api/ro", async (c) => {
    requireDesk(c);
    const { repairOrder } = await createRepairOrder(deps, (await readJson(c)) as CreateRepairOrderInput);
    return c.json(stateBody(await getRepairOrder(deps, repairOrder.id), "desk"), 201);
  });

  app.get("/api/ro/:id", async (c) => {
    const roId = param(c, "id");
    const caller = requireRoAccess(c, roId);
    return c.json(stateBody(await getRepairOrder(deps, roId), caller));
  });

  app.post("/api/ro/:id/estimate/approval", async (c) => {
    const roId = param(c, "id");
    const caller = requireRoAccess(c, roId);
    const body = await readJson(c);
    refuseDeskChannel(caller, body);
    const { order, created } = await createEstimateOrder(deps, roId, body as ConsentInput);
    return c.json(withUsd({ order, created, approveUrl: order.approveUrl }), created ? 201 : 200);
  });

  app.post("/api/ro/:id/lines", async (c) => {
    const roId = param(c, "id");
    requireDesk(c);
    const line = await addLine(deps, roId, (await readJson(c)) as LineInput);
    return c.json(withUsd({ line }), 201);
  });

  app.post("/api/ro/:id/decisions", async (c) => {
    const roId = param(c, "id");
    const caller = requireRoAccess(c, roId);
    const body = await readJson(c);
    refuseDeskChannel(caller, body);
    const r = await decide(deps, roId, body as DecideInput);
    return c.json(withUsd({ declined: r.declined, order: r.order, approveUrl: r.order?.approveUrl ?? null }));
  });

  app.post("/api/orders/:orderId/refresh", async (c) => {
    const orderId = param(c, "orderId");
    if (!isDesk(c)) {
      if (bearer(c) === null) throw unauthorized(c, "the desk token or the repair order's customer token is required");
      requireRoAccess(c, (await loadOrder(deps.db, orderId)).roId);
    }
    const r = await refreshApproval(deps, orderId);
    return c.json(withUsd({ order: r.order, refreshed: r.refreshed, approveUrl: r.order.approveUrl }));
  });

  // PayPal sends the customer back here with ?token=<order id>. We authorize, then redirect to the customer page.
  app.get("/api/paypal/return", async (c) => {
    const orderId = parseInput(OrderIdSchema, c.req.query("token"));
    const order = await loadOrder(deps.db, orderId);
    let params: Record<string, string> = { paypal: "approved", order: orderId };
    try {
      await onApproved(deps, orderId);
    } catch (e) {
      if (!(e instanceof CoreError)) throw e;
      console.warn(`PayPal return for order ${orderId}: ${e.code} ${e.message}`);
      params = e.code === "IN_PROGRESS" ? { paypal: "pending", order: orderId } : { paypal: "error", order: orderId, code: e.code };
    }
    return c.redirect(customerPage(order.roId, params), 303);
  });

  app.get("/api/paypal/cancel", async (c) => {
    const orderId = parseInput(OrderIdSchema, c.req.query("token"));
    const order = await loadOrder(deps.db, orderId);
    let params: Record<string, string> = { paypal: "cancelled", order: orderId };
    try {
      await onCancelled(deps, orderId);
    } catch (e) {
      if (!(e instanceof CoreError)) throw e;
      console.warn(`PayPal cancel for order ${orderId}: ${e.code} ${e.message}`);
      params = { paypal: "error", order: orderId, code: e.code };
    }
    return c.redirect(customerPage(order.roId, params), 303);
  });

  app.post("/api/ro/:id/pickup", async (c) => {
    const roId = param(c, "id");
    requireDesk(c);
    const body = parseInput(PickupBodySchema, await readJson(c));
    return c.json(withUsd(await pickup(deps, roId, body.performed)));
  });

  app.get("/api/authorizations/:id", async (c) => {
    const id = param(c, "id");
    requireDesk(c);
    return c.json(withUsd(await reconcile(deps, id)));
  });

  app.post("/api/jobs/reauthorize", async (c) => {
    if (!o.jobToken) throw new HttpError(503, "JOB_DISABLED", "the reauthorize job is not configured (JOB_TOKEN is not set)");
    const t = bearer(c);
    if (t === null || !sameToken(t, o.jobToken)) throw unauthorized(c, "a valid bearer token is required");
    return c.json(withUsd(await runReauthorize(deps)));
  });

  app.post("/api/webhooks/paypal", async (c) => {
    const r = await webhooks.receive(await c.req.text(), c.req.header());
    return c.json(r.body, r.status);
  });

  return app;
}
