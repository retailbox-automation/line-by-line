import type { Db } from "../db/db.js";
import type { PayPalClient, UserAction } from "../paypal/client.js";

export const DEFAULT_APPROVAL_TTL_MS = 3 * 60 * 60 * 1000;
/** A `started` operation older than this is treated as abandoned (process died) and may be retried. */
export const DEFAULT_OP_STALE_MS = 5 * 60 * 1000;

export interface CoreConfig {
  /** PayPal sends the payer back here with ?token=<orderId> (e.g. PUBLIC_BASE_URL + /api/paypal/return). */
  returnUrl: string;
  cancelUrl: string;
  /** An approval link older than this is re-created as a new order. Default 3 h. */
  approvalTtlMs?: number;
  userAction?: UserAction;
  opStaleMs?: number;
}

export interface CoreDeps {
  db: Db;
  paypal: PayPalClient;
  now: () => Date;
  config: CoreConfig;
}

export function approvalTtlMs(deps: CoreDeps): number {
  return deps.config.approvalTtlMs ?? DEFAULT_APPROVAL_TTL_MS;
}

export function opStaleMs(deps: CoreDeps): number {
  return deps.config.opStaleMs ?? DEFAULT_OP_STALE_MS;
}
