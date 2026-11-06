import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadPriceList } from "../src/agent/priceList.js";
import { EVAL_SETS, formatReport, parseCli, percentile, runEval } from "./run.js";
import { loadFindings } from "./score.js";

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

  it("--set picks the note set: base is this folder, hard is eval/hard", () => {
    expect(parseCli([]).evalDir).toBeUndefined();
    expect(parseCli(["--set", "base"]).evalDir).toBeUndefined();
    expect(parseCli(["--set", "hard", "--text"])).toMatchObject({ stt: "text", evalDir: EVAL_SETS.hard });
    expect(EVAL_SETS.hard.endsWith(join("eval", "hard"))).toBe(true);
    expect(() => parseCli(["--set", "harder"])).toThrow(/unknown --set/);
    expect(() => parseCli(["--set", "toString"])).toThrow(/unknown --set/);
  });
});

describe("hard set (eval/hard)", () => {
  const hardDir = EVAL_SETS.hard;
  const findings = loadFindings(join(hardDir, "findings.json"));
  const codes = new Set(loadPriceList().items.map((p) => p.code));

  it("has 48 notes with unique ids and only price-list codes", () => {
    expect(findings).toHaveLength(48);
    expect(new Set(findings.map((f) => f.id)).size).toBe(48);
    for (const f of findings) {
      for (const e of f.expected) expect(codes.has(e.code), `${f.id} ${e.code}`).toBe(true);
      expect(new Set(f.expected.map((e) => e.code)).size, f.id).toBe(f.expected.length);
    }
  });

  it("both blind labelers agree with the labels on every code and urgency", () => {
    const check = JSON.parse(readFileSync(join(hardDir, "label-check.json"), "utf8")) as {
      labelers: Array<{ labels: Array<{ id: string; lines: Array<{ code: string; urgency: string }> }> }>;
    };
    expect(check.labelers).toHaveLength(2);
    const key = (lines: Array<{ code: string; urgency: string }>) => lines.map((l) => `${l.code}:${l.urgency}`).sort().join(",");
    for (const labeler of check.labelers) {
      const byId = new Map(labeler.labels.map((l) => [l.id, l.lines]));
      for (const f of findings) expect(key(byId.get(f.id) ?? []), f.id).toBe(key(f.expected));
    }
  });

  it("every note has its audio, mixed at the stated signal-to-noise ratio", () => {
    const manifest = JSON.parse(readFileSync(join(hardDir, "audio", "manifest.json"), "utf8")) as {
      items: Array<{ id: string; snr_db: number; snr_db_measured: number }>;
    };
    expect(manifest.items.map((m) => m.id)).toEqual(findings.map((f) => f.id));
    for (const m of manifest.items) {
      expect([12, 8, 5]).toContain(m.snr_db);
      expect(Math.abs(m.snr_db_measured - m.snr_db), m.id).toBeLessThan(0.1);
      expect(existsSync(join(hardDir, "audio", `${m.id}.wav`)), m.id).toBe(true);
    }
  });

  it("keywords on the note text: 10/48 (the lower bound for the hard set)", async () => {
    const r = await runEval({ stt: "text", llm: "keywords", writeResults: false, evalDir: hardDir });
    expect(r.notes).toBe(48);
    expect(r.exact).toBe(10);
    expect(r.invented).toBe(0);
  });

  it("the recorded runs of 2026-11-06 replay to the README numbers, with no network", async () => {
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("no network in a replay"); }));
    const run = (stt: string, llm: string) => runEval({ stt, llm, writeResults: false, evalDir: hardDir });
    const kw = await run("recorded:parakeet-local", "keywords");
    expect([kw.exact, kw.modelErrors]).toEqual([8, 0]);
    expect(kw.wer?.mean).toBe(0.2183);
    expect(kw.rows.filter((r) => (r.wer ?? 0) > 0.6).map((r) => r.id)).toEqual(["H07", "H09", "H24", "H25", "H36"]);
    const big = await run("recorded:parakeet-local", "recorded:gpt-oss-120b-parakeet");
    expect([big.exact, big.modelErrors, big.invented]).toEqual([37, 0, 0]);
    // on the five transcripts that are noise the model drafts nothing rather than inventing lines
    for (const id of ["H07", "H09", "H24", "H25", "H36"]) expect(big.rows.find((r) => r.id === id)?.got, id).toEqual([]);
    const small = await run("recorded:parakeet-local", "recorded:gpt-oss-20b-parakeet");
    expect([small.exact, small.modelErrors, small.invented]).toEqual([32, 5, 0]);
    const smallText = await run("text", "recorded:gpt-oss-20b-text");
    expect([smallText.exact, smallText.modelErrors]).toEqual([47, 0]);
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

  it("a model answer that breaks the JSON schema (Groq 400 json_validate_failed) is a missed note, recorded, and replays the same", async () => {
    const ok = () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ lines: [] }) } }] }), { status: 200 });
    const invalid = () => new Response(JSON.stringify({ error: { message: "Failed to validate JSON.", type: "invalid_request_error", code: "json_validate_failed", failed_generation: "" } }), { status: 400 });
    let calls = 0;
    // Call 21 is F21, a note that expects no line: with the model failing it must not count as exact.
    vi.stubGlobal("fetch", vi.fn(async () => (++calls === 21 ? invalid() : ok())));
    vi.stubEnv("LBL_LLM_LIVE", "1");
    vi.stubEnv("GROQ_API_KEY", "fake-test-key-not-real");
    const live = await runEval({ stt: "text", llm: "groq:openai/gpt-oss-20b", record: "r3", writeResults: false, evalDir: dir });
    expect(calls).toBe(32);
    expect(live.modelErrors).toBe(1);
    expect(live.exact).toBe(1); // F20 only: every answer is empty, F20 and F21 expect nothing, F21 failed
    expect(live.rows.find((r) => r.id === "F21")).toMatchObject({ ok: false });
    expect(live.rows.find((r) => r.id === "F21")?.modelError).toMatch(/json_validate_failed/);
    expect(live.summary).toContain("1 model error");
    const saved = readFileSync(join(dir, "recordings", "llm", "r3.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { id: string; error?: string });
    expect(saved).toHaveLength(32);
    expect(saved.find((r) => r.id === "F21")?.error).toMatch(/json_validate_failed/);

    vi.unstubAllGlobals();
    const fake = vi.fn();
    vi.stubGlobal("fetch", fake);
    const replay = await runEval({ stt: "text", llm: "recorded:r3", writeResults: false, evalDir: dir });
    expect(fake).not.toHaveBeenCalled();
    expect(replay).toMatchObject({ exact: live.exact, modelErrors: 1, precision: live.precision, recall: live.recall });
  });

  it("any other error from the live model still stops the run", async () => {
    let calls = 0;
    const other = () => new Response(JSON.stringify({ error: { message: "Invalid API Key", type: "invalid_request_error", code: "invalid_api_key" } }), { status: 400 });
    vi.stubGlobal("fetch", vi.fn(async () => (++calls === 2 ? other() : new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ lines: [] }) } }] }), { status: 200 }))));
    vi.stubEnv("LBL_LLM_LIVE", "1");
    vi.stubEnv("GROQ_API_KEY", "fake-test-key-not-real");
    await expect(runEval({ stt: "text", llm: "groq:openai/gpt-oss-20b", writeResults: false, evalDir: dir })).rejects.toThrow(/invalid_api_key/);
    expect(calls).toBe(2);
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
