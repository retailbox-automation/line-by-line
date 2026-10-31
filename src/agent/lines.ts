// A mechanic's note -> the price-list lines it asks for. The model names codes; the price comes from the list.

import { z } from "zod";
import { AgentError, groqPost } from "./groq.js";
import { loadPriceList, type PriceList } from "./priceList.js";
import { DEFAULT_RECORDINGS_DIR, recordedRow } from "./recordings.js";

export const urgencySchema = z.enum(["safety", "soon", "can_wait"]);
export type Urgency = z.infer<typeof urgencySchema>;

const rawLineSchema = z.object({ code: z.string(), urgency: urgencySchema, customerText: z.string().default("") });
export type DraftLine = z.infer<typeof rawLineSchema>;
const recordedLlm = z.object({ lines: z.array(rawLineSchema), ms: z.number().nonnegative() });

export interface DraftResult {
  /** Lines whose code is in the price list, one per code (first mention wins). */
  lines: DraftLine[];
  /** Codes the provider named that are not in the price list (the "invented" count). */
  droppedCodes: string[];
  /** What the provider returned before the price list filtered it; this is what `--record` saves. */
  raw: DraftLine[];
  /** Provider time in ms (0 for `keywords`: no model call). */
  ms: number;
}

export interface DraftOptions {
  /** Note id, needed by `recorded:<name>` to find the stored answer. */
  id?: string;
  priceList?: PriceList;
  /** Directory that holds `llm/<name>.jsonl` for `recorded:<name>`. Defaults to eval/recordings. */
  recordingsDir?: string;
}

export const GROQ_LLM_MODELS = ["openai/gpt-oss-120b", "openai/gpt-oss-20b"] as const;

let defaultList: PriceList | undefined;

export async function draftLines(text: string, provider: string, opts: DraftOptions = {}): Promise<DraftResult> {
  const list = opts.priceList ?? (defaultList ??= loadPriceList());
  const sep = provider.indexOf(":");
  const kind = sep < 0 ? provider : provider.slice(0, sep);
  const arg = sep < 0 ? "" : provider.slice(sep + 1);

  if (kind === "keywords" && sep < 0) return finish(keywordLines(text, list), 0, list);
  if (kind === "recorded") {
    if (!opts.id) throw new AgentError("recorded:<name> needs the note id");
    const row = recordedRow(opts.recordingsDir ?? DEFAULT_RECORDINGS_DIR, "llm", arg, opts.id);
    const rec = recordedLlm.parse(row);
    return finish(rec.lines, rec.ms, list);
  }
  if (kind === "groq") {
    if (!(GROQ_LLM_MODELS as readonly string[]).includes(arg)) {
      throw new AgentError(`unknown Groq model ${JSON.stringify(arg)}; allowed: ${GROQ_LLM_MODELS.join(", ")}`);
    }
    const started = performance.now();
    const raw = await groqLines(text, arg, list);
    return finish(raw, Math.round(performance.now() - started), list);
  }
  throw new AgentError(`unknown lines provider ${JSON.stringify(provider)}; use keywords, recorded:<name> or groq:<model>`);
}

function finish(raw: DraftLine[], ms: number, list: PriceList): DraftResult {
  const lines: DraftLine[] = [];
  const dropped = new Set<string>();
  for (const line of raw) {
    if (!list.byCode(line.code)) dropped.add(line.code);
    else if (!lines.some((l) => l.code === line.code)) lines.push(line);
  }
  return { lines, droppedCodes: [...dropped], raw, ms };
}

// --- keywords: no model. Port of baseline() in docs/2026-10-31-lbl-measure/score.py, same words, same order. ---

const SAFETY = ["safety", "can't let", "metal on metal", "grinding", "cords", "play in", "has play", "minimum", " out.", "is out", "burned out", "two millimeters", "three mil"];
const CAN_WAIT = ["can wait", "recommendation", "whenever", "not urgent", "cheap fix", "wearing faster", "blowing warm", "dirty"];

export function keywordLines(text: string, list: PriceList): DraftLine[] {
  const t = ` ${text.toLowerCase().replaceAll("-", " ")} `;
  const urgency: Urgency = SAFETY.some((c) => t.includes(c)) ? "safety" : CAN_WAIT.some((c) => t.includes(c)) ? "can_wait" : "soon";
  const lines: DraftLine[] = [];
  for (const p of list.items) {
    const keys = [...p.aliases.map((a) => a.toLowerCase()), (p.name.split("—")[0] ?? p.name).trim().toLowerCase()];
    if (keys.some((k) => t.includes(k))) lines.push({ code: p.code, urgency, customerText: p.name });
  }
  return lines;
}

// --- groq ---

export function systemPrompt(list: PriceList): string {
  const rows = list.items.map((p) => `${p.code} | ${p.name} | ${p.aliases.join(", ")}`).join("\n");
  return [
    "You help a service writer at an auto repair shop. A mechanic dictated a note after looking at a car. Decide which items of the price list below the writer should add to the customer's estimate, based only on the work the note calls for.",
    "Rules:",
    "- Use only codes from the list. Never invent a code. Never write a price.",
    "- If the work is not in the list, or the note says nothing needs doing, return an empty list.",
    "- A part the mechanic calls fine gets no line. Add a line only for work the note says is needed.",
    "- urgency: safety = not safe to drive as it is; soon = do it within weeks; can_wait = a recommendation, no rush.",
    "- customerText: one or two plain sentences for the customer, no jargon, no prices.",
    "Price list (code | name | also called):",
    rows,
  ].join("\n");
}

export function responseFormat(): unknown {
  return {
    type: "json_schema",
    json_schema: {
      name: "repair_lines",
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["lines"],
        properties: {
          lines: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["code", "urgency", "customerText"],
              properties: {
                code: { type: "string" },
                urgency: { type: "string", enum: urgencySchema.options },
                customerText: { type: "string" },
              },
            },
          },
        },
      },
    },
  };
}

const chatAnswer = z.object({ choices: z.array(z.object({ message: z.object({ content: z.string() }) })).min(1) });

async function groqLines(text: string, model: string, list: PriceList): Promise<DraftLine[]> {
  const body = JSON.stringify({
    model,
    temperature: 0,
    messages: [
      { role: "system", content: systemPrompt(list) },
      { role: "user", content: text },
    ],
    response_format: responseFormat(),
  });
  const answer = chatAnswer.safeParse(await groqPost("/chat/completions", body, "application/json"));
  if (!answer.success) throw new AgentError("Groq chat answer has no message content");
  const content = answer.data.choices[0]?.message.content ?? "";
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch {
    throw new AgentError("Groq chat answer is not JSON");
  }
  const lines = z.object({ lines: z.array(rawLineSchema) }).safeParse(json);
  if (!lines.success) throw new AgentError("Groq chat answer does not match the lines schema");
  return lines.data.lines;
}
