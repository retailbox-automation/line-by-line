// The benchmark: `npm run eval -- [--replay | --text | --stt <provider> --llm <provider>] [--record <name>]`.
// Providers: stt = recorded:<name> | groq:whisper-large-v3[-turbo] | local:parakeet; llm = keywords | recorded:<name> | groq:<model>.
// Live providers (groq:*) need LBL_LLM_LIVE=1 and GROQ_API_KEY; without them the run stops before any network call.

import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { draftLines } from "../src/agent/lines.js";
import { loadPriceList } from "../src/agent/priceList.js";
import { recordingPath } from "../src/agent/recordings.js";
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
  wer: { mean: number; max: number } | null;
  latencyMs: { p50: number; p95: number };
  rows: NoteResult[];
  summary: string;
}

const isLive = (provider: string): boolean => provider.startsWith("groq:") || provider.startsWith("local:");

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
  const extras: Array<Pick<NoteResult, "transcript" | "wer" | "ms">> = [];
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
    const drafted = await draftLines(text, opts.llm, { id: f.id, priceList, recordingsDir });
    keep(recordLlm, llmFile, { id: f.id, lines: drafted.raw, ms: drafted.ms });
    predictions.set(f.id, { lines: drafted.raw, droppedCodes: drafted.droppedCodes });
    const noteWer = fromText ? undefined : wer(f.note, text);
    if (noteWer !== undefined) wers.push(noteWer);
    extras.push({ ...(noteWer === undefined ? {} : { transcript: text, wer: round(noteWer) }), ms: sttMs + drafted.ms });
  }

  const score = scoreLines(findings, predictions);
  const rows: NoteResult[] = score.rows.map((r, i) => ({ ...r, ...(extras[i] as Pick<NoteResult, "transcript" | "wer" | "ms">) }));
  const latencies = extras.map((x) => x.ms);
  const report: EvalReport = {
    stt: opts.stt,
    llm: opts.llm,
    notes: score.notes,
    exact: score.exact,
    precision: round(score.precision),
    recall: round(score.recall),
    invented: score.invented,
    urgency: { ok: score.urgencyOk, n: score.urgencyN },
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

export function parseCli(argv: string[]): EvalOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      replay: { type: "boolean" },
      text: { type: "boolean" },
      stt: { type: "string" },
      llm: { type: "string" },
      record: { type: "string" },
    },
    strict: true,
  });
  if (values.text && (values.replay || values.stt !== undefined)) throw new Error("--text cannot be combined with --replay or --stt");
  const opts: EvalOptions = { stt: values.text ? "text" : (values.stt ?? DEFAULT_STT), llm: values.llm ?? DEFAULT_LLM, writeResults: true };
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
