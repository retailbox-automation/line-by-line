// Repair orders and their lines: our own records only.

import { randomBytes } from "node:crypto";
import { z } from "zod";
import { loadPriceList, type PriceList } from "../agent/priceList.js";
import { customerText, MAX_CUSTOMER_TEXT } from "../agent/voice.js";
import type { Queryable } from "../db/db.js";
import type { CoreDeps } from "./deps.js";
import { CoreError } from "./errors.js";
import {
  AUTH_COLS,
  CAPTURE_COLS,
  CONSENT_COLS,
  LINE_COLS,
  loadRepairOrder,
  ORDER_COLS,
  type Authorization,
  type Capture,
  type Consent,
  type Line,
  type PaypalOrder,
  type RepairOrder,
} from "./rows.js";

/** Largest single line we accept ($10,000). */
export const MAX_LINE_CENTS = 1_000_000;

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

/**
 * A line by hand (`title` + `priceCents`), or from the price list (`priceCode`: the title and price are the list's;
 * a `title` or `priceCents` sent along must equal them, the description is the customer text, at most 300 characters).
 */
export const LineInputSchema = z
  .object({
    priceCode: z.string().trim().min(1).max(32).optional(),
    title: z.string().trim().min(1).max(127).optional(),
    description: z.string().trim().max(2000).default(""),
    priceCents: z.number().int().positive().max(MAX_LINE_CENTS).optional(),
    urgency: z.enum(["safety", "soon", "can_wait"]).nullable().default(null),
    source: z.enum(["desk", "mechanic"]),
  })
  .superRefine((l, ctx) => {
    if (l.priceCode !== undefined) {
      if (l.description.length > MAX_CUSTOMER_TEXT) {
        ctx.addIssue({ code: "custom", path: ["description"], message: `a price-list line takes at most ${MAX_CUSTOMER_TEXT} characters of customer text` });
      }
      return;
    }
    if (l.title === undefined) ctx.addIssue({ code: "custom", path: ["title"], message: "title is required (or send a priceCode)" });
    if (l.priceCents === undefined) ctx.addIssue({ code: "custom", path: ["priceCents"], message: "priceCents is required (or send a priceCode)" });
  });
export type LineInput = z.input<typeof LineInputSchema>;

/** A line ready to insert: the price-list code resolved to its title and price. */
export interface NewLine {
  title: string;
  description: string;
  priceCents: number;
  urgency: z.output<typeof LineInputSchema>["urgency"];
  source: z.output<typeof LineInputSchema>["source"];
  priceCode: string | null;
}

let shopPriceList: PriceList | undefined;

/** Resolves price-list codes; every problem of every line goes into one VALIDATION error. */
export function resolveLines(lines: z.output<typeof LineInputSchema>[], pathPrefix: (i: number) => string, list: PriceList = (shopPriceList ??= loadPriceList())): NewLine[] {
  const issues: { path: string; message: string }[] = [];
  const out = lines.map((l, i): NewLine => {
    if (l.priceCode === undefined) return { title: l.title!, description: l.description, priceCents: l.priceCents!, urgency: l.urgency, source: l.source, priceCode: null };
    const item = list.byCode(l.priceCode);
    const at = pathPrefix(i);
    if (!item) {
      issues.push({ path: `${at}priceCode`, message: `${l.priceCode} is not in the price list` });
      return { title: "", description: "", priceCents: 0, urgency: l.urgency, source: l.source, priceCode: l.priceCode };
    }
    if (l.title !== undefined && l.title !== item.name) issues.push({ path: `${at}title`, message: `${l.priceCode} is "${item.name}" in the price list; leave the title out or send it unchanged` });
    if (l.priceCents !== undefined && l.priceCents !== item.cents) issues.push({ path: `${at}priceCents`, message: `${l.priceCode} costs ${item.cents} cents in the price list; leave the price out or send it unchanged` });
    return { title: item.name, description: customerText(l.description, item.name).text, priceCents: item.cents, urgency: l.urgency, source: l.source, priceCode: item.code };
  });
  if (issues.length) throw new CoreError("VALIDATION", issues.map((x) => `${x.path}: ${x.message}`).join("; "), { issues });
  return out;
}

export const CreateRepairOrderSchema = z.object({
  customerLabel: z.string().trim().min(1).max(100),
  state: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .default("FL"),
  estimateLines: z.array(LineInputSchema).min(1).max(50),
});
export type CreateRepairOrderInput = z.input<typeof CreateRepairOrderSchema>;

export function parseInput<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const r = schema.safeParse(input);
  if (!r.success) {
    const issues = r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
    throw new CoreError("VALIDATION", issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join("; "), { issues });
  }
  return r.data;
}

async function insertLine(q: Queryable, roId: string, kind: "estimate" | "added", l: NewLine, at: Date): Promise<Line> {
  const r = await q.query<Line>(
    `INSERT INTO lines (id, ro_id, kind, title, description, price_cents, urgency, source, status, price_code, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'proposed', $9, $10::timestamptz) RETURNING ${LINE_COLS}`,
    [newId("ln"), roId, kind, l.title, l.description, l.priceCents, l.urgency, l.source, l.priceCode, at.toISOString()],
  );
  return r.rows[0]!;
}

/** The inserts of createRepairOrder, inside the caller's transaction (the judge demo adds its session id). */
export async function insertRepairOrder(q: Queryable, input: CreateRepairOrderInput, at: Date, judgeSessionId: string | null = null): Promise<{ repairOrder: RepairOrder; lines: Line[] }> {
  const data = parseInput(CreateRepairOrderSchema, input);
  const estimate = resolveLines(data.estimateLines, (i) => `estimateLines.${i}.`);
  const id = newId("ro");
  await q.query(`INSERT INTO repair_orders (id, customer_label, state, status, judge_session_id, created_at) VALUES ($1, $2, $3, 'open', $4, $5::timestamptz)`, [
    id,
    data.customerLabel,
    data.state,
    judgeSessionId,
    at.toISOString(),
  ]);
  const lines: Line[] = [];
  // Keep the given order: created_at plus one millisecond per line.
  for (const [i, l] of estimate.entries()) lines.push(await insertLine(q, id, "estimate", l, new Date(at.getTime() + i)));
  return { repairOrder: await loadRepairOrder(q, id), lines };
}

export async function createRepairOrder(deps: CoreDeps, input: CreateRepairOrderInput): Promise<{ repairOrder: RepairOrder; lines: Line[] }> {
  const at = deps.now();
  return deps.db.tx((q) => insertRepairOrder(q, input, at));
}

/** A new line found during the repair (mechanic or desk). It always needs the customer's own decision. */
export async function addLine(deps: CoreDeps, roId: string, input: LineInput): Promise<Line> {
  const [data] = resolveLines([parseInput(LineInputSchema, input)], () => "");
  return deps.db.tx(async (q) => {
    const ro = await loadRepairOrder(q, roId, true);
    if (ro.status !== "open") throw new CoreError("CONFLICT", `repair order ${roId} is already picked up`, { roId });
    return insertLine(q, roId, "added", data!, deps.now());
  });
}

export interface RepairOrderState {
  repairOrder: RepairOrder;
  lines: Line[];
  consents: Consent[];
  orders: PaypalOrder[];
  authorizations: Authorization[];
  captures: Capture[];
}

/** Everything the screens need about one repair order, from our database (no PayPal call). */
export async function getRepairOrder(deps: CoreDeps, roId: string): Promise<RepairOrderState> {
  const q = deps.db;
  const repairOrder = await loadRepairOrder(q, roId);
  const lines = (await q.query<Line>(`SELECT ${LINE_COLS} FROM lines WHERE ro_id = $1 ORDER BY created_at, id`, [roId])).rows;
  const consents = (await q.query<Consent>(`SELECT ${CONSENT_COLS} FROM consents WHERE ro_id = $1 ORDER BY decided_at, id`, [roId])).rows;
  const orders = (await q.query<PaypalOrder>(`SELECT ${ORDER_COLS} FROM paypal_orders WHERE ro_id = $1 ORDER BY created_at, id`, [roId])).rows;
  const authorizations = (await q.query<Authorization>(`SELECT ${AUTH_COLS} FROM authorizations WHERE ro_id = $1 ORDER BY created_at, id`, [roId])).rows;
  const captures = (
    await q.query<Capture>(
      `SELECT ${CAPTURE_COLS} FROM captures WHERE authorization_id IN (SELECT id FROM authorizations WHERE ro_id = $1) ORDER BY created_at, id`,
      [roId],
    )
  ).rows;
  return { repairOrder, lines, consents, orders, authorizations, captures };
}
