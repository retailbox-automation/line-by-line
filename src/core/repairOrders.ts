// Repair orders and their lines: our own records only.

import { randomBytes } from "node:crypto";
import { z } from "zod";
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

export const LineInputSchema = z.object({
  title: z.string().trim().min(1).max(127),
  description: z.string().trim().max(2000).default(""),
  priceCents: z.number().int().positive().max(MAX_LINE_CENTS),
  urgency: z.enum(["safety", "soon", "can_wait"]).nullable().default(null),
  source: z.enum(["desk", "mechanic"]),
});
export type LineInput = z.input<typeof LineInputSchema>;

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

async function insertLine(q: Queryable, roId: string, kind: "estimate" | "added", l: z.output<typeof LineInputSchema>, at: Date): Promise<Line> {
  const r = await q.query<Line>(
    `INSERT INTO lines (id, ro_id, kind, title, description, price_cents, urgency, source, status, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'proposed', $9::timestamptz) RETURNING ${LINE_COLS}`,
    [newId("ln"), roId, kind, l.title, l.description, l.priceCents, l.urgency, l.source, at.toISOString()],
  );
  return r.rows[0]!;
}

export async function createRepairOrder(deps: CoreDeps, input: CreateRepairOrderInput): Promise<{ repairOrder: RepairOrder; lines: Line[] }> {
  const data = parseInput(CreateRepairOrderSchema, input);
  const at = deps.now();
  return deps.db.tx(async (q) => {
    const id = newId("ro");
    await q.query(`INSERT INTO repair_orders (id, customer_label, state, status, created_at) VALUES ($1, $2, $3, 'open', $4::timestamptz)`, [
      id,
      data.customerLabel,
      data.state,
      at.toISOString(),
    ]);
    const lines: Line[] = [];
    // Keep the given order: created_at plus one millisecond per line.
    for (const [i, l] of data.estimateLines.entries()) lines.push(await insertLine(q, id, "estimate", l, new Date(at.getTime() + i)));
    return { repairOrder: await loadRepairOrder(q, id), lines };
  });
}

/** A new line found during the repair (mechanic or desk). It always needs the customer's own decision. */
export async function addLine(deps: CoreDeps, roId: string, input: LineInput): Promise<Line> {
  const data = parseInput(LineInputSchema, input);
  return deps.db.tx(async (q) => {
    const ro = await loadRepairOrder(q, roId, true);
    if (ro.status !== "open") throw new CoreError("CONFLICT", `repair order ${roId} is already picked up`, { roId });
    return insertLine(q, roId, "added", data, deps.now());
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
