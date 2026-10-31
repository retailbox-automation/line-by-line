// Stored provider answers (`eval/recordings/<stt|llm>/<name>.jsonl`, one JSON object per line) for replays without a key.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentError } from "./groq.js";

export const DEFAULT_RECORDINGS_DIR = fileURLToPath(new URL("../../eval/recordings/", import.meta.url));
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function recordingPath(dir: string, layer: "stt" | "llm", name: string): string {
  if (!NAME.test(name)) throw new AgentError(`bad recording name ${JSON.stringify(name)}`);
  return join(dir, layer, `${name}.jsonl`);
}

/** The stored row for a note id; throws if the file or the row is missing. */
export function recordedRow(dir: string, layer: "stt" | "llm", name: string, id: string): unknown {
  const path = recordingPath(dir, layer, name);
  const rows = readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as { id?: unknown });
  const row = rows.find((r) => r.id === id);
  if (!row) throw new AgentError(`no answer for ${id} in ${path}`);
  return row;
}
