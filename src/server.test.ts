import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_BRAND_NAME, DEFAULT_PORT, loadConfig, startServer } from "./server.js";

const BASE_ENV = {
  PAYPAL_SANDBOX_CLIENT_ID: "test-client-id",
  PAYPAL_SANDBOX_CLIENT_SECRET: "test-client-secret-value",
  PUBLIC_BASE_URL: "https://lbl.example.test/",
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
      jobToken: undefined,
      databaseUrl: undefined,
      pgliteDir: undefined,
    });
    expect(DEFAULT_PORT).toBe(8080);
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
      loadConfig({ PUBLIC_BASE_URL: "ftp://lbl.example.test", PORT: "80a", JOB_TOKEN: secret.slice(0, 10) });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("PAYPAL_SANDBOX_CLIENT_ID is not set");
    expect(message).toContain("PAYPAL_SANDBOX_CLIENT_SECRET is not set");
    expect(message).toContain("PUBLIC_BASE_URL is not a usable http(s) URL");
    expect(message).toContain("PORT must be");
    expect(message).toContain("JOB_TOKEN must be at least 16 characters");
    expect(message).not.toContain(secret.slice(0, 10));
    expect(() => loadConfig({ ...BASE_ENV, PUBLIC_BASE_URL: "https://lbl.example.test/?x=1" })).toThrow(/PUBLIC_BASE_URL/);
    expect(() => loadConfig({ ...BASE_ENV, PORT: "70000" })).toThrow(/PORT/);
    expect(() => loadConfig({ ...BASE_ENV, PUBLIC_BASE_URL: undefined })).toThrow(/PUBLIC_BASE_URL is not set/);
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
      const ro = await fetch(`http://127.0.0.1:${server.port}/api/ro/ro_none`);
      expect(ro.status).toBe(404); // the schema exists: migrations ran on start
      const wh = await fetch(`http://127.0.0.1:${server.port}/api/webhooks/paypal`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      expect(wh.status).toBe(503);
    } finally {
      await server.close();
    }
  });
});
