import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatReport, parseCli, percentile, runEval } from "./run.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("parity with the Python prototype (docs/2026-10-31-lbl-measure/score.py)", () => {
  it("keywords on the note text: 16/32, precision 0.818, recall 0.545, 0 invented, urgency 18/18", async () => {
    const r = await runEval({ stt: "text", llm: "keywords", writeResults: false });
    expect(r.exact).toBe(16);
    expect(r.notes).toBe(32);
    expect(r.precision.toFixed(3)).toBe("0.818");
    expect(r.recall.toFixed(3)).toBe("0.545");
    expect(r.invented).toBe(0);
    expect(r.urgency).toEqual({ ok: 18, n: 18 });
    expect(r.wer).toBeNull();
    expect(r.rows.filter((n) => !n.ok).map((n) => n.id)).toEqual(["F03", "F06", "F07", "F11", "F14", "F16", "F17", "F18", "F19", "F21", "F22", "F24", "F28", "F29", "F30", "F31"]);
  });

  it("keywords after local speech recognition: 12/32, precision 0.765, recall 0.394, urgency 12/13", async () => {
    const r = await runEval({ stt: "recorded:parakeet-local", llm: "keywords", writeResults: false });
    expect(r.exact).toBe(12);
    expect(r.precision.toFixed(3)).toBe("0.765");
    expect(r.recall.toFixed(3)).toBe("0.394");
    expect(r.invented).toBe(0);
    expect(r.urgency).toEqual({ ok: 12, n: 13 });
    expect(r.rows.filter((n) => !n.ok).map((n) => n.id)).toEqual(["F03", "F06", "F07", "F08", "F09", "F11", "F14", "F16", "F17", "F18", "F19", "F21", "F22", "F23", "F24", "F28", "F29", "F30", "F31", "F32"]);
    // The number normalizer makes "110,000" and "P0420" count as right; the raw Python WER was 0.152 mean, 0.636 max.
    expect(r.wer?.mean).toBeLessThan(0.152);
    expect(r.rows.find((n) => n.id === "F24")?.wer).toBeLessThan(0.3);
    expect(r.rows.find((n) => n.id === "F22")?.wer).toBe(0);
    expect(r.latencyMs.p50).toBe(755); // same upper-median as score.py
  });

  it("prints the summary line for the README", async () => {
    const r = await runEval({ stt: "text", llm: "keywords", writeResults: false });
    expect(r.summary).toBe("keywords on the note text: 16/32 exact notes, precision 0.818, recall 0.545, 0 invented codes, urgency 18/18");
    expect(formatReport(r)).toContain(`Summary: ${r.summary}`);
  });
});

describe("percentile", () => {
  it("is the upper median like score.py", () => {
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(3);
    expect(percentile([5], 0.95)).toBe(5);
    expect(percentile([], 0.5)).toBe(0);
  });
});

describe("parseCli", () => {
  it("defaults to the replay and accepts providers", () => {
    expect(parseCli([])).toMatchObject({ stt: "recorded:parakeet-local", llm: "keywords" });
    expect(parseCli(["--replay"])).toMatchObject({ stt: "recorded:parakeet-local", llm: "keywords" });
    expect(parseCli(["--text"])).toMatchObject({ stt: "text", llm: "keywords" });
    expect(parseCli(["--stt", "groq:whisper-large-v3", "--llm", "groq:openai/gpt-oss-20b", "--record", "run1"])).toMatchObject({ stt: "groq:whisper-large-v3", llm: "groq:openai/gpt-oss-20b", record: "run1" });
  });

  it("refuses --text with --stt or --replay, and unknown flags", () => {
    expect(() => parseCli(["--text", "--stt", "recorded:x"])).toThrow(/cannot be combined/);
    expect(() => parseCli(["--text", "--replay"])).toThrow(/cannot be combined/);
    expect(() => parseCli(["--live"])).toThrow();
  });
});

describe("live providers and recordings", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lbl-eval-"));
    cpSync(new URL("./findings.json", import.meta.url), join(dir, "findings.json"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("a groq run without LBL_LLM_LIVE=1 stops before any network call and writes nothing", async () => {
    const fake = vi.fn();
    vi.stubGlobal("fetch", fake);
    vi.stubEnv("GROQ_API_KEY", "fake-test-key-not-real");
    vi.stubEnv("LBL_LLM_LIVE", "");
    await expect(runEval({ stt: "text", llm: "groq:openai/gpt-oss-120b", record: "r1", writeResults: true, evalDir: dir })).rejects.toThrow(/LBL_LLM_LIVE=1/);
    expect(fake).not.toHaveBeenCalled();
    expect(existsSync(join(dir, "results"))).toBe(false);
    expect(existsSync(join(dir, "recordings"))).toBe(false);
  });

  it("--record needs a live provider and never overwrites a recording", async () => {
    await expect(runEval({ stt: "text", llm: "keywords", record: "r1", writeResults: false, evalDir: dir })).rejects.toThrow(/nothing to record/);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ lines: [] }) } }] }), { status: 200 })));
    vi.stubEnv("LBL_LLM_LIVE", "1");
    vi.stubEnv("GROQ_API_KEY", "fake-test-key-not-real");
    const live = { stt: "text", llm: "groq:openai/gpt-oss-20b", record: "r1", writeResults: false, evalDir: dir };
    await runEval(live);
    await expect(runEval(live)).rejects.toThrow(/already exists/);
  });

  it("a live run that fails on a later note keeps the answers already received", async () => {
    const ok = () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ lines: [] }) } }] }), { status: 200 });
    let calls = 0;
    const fake = vi.fn(async () => (++calls === 3 ? new Response("boom", { status: 500 }) : ok()));
    vi.stubGlobal("fetch", fake);
    vi.stubEnv("LBL_LLM_LIVE", "1");
    vi.stubEnv("GROQ_API_KEY", "fake-test-key-not-real");
    await expect(runEval({ stt: "text", llm: "groq:openai/gpt-oss-20b", record: "r2", writeResults: true, evalDir: dir })).rejects.toThrow(/500/);
    const saved = readFileSync(join(dir, "recordings", "llm", "r2.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { id: string });
    expect(saved.map((r) => r.id)).toEqual(["F01", "F02"]);
    expect(existsSync(join(dir, "results"))).toBe(false);
  });

  it("a recorded live run replays to the same numbers", async () => {
    const answer = { lines: [{ code: "BRK-PAD-F", urgency: "safety", customerText: "Pads are worn." }, { code: "MADE-UP", urgency: "soon", customerText: "?" }] };
    const fake = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) } }] }), { status: 200 }));
    vi.stubGlobal("fetch", fake);
    vi.stubEnv("LBL_LLM_LIVE", "1");
    vi.stubEnv("GROQ_API_KEY", "fake-test-key-not-real");
    const live = await runEval({ stt: "text", llm: "groq:openai/gpt-oss-20b", record: "r1", writeResults: true, evalDir: dir });
    expect(fake).toHaveBeenCalledTimes(32);
    // Same as `score.py lines` on the same answers: MADE-UP is a false positive on every note, so no note is exact (0/32, precision 0.031, recall 0.061, 32 hallucinated).
    expect(live.exact).toBe(0);
    expect(live.precision.toFixed(3)).toBe("0.031");
    expect(live.recall.toFixed(3)).toBe("0.061");
    expect(live.invented).toBe(32);
    expect(existsSync(join(dir, "results", "text__groq-openai-gpt-oss-20b.json"))).toBe(true);
    expect(JSON.stringify(readFileSync(join(dir, "results", "text__groq-openai-gpt-oss-20b.json"), "utf8"))).not.toContain("fake-test-key-not-real");

    vi.unstubAllGlobals();
    vi.stubGlobal("fetch", vi.fn());
    const replay = await runEval({ stt: "text", llm: "recorded:r1", writeResults: false, evalDir: dir });
    expect(replay).toMatchObject({ exact: live.exact, invented: live.invented, precision: live.precision, recall: live.recall });
  });
});
