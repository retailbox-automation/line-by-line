// Server entry: env config -> database + migrations -> PayPal sandbox client -> Hono app on @hono/node-server.
// Secrets come from the environment only (in production through the secrets vault at start); none are logged.

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve, type ServerType } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { GROQ_LLM_MODELS } from "./agent/lines.js";
import { DEFAULT_LIVE_DAILY_CAP } from "./agent/liveCap.js";
import { RECORDING_NAME } from "./agent/recordings.js";
import { GROQ_STT_MODELS } from "./agent/transcribe.js";
import type { CoreDeps } from "./core/deps.js";
import { migrate, openDb } from "./db/index.js";
import { createApp } from "./http/app.js";
import { DEFAULT_JUDGE_DAILY_SESSIONS } from "./judge/session.js";
import { createPayPalClient } from "./paypal/client.js";
import { dbCallSink } from "./paypal/journal.js";
import { createWebhookReceiver } from "./webhooks/paypal.js";

export const DEFAULT_PORT = 8080;
export const DEFAULT_BRAND_NAME = "Bayside Auto Care";
const MIN_TOKEN_LENGTH = 16;
/** How often the server re-runs webhook events whose processing failed for a passing reason. */
export const WEBHOOK_RETRY_EVERY_MS = 5 * 60 * 1000;

export interface ServerConfig {
  port: number;
  /** PUBLIC_BASE_URL without a trailing slash. */
  publicBaseUrl: string;
  paypalClientId: string;
  paypalClientSecret: string;
  brandName: string;
  webhookId: string | undefined;
  /** Bearer token of the desk and mechanic screens; also the key of the customer page links. */
  deskToken: string;
  jobToken: string | undefined;
  databaseUrl: string | undefined;
  pgliteDir: string | undefined;
  /** LBL_STT (unset = no live voice notes), LBL_LLM, LBL_LLM_RECORDED, LBL_LIVE_DAILY_CAP. */
  voice: { stt: string | undefined; llm: string; llmRecorded: string | undefined; liveDailyCap: number };
  /** LBL_JUDGE_DAILY_SESSIONS, LBL_JUDGE_LIVE_VOICE. */
  judge: { dailySessions: number; liveVoice: boolean };
}

function opt(v: string | undefined): string | undefined {
  const t = v?.trim();
  return t ? t : undefined;
}

const isGroq = (provider: string, models: readonly string[]) => provider.startsWith("groq:") && models.includes(provider.slice("groq:".length));

/** A whole number of 0 or more, or the default when unset; a problem is recorded otherwise. */
function count(env: Record<string, string | undefined>, name: string, fallback: number, problems: string[]): number {
  const raw = opt(env[name]);
  if (raw === undefined) return fallback;
  if (!/^\d{1,9}$/.test(raw)) {
    problems.push(`${name} must be a whole number of 0 or more`);
    return fallback;
  }
  return Number(raw);
}

/** Reads and checks the environment. Throws one error that names every missing or bad variable (never a value). */
export function loadConfig(env: Record<string, string | undefined> = process.env): ServerConfig {
  const problems: string[] = [];
  const clientId = opt(env.PAYPAL_SANDBOX_CLIENT_ID);
  const clientSecret = opt(env.PAYPAL_SANDBOX_CLIENT_SECRET);
  if (!clientId) problems.push("PAYPAL_SANDBOX_CLIENT_ID is not set");
  if (!clientSecret) problems.push("PAYPAL_SANDBOX_CLIENT_SECRET is not set");

  let publicBaseUrl = "";
  const rawBase = opt(env.PUBLIC_BASE_URL);
  if (!rawBase) problems.push("PUBLIC_BASE_URL is not set");
  else {
    try {
      const u = new URL(rawBase);
      if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("not http(s)");
      if (u.search || u.hash) throw new Error("has a query or fragment");
      publicBaseUrl = u.toString().replace(/\/+$/, "");
    } catch (e) {
      problems.push(`PUBLIC_BASE_URL is not a usable http(s) URL (${(e as Error).message})`);
    }
  }

  let port = DEFAULT_PORT;
  const rawPort = opt(env.PORT);
  if (rawPort !== undefined) {
    port = Number(rawPort);
    if (!/^\d+$/.test(rawPort) || !Number.isInteger(port) || port < 1 || port > 65535) problems.push("PORT must be a whole number from 1 to 65535");
  }

  const deskToken = opt(env.DESK_TOKEN);
  if (!deskToken) problems.push("DESK_TOKEN is not set");
  else if (deskToken.length < MIN_TOKEN_LENGTH) problems.push(`DESK_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters`);

  const jobToken = opt(env.JOB_TOKEN);
  if (jobToken !== undefined && jobToken.length < MIN_TOKEN_LENGTH) problems.push(`JOB_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters`);

  const brandName = opt(env.BRAND_NAME) ?? DEFAULT_BRAND_NAME;
  if (brandName.length > 127) problems.push("BRAND_NAME must be at most 127 characters");

  // Voice notes. recorded:<name> speech recognition replays stored answers by file name: tests and local runs only.
  const stt = opt(env.LBL_STT);
  if (stt !== undefined && !(isGroq(stt, GROQ_STT_MODELS) || stt === "local:parakeet" || (stt.startsWith("recorded:") && RECORDING_NAME.test(stt.slice("recorded:".length))))) {
    problems.push(`LBL_STT must be groq:${GROQ_STT_MODELS.join(" | groq:")}, local:parakeet or recorded:<name>`);
  }
  const llm = opt(env.LBL_LLM) ?? "keywords";
  if (llm !== "keywords" && !isGroq(llm, GROQ_LLM_MODELS)) problems.push(`LBL_LLM must be keywords or groq:${GROQ_LLM_MODELS.join(" | groq:")}`);
  const llmRecorded = opt(env.LBL_LLM_RECORDED);
  if (llmRecorded !== undefined && !RECORDING_NAME.test(llmRecorded)) problems.push("LBL_LLM_RECORDED must be a recording name ([A-Za-z0-9._-], not starting with . or -)");
  if ([stt, llm].some((p) => p?.startsWith("groq:")) && (env.LBL_LLM_LIVE !== "1" || !opt(env.GROQ_API_KEY))) {
    problems.push("a groq: provider in LBL_STT or LBL_LLM needs LBL_LLM_LIVE=1 and GROQ_API_KEY (paid calls are off otherwise)");
  }
  const liveDailyCap = count(env, "LBL_LIVE_DAILY_CAP", DEFAULT_LIVE_DAILY_CAP, problems);
  const dailySessions = count(env, "LBL_JUDGE_DAILY_SESSIONS", DEFAULT_JUDGE_DAILY_SESSIONS, problems);
  const liveVoiceRaw = opt(env.LBL_JUDGE_LIVE_VOICE);
  if (liveVoiceRaw !== undefined && liveVoiceRaw !== "1" && liveVoiceRaw !== "0") problems.push("LBL_JUDGE_LIVE_VOICE must be 1 or 0");

  if (problems.length) throw new Error(`configuration: ${problems.join("; ")}`);
  return {
    port,
    publicBaseUrl,
    paypalClientId: clientId!,
    paypalClientSecret: clientSecret!,
    brandName,
    webhookId: opt(env.PAYPAL_WEBHOOK_ID),
    deskToken: deskToken!,
    jobToken,
    databaseUrl: opt(env.DATABASE_URL),
    pgliteDir: opt(env.PGLITE_DIR),
    voice: { stt, llm, llmRecorded, liveDailyCap },
    judge: { dailySessions, liveVoice: liveVoiceRaw === "1" },
  };
}

export interface RunningServer {
  port: number;
  close(): Promise<void>;
}

/** Opens the database, applies pending migrations, and listens. */
export async function startServer(config: ServerConfig): Promise<RunningServer> {
  const db = await openDb({ DATABASE_URL: config.databaseUrl, PGLITE_DIR: config.pgliteDir });
  try {
    const applied = await migrate(db);
    if (applied.length) console.log(`applied migrations: ${applied.join(", ")}`);
  } catch (e) {
    await db.close().catch(() => undefined);
    throw e;
  }
  const paypal = createPayPalClient({
    clientId: config.paypalClientId,
    clientSecret: config.paypalClientSecret,
    brandName: config.brandName,
    onCall: dbCallSink(db),
  });
  const deps: CoreDeps = {
    db,
    paypal,
    now: () => new Date(),
    config: { returnUrl: `${config.publicBaseUrl}/api/paypal/return`, cancelUrl: `${config.publicBaseUrl}/api/paypal/cancel` },
  };
  const webhooks = createWebhookReceiver(deps, config.webhookId);
  const app = createApp({ deps, publicBaseUrl: config.publicBaseUrl, deskToken: config.deskToken, jobToken: config.jobToken, webhooks, voice: config.voice, judge: config.judge });

  const server: ServerType = await new Promise((ok, fail) => {
    const s = serve({ fetch: app.fetch, port: config.port }, () => ok(s));
    s.once("error", fail);
  });
  const port = (server.address() as AddressInfo).port;
  console.log(
    `line-by-line listening on port ${port} (database: ${config.databaseUrl ? "postgres" : "pglite"}, webhooks: ${config.webhookId ? "on" : "off"}, reauthorize job: ${config.jobToken ? "on" : "off"}, speech recognition: ${config.voice.stt ?? "off"}, line drafting: ${config.voice.llm})`,
  );

  // PayPal does not deliver an event again after our 200: events whose processing failed are retried here.
  // One sweep at a time; close() waits for the last one.
  let sweeping: Promise<void> = Promise.resolve();
  const retryWebhooks = () => {
    sweeping = sweeping
      .then(() => webhooks.retryPending())
      .then(
        (n) => {
          if (n) console.log(`webhooks: retried ${n} event(s)`);
        },
        (e: unknown) => console.error(`webhooks: retry sweep failed: ${(e as Error).message}`),
      );
  };
  let retryTimer: NodeJS.Timeout | null = null;
  if (config.webhookId) {
    retryWebhooks();
    retryTimer = setInterval(retryWebhooks, WEBHOOK_RETRY_EVERY_MS);
    retryTimer.unref();
  }

  let closing: Promise<void> | null = null;
  return {
    port,
    close() {
      closing ??= (async () => {
        if (retryTimer) clearInterval(retryTimer);
        await new Promise<void>((ok) => server.close(() => ok()));
        await sweeping;
        await webhooks.idle();
        await db.close();
      })();
      return closing;
    },
  };
}

async function main(): Promise<void> {
  let running: RunningServer;
  try {
    running = await startServer(loadConfig());
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
  const stop = (signal: string) => {
    console.log(`${signal}: shutting down`);
    running.close().then(
      () => process.exit(0),
      (e: unknown) => {
        console.error(`shutdown failed: ${(e as Error).message}`);
        process.exit(1);
      },
    );
  };
  process.once("SIGTERM", () => stop("SIGTERM"));
  process.once("SIGINT", () => stop("SIGINT"));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
