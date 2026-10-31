// Scoring of the voice-to-line benchmark. Same rules as docs/2026-10-31-lbl-measure/score.py.

import { readFileSync } from "node:fs";
import { z } from "zod";
import { urgencySchema, type Urgency } from "../src/agent/lines.js";

const findingsFile = z.object({
  about: z.string(),
  findings: z
    .array(
      z.object({
        id: z.string(),
        note: z.string(),
        expected: z.array(z.object({ code: z.string(), urgency: urgencySchema })),
        tags: z.array(z.string()).default([]),
      }),
    )
    .min(1),
});
export type Finding = z.infer<typeof findingsFile>["findings"][number];

export function loadFindings(path: string | URL): Finding[] {
  return findingsFile.parse(JSON.parse(readFileSync(path, "utf8"))).findings;
}

export interface Prediction {
  /** Lines after the price list filtered them. */
  lines: Array<{ code: string; urgency: Urgency }>;
  /** Codes the model named that are not in the price list. */
  droppedCodes: string[];
}

export interface NoteScore {
  id: string;
  ok: boolean;
  expected: string[];
  got: string[];
  invented: number;
}

export interface Score {
  notes: number;
  exact: number;
  precision: number;
  recall: number;
  invented: number;
  urgencyOk: number;
  urgencyN: number;
  rows: NoteScore[];
}

/** A note is exact when its set of codes equals the expected set. A note with no prediction counts as no lines. */
export function scoreLines(findings: Finding[], predictions: ReadonlyMap<string, Prediction>): Score {
  let exact = 0, tp = 0, fp = 0, fn = 0, invented = 0, urgencyOk = 0, urgencyN = 0;
  const rows: NoteScore[] = [];
  for (const f of findings) {
    const want = new Map(f.expected.map((e) => [e.code, e.urgency] as const));
    const pred = predictions.get(f.id);
    const got = new Map((pred?.lines ?? []).map((l) => [l.code, l.urgency] as const));
    const dropped = new Set(pred?.droppedCodes ?? []).size;
    invented += dropped;
    const both = [...want.keys()].filter((c) => got.has(c));
    tp += both.length;
    fp += got.size - both.length;
    fn += want.size - both.length;
    const ok = want.size === got.size && both.length === want.size;
    if (ok) exact += 1;
    for (const c of both) {
      urgencyN += 1;
      if (want.get(c) === got.get(c)) urgencyOk += 1;
    }
    rows.push({ id: f.id, ok, expected: [...want.keys()].sort(), got: [...got.keys()].sort(), invented: dropped });
  }
  return {
    notes: findings.length,
    exact,
    precision: tp / Math.max(1, tp + fp),
    recall: tp / Math.max(1, tp + fn),
    invented,
    urgencyOk,
    urgencyN,
    rows,
  };
}
