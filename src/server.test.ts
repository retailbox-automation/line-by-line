import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_BRAND_NAME, DEFAULT_PORT, loadConfig, startServer } from "./server.js";

const BASE_ENV = {
  PAYPAL_SANDBOX_CLIENT_ID: "test-client-id",
  PAYPAL_SANDBOX_CLIENT_SECRET: "test-client-secret-value",
  PUBLIC_BASE_URL: "https://lbl.example.test/",
  DESK_TOKEN: "test-desk-token-value-0123",
};

afterEach(() => vi.restoreAllMocks());

describe("loadConfig", () => {
  it("minimal env: port 8080, trailing slash dropped, optional parts off", () => {
    expect(loadConfig(BASE_ENV)).toEqual({
      port: DEFAULT_PORT,
      publicBaseUrl: "https://lbl.example.test",
      paypalClientId: "test-client-id",
      paypalClientSecret: "test-client-secret-value",
      brandName: DEFAULT_BRAND_NAME,
      webhookId: undefined,
      deskToken: "test-desk-token-value-0123",
      jobToken: undefined,
      databaseUrl: undefined,
      pgliteDir: undefined,
      voice: { stt: undefined, llm: "keywords", llmRecorded: undefined, liveDailyCap: 200 },
      judge: { dailySessions: 200, liveVoice: false },
    });
    expect(DEFAULT_PORT).toBe(8080);
  });

  it("reads the voice and judge settings", () => {
    const c = loadConfig({
      ...BASE_ENV,
      LBL_STT: "groq:whisper-large-v3-turbo",
      LBL_LLM: "groq:openai/gpt-oss-120b",
      LBL_LLM_LIVE: "1",
      GROQ_API_KEY: "fake-test-key-not-real",
      LBL_LLM_RECORDED: "groq-gpt-oss-120b",
      LBL_LIVE_DAILY_CAP: "50",
      LBL_JUDGE_DAILY_SESSIONS: "0",
      LBL_JUDGE_LIVE_VOICE: "1",
    });
    expect(c.voice).toEqual({ stt: "groq:whisper-large-v3-turbo", llm: "groq:openai/gpt-oss-120b", llmRecorded: "groq-gpt-oss-120b", liveDailyCap: 50 });
    expect(c.judge).toEqual({ dailySessions: 0, liveVoice: true });
    expect(loadConfig({ ...BASE_ENV, LBL_STT: "recorded:fixture" }).voice.stt).toBe("recorded:fixture");
    expect(loadConfig({ ...BASE_ENV, LBL_STT: "local:parakeet" }).voice.stt).toBe("local:parakeet");
  });

  it("refuses unknown providers, a paid provider without the live flag, and bad numbers", () => {
    expect(() => loadConfig({ ...BASE_ENV, LBL_STT: "whisper" })).toThrow(/LBL_STT must be/);
    expect(() => loadConfig({ ...BASE_ENV, LBL_STT: "recorded:../x" })).toThrow(/LBL_STT must be/);
    expect(() => loadConfig({ ...BASE_ENV, LBL_LLM: "recorded:x" })).toThrow(/LBL_LLM must be keywords or groq:/);
    expect(() => loadConfig({ ...BASE_ENV, LBL_LLM: "groq:llama-3.3-70b-versatile", LBL_LLM_LIVE: "1", GROQ_API_KEY: "k" })).toThrow(/LBL_LLM must be/);
    expect(() => loadConfig({ ...BASE_ENV, LBL_LLM: "groq:openai/gpt-oss-20b" })).toThrow(/needs LBL_LLM_LIVE=1 and GROQ_API_KEY/);
    expect(() => loadConfig({ ...BASE_ENV, LBL_STT: "groq:whisper-large-v3", LBL_LLM_LIVE: "1" })).toThrow(/needs LBL_LLM_LIVE=1 and GROQ_API_KEY/);
    expect(() => loadConfig({ ...BASE_ENV, LBL_LLM_RECORDED: "-x" })).toThrow(/LBL_LLM_RECORDED/);
    expect(() => loadConfig({ ...BASE_ENV, LBL_LIVE_DAILY_CAP: "-1" })).toThrow(/LBL_LIVE_DAILY_CAP/);
    expect(() => loadConfig({ ...BASE_ENV, LBL_JUDGE_DAILY_SESSIONS: "1.5" })).toThrow(/LBL_JUDGE_DAILY_SESSIONS/);
    expect(() => loadConfig({ ...BASE_ENV, LBL_JUDGE_LIVE_VOICE: "yes" })).toThrow(/LBL_JUDGE_LIVE_VOICE/);
  });

  it("reads PORT, PAYPAL_WEBHOOK_ID, JOB_TOKEN, DATABASE_URL, BRAND_NAME", () => {
    const c = loadConfig({ ...BASE_ENV, PORT: "3000", PAYPAL_WEBHOOK_ID: "WH-1", JOB_TOKEN: "j".repeat(16), DATABASE_URL: "postgres://db.example.test/lbl", BRAND_NAME: "Demo Shop" });
    expect(c).toMatchObject({ port: 3000, webhookId: "WH-1", jobToken: "j".repeat(16), databaseUrl: "postgres://db.example.test/lbl", brandName: "Demo Shop" });
    expect(loadConfig({ ...BASE_ENV, PORT: "  " }).port).toBe(8080);
  });

  it("names every missing or bad variable and never echoes a value", () => {
    const secret = "short-token-value";
    let message = "";
    try {
      loadConfig({ PUBLIC_BASE_URL: "ftp://lbl.example.test", PORT: "80a", JOB_TOKEN: secret.slice(0, 10), DESK_TOKEN: secret.slice(0, 12) });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("PAYPAL_SANDBOX_CLIENT_ID is not set");
    expect(message).toContain("PAYPAL_SANDBOX_CLIENT_SECRET is not set");
    expect(message).toContain("PUBLIC_BASE_URL is not a usable http(s) URL");
    expect(message).toContain("PORT must be");
    expect(message).toContain("JOB_TOKEN must be at least 16 characters");
    expect(message).toContain("DESK_TOKEN must be at least 16 characters");
    expect(message).not.toContain(secret.slice(0, 10));
    expect(() => loadConfig({ ...BASE_ENV, PUBLIC_BASE_URL: "https://lbl.example.test/?x=1" })).toThrow(/PUBLIC_BASE_URL/);
    expect(() => loadConfig({ ...BASE_ENV, PORT: "70000" })).toThrow(/PORT/);
    expect(() => loadConfig({ ...BASE_ENV, PUBLIC_BASE_URL: undefined })).toThrow(/PUBLIC_BASE_URL is not set/);
    expect(() => loadConfig({ ...BASE_ENV, DESK_TOKEN: undefined })).toThrow(/DESK_TOKEN is not set/);
  });
});

describe("startServer", () => {
  it("migrates an empty database, listens, answers /healthz, refuses webhooks without PAYPAL_WEBHOOK_ID, closes", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const server = await startServer({ ...loadConfig(BASE_ENV), port: 0 });
    try {
      expect(server.port).toBeGreaterThan(0);
      const health = await fetch(`http://127.0.0.1:${server.port}/healthz`);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ ok: true });
      const ro = await fetch(`http://127.0.0.1:${server.port}/api/ro/ro_none`, { headers: { authorization: `Bearer ${BASE_ENV.DESK_TOKEN}` } });
      expect(ro.status).toBe(404); // the schema exists: migrations ran on start
      expect((await fetch(`http://127.0.0.1:${server.port}/api/ro/ro_none`)).status).toBe(401);
      const wh = await fetch(`http://127.0.0.1:${server.port}/api/webhooks/paypal`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      expect(wh.status).toBe(503);
    } finally {
      await server.close();
    }
  });
});
