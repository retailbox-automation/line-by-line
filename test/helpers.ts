import { PGlite } from "@electric-sql/pglite";
import { createEstimateOrder, createRepairOrder, onApproved, type CoreDeps } from "../src/core/index.js";
import type { Db } from "../src/db/db.js";
import { migrate } from "../src/db/migrate.js";
import { wrapPglite } from "../src/db/pglite.js";
import { createPayPalClient, type PayPalClient } from "../src/paypal/client.js";
import { dbCallSink } from "../src/paypal/journal.js";
import { FakePayPal } from "./fake-paypal.js";

export class Clock {
  constructor(private t: number) {}
  now(): Date {
    return new Date(this.t);
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

let template: Promise<PGlite> | null = null;

/** A migrated PGlite per test, cloned from one migrated template per test file. */
export async function freshDb(): Promise<Db> {
  template ??= (async () => {
    const pg = new PGlite();
    await pg.waitReady;
    await migrate(wrapPglite(pg));
    return pg;
  })();
  const clone = await (await template).clone();
  return wrapPglite(clone);
}

export interface Env {
  clock: Clock;
  fake: FakePayPal;
  db: Db;
  paypal: PayPalClient;
  deps: CoreDeps;
}

export const START = Date.parse("2026-11-02T15:00:00Z");

export async function makeEnv(): Promise<Env> {
  const clock = new Clock(START);
  const fake = new FakePayPal(clock);
  const db = await freshDb();
  const paypal = createPayPalClient({
    clientId: "test-client-id",
    clientSecret: "test-client-secret",
    brandName: "Line by Line demo shop",
    fetch: fake.fetch,
    now: () => clock.now().getTime(),
    onCall: dbCallSink(db),
    retryDelayMs: 0,
    timeoutMs: 200,
  });
  const deps: CoreDeps = {
    db,
    paypal,
    now: () => clock.now(),
    config: { returnUrl: "https://lbl.example.test/api/paypal/return", cancelUrl: "https://lbl.example.test/api/paypal/cancel" },
  };
  return { clock, fake, db, paypal, deps };
}

export const CONSENT = { approverName: "Dana Demo", channel: "qr_page", esignConsent: true } as const;

/** The demo repair order: a $412 estimate in two lines. */
export async function estimateRo(env: Env) {
  const { repairOrder, lines } = await createRepairOrder(env.deps, {
    customerLabel: "Dana Demo (made-up)",
    estimateLines: [
      { title: "Front brake pads", priceCents: 26800, source: "desk", urgency: "safety" },
      { title: "Brake fluid flush", priceCents: 14400, source: "desk", urgency: "soon" },
    ],
  });
  return { ro: repairOrder, lines };
}

/** Estimate approved in PayPal and authorized. */
export async function approvedEstimate(env: Env, source: "paypal" | "card" = "paypal") {
  const { ro, lines } = await estimateRo(env);
  const { order } = await createEstimateOrder(env.deps, ro.id, CONSENT);
  env.fake.approve(order.id, source);
  const { authorization } = await onApproved(env.deps, order.id);
  return { ro, lines, order, authorization };
}

export async function dumpTables(db: Db): Promise<string> {
  const tables = ["repair_orders", "lines", "consents", "paypal_orders", "authorizations", "captures", "paypal_calls", "webhook_events", "ops"];
  const out: Record<string, unknown> = {};
  for (const t of tables) out[t] = (await db.query(`SELECT * FROM ${t}`)).rows;
  return JSON.stringify(out);
}
