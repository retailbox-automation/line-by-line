// Judge sessions. A judge gets no login: POST /api/judge/session hands out a signed token
// j.<sessionId>.<expiresAt>.<hmac> that lives 2 hours and opens only the repair orders created in that session.
// The HMAC key is derived from DESK_TOKEN under its own label, so the token never reveals DESK_TOKEN and a new
// DESK_TOKEN ends every judge session.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { CoreDeps } from "../core/deps.js";
import type { Queryable } from "../db/db.js";
import { HttpError } from "../http/errors.js";

export const JUDGE_SESSION_MS = 2 * 60 * 60 * 1000;
export const DEFAULT_JUDGE_DAILY_SESSIONS = 200;
export const JUDGE_COOKIE = "lbl_judge";
const DAY_MS = 24 * 60 * 60 * 1000;
// Epoch milliseconds have 13 digits until the year 2286; the MAC is 32 bytes in hex.
const TOKEN = /^j\.(js_[0-9a-f]{32})\.([0-9]{13})\.([0-9a-f]{64})$/;

function judgeKey(deskToken: string): Buffer {
  return createHmac("sha256", deskToken).update("lbl-judge-session-key:v1").digest();
}

function mac(deskToken: string, sessionId: string, expiresAt: number): Buffer {
  return createHmac("sha256", judgeKey(deskToken)).update(`j.${sessionId}.${expiresAt}`).digest();
}

export function signJudgeToken(deskToken: string, sessionId: string, expiresAt: number): string {
  return `j.${sessionId}.${expiresAt}.${mac(deskToken, sessionId, expiresAt).toString("hex")}`;
}

/** A judge token, as opposed to the desk token or a customer page token (it may still be forged or expired). */
export function looksLikeJudgeToken(token: string): boolean {
  return token.startsWith("j.");
}

/** The session of a well-formed, correctly signed, unexpired token; null otherwise. The MAC is compared in constant time. */
export function verifyJudgeToken(deskToken: string, token: string, now: Date): { sessionId: string; expiresAt: number } | null {
  const m = TOKEN.exec(token);
  if (!m) return null;
  const sessionId = m[1]!;
  const expiresAt = Number(m[2]);
  // Both sides are 32 bytes (the pattern fixes the length), so timingSafeEqual compares them in full.
  if (!timingSafeEqual(Buffer.from(m[3]!, "hex"), mac(deskToken, sessionId, expiresAt))) return null;
  if (expiresAt <= now.getTime()) return null;
  return { sessionId, expiresAt };
}

/**
 * A new session, at most `dailyCap` per UTC day (429 DAILY_CAP beyond). The count and the insert run under a table
 * lock, so two requests cannot both take the last session of the day.
 */
export async function createJudgeSession(deps: Pick<CoreDeps, "db" | "now">, dailyCap: number): Promise<{ id: string; expiresAt: Date }> {
  const now = deps.now();
  const dayStart = new Date(Math.floor(now.getTime() / DAY_MS) * DAY_MS);
  return deps.db.tx(async (q) => {
    await q.query(`LOCK TABLE judge_sessions IN SHARE ROW EXCLUSIVE MODE`);
    const n = (await q.query<{ n: number }>(`SELECT count(*)::int AS n FROM judge_sessions WHERE created_at >= $1::timestamptz`, [dayStart.toISOString()])).rows[0]?.n ?? 0;
    if (n >= dailyCap) throw new HttpError(429, "DAILY_CAP", `the daily limit of ${dailyCap} judge sessions is reached; try again after 00:00 UTC`);
    const id = `js_${randomBytes(16).toString("hex")}`;
    const expiresAt = new Date(now.getTime() + JUDGE_SESSION_MS);
    await q.query(`INSERT INTO judge_sessions (id, created_at, expires_at) VALUES ($1, $2::timestamptz, $3::timestamptz)`, [id, now.toISOString(), expiresAt.toISOString()]);
    return { id, expiresAt };
  });
}

/** True when the session row exists and has not expired. */
export async function judgeSessionAlive(q: Queryable, sessionId: string, now: Date): Promise<boolean> {
  const r = await q.query(`SELECT 1 FROM judge_sessions WHERE id = $1 AND expires_at > $2::timestamptz`, [sessionId, now.toISOString()]);
  return r.rows.length > 0;
}
