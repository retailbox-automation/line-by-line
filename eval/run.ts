// The benchmark: `npm run eval -- [--set base|hard] [--replay | --text | --stt <provider> --llm <provider>] [--record <name>]`.
// Providers: stt = recorded:<name> | groq:whisper-large-v3[-turbo] | local:parakeet; llm = keywords | recorded:<name> | groq:<model>.
// Live providers (groq:*) need LBL_LLM_LIVE=1 and GROQ_API_KEY; without them the run stops before any network call.

import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { AgentError } from "../src/agent/groq.js";
import { draftLines, type DraftResult } from "../src/agent/lines.js";
import { loadPriceList } from "../src/agent/priceList.js";
import { recordedRow, recordingPath } from "../src/agent/recordings.js";
import { transcribe } from "../src/agent/transcribe.js";
import { loadFindings, scoreLines, type NoteScore, type Prediction } from "./score.js";
import { wer } from "./wer.js";

const EVAL_DIR = dirname(fileURLToPath(import.meta.url));

export const DEFAULT_STT = "recorded:parakeet-local";
export const DEFAULT_LLM = "keywords";

export interface EvalOptions {
  /** A speech provider, or "text" to feed the written note straight to the lines provider. */
  stt: string;
  llm: string;
  /** Save the answers of live providers under eval/recordings/ for a later --replay. */
  record?: string;
  /** Write eval/results/<stt>__<llm>.json. */
  writeResults: boolean;
  /** Folder with findings.json, audio/, recordings/ and results/. Defaults to this folder. */
  evalDir?: string;
}

export interface NoteResult extends NoteScore {
  transcript?: string;
  wer?: number;
  ms: number;
  /** The live model failed on this note (it answered JSON that broke the schema); the note counts as missed. */
  modelError?: string;
}

export interface EvalReport {
  stt: string;
  llm: string;
  notes: number;
  exact: number;
  precision: number;
  recall: number;
  invented: number;
  urgency: { ok: number; n: number };
  /** Notes where the live model's own answer was rejected (Groq 400 json_validate_failed); each counts as a missed note. */
  modelErrors: number;
  wer: { mean: number; max: number } | null;
  latencyMs: { p50: number; p95: number };
  rows: NoteResult[];
  summary: string;
}

const isLive = (provider: string): boolean => provider.startsWith("groq:") || provider.startsWith("local:");

/**
 * Groq rejects an answer that breaks the strict JSON schema with 400 json_validate_failed. That is the model failing on
 * this note (in the product the mechanic would get an error), so the run goes on and the note counts as missed. Any other
 * error (network, 5xx, 429 after its retries, a bad key) still stops the run.
 */
export function isModelOutputError(provider: string, e: unknown): e is AgentError {
  return provider.startsWith("groq:") && e instanceof AgentError && / answered 400: /.test(e.message) && e.message.includes('"json_validate_failed"');
}

const noLines = (ms: number): DraftResult => ({ lines: [], droppedCodes: [], raw: [], ms });

/** A recorded model failure (`{"id","error","ms"}` row) replays as the same failure. */
function recordedFailure(provider: string, recordingsDir: string, id: string): { error: string; ms: number } | undefined {
  if (!provider.startsWith("recorded:")) return undefined;
  const row = recordedRow(recordingsDir, "llm", provider.slice("recorded:".length), id) as { error?: unknown; ms?: unknown };
  return typeof row.error === "string" ? { error: row.error, ms: typeof row.ms === "number" ? row.ms : 0 } : undefined;
}

/** Same convention as score.py: the upper median, sorted[floor(q * n)]. */
export function percentile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] as number;
}

const round = (x: number, digits = 4): number => Math.round(x * 10 ** digits) / 10 ** digits;

export async function runEval(opts: EvalOptions): Promise<EvalReport> {
  const dir = opts.evalDir ?? EVAL_DIR;
  const findings = loadFindings(join(dir, "findings.json"));
  const priceList = loadPriceList();
  const recordingsDir = join(dir, "recordings");
  const fromText = opts.stt === "text";

  const recordStt = opts.record !== undefined && !fromText && isLive(opts.stt);
  const recordLlm = opts.record !== undefined && isLive(opts.llm);
  const sttFile = opts.record !== undefined ? recordingPath(recordingsDir, "stt", opts.record) : "";
  const llmFile = opts.record !== undefined ? recordingPath(recordingsDir, "llm", opts.record) : "";
  if (opts.record !== undefined) {
    if (!recordStt && !recordLlm) throw new Error("--record needs a live provider (groq:* or local:parakeet); nothing to record");
    for (const [wanted, file] of [[recordStt, sttFile], [recordLlm, llmFile]] as const) {
      if (wanted && existsSync(file)) throw new Error(`${file} already exists (a failed run leaves its partial answers there); pick another --record name`);
    }
  }

  const predictions = new Map<string, Prediction>();
  const extras: Array<Pick<NoteResult, "transcript" | "wer" | "ms" | "modelError">> = [];
  const wers: number[] = [];
  // Each answer goes to the recording file as soon as it arrives, so a failure on note 31 keeps the paid answers of notes 1 to 30.
  const keep = (wanted: boolean, file: string, row: unknown): void => {
    if (!wanted) return;
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify(row)}\n`);
  };

  for (const f of findings) {
    let text = f.note;
    let sttMs = 0;
    if (!fromText) {
      const heard = await transcribe(join(dir, "audio", `${f.id}.wav`), opts.stt, { recordingsDir });
      text = heard.text;
      sttMs = heard.ms;
      keep(recordStt, sttFile, { id: f.id, text, ms: sttMs });
    }
    let drafted: DraftResult;
    let modelError: string | undefined;
    const replayedFailure = recordedFailure(opts.llm, recordingsDir, f.id);
    if (replayedFailure) {
      modelError = replayedFailure.error;
      drafted = noLines(replayedFailure.ms);
    } else {
      const started = performance.now();
      try {
        drafted = await draftLines(text, opts.llm, { id: f.id, priceList, recordingsDir });
      } catch (e) {
        if (!isModelOutputError(opts.llm, e)) throw e;
        modelError = e.message.slice(0, 300);
        drafted = noLines(Math.round(performance.now() - started));
      }
    }
    keep(recordLlm, llmFile, modelError === undefined ? { id: f.id, lines: drafted.raw, ms: drafted.ms } : { id: f.id, error: modelError, ms: drafted.ms });
    predictions.set(f.id, { lines: drafted.raw, droppedCodes: drafted.droppedCodes });
    const noteWer = fromText ? undefined : wer(f.note, text);
    if (noteWer !== undefined) wers.push(noteWer);
    extras.push({ ...(noteWer === undefined ? {} : { transcript: text, wer: round(noteWer) }), ms: sttMs + drafted.ms, ...(modelError === undefined ? {} : { modelError }) });
  }

  const score = scoreLines(findings, predictions);
  // A note where the model failed is missed even when no line was expected.
  const rows: NoteResult[] = score.rows.map((r, i) => {
    const extra = extras[i] as Pick<NoteResult, "transcript" | "wer" | "ms" | "modelError">;
    return { ...r, ...extra, ok: r.ok && extra.modelError === undefined };
  });
  const latencies = extras.map((x) => x.ms);
  const report: EvalReport = {
    stt: opts.stt,
    llm: opts.llm,
    notes: score.notes,
    exact: rows.filter((r) => r.ok).length,
    precision: round(score.precision),
    recall: round(score.recall),
    invented: score.invented,
    urgency: { ok: score.urgencyOk, n: score.urgencyN },
    modelErrors: rows.filter((r) => r.modelError !== undefined).length,
    wer: wers.length ? { mean: round(wers.reduce((a, b) => a + b, 0) / wers.length), max: round(Math.max(...wers)) } : null,
    latencyMs: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95) },
    rows,
    summary: "",
  };
  report.summary = summaryLine(report);

  if (opts.writeResults) {
    const name = `${opts.stt}__${opts.llm}`.replace(/[^A-Za-z0-9._-]+/g, "-");
    mkdirSync(join(dir, "results"), { recursive: true });
    writeFileSync(join(dir, "results", `${name}.json`), `${JSON.stringify(report, null, 2)}\n`);
  }
  return report;
}

export function summaryLine(r: EvalReport): string {
  const input = r.stt === "text" ? "the note text" : `speech recognition ${r.stt}`;
  const parts = [
    `${r.llm} on ${input}: ${r.exact}/${r.notes} exact notes`,
    `precision ${r.precision.toFixed(3)}`,
    `recall ${r.recall.toFixed(3)}`,
    `${r.invented} invented codes`,
    `urgency ${r.urgency.ok}/${r.urgency.n}`,
  ];
  if (r.modelErrors) parts.push(`${r.modelErrors} model error${r.modelErrors === 1 ? "" : "s"}`);
  if (r.wer) parts.push(`WER ${r.wer.mean.toFixed(3)}`);
  return parts.join(", ");
}

export function formatReport(r: EvalReport): string {
  const out = [
    `Line by Line eval   speech: ${r.stt}   lines: ${r.llm}`,
    `  exact notes   ${r.exact}/${r.notes}`,
    `  precision     ${r.precision.toFixed(3)}`,
    `  recall        ${r.recall.toFixed(3)}`,
    `  invented      ${r.invented}`,
    `  urgency       ${r.urgency.ok}/${r.urgency.n} on matched lines`,
    `  model errors  ${r.modelErrors}`,
    `  WER           ${r.wer ? `mean ${r.wer.mean.toFixed(3)}  max ${r.wer.max.toFixed(3)}` : "n/a (note text, no speech recognition)"}`,
    `  latency       p50 ${r.latencyMs.p50} ms  p95 ${r.latencyMs.p95} ms`,
    "",
    "Misses:",
    ...r.rows.filter((n) => !n.ok).map((n) => `  ${n.id}  expected [${n.expected.join(", ")}]  got [${n.got.join(", ")}]${n.invented ? `  invented ${n.invented}` : ""}`),
    "",
    `Summary: ${r.summary}`,
  ];
  return out.join("\n");
}

/** Note sets: `base` is the 32 notes of this folder, `hard` the 48 harder notes of eval/hard/ (own audio, recordings and results). */
export const EVAL_SETS = { base: EVAL_DIR, hard: join(EVAL_DIR, "hard") } as const;

export function parseCli(argv: string[]): EvalOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      replay: { type: "boolean" },
      text: { type: "boolean" },
      stt: { type: "string" },
      llm: { type: "string" },
      record: { type: "string" },
      set: { type: "string" },
    },
    strict: true,
  });
  if (values.text && (values.replay || values.stt !== undefined)) throw new Error("--text cannot be combined with --replay or --stt");
  const set = values.set ?? "base";
  if (!Object.hasOwn(EVAL_SETS, set)) throw new Error(`unknown --set ${JSON.stringify(set)}; use ${Object.keys(EVAL_SETS).join(" or ")}`);
  const opts: EvalOptions = { stt: values.text ? "text" : (values.stt ?? DEFAULT_STT), llm: values.llm ?? DEFAULT_LLM, writeResults: true };
  if (set !== "base") opts.evalDir = EVAL_SETS[set as keyof typeof EVAL_SETS];
  if (values.record !== undefined) opts.record = values.record;
  return opts;
}

async function main(): Promise<void> {
  const report = await runEval(parseCli(process.argv.slice(2)));
  console.log(formatReport(report));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e: unknown) => {
    console.error(`eval: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}
