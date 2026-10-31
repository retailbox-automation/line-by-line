// Idempotency of every PayPal POST.
//
// The PayPal-Request-Id is derived from our own operation: lbl:<op>:<entityId>:<attempt>, where attempt is
// 1 + the number of FINISHED (done or failed) rows for (op, entityId). A row is written as `started` before the
// POST. If the process dies, or PayPal does not answer, the row stays `started`, the attempt number does not
// move, and the retry goes out with the same PayPal-Request-Id, so PayPal replays the first result instead of
// capturing twice. Only a definite refusal from PayPal (4xx) finishes the row as `failed` and frees a new id.
// A parallel duplicate hits the primary key of `ops` and gets IN_PROGRESS.

import { MoneyError } from "../money.js";
import { REQUEST_ID_PATTERN } from "../paypal/client.js";
import { classify, describeError, GuardError, isDefiniteFailure, PayPalError } from "../paypal/errors.js";
import type { Queryable } from "../db/db.js";
import { opStaleMs, type CoreDeps } from "./deps.js";
import { CoreError } from "./errors.js";

export type OpName = "order-est" | "order-add" | "authorize" | "capture" | "void" | "reauth";

const PART = /^[A-Za-z0-9._-]+$/;

export function requestIdFor(op: string, entityId: string, attempt: number): string {
  if (!PART.test(op) || !PART.test(entityId)) throw new GuardError(`request id parts must be [A-Za-z0-9._-]: ${op} ${entityId}`);
  if (!Number.isSafeInteger(attempt) || attempt < 1) throw new GuardError(`attempt must be a positive integer, got ${attempt}`);
  const id = `lbl:${op}:${entityId}:${attempt}`;
  if (!REQUEST_ID_PATTERN.test(id)) throw new GuardError(`request id longer than 108 characters: ${id}`);
  return id;
}

export async function nextAttempt(q: Queryable, op: string, entityId: string): Promise<number> {
  const r = await q.query<{ n: number }>(`SELECT count(*)::int AS n FROM ops WHERE op = $1 AND entity_id = $2 AND state IN ('done', 'failed')`, [op, entityId]);
  return (r.rows[0]?.n ?? 0) + 1;
}

/** Stable JSON (sorted keys) so an intent read back from jsonb compares equal to the one we built. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

export interface OpSpec {
  op: OpName;
  entityId: string;
  /** What this request will do (amount, final flag, line ids). A retry with the same id must match it. */
  intent: Record<string, unknown>;
}

interface OpRow {
  op: string;
  entity_id: string;
  state: "started" | "done" | "failed";
  result: { intent?: unknown; unknownOutcome?: boolean } | null;
  updated_at_text: string;
  updated_ms: number;
}

/**
 * Computes the attempt and claims the PayPal-Request-Id. Call inside a transaction when other checks must be
 * atomic with the claim. Throws IN_PROGRESS for a live duplicate, CONFLICT when the same id already finished
 * or was used for a different intent.
 */
export async function claimOp(q: Queryable, spec: OpSpec, now: Date, staleMs: number): Promise<{ requestId: string; attempt: number }> {
  const attempt = await nextAttempt(q, spec.op, spec.entityId);
  const requestId = requestIdFor(spec.op, spec.entityId, attempt);
  const at = now.toISOString();
  const inserted = await q.query(
    `INSERT INTO ops (request_id, op, entity_id, state, result, created_at, updated_at)
     VALUES ($1, $2, $3, 'started', $4::jsonb, $5::timestamptz, $5::timestamptz)
     ON CONFLICT (request_id) DO NOTHING RETURNING request_id`,
    [requestId, spec.op, spec.entityId, JSON.stringify({ intent: spec.intent }), at],
  );
  if (inserted.rows.length > 0) return { requestId, attempt };

  const existing = (
    await q.query<OpRow>(
      `SELECT op, entity_id, state, result, updated_at::text AS updated_at_text,
              (extract(epoch FROM updated_at) * 1000)::float8 AS updated_ms
         FROM ops WHERE request_id = $1`,
      [requestId],
    )
  ).rows[0];
  if (!existing) throw new CoreError("IN_PROGRESS", `operation ${requestId} is being written right now`, { requestId });
  if (existing.op !== spec.op || existing.entity_id !== spec.entityId) throw new CoreError("CONFLICT", `request id ${requestId} belongs to another operation`, { requestId });
  if (canonicalJson(existing.result?.intent ?? null) !== canonicalJson(spec.intent)) {
    throw new CoreError("CONFLICT", `operation ${requestId} was started with different parameters`, { requestId, started: existing.result?.intent ?? null, now: spec.intent });
  }
  if (existing.state !== "started") throw new CoreError("CONFLICT", `operation ${requestId} already ${existing.state}; reload the state`, { requestId, state: existing.state });

  const abandoned = existing.result?.unknownOutcome === true || now.getTime() - Number(existing.updated_ms) >= staleMs;
  if (!abandoned) throw new CoreError("IN_PROGRESS", `operation ${requestId} is in progress`, { requestId });
  // Take over an abandoned attempt (compare-and-set, so two takers cannot both win). Same id, same body.
  const taken = await q.query(
    `UPDATE ops SET updated_at = $3::timestamptz, result = $4::jsonb
      WHERE request_id = $1 AND state = 'started' AND updated_at::text = $2 RETURNING request_id`,
    [requestId, existing.updated_at_text, at, JSON.stringify({ intent: spec.intent, retakenAt: at })],
  );
  if (taken.rows.length === 0) throw new CoreError("IN_PROGRESS", `operation ${requestId} is in progress`, { requestId });
  return { requestId, attempt };
}

export async function finishOp(q: Queryable, requestId: string, state: "done" | "failed", result: Record<string, unknown>, now: Date): Promise<void> {
  await q.query(`UPDATE ops SET state = $2, result = $3::jsonb, updated_at = $4::timestamptz WHERE request_id = $1`, [
    requestId,
    state,
    JSON.stringify(result),
    now.toISOString(),
  ]);
}

/** The outcome is unknown (no answer, 5xx, unreadable answer, our write failed): keep `started`, allow an immediate retry. */
async function markUnknown(q: Queryable, requestId: string, intent: Record<string, unknown>, err: unknown, now: Date): Promise<void> {
  await q.query(`UPDATE ops SET result = $2::jsonb, updated_at = $3::timestamptz WHERE request_id = $1 AND state = 'started'`, [
    requestId,
    JSON.stringify({ intent, unknownOutcome: true, error: describeError(err) }),
    now.toISOString(),
  ]);
}

function errorSummary(err: unknown): Record<string, unknown> {
  return {
    outcome: classify(err),
    text: describeError(err),
    httpStatus: err instanceof PayPalError ? err.httpStatus : null,
    issue: err instanceof PayPalError ? (err.issue ?? null) : null,
    debugId: err instanceof PayPalError ? (err.debugId ?? null) : null,
  };
}

/**
 * Phases 2 and 3 of an operation whose id is already claimed: the PayPal call, then our write and `done` in one
 * transaction. `persist` must only use the `q` it gets.
 */
export async function executeOp<T>(
  deps: CoreDeps,
  claimed: { requestId: string },
  intent: Record<string, unknown>,
  call: (requestId: string) => Promise<T>,
  persist: (q: Queryable, result: T, requestId: string) => Promise<void>,
): Promise<T> {
  const { requestId } = claimed;
  let result: T;
  try {
    result = await call(requestId);
  } catch (err) {
    const definite = isDefiniteFailure(err) || err instanceof GuardError || err instanceof MoneyError;
    if (definite) await finishOp(deps.db, requestId, "failed", { intent, error: errorSummary(err) }, deps.now());
    else await markUnknown(deps.db, requestId, intent, err, deps.now());
    throw err;
  }
  try {
    await deps.db.tx(async (q) => {
      await persist(q, result, requestId);
      await finishOp(q, requestId, "done", { intent, response: result as unknown }, deps.now());
    });
  } catch (err) {
    // PayPal did it but our write failed: the retry replays the same id and writes again.
    await markUnknown(deps.db, requestId, intent, err, deps.now()).catch(() => undefined);
    throw err;
  }
  return result;
}

/**
 * claim (own transaction) + execute. `precheck` runs in the claim transaction before the id is claimed: it takes
 * the row locks and re-checks, on fresh rows, that the operation still applies (throw a CoreError to refuse). The
 * attempt number moves on once an operation is done, so a caller working from an old snapshot would otherwise get
 * a new PayPal-Request-Id and repeat the money call.
 */
export async function runOp<T>(
  deps: CoreDeps,
  spec: OpSpec,
  call: (requestId: string) => Promise<T>,
  persist: (q: Queryable, result: T, requestId: string) => Promise<void>,
  precheck?: (q: Queryable) => Promise<void>,
): Promise<{ requestId: string; result: T }> {
  const claimed = await deps.db.tx(async (q) => {
    if (precheck) await precheck(q);
    return claimOp(q, spec, deps.now(), opStaleMs(deps));
  });
  const result = await executeOp(deps, claimed, spec.intent, call, persist);
  return { requestId: claimed.requestId, result };
}
