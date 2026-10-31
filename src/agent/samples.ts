// The 32 synthetic voice notes of the benchmark (eval/), offered to judges as ready-made samples: their speech
// recognition is recorded, so a sample needs no live model call.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { recordedIds } from "./recordings.js";

export const DEFAULT_EVAL_DIR = fileURLToPath(new URL("../../eval/", import.meta.url));
export const SAMPLE_ID = /^F[0-9]{2}$/;
/** The recorded speech recognition every sample has (eval/recordings/stt/parakeet-local.jsonl). */
export const SAMPLE_STT = "recorded:parakeet-local";

/** The recorded answers that go with the samples: <evalDir>/recordings. */
export function sampleRecordingsDir(evalDir: string = DEFAULT_EVAL_DIR): string {
  return join(evalDir, "recordings");
}

export interface Sample {
  id: string;
  /** What the note says (the written note the audio was spoken from). */
  text: string;
  /** The synthetic voice, from the manifest. */
  voice: string;
  /** Absolute path of the WAV file, built from the manifest, never from a request. */
  path: string;
}

const manifestFile = z.object({
  items: z.array(z.object({ id: z.string().regex(SAMPLE_ID), file: z.string(), voice: z.string().min(1) })).min(1),
});
const findingsFile = z.object({ findings: z.array(z.object({ id: z.string(), note: z.string().min(1) })) });

/** Reads eval/audio/manifest.json and eval/findings.json; throws on anything inconsistent or a sample without its recorded transcript. */
export function loadSamples(evalDir: string = DEFAULT_EVAL_DIR): Map<string, Sample> {
  const manifest = manifestFile.parse(JSON.parse(readFileSync(join(evalDir, "audio", "manifest.json"), "utf8")));
  const notes = new Map(findingsFile.parse(JSON.parse(readFileSync(join(evalDir, "findings.json"), "utf8"))).findings.map((f) => [f.id, f.note]));
  const transcribed = recordedIds(sampleRecordingsDir(evalDir), "stt", SAMPLE_STT.slice("recorded:".length));
  const out = new Map<string, Sample>();
  for (const it of manifest.items) {
    if (it.file !== `audio/${it.id}.wav`) throw new Error(`sample ${it.id}: unexpected file ${JSON.stringify(it.file)} in the manifest`);
    const text = notes.get(it.id);
    if (text === undefined) throw new Error(`sample ${it.id} has no note in findings.json`);
    if (out.has(it.id)) throw new Error(`sample ${it.id} appears twice in the manifest`);
    if (!transcribed.has(it.id)) throw new Error(`sample ${it.id} has no recorded transcript (${SAMPLE_STT})`);
    out.set(it.id, { id: it.id, text, voice: it.voice, path: join(evalDir, it.file) });
  }
  return out;
}
