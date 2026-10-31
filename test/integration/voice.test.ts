import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, MAX_VOICE_BYTES, type VoiceConfig } from "../../src/http/app.js";
import { DEFAULT_EVAL_DIR } from "../../src/agent/samples.js";
import { call, desk, DESK, DESK_TOKEN, dumpTables, makeAppEnv, PUBLIC_BASE, type AppEnv, type Reply } from "../helpers.js";

const NEW_RO = {
  customerLabel: "Dana Demo (made-up)",
  estimateLines: [
    { title: "Front brake pads", priceCents: 26800, source: "desk", urgency: "safety" },
    { title: "Brake fluid flush", priceCents: 14400, source: "desk", urgency: "soon" },
  ],
};

const dirs: string[] = [];
function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** The app env with other voice settings (same database, PayPal fake and clock). */
async function voiceEnv(voice: Partial<VoiceConfig> = {}, judge = {}): Promise<AppEnv> {
  const t = await makeAppEnv();
  const app = createApp({ deps: t.deps, publicBaseUrl: PUBLIC_BASE, deskToken: DESK_TOKEN, webhooks: t.webhooks, voice, judge });
  return { ...t, app };
}

async function newRo(t: AppEnv): Promise<string> {
  const r = await desk(t.app, "POST", "/api/ro", NEW_RO);
  expect(r.status).toBe(201);
  return r.json.repairOrder.id as string;
}

function expectError(r: Reply, status: number, code: string) {
  expect(r.status, r.text).toBe(status);
  expect(r.json).toMatchObject({ code, error: expect.any(String) });
}

/** Raw audio POST as the desk. */
async function sendAudio(t: AppEnv, roId: string, bytes: Uint8Array, contentType: string, headers: Record<string, string> = DESK): Promise<Reply> {
  const res = await t.app.request(`/api/ro/${roId}/voice`, { method: "POST", headers: { ...headers, "content-type": contentType }, body: bytes });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json, text, headers: res.headers };
}

/** A recordings folder with one stored transcript for the uploaded file (it is always written as note.<ext>). */
function fixtureRecordings(text: string): string {
  const dir = tempDir("lbl-rec-");
  mkdirSync(join(dir, "stt"));
  writeFileSync(join(dir, "stt", "fixture.jsonl"), `${JSON.stringify({ id: "note", text, ms: 12 })}\n`);
  return dir;
}

const groqAnswer = (lines: unknown[]) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ lines }) } }] }), { status: 200 });

function liveGroqEnv() {
  vi.stubEnv("LBL_LLM_LIVE", "1");
  vi.stubEnv("GROQ_API_KEY", "fake-test-key-not-real");
}

async function modelCalls(t: AppEnv): Promise<{ day: string; count: number }[]> {
  return (await t.db.query<{ day: string; count: number }>(`SELECT day::text AS day, count FROM model_calls ORDER BY day`)).rows;
}

describe("lines from the price list (priceCode)", () => {
  it("takes the title and price from the list; the description is the customer text", async () => {
    const t = await voiceEnv();
    const roId = await newRo(t);
    const r = await desk(t.app, "POST", `/api/ro/${roId}/lines`, { priceCode: "BRK-ROT-F", urgency: "safety", source: "mechanic", description: "Your front rotors are below the minimum thickness." });
    expect(r.status, r.text).toBe(201);
    expect(r.json.line).toMatchObject({
      priceCode: "BRK-ROT-F",
      title: "Front brake rotors — replace (pair)",
      priceCents: 18600,
      price: "186.00",
      description: "Your front rotors are below the minimum thickness.",
      kind: "added",
      status: "proposed",
    });
    // The same title and price sent along are accepted.
    const same = await desk(t.app, "POST", `/api/ro/${roId}/lines`, { priceCode: "FLT-CABIN", title: "Cabin air filter — replace", priceCents: 3900, source: "mechanic" });
    expect(same.status, same.text).toBe(201);
    expect(same.json.line).toMatchObject({ priceCode: "FLT-CABIN", priceCents: 3900, description: "" });
  });

  it("refuses an unknown code, and a title or price that differs from the list", async () => {
    const t = await voiceEnv();
    const roId = await newRo(t);
    const unknown = await desk(t.app, "POST", `/api/ro/${roId}/lines`, { priceCode: "NOT-A-CODE", source: "mechanic" });
    expectError(unknown, 400, "VALIDATION");
    expect(unknown.json.details.issues).toEqual([{ path: "priceCode", message: "NOT-A-CODE is not in the price list" }]);
    const price = await desk(t.app, "POST", `/api/ro/${roId}/lines`, { priceCode: "BRK-ROT-F", priceCents: 15000, source: "mechanic" });
    expectError(price, 400, "VALIDATION");
    expect(price.json.details.issues[0].path).toBe("priceCents");
    const title = await desk(t.app, "POST", `/api/ro/${roId}/lines`, { priceCode: "BRK-ROT-F", title: "Rotors (cheap)", source: "mechanic" });
    expectError(title, 400, "VALIDATION");
    expect(title.json.details.issues[0].path).toBe("title");
    const long = await desk(t.app, "POST", `/api/ro/${roId}/lines`, { priceCode: "BRK-ROT-F", source: "mechanic", description: "x".repeat(301) });
    expectError(long, 400, "VALIDATION");
    const nothing = await desk(t.app, "POST", `/api/ro/${roId}/lines`, { source: "mechanic" });
    expectError(nothing, 400, "VALIDATION");
    expect(nothing.json.details.issues.map((i: { path: string }) => i.path).sort()).toEqual(["priceCents", "title"]);
    const state = await desk(t.app, "GET", `/api/ro/${roId}`);
    expect(state.json.lines.filter((l: { kind: string }) => l.kind === "added")).toEqual([]);
  });

  it("cleans a customer text that names a price (the screen shows the list price only)", async () => {
    const t = await voiceEnv();
    const roId = await newRo(t);
    const r = await desk(t.app, "POST", `/api/ro/${roId}/lines`, { priceCode: "BRK-ROT-F", source: "mechanic", description: "About $150 for both rotors." });
    expect(r.status).toBe(201);
    expect(r.json.line.description).toBe("Front brake rotors — replace (pair)");
  });

  it("a line by hand without a code works as before", async () => {
    const t = await voiceEnv();
    const roId = await newRo(t);
    const r = await desk(t.app, "POST", `/api/ro/${roId}/lines`, { title: "Front brake rotors", priceCents: 20000, source: "mechanic", description: "About $200." });
    expect(r.status).toBe(201);
    expect(r.json.line).toMatchObject({ priceCode: null, title: "Front brake rotors", priceCents: 20000, description: "About $200." });
  });

  it("estimate lines take codes too; the PayPal order item carries the list name and price", async () => {
    const t = await voiceEnv();
    const bad = await desk(t.app, "POST", "/api/ro", { customerLabel: "A", estimateLines: [{ priceCode: "BRK-PAD-F", source: "desk" }, { priceCode: "NOPE", source: "desk" }] });
    expectError(bad, 400, "VALIDATION");
    expect(bad.json.details.issues).toEqual([{ path: "estimateLines.1.priceCode", message: "NOPE is not in the price list" }]);
    expect((await t.db.query(`SELECT 1 FROM repair_orders`)).rows).toEqual([]);
    const r = await desk(t.app, "POST", "/api/ro", { customerLabel: "A", estimateLines: [{ priceCode: "BRK-PAD-F", source: "desk" }] });
    expect(r.status, r.text).toBe(201);
    expect(r.json.lines[0]).toMatchObject({ priceCode: "BRK-PAD-F", priceCents: 18900, title: "Front brake pads — replace" });
    const a = await desk(t.app, "POST", `/api/ro/${r.json.repairOrder.id}/estimate/approval`, { approverName: "Dana Demo", channel: "qr_page", esignConsent: true });
    expect(a.status).toBe(201);
    const items = t.fake.orders.get(a.json.order.id)!.req.purchase_units[0]!.items as { name: string; unit_amount: { value: string } }[];
    expect(items).toEqual([expect.objectContaining({ name: "Front brake pads — replace", unit_amount: { currency_code: "USD", value: "189.00" } })]);
  });
});

describe("POST /api/ro/:id/lines/draft", () => {
  it("drafts with keywords by default, creates nothing, and never puts a sum in the customer text", async () => {
    const t = await voiceEnv();
    const roId = await newRo(t);
    const text = "Front pads are down to about two millimeters. The wipers are streaking.";
    const r = await desk(t.app, "POST", `/api/ro/${roId}/lines/draft`, { text });
    expect(r.status, r.text).toBe(200);
    expect(r.json).toMatchObject({ transcript: text, provider: "keywords", ms: 0, droppedCodes: [], priceTextCodes: [] });
    expect(r.json.lines).toEqual([
      { priceCode: "BRK-PAD-F", name: "Front brake pads — replace", cents: 18900, usd: "189.00", amount: "189.00", urgency: "safety", customerText: "Front brake pads — replace" },
      { priceCode: "WIPER-F", name: "Front wiper blades — replace", cents: 4900, usd: "49.00", amount: "49.00", urgency: "safety", customerText: "Front wiper blades — replace" },
    ]);
    for (const l of r.json.lines) expect(l.customerText).not.toMatch(/[$€£]|\d+\.\d\d|dollar|usd|cents?\b/i);
    const state = await desk(t.app, "GET", `/api/ro/${roId}`);
    expect(state.json.lines).toHaveLength(2);
    // The mechanic confirms a drafted line by its code.
    const add = await desk(t.app, "POST", `/api/ro/${roId}/lines`, { priceCode: r.json.lines[0].priceCode, urgency: r.json.lines[0].urgency, source: "mechanic", description: r.json.lines[0].customerText });
    expect(add.status).toBe(201);
    expect(add.json.line).toMatchObject({ priceCode: "BRK-PAD-F", priceCents: 18900 });
  });

  it("validates the text, the media type, the token and the repair order", async () => {
    const t = await voiceEnv();
    const roId = await newRo(t);
    expectError(await desk(t.app, "POST", `/api/ro/${roId}/lines/draft`, { text: "   " }), 400, "VALIDATION");
    expectError(await desk(t.app, "POST", `/api/ro/${roId}/lines/draft`, { text: "x".repeat(1001) }), 400, "VALIDATION");
    expect((await desk(t.app, "POST", `/api/ro/${roId}/lines/draft`, { text: "x".repeat(1000) })).status).toBe(200);
    expectError(await desk(t.app, "POST", `/api/ro/${roId}/lines/draft`, "text=front pads", { "content-type": "text/plain" }), 415, "UNSUPPORTED_MEDIA_TYPE");
    expectError(await call(t.app, "POST", `/api/ro/${roId}/lines/draft`, { text: "front pads" }), 401, "UNAUTHORIZED");
    expectError(await desk(t.app, "POST", "/api/ro/ro_missing/lines/draft", { text: "front pads" }), 404, "NOT_FOUND");
  });

  it("a live provider's customer text with a price is replaced by the item name", async () => {
    liveGroqEnv();
    vi.stubGlobal("fetch", vi.fn(async () => groqAnswer([{ code: "BRK-PAD-F", urgency: "safety", customerText: "Pads run about $150." }, { code: "MADE-UP", urgency: "soon", customerText: "?" }])));
    const t = await voiceEnv({ llm: "groq:openai/gpt-oss-120b" });
    const roId = await newRo(t);
    const r = await desk(t.app, "POST", `/api/ro/${roId}/lines/draft`, { text: "Front pads are at two mil." });
    expect(r.status, r.text).toBe(200);
    expect(r.json).toMatchObject({ provider: "groq:openai/gpt-oss-120b", droppedCodes: ["MADE-UP"], priceTextCodes: ["BRK-PAD-F"] });
    expect(r.json.lines).toEqual([expect.objectContaining({ priceCode: "BRK-PAD-F", cents: 18900, customerText: "Front brake pads — replace" })]);
  });

  it("a provider failure is 502 MODEL_ERROR and does not leak the key", async () => {
    liveGroqEnv();
    vi.stubGlobal("fetch", vi.fn(async () => new Response('{"error":"bad gateway"}', { status: 502 })));
    const t = await voiceEnv({ llm: "groq:openai/gpt-oss-20b" });
    const roId = await newRo(t);
    const r = await desk(t.app, "POST", `/api/ro/${roId}/lines/draft`, { text: "Front pads are thin." });
    expectError(r, 502, "MODEL_ERROR");
    expect(r.text).not.toContain("fake-test-key-not-real");
  });
});

describe("POST /api/ro/:id/voice (live audio)", () => {
  it("503 VOICE_DISABLED when speech recognition is not configured", async () => {
    const t = await voiceEnv();
    const roId = await newRo(t);
    const r = await sendAudio(t, roId, new Uint8Array(1000).fill(1), "audio/webm");
    expectError(r, 503, "VOICE_DISABLED");
    expect(r.json.error).toBe("speech recognition is not configured");
  });

  it("415 on other media types, 400 on an empty body, 401 without a token", async () => {
    const tmp = tempDir("lbl-voice-tmp-");
    const t = await voiceEnv({ stt: "recorded:fixture", recordingsDir: fixtureRecordings("Front pads are thin."), tmpDir: tmp });
    const roId = await newRo(t);
    for (const type of ["audio/flac", "text/plain", "application/json", "video/webm", ""]) expectError(await sendAudio(t, roId, new Uint8Array(100).fill(1), type), 415, "UNSUPPORTED_MEDIA_TYPE");
    expectError(await sendAudio(t, roId, new Uint8Array(0), "audio/wav"), 400, "VALIDATION");
    expectError(await sendAudio(t, roId, new Uint8Array(100).fill(1), "audio/wav", {}), 401, "UNAUTHORIZED");
    expect(readdirSync(tmp)).toEqual([]);
  });

  it("413 above 2 MB on this route only; above the 256 KB JSON limit is fine here", async () => {
    const tmp = tempDir("lbl-voice-tmp-");
    const t = await voiceEnv({ stt: "recorded:fixture", recordingsDir: fixtureRecordings("Front pads are down to two millimeters."), tmpDir: tmp });
    const roId = await newRo(t);
    expectError(await sendAudio(t, roId, new Uint8Array(MAX_VOICE_BYTES + 1).fill(1), "audio/webm"), 413, "TOO_LARGE");
    expectError(await sendAudio(t, roId, new Uint8Array(MAX_VOICE_BYTES + 1).fill(1), "audio/webm", { ...DESK, "content-length": String(MAX_VOICE_BYTES + 1) }), 413, "TOO_LARGE");
    const big = await sendAudio(t, roId, new Uint8Array(1_500_000).fill(1), "audio/webm;codecs=opus");
    expect(big.status, big.text).toBe(200);
    // Other routes keep the 256 KB limit.
    expectError(await desk(t.app, "POST", `/api/ro/${roId}/lines/draft`, { text: "x".repeat(300 * 1024) }), 413, "TOO_LARGE");
    expect(readdirSync(tmp)).toEqual([]);
  });

  it("with a recorded speech provider: the draft, the transcript; the temporary file is gone; nothing is stored", async () => {
    const tmp = tempDir("lbl-voice-tmp-");
    const transcript = "Front pads are down to two millimeters, rotors look fine.";
    const t = await voiceEnv({ stt: "recorded:fixture", recordingsDir: fixtureRecordings(transcript), tmpDir: tmp });
    const roId = await newRo(t);
    const r = await sendAudio(t, roId, new Uint8Array(4000).fill(7), "audio/mp4");
    expect(r.status, r.text).toBe(200);
    expect(r.json).toMatchObject({ transcript, provider: "keywords", stt: "recorded:fixture", ms: 12, timings: { sttMs: 12, llmMs: 0 } });
    expect(r.json.lines).toEqual([expect.objectContaining({ priceCode: "BRK-PAD-F", cents: 18900, usd: "189.00", urgency: "safety" })]);
    expect(readdirSync(tmp)).toEqual([]);
    // Neither the audio nor the transcript is kept anywhere in the database.
    const tables = await dumpTables(t.db);
    expect(tables).not.toContain("two millimeters");
    expect((await desk(t.app, "GET", `/api/ro/${roId}`)).json.lines).toHaveLength(2);
  });

  it("the temporary file is removed when speech recognition fails too", async () => {
    const tmp = tempDir("lbl-voice-tmp-");
    const rec = tempDir("lbl-rec-");
    mkdirSync(join(rec, "stt"));
    writeFileSync(join(rec, "stt", "fixture.jsonl"), `${JSON.stringify({ id: "F01", text: "not this file", ms: 1 })}\n`);
    const t = await voiceEnv({ stt: "recorded:fixture", recordingsDir: rec, tmpDir: tmp });
    const roId = await newRo(t);
    const r = await sendAudio(t, roId, new Uint8Array(500).fill(3), "audio/ogg");
    expectError(r, 502, "MODEL_ERROR");
    expect(readdirSync(tmp)).toEqual([]);
  });
});

describe("samples", () => {
  it("a sample set with a note that has no recorded transcript stops the app at start", async () => {
    const evalDir = tempDir("lbl-eval-");
    mkdirSync(join(evalDir, "audio"));
    mkdirSync(join(evalDir, "recordings", "stt"), { recursive: true });
    copyFileSync(join(DEFAULT_EVAL_DIR, "findings.json"), join(evalDir, "findings.json"));
    copyFileSync(join(DEFAULT_EVAL_DIR, "audio", "manifest.json"), join(evalDir, "audio", "manifest.json"));
    writeFileSync(join(evalDir, "recordings", "stt", "parakeet-local.jsonl"), `${JSON.stringify({ id: "F01", text: "x", ms: 1 })}\n`);
    await expect(voiceEnv({ evalDir })).rejects.toThrow(/sample F02 has no recorded transcript/);
  });

  it("GET /api/samples lists the 32 synthetic notes with text, voice and audio link (public)", async () => {
    const t = await voiceEnv();
    const r = await call(t.app, "GET", "/api/samples");
    expect(r.status).toBe(200);
    expect(r.json.samples).toHaveLength(32);
    expect(r.json.samples[0]).toEqual({
      id: "F01",
      text: "Front pads are down to about two millimeters. Rotors look fine though.",
      voice: "Eddy (English (US))",
      audioUrl: "/api/samples/F01.wav",
      synthetic: true,
    });
  });

  it("GET /api/samples/:id.wav serves the file; paths and other ids are 404", async () => {
    const t = await voiceEnv();
    const res = await t.app.request("/api/samples/F07.wav");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/wav");
    const body = new Uint8Array(await res.arrayBuffer());
    const file = new URL("../../eval/audio/F07.wav", import.meta.url);
    expect(body.byteLength).toBe(statSync(file).size);
    expect(Buffer.from(body.subarray(0, 4)).toString("ascii")).toBe("RIFF");
    for (const path of ["/api/samples/F99.wav", "/api/samples/F1.wav", "/api/samples/F07.WAV", "/api/samples/F07", "/api/samples/manifest.json", "/api/samples/..%2F..%2Fpackage.json", "/api/samples/..%2Ffindings.json", "/api/samples/%2E%2E%2Fmanifest.json"]) {
      expectError(await call(t.app, "GET", path), 404, "NOT_FOUND");
    }
    // Dot segments are resolved by the URL parser before routing: nothing outside /api/samples is reached.
    expect((await call(t.app, "GET", "/api/samples/../../package.json")).status).toBe(404);
  });

  it("POST /api/ro/:id/voice/sample/:id: recorded speech recognition and keywords, marked as recorded", async () => {
    const t = await voiceEnv();
    const roId = await newRo(t);
    const r = await desk(t.app, "POST", `/api/ro/${roId}/voice/sample/F13`);
    expect(r.status, r.text).toBe(200);
    expect(r.json).toMatchObject({
      transcript: "Front struts are leaking and the car keeps bouncing after bumps.",
      sampleId: "F13",
      source: "recorded",
      recordings: { stt: "recorded:parakeet-local", llm: "keywords" },
      provider: "keywords",
    });
    expect(r.json.lines).toEqual([expect.objectContaining({ priceCode: "SUSP-STRUT-F", cents: 68900 })]);
    expectError(await desk(t.app, "POST", `/api/ro/${roId}/voice/sample/F99`), 404, "NOT_FOUND");
    expectError(await desk(t.app, "POST", `/api/ro/${roId}/voice/sample/x`), 404, "NOT_FOUND");
    expectError(await call(t.app, "POST", `/api/ro/${roId}/voice/sample/F13`), 401, "UNAUTHORIZED");
    expect(await modelCalls(t)).toEqual([]);
  });

  it("uses the recorded line answers of LBL_LLM_RECORDED when the sample has one, keywords otherwise", async () => {
    // A copy of the benchmark set (notes, manifest, recorded transcripts; the samples here never read their audio) plus line answers for F13.
    const evalDir = tempDir("lbl-eval-");
    for (const d of ["audio", "recordings/stt", "recordings/llm"]) mkdirSync(join(evalDir, d), { recursive: true });
    copyFileSync(join(DEFAULT_EVAL_DIR, "findings.json"), join(evalDir, "findings.json"));
    copyFileSync(join(DEFAULT_EVAL_DIR, "audio", "manifest.json"), join(evalDir, "audio", "manifest.json"));
    copyFileSync(join(DEFAULT_EVAL_DIR, "recordings", "stt", "parakeet-local.jsonl"), join(evalDir, "recordings", "stt", "parakeet-local.jsonl"));
    writeFileSync(join(evalDir, "recordings", "llm", "gptoss.jsonl"), `${JSON.stringify({ id: "F13", lines: [{ code: "SUSP-STRUT-F", urgency: "soon", customerText: "Your front struts leak; it costs $689." }], ms: 410 })}\n`);
    const t = await voiceEnv({ llmRecorded: "gptoss", evalDir });
    const roId = await newRo(t);
    const f13 = await desk(t.app, "POST", `/api/ro/${roId}/voice/sample/F13`);
    expect(f13.status, f13.text).toBe(200);
    expect(f13.json).toMatchObject({ recordings: { stt: "recorded:parakeet-local", llm: "recorded:gptoss" }, provider: "recorded:gptoss", priceTextCodes: ["SUSP-STRUT-F"] });
    expect(f13.json.lines).toEqual([expect.objectContaining({ priceCode: "SUSP-STRUT-F", customerText: "Front struts — replace (pair)" })]);
    const f01 = await desk(t.app, "POST", `/api/ro/${roId}/voice/sample/F01`);
    expect(f01.json.recordings).toEqual({ stt: "recorded:parakeet-local", llm: "keywords" });
  });
});

describe("daily ceiling on live model calls", () => {
  it("groq: counted before the call; at the ceiling 429 DAILY_CAP and fetch is never called", async () => {
    liveGroqEnv();
    const fake = vi.fn(async () => groqAnswer([{ code: "BRK-PAD-F", urgency: "safety", customerText: "Pads are thin." }]));
    vi.stubGlobal("fetch", fake);
    const t = await voiceEnv({ llm: "groq:openai/gpt-oss-120b", liveDailyCap: 2 });
    const roId = await newRo(t);
    for (let i = 0; i < 2; i++) expect((await desk(t.app, "POST", `/api/ro/${roId}/lines/draft`, { text: "Front pads are thin." })).status).toBe(200);
    expect(fake).toHaveBeenCalledTimes(2);
    expect(await modelCalls(t)).toEqual([{ day: "2026-11-02", count: 2 }]);
    const over = await desk(t.app, "POST", `/api/ro/${roId}/lines/draft`, { text: "Front pads are thin." });
    expectError(over, 429, "DAILY_CAP");
    expect(fake).toHaveBeenCalledTimes(2);
    expect(await modelCalls(t)).toEqual([{ day: "2026-11-02", count: 2 }]);
    // A new UTC day has a new budget.
    t.clock.advance(24 * 60 * 60 * 1000);
    expect((await desk(t.app, "POST", `/api/ro/${roId}/lines/draft`, { text: "Front pads are thin." })).status).toBe(200);
    expect(await modelCalls(t)).toEqual([
      { day: "2026-11-02", count: 2 },
      { day: "2026-11-03", count: 1 },
    ]);
  });

  it("speech recognition and line drafting both count; a ceiling of 0 refuses before the audio is even written", async () => {
    liveGroqEnv();
    const fake = vi.fn();
    vi.stubGlobal("fetch", fake);
    const tmp = tempDir("lbl-voice-tmp-");
    const zero = await voiceEnv({ stt: "groq:whisper-large-v3-turbo", liveDailyCap: 0, tmpDir: tmp });
    const roId = await newRo(zero);
    expectError(await sendAudio(zero, roId, new Uint8Array(100).fill(1), "audio/webm"), 429, "DAILY_CAP");
    const both = await voiceEnv({ stt: "groq:whisper-large-v3-turbo", llm: "groq:openai/gpt-oss-20b", liveDailyCap: 1, tmpDir: tmp });
    const roId2 = await newRo(both);
    expectError(await sendAudio(both, roId2, new Uint8Array(100).fill(1), "audio/webm"), 429, "DAILY_CAP");
    expect(fake).not.toHaveBeenCalled();
    expect(readdirSync(tmp)).toEqual([]);
    expect(await modelCalls(both)).toEqual([]);
  });

  it("keywords and recorded providers never touch the counter (samples read the benchmark's own recordings)", async () => {
    const tmp = tempDir("lbl-voice-tmp-");
    const t = await voiceEnv({ stt: "recorded:fixture", recordingsDir: fixtureRecordings("Front pads are thin."), tmpDir: tmp, liveDailyCap: 0 });
    const roId = await newRo(t);
    expect((await desk(t.app, "POST", `/api/ro/${roId}/lines/draft`, { text: "Front pads are thin." })).status).toBe(200);
    expect((await sendAudio(t, roId, new Uint8Array(100).fill(1), "audio/wav")).status).toBe(200);
    expect((await desk(t.app, "POST", `/api/ro/${roId}/voice/sample/F01`)).status).toBe(200);
    expect(await modelCalls(t)).toEqual([]);
  });
});
