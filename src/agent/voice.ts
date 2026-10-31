// The service the mechanic screen calls: audio in, priced lines out. The price always comes from the price list.

import { draftLines, type DraftLine } from "./lines.js";
import { loadPriceList, type PriceList } from "./priceList.js";
import { noteId, transcribe, type TranscribeOptions } from "./transcribe.js";

export interface PricedLine extends DraftLine {
  title: string;
  priceCents: number;
}

export interface VoiceResult {
  transcript: string;
  lines: PricedLine[];
  droppedCodes: string[];
  timings: { sttMs: number; llmMs: number };
}

export interface VoiceOptions extends TranscribeOptions {
  priceList?: PriceList;
}

let defaultList: PriceList | undefined;

export async function voiceToLines(audioPath: string, providers: { stt: string; llm: string }, opts: VoiceOptions = {}): Promise<VoiceResult> {
  const list = opts.priceList ?? (defaultList ??= loadPriceList());
  const heard = await transcribe(audioPath, providers.stt, opts);
  const drafted = await draftLines(heard.text, providers.llm, { id: noteId(audioPath), priceList: list, recordingsDir: opts.recordingsDir });
  const lines = drafted.lines.map((l) => {
    const item = list.byCode(l.code);
    if (!item) throw new Error(`line ${l.code} survived the price-list filter without a price`);
    return { ...l, title: item.name, priceCents: item.cents };
  });
  return { transcript: heard.text, lines, droppedCodes: drafted.droppedCodes, timings: { sttMs: heard.ms, llmMs: drafted.ms } };
}
