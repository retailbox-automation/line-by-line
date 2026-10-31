// Word error rate with a small normalizer, so "two millimeters" and "2mm" do not count as an error.

const UNITS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const SCALES: Record<string, number> = { hundred: 100, thousand: 1000 };
const MM = new Set(["mm", "mil", "mils", "millimeter", "millimeters"]);

const isDigitWord = (w: string): boolean => Object.hasOwn(UNITS, w) && (UNITS[w] ?? 10) < 10;
const isNumberWord = (w: string): boolean => Object.hasOwn(UNITS, w) || Object.hasOwn(TENS, w) || Object.hasOwn(SCALES, w);

/** Lower-cased words with spoken numbers turned into digits ("a hundred and ten thousand" -> "110000"). */
export function normalizeWords(text: string): string[] {
  const cleaned = text
    .toLowerCase()
    .replace(/%/g, " percent ")
    .replace(/-/g, " ")
    .replace(/(?<=\d),(?=\d{3}(?!\d))/g, "")
    .replace(/[^a-z0-9' ]+/g, " ");
  const words = cleaned.split(/\s+/).filter(Boolean);

  const out: string[] = [];
  for (let i = 0; i < words.length; ) {
    const w = words[i] as string;
    const next = words[i + 1] ?? "";
    const startsRun = isNumberWord(w) || (w === "a" && Object.hasOwn(SCALES, next));
    if (!startsRun) {
      out.push(w);
      i += 1;
      continue;
    }
    // Take the longest run of number words ("and" only after a hundred or thousand).
    let j = i;
    let sawScale = false;
    while (j < words.length) {
      const x = words[j] as string;
      const after = words[j + 1] ?? "";
      if (isNumberWord(x) || (j === i && x === "a" && Object.hasOwn(SCALES, after))) {
        if (Object.hasOwn(SCALES, x)) sawScale = true;
        j += 1;
      } else if (x === "and" && sawScale && isNumberWord(after) && !(Object.hasOwn(SCALES, after))) {
        j += 1;
      } else break;
    }
    const run = words.slice(i, j);
    if (run.length > 1 && run.every(isDigitWord)) {
      out.push(run.map((x) => String(UNITS[x])).join("")); // "zero four two zero" -> "0420"
    } else {
      let total = 0;
      let current = 0;
      for (const x of run) {
        if (x === "a" || x === "and") continue;
        if (Object.hasOwn(UNITS, x)) current += UNITS[x] as number;
        else if (Object.hasOwn(TENS, x)) current += TENS[x] as number;
        else if (x === "hundred") current = (current || 1) * 100;
        else {
          total += (current || 1) * 1000;
          current = 0;
        }
      }
      out.push(String(total + current));
    }
    i = j;
  }

  // "p 0420" -> "p0420" and "2 millimeters" -> "2mm".
  const merged: string[] = [];
  for (const w of out) {
    const prev = merged[merged.length - 1];
    if (prev === "p" && /^\d+$/.test(w)) merged[merged.length - 1] = `p${w}`;
    else if (prev !== undefined && /^\d+$/.test(prev) && MM.has(w)) merged[merged.length - 1] = `${prev}mm`;
    else merged.push(w);
  }
  return merged;
}

/** Word-level edit distance of the normalized texts, divided by the reference length. */
export function wer(reference: string, hypothesis: string): number {
  const r = normalizeWords(reference);
  const h = normalizeWords(hypothesis);
  let d = Array.from({ length: h.length + 1 }, (_, j) => j);
  for (let i = 1; i <= r.length; i++) {
    const next = [i];
    for (let j = 1; j <= h.length; j++) {
      next[j] = Math.min((d[j] as number) + 1, (next[j - 1] as number) + 1, (d[j - 1] as number) + (r[i - 1] === h[j - 1] ? 0 : 1));
    }
    d = next;
  }
  return (d[h.length] as number) / Math.max(1, r.length);
}
