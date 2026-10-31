// The shop's price list. Prices live here and only here: a model names a code, code looks up the price.

import { readFileSync } from "node:fs";
import { z } from "zod";

const item = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
  cents: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  aliases: z.array(z.string().min(1)),
});

const file = z
  .object({
    shop: z.string(),
    currency: z.literal("USD"),
    items: z.array(item).min(1),
  })
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    value.items.forEach((it, i) => {
      if (seen.has(it.code)) ctx.addIssue({ code: "custom", path: ["items", i, "code"], message: `duplicate code ${it.code}` });
      seen.add(it.code);
    });
  });

export type PriceItem = z.infer<typeof item>;

export interface PriceList {
  shop: string;
  items: PriceItem[];
  byCode(code: string): PriceItem | undefined;
}

export const DEFAULT_PRICE_LIST_PATH = new URL("../../data/price-list.json", import.meta.url);

/** Validates a parsed price list file. Throws a ZodError that names the offending item. */
export function parsePriceList(json: unknown): PriceList {
  const parsed = file.parse(json);
  const map = new Map(parsed.items.map((it) => [it.code, it] as const));
  return { shop: parsed.shop, items: parsed.items, byCode: (code) => map.get(code) };
}

export function loadPriceList(path: string | URL = DEFAULT_PRICE_LIST_PATH): PriceList {
  return parsePriceList(JSON.parse(readFileSync(path, "utf8")));
}
