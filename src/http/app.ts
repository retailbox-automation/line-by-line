// HTTP API for the screens (desk, mechanic, customer page). Contract: docs/api.md.
// JSON in and out; errors are {error, code[, details]}; money is cents plus a "184.00" string; no payer data.
// Bodies are validated by the zod schemas of the core functions (the casts below only satisfy the compiler).
// Access: the desk and mechanic screens send DESK_TOKEN; the customer page sends its repair order's own token (from
// the customer link), which opens only that repair order and only the customer's steps; a judge session (token or
// cookie) has the desk's rights on the repair orders created in that session only. PayPal's redirects and webhooks
// need no token (the webhook is checked by its signature).

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getCookie, setCookie } from "hono/cookie";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import { AgentError } from "../agent/groq.js";
import { draftLines } from "../agent/lines.js";
import { DailyCapError, DEFAULT_LIVE_DAILY_CAP, isLiveProvider, takeLiveCalls } from "../agent/liveCap.js";
import { loadPriceList } from "../agent/priceList.js";
import { hasRecording } from "../agent/recordings.js";
import { DEFAULT_EVAL_DIR, loadSamples, SAMPLE_ID, SAMPLE_STT, sampleRecordingsDir } from "../agent/samples.js";
import { priceLines, voiceToLines, type PricedLine } from "../agent/voice.js";
import { toPayPal } from "../money.js";
import { createJudgeDemo } from "../judge/demo.js";
import { listPool, reauthorizeNext } from "../judge/pool.js";
import { createJudgeSession, DEFAULT_JUDGE_DAILY_SESSIONS, JUDGE_COOKIE, JUDGE_SESSION_MS, judgeSessionAlive, looksLikeJudgeToken, signJudgeToken, verifyJudgeToken } from "../judge/session.js";
import {
  addLine,
  CoreError,
  createEstimateOrder,
  createRepairOrder,
  decide,
  getRepairOrder,
  loadAuthorization,
  loadOrder,
  loadRepairOrder,
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
import { HttpError } from "./errors.js";
import { mountPages } from "./pages.js";
import { clientAddress, windowLimiter } from "./rateLimit.js";
import { withUsd } from "./serialize.js";

/** Largest request body (a repair order with 50 estimate lines and long descriptions fits). */
export const MAX_BODY_BYTES = 256 * 1024;
/** Largest voice note upload (POST /api/ro/:id/voice only). */
export const MAX_VOICE_BYTES = 2 * 1024 * 1024;
const VOICE_PATH = /^\/api\/ro\/[^/]+\/voice$/;
/** Webhook requests per client address and minute; each may cost a verify-webhook-signature call at PayPal. */
export const WEBHOOK_RATE_PER_MINUTE = 60;
/** Judge sessions one client address may start in an hour (the daily cap still applies to everyone together). */
export const JUDGE_SESSIONS_PER_HOUR = 10;
/** Audio types the voice route takes, and the file extension the upload is written with. */
const AUDIO_EXT: Record<string, string> = { "audio/webm": ".webm", "audio/mp4": ".m4a", "audio/mpeg": ".mp3", "audio/wav": ".wav", "audio/ogg": ".ogg" };

const STATUS: Record<CoreErrorCode, ContentfulStatusCode> = { NOT_FOUND: 404, VALIDATION: 400, CONFLICT: 409, IN_PROGRESS: 409, PAYPAL: 502 };

const IdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "not a valid id");
const OrderIdSchema = z.string({ error: "token is required" }).regex(/^[A-Za-z0-9-]{1,64}$/, "token is not a PayPal order id");
const PickupBodySchema = z.object({ performed: PerformedSchema });
const DraftBodySchema = z.object({ text: z.string().trim().min(1).max(1000) });

export interface VoiceConfig {
  /** LBL_STT: speech recognition of POST /api/ro/:id/voice. Unset = that route answers 503 VOICE_DISABLED. */
  stt: string | undefined;
  /** LBL_LLM: line drafting from a note (default `keywords`, no model). */
  llm: string;
  /** LBL_LLM_RECORDED: name of the recorded line answers used for the samples when one exists for the sample. */
  llmRecorded: string | undefined;
  /** LBL_LIVE_DAILY_CAP: live (`groq:*`) model calls per UTC day, default 200. */
  liveDailyCap: number;
  /** Folder the `recorded:` providers of the live voice route read (default <evalDir>/recordings; tests use their own). */
  recordingsDir: string;
  /** The benchmark set behind the samples (default eval): notes, audio, and the recorded answers in <evalDir>/recordings. */
  evalDir: string;
  /** Where an uploaded voice note is written for the length of one request (default the OS temp folder). */
  tmpDir: string;
}

export interface JudgeConfig {
  /** LBL_JUDGE_DAILY_SESSIONS: new judge sessions per UTC day, default 200. */
  dailySessions: number;
  /** LBL_JUDGE_LIVE_VOICE=1: a judge may also send live audio; default no (samples only). */
  liveVoice: boolean;
}

export interface AppOptions {
  deps: CoreDeps;
  /** Public origin of the app (no trailing slash needed): the customer page is PUBLIC_BASE_URL/c/:roId. */
  publicBaseUrl: string;
  /** DESK_TOKEN: bearer token of the desk and mechanic screens, and the key of the customer page and judge tokens. */
  deskToken: string;
  /** JOB_TOKEN: bearer token of POST /api/jobs/reauthorize. Unset = the job route answers 503. */
  jobToken?: string | undefined;
  webhooks: WebhookReceiver;
  voice?: Partial<VoiceConfig>;
  judge?: Partial<JudgeConfig>;
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

type Caller = "desk" | "judge" | "customer";

/** The customer page may decide only as the customer: a decision "made at the desk" needs the desk token. */
function refuseDeskChannel(caller: Caller, body: unknown): void {
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

/** A failure of speech recognition or line drafting (provider error, no answer, refused live call). */
function modelFailure(e: unknown): unknown {
  return e instanceof AgentError ? new HttpError(502, "MODEL_ERROR", `speech recognition or line drafting failed: ${e.message}`) : e;
}

/** The draft the mechanic confirms line by line (POST /api/ro/:id/lines with each priceCode). Nothing is stored. */
function draftBody(d: { transcript: string; lines: PricedLine[]; droppedCodes: string[]; priceTextCodes: string[] }, provider: string, ms: number, extra: Record<string, unknown> = {}): unknown {
  return withUsd({
    transcript: d.transcript,
    lines: d.lines.map((l) => ({ priceCode: l.code, name: l.title, cents: l.priceCents, usd: toPayPal(l.priceCents), urgency: l.urgency, customerText: l.customerText })),
    droppedCodes: d.droppedCodes,
    priceTextCodes: d.priceTextCodes,
    provider,
    ms,
    ...extra,
  });
}

function checkCount(name: string, n: number): number {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`createApp: ${name} must be a whole number of 0 or more`);
  return n;
}

export function createApp(o: AppOptions): Hono {
  const { deps, webhooks, deskToken } = o;
  if (!deskToken || deskToken.length < 16) throw new Error("createApp: a deskToken of at least 16 characters is required");
  const base = new URL(o.publicBaseUrl).toString().replace(/\/+$/, "");
  const evalDir = o.voice?.evalDir ?? DEFAULT_EVAL_DIR;
  const voice: VoiceConfig = {
    stt: o.voice?.stt,
    llm: o.voice?.llm ?? "keywords",
    llmRecorded: o.voice?.llmRecorded,
    liveDailyCap: checkCount("voice.liveDailyCap", o.voice?.liveDailyCap ?? DEFAULT_LIVE_DAILY_CAP),
    recordingsDir: o.voice?.recordingsDir ?? sampleRecordingsDir(evalDir),
    evalDir,
    tmpDir: o.voice?.tmpDir ?? tmpdir(),
  };
  const sampleRecordings = sampleRecordingsDir(evalDir);
  const judge: JudgeConfig = {
    dailySessions: checkCount("judge.dailySessions", o.judge?.dailySessions ?? DEFAULT_JUDGE_DAILY_SESSIONS),
    liveVoice: o.judge?.liveVoice ?? false,
  };
  const priceList = loadPriceList();
  // Read once: a missing or inconsistent sample set stops the app at start, not in front of a judge.
  const samples = loadSamples(voice.evalDir);
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
  /**
   * The judge session of this request: a judge token as the bearer, or the `lbl_judge` cookie when there is no bearer
   * at all. Null when neither is there; 401 when one is there but forged, expired or of an ended session.
   */
  const judgeSession = async (c: Context): Promise<string | null> => {
    const t = bearer(c);
    const token = t !== null ? (looksLikeJudgeToken(t) ? t : null) : (getCookie(c, JUDGE_COOKIE) ?? null);
    if (token === null) return null;
    const now = deps.now();
    const v = verifyJudgeToken(deskToken, token, now);
    if (!v || !(await judgeSessionAlive(deps.db, v.sessionId, now))) throw unauthorized(c, "the judge session is not valid or has expired; start a new one (POST /api/judge/session)");
    return v.sessionId;
  };
  const requireJudge = async (c: Context): Promise<string> => {
    const sessionId = await judgeSession(c);
    if (sessionId === null) throw unauthorized(c, "a judge session is required (POST /api/judge/session)");
    return sessionId;
  };
  /** A judge may act only on the repair orders created in its own session. */
  const assertJudgeOwns = async (sessionId: string, roId: string) => {
    const r = (await deps.db.query<{ judge_session_id: string | null }>(`SELECT judge_session_id FROM repair_orders WHERE id = $1`, [roId])).rows[0];
    if (!r) throw new CoreError("NOT_FOUND", `repair order ${roId} not found`, { roId });
    if (r.judge_session_id !== sessionId) throw new HttpError(403, "FORBIDDEN", "this repair order was not created in your judge session");
  };
  /** The desk, or a judge on a repair order of its own session. */
  const requireDeskOrJudge = async (c: Context, roId: string): Promise<"desk" | "judge"> => {
    if (isDesk(c)) return "desk";
    const sessionId = await judgeSession(c);
    if (sessionId === null) throw unauthorized(c, "the desk token or a judge session is required");
    await assertJudgeOwns(sessionId, roId);
    return "judge";
  };
  /** The desk, a judge on its own repair order, or the customer page of this repair order. */
  const requireRoAccess = async (c: Context, roId: string): Promise<Caller> => {
    if (isDesk(c)) return "desk";
    const t = bearer(c);
    if (t !== null && !looksLikeJudgeToken(t)) {
      if (sameToken(t, customerToken(deskToken, roId))) return "customer";
      throw unauthorized(c, "the desk token, a judge session or this repair order's customer token is required");
    }
    const sessionId = await judgeSession(c);
    if (sessionId === null) throw unauthorized(c, "the desk token, a judge session or this repair order's customer token is required");
    await assertJudgeOwns(sessionId, roId);
    return "judge";
  };

  /** The desk (and a judge) also gets the customer link (QR / text message) with the repair order's customer token. */
  const stateBody = (state: RepairOrderState, caller: Caller): unknown =>
    withUsd({
      ...state,
      fl: flFlags(state),
      ...(caller !== "customer" ? { customerUrl: customerPage(state.repairOrder.id, { k: customerToken(deskToken, state.repairOrder.id) }) } : {}),
    });

  /** Takes today's live model calls for these providers (`groq:*` only), before any of them is called. */
  const takeLive = async (...providers: string[]) => {
    const n = providers.filter(isLiveProvider).length;
    if (n > 0) await takeLiveCalls(deps.db, deps.now(), n, voice.liveDailyCap);
  };

  const tooLarge = (max: number) => (c: Context) => c.json({ error: `body larger than ${max} bytes`, code: "TOO_LARGE" }, 413);
  const jsonLimit = bodyLimit({ maxSize: MAX_BODY_BYTES, onError: tooLarge(MAX_BODY_BYTES) });
  const voiceLimit = bodyLimit({ maxSize: MAX_VOICE_BYTES, onError: tooLarge(MAX_VOICE_BYTES) });
  app.use("*", (c, next) => (VOICE_PATH.test(c.req.path) ? voiceLimit(c, next) : jsonLimit(c, next)));

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message, code: err.code, ...(err.details ? { details: withUsd(err.details) } : {}) }, err.status);
    if (err instanceof DailyCapError) return c.json({ error: err.message, code: "DAILY_CAP" }, 429);
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
    const caller = await requireRoAccess(c, roId);
    return c.json(stateBody(await getRepairOrder(deps, roId), caller));
  });

  app.post("/api/ro/:id/estimate/approval", async (c) => {
    const roId = param(c, "id");
    const caller = await requireRoAccess(c, roId);
    const body = await readJson(c);
    refuseDeskChannel(caller, body);
    const { order, created } = await createEstimateOrder(deps, roId, body as ConsentInput);
    return c.json(withUsd({ order, created, approveUrl: order.approveUrl }), created ? 201 : 200);
  });

  app.post("/api/ro/:id/lines", async (c) => {
    const roId = param(c, "id");
    await requireDeskOrJudge(c, roId);
    const line = await addLine(deps, roId, (await readJson(c)) as LineInput);
    return c.json(withUsd({ line }), 201);
  });

  // A mechanic's note as text -> draft lines from the price list. Creates nothing.
  app.post("/api/ro/:id/lines/draft", async (c) => {
    const roId = param(c, "id");
    await requireDeskOrJudge(c, roId);
    await loadRepairOrder(deps.db, roId);
    const { text } = parseInput(DraftBodySchema, await readJson(c));
    await takeLive(voice.llm);
    const d = await draftLines(text, voice.llm, { priceList }).catch((e: unknown) => {
      throw modelFailure(e);
    });
    return c.json(draftBody({ transcript: text, ...priceLines(d.lines, priceList), droppedCodes: d.droppedCodes }, voice.llm, d.ms));
  });

  // A live voice note (raw audio body) -> transcript + draft lines. The audio lives in a 0600 file for this request only.
  app.post("/api/ro/:id/voice", async (c) => {
    const roId = param(c, "id");
    const caller = await requireDeskOrJudge(c, roId);
    if (caller === "judge" && !judge.liveVoice) throw new HttpError(403, "FORBIDDEN", "live voice is off for judge sessions; use a sample (POST /api/ro/:id/voice/sample/:sampleId)");
    await loadRepairOrder(deps.db, roId);
    if (!voice.stt) throw new HttpError(503, "VOICE_DISABLED", "speech recognition is not configured");
    const type = (c.req.header("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    const ext = AUDIO_EXT[type];
    if (!ext) throw new HttpError(415, "UNSUPPORTED_MEDIA_TYPE", `send the audio as one of ${Object.keys(AUDIO_EXT).join(", ")}`);
    const audio = new Uint8Array(await c.req.arrayBuffer());
    if (audio.byteLength === 0) throw new CoreError("VALIDATION", "the audio is empty");
    await takeLive(voice.stt, voice.llm);
    const dir = await mkdtemp(join(voice.tmpDir, "lbl-voice-"));
    try {
      const file = join(dir, `note${ext}`);
      await writeFile(file, audio, { mode: 0o600, flag: "wx" });
      const r = await voiceToLines(file, { stt: voice.stt, llm: voice.llm }, { recordingsDir: voice.recordingsDir, priceList });
      return c.json(draftBody(r, voice.llm, r.timings.sttMs + r.timings.llmMs, { stt: voice.stt, timings: r.timings }));
    } catch (e) {
      throw modelFailure(e);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // A ready-made sample note: recorded speech recognition, recorded lines when there are some, else keywords. No live call.
  app.post("/api/ro/:id/voice/sample/:sampleId", async (c) => {
    const roId = param(c, "id");
    await requireDeskOrJudge(c, roId);
    await loadRepairOrder(deps.db, roId);
    const sampleId = c.req.param("sampleId");
    const sample = SAMPLE_ID.test(sampleId) ? samples.get(sampleId) : undefined;
    if (!sample) throw new CoreError("NOT_FOUND", `no sample ${sampleId}`, { sampleId });
    const llm = voice.llmRecorded && hasRecording(sampleRecordings, "llm", voice.llmRecorded, sample.id) ? `recorded:${voice.llmRecorded}` : "keywords";
    const r = await voiceToLines(sample.path, { stt: SAMPLE_STT, llm }, { recordingsDir: sampleRecordings, priceList }).catch((e: unknown) => {
      throw modelFailure(e);
    });
    return c.json(
      draftBody(r, llm, r.timings.sttMs + r.timings.llmMs, { stt: SAMPLE_STT, timings: r.timings, sampleId: sample.id, source: "recorded", recordings: { stt: SAMPLE_STT, llm } }),
    );
  });

  app.get("/api/samples", (c) =>
    c.json({ samples: [...samples.values()].map((s) => ({ id: s.id, text: s.text, voice: s.voice, audioUrl: `/api/samples/${s.id}.wav`, synthetic: true })) }),
  );

  app.get("/api/samples/:file", async (c) => {
    const m = /^(F[0-9]{2})\.wav$/.exec(c.req.param("file"));
    const sample = m ? samples.get(m[1]!) : undefined;
    if (!sample) throw new CoreError("NOT_FOUND", "no such sample");
    // The path comes from the manifest, never from the request.
    const data = await readFile(sample.path);
    return c.body(new Uint8Array(data), 200, { "content-type": "audio/wav", "cache-control": "public, max-age=3600" });
  });

  app.post("/api/ro/:id/decisions", async (c) => {
    const roId = param(c, "id");
    const caller = await requireRoAccess(c, roId);
    const body = await readJson(c);
    refuseDeskChannel(caller, body);
    const r = await decide(deps, roId, body as DecideInput);
    return c.json(withUsd({ declined: r.declined, order: r.order, approveUrl: r.order?.approveUrl ?? null }));
  });

  app.post("/api/orders/:orderId/refresh", async (c) => {
    const orderId = param(c, "orderId");
    if (!isDesk(c)) {
      const t = bearer(c);
      if (t === null || looksLikeJudgeToken(t)) throw unauthorized(c, "the desk token or the repair order's customer token is required");
      await requireRoAccess(c, (await loadOrder(deps.db, orderId)).roId);
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
    await requireDeskOrJudge(c, roId);
    const body = parseInput(PickupBodySchema, await readJson(c));
    return c.json(withUsd(await pickup(deps, roId, body.performed)));
  });

  app.get("/api/authorizations/:id", async (c) => {
    const id = param(c, "id");
    if (!isDesk(c)) {
      const sessionId = await judgeSession(c);
      if (sessionId === null) throw unauthorized(c, "the desk token or a judge session is required");
      await assertJudgeOwns(sessionId, (await loadAuthorization(deps.db, id)).roId);
    }
    return c.json(withUsd(await reconcile(deps, id)));
  });

  // --- judge mode (API only; the /judge screen comes later) ---

  const judgeSessionLimit = windowLimiter(JUDGE_SESSIONS_PER_HOUR, 3_600_000);
  app.post("/api/judge/session", async (c) => {
    const limit = judgeSessionLimit(clientAddressOf(c), deps.now().getTime());
    if (!limit.ok) {
      c.header("Retry-After", String(Math.ceil(limit.retryAfterMs / 1000)));
      throw new HttpError(429, "RATE_LIMITED", `more than ${JUDGE_SESSIONS_PER_HOUR} judge sessions an hour from this address; try again later`);
    }
    const s = await createJudgeSession(deps, judge.dailySessions);
    const token = signJudgeToken(deskToken, s.id, s.expiresAt.getTime());
    setCookie(c, JUDGE_COOKIE, token, { httpOnly: true, secure: true, sameSite: "Lax", path: "/", maxAge: JUDGE_SESSION_MS / 1000 });
    return c.json({ token, expiresAt: s.expiresAt.toISOString(), liveVoice: judge.liveVoice }, 201);
  });

  app.post("/api/judge/demo", async (c) => {
    const sessionId = await requireJudge(c);
    const { roId, order } = await createJudgeDemo(deps, sessionId, (await readJson(c)) as ConsentInput);
    return c.json(withUsd({ roId, order, approveUrl: order.approveUrl, customerUrl: customerPage(roId, { k: customerToken(deskToken, roId) }) }), 201);
  });

  app.get("/api/judge/pool", async (c) => {
    await requireJudge(c);
    return c.json(withUsd({ holds: await listPool(deps) }));
  });

  app.post("/api/judge/pool/reauthorize-next", async (c) => {
    const sessionId = await requireJudge(c);
    return c.json(withUsd(await reauthorizeNext(deps, sessionId)));
  });

  app.post("/api/jobs/reauthorize", async (c) => {
    if (!o.jobToken) throw new HttpError(503, "JOB_DISABLED", "the reauthorize job is not configured (JOB_TOKEN is not set)");
    const t = bearer(c);
    if (t === null || !sameToken(t, o.jobToken)) throw unauthorized(c, "a valid bearer token is required");
    return c.json(withUsd(await runReauthorize(deps)));
  });

  const webhookLimit = windowLimiter(WEBHOOK_RATE_PER_MINUTE, 60_000);
  app.post("/api/webhooks/paypal", async (c) => {
    const raw = await c.req.text();
    // Only a request that could reach PayPal's verify step is counted: junk (not JSON, no id, no PayPal transmission
    // headers) is refused without a PayPal call anyway, and must not use up a bucket real deliveries may share.
    if (looksLikePayPalDelivery(raw, c.req.header("paypal-transmission-id"), c.req.header("paypal-transmission-sig"))) {
      const limit = webhookLimit(clientAddressOf(c), deps.now().getTime());
      if (!limit.ok) {
        c.header("Retry-After", String(Math.ceil(limit.retryAfterMs / 1000)));
        throw new HttpError(429, "RATE_LIMITED", `more than ${WEBHOOK_RATE_PER_MINUTE} webhook requests a minute from this address; try again later`);
      }
    }
    const r = await webhooks.receive(raw, c.req.header());
    return c.json(r.body, r.status);
  });

  // The screens (HTML of web/, filled by web/app.js from the routes above).
  mountPages(app, {
    db: deps.db,
    requireDeskOrJudge,
    isCustomerToken: (roId, k) => sameToken(k, customerToken(deskToken, roId)),
  });

  return app;
}

/** The client address of a request (see clientAddress): the platform proxy's X-Forwarded-For entry or the socket. */
function clientAddressOf(c: Context): string {
  const socket = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket;
  return clientAddress(c.req.header("x-forwarded-for"), socket?.remoteAddress);
}

/** JSON with a string id and event_type, sent with PayPal's transmission id and signature headers. */
function looksLikePayPalDelivery(raw: string, transmissionId: string | undefined, transmissionSig: string | undefined): boolean {
  if (!transmissionId || !transmissionSig) return false;
  try {
    const e = JSON.parse(raw) as { id?: unknown; event_type?: unknown } | null;
    return !!e && typeof e.id === "string" && typeof e.event_type === "string";
  } catch {
    return false;
  }
}
