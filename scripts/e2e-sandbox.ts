// Live walk-through against the PayPal SANDBOX (never live) and a local database. Run by hand, not by the tests.
//
//   npm run e2e:sandbox                                  the demo story (see below)
//   npm run e2e:sandbox -- --probe-capture-limit          $5.00 hold, $0.01 captures until the first error (max 30)
//   npm run e2e:sandbox -- --reauthorize <authId>...     reauthorize existing holds for the same amount, read the new ids
//
// Options: --timeout-min N (wait for approval, default 20), --user-action PAY_NOW|CONTINUE (default PAY_NOW),
// --attempt N (reauthorize PayPal-Request-Id attempt, default 1).
// Env: PAYPAL_SANDBOX_CLIENT_ID, PAYPAL_SANDBOX_CLIENT_SECRET; optional DATABASE_URL (else in-memory PGlite, or
// PGLITE_DIR), PUBLIC_BASE_URL (return/cancel pages; default https://example.com/line-by-line-e2e), BRAND_NAME.
//
// The script never approves anything: it prints each approval link, a person approves it as the sandbox buyer in a
// browser, and the script polls GET /v2/checkout/orders/:id until APPROVED. Results (ids, statuses, fees, the call
// journal; no payer data) go to e2e-out/ (git-ignored).

import { mkdir, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import type { CoreDeps } from "../src/core/index.js";
import { migrate, openDb, type Db } from "../src/db/index.js";
import { createPayPalClient, type PayPalClient, type UserAction } from "../src/paypal/client.js";
import { describeError } from "../src/paypal/errors.js";
import { dbCallSink } from "../src/paypal/journal.js";
import { demoStory, probeCaptureLimit, reauthorizeIds, type Check, type ScenarioContext } from "./e2e-scenarios.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    "probe-capture-limit": { type: "boolean", default: false },
    reauthorize: { type: "boolean", default: false },
    "timeout-min": { type: "string", default: "20" },
    "user-action": { type: "string", default: "PAY_NOW" },
    attempt: { type: "string", default: "1" },
  },
});

const POLL_MS = 5000;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

const timeoutMin = Number(values["timeout-min"]);
if (!Number.isFinite(timeoutMin) || timeoutMin <= 0) fail("--timeout-min must be a positive number");
const userAction = values["user-action"] as UserAction;
if (userAction !== "PAY_NOW" && userAction !== "CONTINUE") fail("--user-action must be PAY_NOW or CONTINUE");
const attempt = Number(values.attempt);
if (!Number.isSafeInteger(attempt) || attempt < 1) fail("--attempt must be a positive whole number");
if (values.reauthorize && values["probe-capture-limit"]) fail("choose one mode: --reauthorize or --probe-capture-limit");
if (values.reauthorize && positionals.length === 0) fail("--reauthorize needs at least one authorization id");
if (!values.reauthorize && positionals.length) fail(`unexpected arguments: ${positionals.join(" ")}`);
for (const id of positionals) if (!/^[A-Z0-9]{10,64}$/.test(id)) fail(`not a PayPal authorization id: ${id}`);

const clientId = process.env.PAYPAL_SANDBOX_CLIENT_ID;
const clientSecret = process.env.PAYPAL_SANDBOX_CLIENT_SECRET;
if (!clientId || !clientSecret) fail("PAYPAL_SANDBOX_CLIENT_ID and PAYPAL_SANDBOX_CLIENT_SECRET must be set (sandbox REST app)");
const base = (process.env.PUBLIC_BASE_URL ?? "https://example.com/line-by-line-e2e").replace(/\/+$/, "");

const db: Db = await openDb();
await migrate(db);
const paypal: PayPalClient = createPayPalClient({ clientId, clientSecret, brandName: process.env.BRAND_NAME ?? "Line by Line", onCall: dbCallSink(db) });
const deps: CoreDeps = { db, paypal, now: () => new Date(), config: { returnUrl: `${base}/api/paypal/return`, cancelUrl: `${base}/api/paypal/cancel`, userAction } };

const checks: Check[] = [];
function check(name: string, ok: boolean, detail: string): void {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name} — ${detail}`);
}

/** Prints the approval link and polls GET /v2/checkout/orders/:id until a person has approved it in a browser. */
async function waitForApproval(orderId: string, approveUrl: string | null): Promise<void> {
  if (!approveUrl) throw new Error(`order ${orderId} has no approval link`);
  console.log(`\nApprove order ${orderId} in the browser as the sandbox buyer:\n  ${approveUrl}\n(waiting up to ${timeoutMin} min)`);
  const deadline = Date.now() + timeoutMin * 60_000;
  for (;;) {
    const o = await paypal.getOrder(orderId);
    if (o.status === "APPROVED" || o.status === "COMPLETED") {
      console.log(`order ${orderId}: ${o.status}`);
      return;
    }
    if (Date.now() > deadline) throw new Error(`order ${orderId} was not approved within ${timeoutMin} min (status ${o.status})`);
    await sleep(POLL_MS);
  }
}

const ctx: ScenarioContext = { deps, waitForApproval, check };
const mode = values.reauthorize ? "reauthorize" : values["probe-capture-limit"] ? "probe-capture-limit" : "demo";
const startedAt = new Date();
let result: Record<string, unknown> = {};
let crash: unknown = null;
try {
  result = mode === "reauthorize" ? await reauthorizeIds(ctx, positionals, attempt) : mode === "probe-capture-limit" ? await probeCaptureLimit(ctx) : await demoStory(ctx);
} catch (e) {
  crash = e;
  console.error(`stopped: ${describeError(e)}`);
}
// This run's calls only (DATABASE_URL may hold earlier runs).
const calls = (
  await db.query(`SELECT at, op, method, path, request_id, http_status, debug_id, resource_id, issue FROM paypal_calls WHERE at >= $1::timestamptz ORDER BY id`, [
    startedAt.toISOString(),
  ])
).rows;
await mkdir("e2e-out", { recursive: true });
const file = `e2e-out/${mode}-${startedAt.toISOString().replace(/[:.]/g, "-")}.json`;
await writeFile(file, JSON.stringify({ mode, userAction, startedAt, finishedAt: new Date(), checks, error: crash ? describeError(crash) : null, result, calls }, null, 2));
await db.close();
console.log(`\nresult: ${file}`);
const failed = checks.filter((c) => !c.ok).length;
console.log(`${checks.length - failed}/${checks.length} checks passed${crash ? ", stopped early" : ""}`);
process.exit(crash || failed ? 1 : 0);
