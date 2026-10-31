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

/** Longest text for the customer on a line. */
export const MAX_CUSTOMER_TEXT = 300;

/** A currency sign or a money word. The model is told to write no prices; this enforces it. */
const PRICE_TALK = /[$€£]|\b(?:dollars?|usd|bucks?|cents?)\b/i;

/**
 * The text the customer sees on a price-list line: a text that names a price becomes the item name (the screen shows
 * one price, the list's), and a long text is cut to 300 characters.
 */
export function customerText(text: string, itemName: string): { text: string; namedPrice: boolean } {
  if (PRICE_TALK.test(text)) return { text: itemName, namedPrice: true };
  const t = text.trim();
  return { text: t.length <= MAX_CUSTOMER_TEXT ? t : `${t.slice(0, MAX_CUSTOMER_TEXT - 1)}…`, namedPrice: false };
}

/** Puts the list's title and price on drafted lines and cleans their customer text. */
export function priceLines(drafted: DraftLine[], list: PriceList): { lines: PricedLine[]; priceTextCodes: string[] } {
  const priceTextCodes: string[] = [];
  const lines = drafted.map((l) => {
    const item = list.byCode(l.code);
    if (!item) throw new Error(`line ${l.code} survived the price-list filter without a price`);
    const t = customerText(l.customerText, item.name);
    if (t.namedPrice) priceTextCodes.push(l.code);
    return { ...l, customerText: t.text, title: item.name, priceCents: item.cents };
  });
  return { lines, priceTextCodes };
}

let defaultList: PriceList | undefined;

export async function voiceToLines(audioPath: string, providers: { stt: string; llm: string }, opts: VoiceOptions = {}): Promise<VoiceResult> {
  const list = opts.priceList ?? (defaultList ??= loadPriceList());
  const heard = await transcribe(audioPath, providers.stt, opts);
  const drafted = await draftLines(heard.text, providers.llm, { id: noteId(audioPath), priceList: list, recordingsDir: opts.recordingsDir });
  const { lines, priceTextCodes } = priceLines(drafted.lines, list);
  return { transcript: heard.text, lines, droppedCodes: drafted.droppedCodes, priceTextCodes, timings: { sttMs: heard.ms, llmMs: drafted.ms } };
}
