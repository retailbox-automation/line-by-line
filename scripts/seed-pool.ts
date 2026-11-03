// Records existing sandbox holds in the judge pool. Explicit authorization ids only: nothing is searched or listed at
// PayPal (orders of another entry live in the same sandbox app and are never touched).
//
//   npm run seed:pool -- --purpose judge|reserved --wave N --label L [--note "..."] <authId>...
//
// Per id: live GET of the authorization and of its order; only a CREATED hold paid from a PayPal wallet is taken. It
// becomes a repair order of kind 'pool' with its lines (from the order's items, PayPal's prices), order and
// authorization, plus the pool row. Running it again with the same id updates the pool row only (label, purpose,
// wave, note). Exit code 1 when any id was refused.
// Env: PAYPAL_SANDBOX_CLIENT_ID, PAYPAL_SANDBOX_CLIENT_SECRET, DATABASE_URL (else PGlite in PGLITE_DIR), BRAND_NAME.

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { CoreDeps } from "../src/core/index.js";
import { migrate, openDb } from "../src/db/index.js";
import { seedPool, type PoolSeedInput, type SeedResult } from "../src/judge/pool.js";
import { createPayPalClient } from "../src/paypal/client.js";
import { dbCallSink } from "../src/paypal/journal.js";

/** Command line -> seedPool input. Throws a readable error; the values are checked again by seedPool. */
export function parseSeedArgs(argv: string[]): PoolSeedInput {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: { purpose: { type: "string" }, wave: { type: "string" }, label: { type: "string" }, note: { type: "string" } },
  });
  if (values.purpose !== "judge" && values.purpose !== "reserved") throw new Error("--purpose must be judge or reserved");
  if (values.wave === undefined || !/^[0-9]{1,4}$/.test(values.wave)) throw new Error("--wave must be a whole number");
  if (!values.label?.trim()) throw new Error("--label is required");
  if (positionals.length === 0) throw new Error("give at least one authorization id");
  return { purpose: values.purpose, wave: Number(values.wave), label: values.label, note: values.note ?? "", ids: positionals };
}

export function formatResults(results: SeedResult[]): string {
  return results
    .map((r) => `${r.outcome.padEnd(8)} ${r.authorizationId}${r.roId ? `  ${r.roId}` : ""}${r.amountCents !== null ? `  ${(r.amountCents / 100).toFixed(2)} USD` : ""}${r.reason ? `  ${r.reason}` : ""}`)
    .join("\n");
}

async function main(): Promise<void> {
  let input: PoolSeedInput;
  try {
    input = parseSeedArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`seed-pool: ${(e as Error).message}`);
    process.exit(2);
  }
  const clientId = process.env.PAYPAL_SANDBOX_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_SANDBOX_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    console.error("seed-pool: PAYPAL_SANDBOX_CLIENT_ID and PAYPAL_SANDBOX_CLIENT_SECRET must be set (sandbox REST app)");
    process.exit(2);
  }
  const db = await openDb();
  try {
    await migrate(db);
    const paypal = createPayPalClient({ clientId, clientSecret, brandName: process.env.BRAND_NAME ?? "Bayside Auto Care", onCall: dbCallSink(db) });
    // Seeding creates no PayPal order, so the return and cancel pages are never used.
    const deps: CoreDeps = { db, paypal, now: () => new Date(), config: { returnUrl: "https://example.com/unused", cancelUrl: "https://example.com/unused" } };
    const results = await seedPool(deps, input);
    console.log(formatResults(results));
    process.exitCode = results.some((r) => r.outcome === "refused") ? 1 : 0;
  } catch (e) {
    console.error(`seed-pool: ${(e as Error).message}`);
    process.exitCode = 2;
  } finally {
    await db.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
