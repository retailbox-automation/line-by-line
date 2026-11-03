// groqPost on Groq's 429 (the free tier allows 8K tokens a minute): wait as long as `retry-after` says, within a ceiling,
// and send the same request again, as many times as LBL_GROQ_429_RETRIES allows (default 1). No network: fetch is stubbed.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { groqPost } from "./groq.js";

const ok = () => new Response(JSON.stringify({ ok: true }), { status: 200 });
const limited = (after: string | null) => new Response(JSON.stringify({ error: { message: "Rate limit reached" } }), { status: 429, headers: after === null ? {} : { "retry-after": after } });

describe("groqPost on 429", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv("LBL_LLM_LIVE", "1");
    vi.stubEnv("GROQ_API_KEY", "test-key-not-real");
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("waits retry-after and sends the same body again (one retry by default)", async () => {
    const fake = vi.fn().mockResolvedValueOnce(limited("3")).mockResolvedValueOnce(ok());
    vi.stubGlobal("fetch", fake);
    const p = groqPost("/chat/completions", '{"a":1}', "application/json");
    await vi.advanceTimersByTimeAsync(2_900);
    expect(fake).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(200);
    await expect(p).resolves.toEqual({ ok: true });
    expect(fake).toHaveBeenCalledTimes(2);
    expect(fake.mock.calls[1]![1].body).toBe('{"a":1}');
  });

  it("gives up after the allowed retries with the 429 in the error", async () => {
    const fake = vi.fn().mockImplementation(async () => limited("1"));
    vi.stubGlobal("fetch", fake);
    const p = groqPost("/chat/completions", "{}", "application/json");
    const seen = expect(p).rejects.toThrow(/answered 429/);
    await vi.advanceTimersByTimeAsync(5_000);
    await seen;
    expect(fake).toHaveBeenCalledTimes(2);
  });

  it("LBL_GROQ_429_RETRIES sets the number of retries (the benchmark uses more)", async () => {
    vi.stubEnv("LBL_GROQ_429_RETRIES", "3");
    const fake = vi.fn().mockResolvedValueOnce(limited("1")).mockResolvedValueOnce(limited("1")).mockResolvedValueOnce(limited("1")).mockResolvedValueOnce(ok());
    vi.stubGlobal("fetch", fake);
    const p = groqPost("/chat/completions", "{}", "application/json");
    await vi.advanceTimersByTimeAsync(4_000);
    await expect(p).resolves.toEqual({ ok: true });
    expect(fake).toHaveBeenCalledTimes(4);
  });

  it("does not wait when retry-after is missing, unreadable or longer than 60 seconds", async () => {
    for (const after of [null, "soon", "120"]) {
      const fake = vi.fn().mockResolvedValue(limited(after));
      vi.stubGlobal("fetch", fake);
      await expect(groqPost("/chat/completions", "{}", "application/json")).rejects.toThrow(/answered 429/);
      expect(fake, String(after)).toHaveBeenCalledTimes(1);
    }
  });

  it("other errors are not retried", async () => {
    const fake = vi.fn().mockResolvedValue(new Response("bad", { status: 400 }));
    vi.stubGlobal("fetch", fake);
    await expect(groqPost("/chat/completions", "{}", "application/json")).rejects.toThrow(/answered 400/);
    expect(fake).toHaveBeenCalledTimes(1);
  });
});
