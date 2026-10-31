import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { draftLines, keywordLines } from "./lines.js";
import { loadPriceList } from "./priceList.js";

const list = loadPriceList();

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("keywords provider", () => {
  it("finds a line by alias and reads the urgency from the cue words", async () => {
    const r = await draftLines("Front pads are down to about two millimeters. Rotors look fine though.", "keywords");
    expect(r.lines.map((l) => [l.code, l.urgency])).toEqual([["BRK-PAD-F", "safety"]]);
    expect(r.droppedCodes).toEqual([]);
    expect(r.ms).toBe(0);
  });

  it("matches the first part of the item name too, and treats hyphens as spaces", () => {
    expect(keywordLines("Time for a coolant flush.", list).map((l) => l.code)).toEqual(["COOL-FLUSH"]);
    expect(keywordLines("The front-pads are shot", list).map((l) => l.code)).toEqual(["BRK-PAD-F"]);
  });

  it("returns nothing for a note with no work, and defaults to soon", async () => {
    expect((await draftLines("Everything looks good.", "keywords")).lines).toEqual([]);
    expect((await draftLines("Serpentine belt has cracks.", "keywords")).lines[0]?.urgency).toBe("soon");
  });

  it("refuses an unknown provider", async () => {
    await expect(draftLines("x", "keywords:fast")).rejects.toThrow(/unknown lines provider/);
    await expect(draftLines("x", "some-model")).rejects.toThrow(/unknown lines provider/);
  });
});

describe("recorded provider", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lbl-rec-"));
    mkdirSync(join(dir, "llm"));
    const rows = [
      { id: "N1", lines: [{ code: "BRK-PAD-F", urgency: "safety", customerText: "Pads are thin." }, { code: "MADE-UP", urgency: "soon", customerText: "?" }, { code: "BRK-PAD-F", urgency: "soon", customerText: "again" }], ms: 321 },
    ];
    writeFileSync(join(dir, "llm", "t.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("drops a code that is not in the price list, keeps one line per code (the last mention wins, as in score.py), and keeps the raw answer", async () => {
    const r = await draftLines("ignored", "recorded:t", { id: "N1", recordingsDir: dir });
    expect(r.lines).toEqual([{ code: "BRK-PAD-F", urgency: "soon", customerText: "again" }]);
    expect(r.droppedCodes).toEqual(["MADE-UP"]);
    expect(r.raw).toHaveLength(3);
    expect(r.ms).toBe(321);
  });

  it("fails clearly on a missing id, a missing note, or a bad name", async () => {
    await expect(draftLines("x", "recorded:t", { recordingsDir: dir })).rejects.toThrow(/needs the note id/);
    await expect(draftLines("x", "recorded:t", { id: "N9", recordingsDir: dir })).rejects.toThrow(/no answer for N9/);
    await expect(draftLines("x", "recorded:../t", { id: "N1", recordingsDir: dir })).rejects.toThrow(/bad recording name/);
  });
});

describe("groq provider", () => {
  const chat = (lines: unknown[]) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ lines }) } }] }), { status: 200 });

  it("refuses without LBL_LLM_LIVE=1 and never calls fetch", async () => {
    const fake = vi.fn();
    vi.stubGlobal("fetch", fake);
    vi.stubEnv("GROQ_API_KEY", "fake-test-key-not-real");
    vi.stubEnv("LBL_LLM_LIVE", "");
    await expect(draftLines("Front pads are thin", "groq:openai/gpt-oss-120b")).rejects.toThrow(/LBL_LLM_LIVE=1/);
    vi.stubEnv("LBL_LLM_LIVE", "true");
    await expect(draftLines("Front pads are thin", "groq:openai/gpt-oss-120b")).rejects.toThrow(/LBL_LLM_LIVE=1/);
    expect(fake).not.toHaveBeenCalled();
  });

  it("refuses with the flag but without a key, and never calls fetch", async () => {
    const fake = vi.fn();
    vi.stubGlobal("fetch", fake);
    vi.stubEnv("LBL_LLM_LIVE", "1");
    vi.stubEnv("GROQ_API_KEY", "");
    await expect(draftLines("x", "groq:openai/gpt-oss-20b")).rejects.toThrow(/GROQ_API_KEY/);
    expect(fake).not.toHaveBeenCalled();
  });

  it("refuses a model outside the list without touching fetch", async () => {
    const fake = vi.fn();
    vi.stubGlobal("fetch", fake);
    vi.stubEnv("LBL_LLM_LIVE", "1");
    vi.stubEnv("GROQ_API_KEY", "fake-test-key-not-real");
    await expect(draftLines("x", "groq:llama-3.3-70b-versatile")).rejects.toThrow(/unknown Groq model/);
    await expect(draftLines("x", "groq:")).rejects.toThrow(/unknown Groq model/);
    expect(fake).not.toHaveBeenCalled();
  });

  it("sends a strict JSON schema at temperature 0, with the price list in the prompt and no prices", async () => {
    const fake = vi.fn(async () => chat([{ code: "BRK-PAD-F", urgency: "safety", customerText: "Your front pads are worn." }, { code: "NOT-A-CODE", urgency: "soon", customerText: "?" }]));
    vi.stubGlobal("fetch", fake);
    vi.stubEnv("LBL_LLM_LIVE", "1");
    vi.stubEnv("GROQ_API_KEY", "fake-test-key-not-real");
    const r = await draftLines("Front pads are at two mil.", "groq:openai/gpt-oss-120b");
    expect(fake).toHaveBeenCalledTimes(1);
    const [url, init] = fake.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer fake-test-key-not-real");
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("openai/gpt-oss-120b");
    expect(body.temperature).toBe(0);
    expect(body.response_format.type).toBe("json_schema");
    expect(body.response_format.json_schema.strict).toBe(true);
    expect(body.messages[0].content).toContain("BRK-PAD-F | Front brake pads");
    expect(body.messages[0].content).not.toContain("18900");
    expect(body.messages[1]).toEqual({ role: "user", content: "Front pads are at two mil." });
    expect(r.lines.map((l) => l.code)).toEqual(["BRK-PAD-F"]);
    expect(r.droppedCodes).toEqual(["NOT-A-CODE"]);
  });

  it("does not retry a 4xx and does not leak the key", async () => {
    const fake = vi.fn(async () => new Response('{"error":"invalid api key"}', { status: 401 }));
    vi.stubGlobal("fetch", fake);
    vi.stubEnv("LBL_LLM_LIVE", "1");
    vi.stubEnv("GROQ_API_KEY", "fake-test-key-not-real");
    const err = await draftLines("x", "groq:openai/gpt-oss-20b").catch((e: Error) => e);
    expect((err as Error).message).toMatch(/401/);
    expect((err as Error).message).not.toContain("fake-test-key-not-real");
    expect(fake).toHaveBeenCalledTimes(1);
  });

  it("fails on an answer that is not the lines schema", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => chat([{ code: "BRK-PAD-F", urgency: "urgent!" }])));
    vi.stubEnv("LBL_LLM_LIVE", "1");
    vi.stubEnv("GROQ_API_KEY", "fake-test-key-not-real");
    await expect(draftLines("x", "groq:openai/gpt-oss-20b")).rejects.toThrow(/lines schema/);
  });
});
