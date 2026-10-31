// Ceiling on live (paid) model calls per UTC day, counted in the database before each call.

import type { Queryable } from "../db/db.js";

export const DEFAULT_LIVE_DAILY_CAP = 200;

/** Providers that cost money per call: every `groq:*`. `keywords`, `recorded:*` and `local:*` are not counted. */
export function isLiveProvider(provider: string): boolean {
  return provider.startsWith("groq:");
}

export class DailyCapError extends Error {
  override name = "DailyCapError";
}

/**
 * Takes `n` calls from today's budget (UTC day of `now`) or throws DailyCapError and takes none. One statement, so two
 * requests at the same moment cannot both get the last free call. Returns today's count after this request.
 */
export async function takeLiveCalls(q: Queryable, now: Date, n: number, cap: number): Promise<number> {
  const day = now.toISOString().slice(0, 10);
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`takeLiveCalls: n must be a positive whole number, got ${n}`);
  const refused = () => new DailyCapError(`the daily limit of ${cap} live model calls is reached (UTC day ${day}); samples and keywords still work`);
  if (n > cap) throw refused();
  const r = await q.query<{ count: number }>(
    `INSERT INTO model_calls (day, count) VALUES ($1::date, $2)
     ON CONFLICT (day) DO UPDATE SET count = model_calls.count + EXCLUDED.count WHERE model_calls.count + EXCLUDED.count <= $3
     RETURNING count`,
    [day, n, cap],
  );
  if (!r.rows.length) throw refused();
  return r.rows[0]!.count;
}
