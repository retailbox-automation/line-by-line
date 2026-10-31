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
  /** Codes whose customer text named a price; the text was replaced by the item name, so the screen shows only the list price. */
  priceTextCodes: string[];
  timings: { sttMs: number; llmMs: number };
}

export interface VoiceOptions extends TranscribeOptions {
  priceList?: PriceList;
}

/** A currency sign or a money word. The model is told to write no prices; this enforces it. */
const PRICE_TALK = /[$€£]|\b(?:dollars?|usd|bucks?|cents?)\b/i;

let defaultList: PriceList | undefined;

export async function voiceToLines(audioPath: string, providers: { stt: string; llm: string }, opts: VoiceOptions = {}): Promise<VoiceResult> {
  const list = opts.priceList ?? (defaultList ??= loadPriceList());
  const heard = await transcribe(audioPath, providers.stt, opts);
  const drafted = await draftLines(heard.text, providers.llm, { id: noteId(audioPath), priceList: list, recordingsDir: opts.recordingsDir });
  const priceTextCodes: string[] = [];
  const lines = drafted.lines.map((l) => {
    const item = list.byCode(l.code);
    if (!item) throw new Error(`line ${l.code} survived the price-list filter without a price`);
    if (PRICE_TALK.test(l.customerText)) {
      priceTextCodes.push(l.code);
      return { ...l, customerText: item.name, title: item.name, priceCents: item.cents };
    }
    return { ...l, title: item.name, priceCents: item.cents };
  });
  return { transcript: heard.text, lines, droppedCodes: drafted.droppedCodes, priceTextCodes, timings: { sttMs: heard.ms, llmMs: drafted.ms } };
}
