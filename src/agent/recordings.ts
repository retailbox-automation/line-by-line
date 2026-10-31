// Stored provider answers (`eval/recordings/<stt|llm>/<name>.jsonl`, one JSON object per line) for replays without a key.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentError } from "./groq.js";

export const DEFAULT_RECORDINGS_DIR = fileURLToPath(new URL("../../eval/recordings/", import.meta.url));
export const RECORDING_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function recordingPath(dir: string, layer: "stt" | "llm", name: string): string {
  if (!RECORDING_NAME.test(name)) throw new AgentError(`bad recording name ${JSON.stringify(name)}`);
  return join(dir, layer, `${name}.jsonl`);
}

/** The note ids with a stored answer (empty when the file is missing). */
export function recordedIds(dir: string, layer: "stt" | "llm", name: string): Set<string> {
  const path = recordingPath(dir, layer, name);
  if (!existsSync(path)) return new Set();
  return new Set(readRows(path).flatMap((r) => (typeof r.id === "string" ? [r.id] : [])));
}

/** Whether a stored answer exists for this note id (false when the file is missing). */
export function hasRecording(dir: string, layer: "stt" | "llm", name: string, id: string): boolean {
  return recordedIds(dir, layer, name).has(id);
}

function readRows(path: string): { id?: unknown }[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as { id?: unknown });
}

/** The stored row for a note id; throws if the file or the row is missing. */
export function recordedRow(dir: string, layer: "stt" | "llm", name: string, id: string): unknown {
  const path = recordingPath(dir, layer, name);
  const row = readRows(path).find((r) => r.id === id);
  if (!row) throw new AgentError(`no answer for ${id} in ${path}`);
  return row;
}
