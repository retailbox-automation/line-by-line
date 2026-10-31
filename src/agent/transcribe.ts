// Speech to text. `recorded:` replays stored answers, `groq:` needs LBL_LLM_LIVE=1, `local:parakeet` is a dev tool on the Mac Studio.

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { AgentError, groqKey, groqPost } from "./groq.js";
import { DEFAULT_RECORDINGS_DIR, recordedRow } from "./recordings.js";

export interface Transcript {
  text: string;
  ms: number;
}

export interface TranscribeOptions {
  /** Directory that holds `stt/<name>.jsonl` for `recorded:<name>`. Defaults to eval/recordings. */
  recordingsDir?: string;
}

export const GROQ_STT_MODELS = ["whisper-large-v3", "whisper-large-v3-turbo"] as const;

const recordedStt = z.object({ text: z.string(), ms: z.number().nonnegative() });
const groqAnswer = z.object({ text: z.string() });
const run = promisify(execFile);

/** The note id of an audio file is its name without the extension (`F07.wav` -> `F07`). */
export function noteId(audioPath: string): string {
  return basename(audioPath, extname(audioPath));
}

export async function transcribe(audioPath: string, provider: string, opts: TranscribeOptions = {}): Promise<Transcript> {
  const sep = provider.indexOf(":");
  const kind = sep < 0 ? provider : provider.slice(0, sep);
  const arg = sep < 0 ? "" : provider.slice(sep + 1);

  if (kind === "recorded") {
    const rec = recordedStt.parse(recordedRow(opts.recordingsDir ?? DEFAULT_RECORDINGS_DIR, "stt", arg, noteId(audioPath)));
    return { text: rec.text, ms: rec.ms };
  }
  if (kind === "groq") {
    if (!(GROQ_STT_MODELS as readonly string[]).includes(arg)) {
      throw new AgentError(`unknown Groq speech model ${JSON.stringify(arg)}; allowed: ${GROQ_STT_MODELS.join(", ")}`);
    }
    groqKey(); // refuse before the file is even read
    const started = performance.now();
    const form = new FormData();
    form.set("file", new Blob([await readFile(audioPath)], { type: "audio/wav" }), basename(audioPath));
    form.set("model", arg);
    form.set("response_format", "json");
    form.set("temperature", "0");
    form.set("language", "en");
    const answer = groqAnswer.safeParse(await groqPost("/audio/transcriptions", form));
    if (!answer.success) throw new AgentError("Groq transcription answer has no text");
    return { text: answer.data.text.trim(), ms: Math.round(performance.now() - started) };
  }
  if (kind === "local" && arg === "parakeet") {
    const started = performance.now();
    try {
      const { stdout } = await run("stt-local", [audioPath], { timeout: 120_000, maxBuffer: 1 << 20 });
      return { text: stdout.trim(), ms: Math.round(performance.now() - started) };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new AgentError("stt-local is not installed on this machine (local:parakeet is a development tool)");
      throw new AgentError(`stt-local failed on ${audioPath}: ${e instanceof Error ? e.message.split("\n")[0] : "unknown error"}`);
    }
  }
  throw new AgentError(`unknown speech provider ${JSON.stringify(provider)}; use recorded:<name>, groq:<model> or local:parakeet`);
}
