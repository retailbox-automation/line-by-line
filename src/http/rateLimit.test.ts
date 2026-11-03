import { describe, expect, it } from "vitest";
import { clientAddress, windowLimiter } from "./rateLimit.js";

describe("windowLimiter", () => {
  it("lets `max` requests per key through in a window, then refuses with the time left", () => {
    const take = windowLimiter(3, 1000);
    expect([take("a", 0), take("a", 10), take("a", 20)]).toEqual([{ ok: true }, { ok: true }, { ok: true }]);
    expect(take("a", 400)).toEqual({ ok: false, retryAfterMs: 600 });
    expect(take("b", 400)).toEqual({ ok: true });
    expect(take("a", 999)).toEqual({ ok: false, retryAfterMs: 1 });
    expect(take("a", 1000)).toEqual({ ok: true });
  });

  it("remembers at most maxKeys addresses: expired windows go first, then the oldest", () => {
    const take = windowLimiter(1, 1000, 2);
    take("a", 0);
    take("b", 500);
    // "a" expired at 1000: it is dropped and "c" takes its place; "b" is still counted.
    expect(take("c", 1200)).toEqual({ ok: true });
    expect(take("b", 1200)).toEqual({ ok: false, retryAfterMs: 300 });
    // Both windows alive and the map full: the oldest ("b") is forgotten for "d".
    expect(take("d", 1300)).toEqual({ ok: true });
    expect(take("b", 1300)).toEqual({ ok: true });
    expect(take("d", 1300)).toEqual({ ok: false, retryAfterMs: 1000 });
  });
});

describe("clientAddress", () => {
  it("takes the last X-Forwarded-For entry, else the socket address, else unknown", () => {
    expect(clientAddress("203.0.113.9, 198.51.100.7", "10.0.0.1")).toBe("198.51.100.7");
    expect(clientAddress(" 198.51.100.7 ", undefined)).toBe("198.51.100.7");
    expect(clientAddress("198.51.100.7, ", undefined)).toBe("198.51.100.7");
    expect(clientAddress(" , ", "10.0.0.1")).toBe("10.0.0.1");
    expect(clientAddress(undefined, "10.0.0.1")).toBe("10.0.0.1");
    expect(clientAddress(undefined, undefined)).toBe("unknown");
  });

  it("never uses a non-IP string as the key: a forged last entry falls back to the socket address", () => {
    expect(clientAddress("198.51.100.7, " + "x".repeat(8000), "10.0.0.1")).toBe("10.0.0.1");
    expect(clientAddress("not-an-ip", undefined)).toBe("unknown");
    expect(clientAddress("2001:db8::1", "10.0.0.1")).toBe("2001:db8::1");
    expect(clientAddress(undefined, "garbage")).toBe("unknown");
  });
});
