// Call journal: one row per HTTP attempt to PayPal. Never request or response bodies, never payer data
// (name, e-mail, address, payer_id): the Developer Agreement asks to delete PayPal data within 48 h, so we
// simply do not keep it.

import type { Queryable } from "../db/db.js";

export interface CallRecord {
  at: Date;
  op: string;
  method: "GET" | "POST";
  path: string;
  requestId: string | null;
  /** null when no HTTP answer came back (network error, timeout). */
  httpStatus: number | null;
  debugId: string | null;
  resourceId: string | null;
  /** details[0].issue of an error answer, or NETWORK / TIMEOUT. */
  issue: string | null;
}

export type CallSink = (record: CallRecord) => void | Promise<void>;

/** Writes call records to `paypal_calls`. A failed journal write is logged and never breaks a money call. */
export function dbCallSink(db: Queryable): CallSink {
  return async (r) => {
    try {
      await db.query(
        `INSERT INTO paypal_calls (at, op, method, path, request_id, http_status, debug_id, resource_id, issue)
         VALUES ($1::timestamptz, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [r.at.toISOString(), r.op, r.method, r.path, r.requestId, r.httpStatus, r.debugId, r.resourceId, r.issue],
      );
    } catch (e) {
      console.error(`paypal_calls write failed for ${r.op}: ${(e as Error).message}`);
    }
  };
}
