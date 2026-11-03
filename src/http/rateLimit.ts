// A fixed one-minute window per client address, in the memory of one server process. Used on the PayPal webhook
// route, where every request may cost a call to PayPal's verify-webhook-signature.

export type Take = (key: string, nowMs: number) => { ok: true } | { ok: false; retryAfterMs: number };

/** At most `max` requests per `windowMs` per key; at most `maxKeys` keys are remembered (the oldest windows go first). */
export function windowLimiter(max: number, windowMs: number, maxKeys = 10_000): Take {
  const hits = new Map<string, { start: number; n: number }>();
  return (key, now) => {
    const h = hits.get(key);
    if (h && now - h.start < windowMs) {
      if (h.n >= max) return { ok: false, retryAfterMs: h.start + windowMs - now };
      h.n++;
      return { ok: true };
    }
    hits.delete(key);
    if (hits.size >= maxKeys) {
      for (const [k, w] of hits) if (now - w.start >= windowMs) hits.delete(k);
      // Still full (that many addresses inside one window): forget the oldest windows, so memory stays bounded.
      for (const k of hits.keys()) {
        if (hits.size < maxKeys) break;
        hits.delete(k);
      }
    }
    hits.set(key, { start: now, n: 1 });
    return { ok: true };
  };
}

/**
 * The client address: the last X-Forwarded-For entry (the one the platform's proxy appended; earlier entries are
 * whatever the client sent), else the socket's address, else "unknown".
 */
export function clientAddress(forwardedFor: string | undefined, socketAddress: string | undefined): string {
  const last = forwardedFor
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .at(-1);
  return last ?? socketAddress ?? "unknown";
}
