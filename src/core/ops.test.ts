import { describe, expect, it } from "vitest";
import { freshDb, makeEnv } from "../../test/helpers.js";
import { GuardError, PayPalError } from "../paypal/errors.js";
import { CoreError } from "./errors.js";
import { canonicalJson, claimOp, finishOp, nextAttempt, requestIdFor, runOp } from "./ops.js";

describe("requestIdFor", () => {
  it("is deterministic and shaped lbl:<op>:<entity>:<attempt>", () => {
    expect(requestIdFor("capture", "4RR33540BR8604004", 1)).toBe("lbl:capture:4RR33540BR8604004:1");
    expect(requestIdFor("capture", "4RR33540BR8604004", 1)).toBe(requestIdFor("capture", "4RR33540BR8604004", 1));
    expect(requestIdFor("order-add", "ro_0123456789abcdef.0a1b2c3d4e5f", 2)).toBe("lbl:order-add:ro_0123456789abcdef.0a1b2c3d4e5f:2");
  });

  it("refuses ids over 108 characters, odd characters and bad attempts", () => {
    expect(() => requestIdFor("capture", "x".repeat(100), 1)).toThrow(GuardError);
    expect(() => requestIdFor("capture", "a b", 1)).toThrow(GuardError);
    expect(() => requestIdFor("capture", "a:b", 1)).toThrow(GuardError);
    expect(() => requestIdFor("cap ture", "a", 1)).toThrow(GuardError);
    expect(() => requestIdFor("capture", "a", 0)).toThrow(GuardError);
    expect(() => requestIdFor("capture", "a", 1.5)).toThrow(GuardError);
    expect(requestIdFor("c", "x".repeat(108 - "lbl:c::1".length), 1)).toHaveLength(108);
  });
});

describe("canonicalJson", () => {
  it("ignores key order (jsonb reorders keys)", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: true } })).toBe(canonicalJson({ a: { c: true, d: [1, { x: 1, y: 2 }] }, b: 1 }));
  });
});

describe("claimOp", () => {
  const T0 = new Date("2026-11-02T15:00:00Z");
  const spec = { op: "capture" as const, entityId: "AUTH1", intent: { cents: 100, finalCapture: false } };

  it("claims once; a live duplicate is IN_PROGRESS; a different intent is CONFLICT", async () => {
    const db = await freshDb();
    await expect(claimOp(db, spec, T0, 60_000)).resolves.toEqual({ requestId: "lbl:capture:AUTH1:1", attempt: 1 });
    await expect(claimOp(db, spec, new Date(T0.getTime() + 1000), 60_000)).rejects.toMatchObject({ code: "IN_PROGRESS" });
    await expect(claimOp(db, { ...spec, intent: { cents: 200, finalCapture: false } }, T0, 60_000)).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("an abandoned (stale) attempt is taken over with the SAME id, once", async () => {
    const db = await freshDb();
    await claimOp(db, spec, T0, 60_000);
    const later = new Date(T0.getTime() + 61_000);
    await expect(claimOp(db, spec, later, 60_000)).resolves.toEqual({ requestId: "lbl:capture:AUTH1:1", attempt: 1 });
    await expect(claimOp(db, spec, later, 60_000)).rejects.toMatchObject({ code: "IN_PROGRESS" });
  });

  it("a finished attempt moves the counter: done and failed both free a new id", async () => {
    const db = await freshDb();
    await claimOp(db, spec, T0, 60_000);
    await finishOp(db, "lbl:capture:AUTH1:1", "failed", {}, T0);
    expect(await nextAttempt(db, "capture", "AUTH1")).toBe(2);
    await expect(claimOp(db, spec, T0, 60_000)).resolves.toMatchObject({ requestId: "lbl:capture:AUTH1:2" });
    await finishOp(db, "lbl:capture:AUTH1:2", "done", {}, T0);
    await expect(claimOp(db, spec, T0, 60_000)).resolves.toMatchObject({ requestId: "lbl:capture:AUTH1:3" });
  });
});

describe("runOp", () => {
  const spec = { op: "void" as const, entityId: "AUTH9", intent: {} };

  it("a definite 4xx finishes the op as failed", async () => {
    const env = await makeEnv();
    const err = PayPalError.fromResponse(422, JSON.stringify({ details: [{ issue: "PREVIOUSLY_VOIDED" }] }));
    await expect(runOp(env.deps, spec, async () => Promise.reject(err), async () => undefined)).rejects.toBe(err);
    const r = await env.db.query<{ state: string; result: { error: { outcome: string } } }>(`SELECT state, result FROM ops`);
    expect(r.rows[0]).toMatchObject({ state: "failed", result: { error: { outcome: "PREVIOUSLY_VOIDED" } } });
  });

  it("no answer keeps the op started and lets the next try reuse the same id at once", async () => {
    const env = await makeEnv();
    const seen: string[] = [];
    await expect(
      runOp(env.deps, spec, async (rid) => {
        seen.push(rid);
        throw new TypeError("fetch failed");
      }, async () => undefined),
    ).rejects.toThrow("fetch failed");
    await runOp(env.deps, spec, async (rid) => {
      seen.push(rid);
      return { ok: true };
    }, async () => undefined);
    expect(seen).toEqual(["lbl:void:AUTH9:1", "lbl:void:AUTH9:1"]);
    expect((await env.db.query<{ state: string }>(`SELECT state FROM ops`)).rows).toEqual([{ state: "done" }]);
  });

  it("our own write failing after PayPal succeeded keeps the same id for the retry", async () => {
    const env = await makeEnv();
    const seen: string[] = [];
    await expect(
      runOp(env.deps, spec, async (rid) => (seen.push(rid), 1), async () => {
        throw new Error("db write failed");
      }),
    ).rejects.toThrow("db write failed");
    await runOp(env.deps, spec, async (rid) => (seen.push(rid), 1), async () => undefined);
    expect(seen).toEqual(["lbl:void:AUTH9:1", "lbl:void:AUTH9:1"]);
  });

  it("a guard error (nothing sent) is a definite failure", async () => {
    const env = await makeEnv();
    await expect(runOp(env.deps, spec, async () => Promise.reject(new GuardError("no")), async () => undefined)).rejects.toBeInstanceOf(GuardError);
    expect((await env.db.query<{ state: string }>(`SELECT state FROM ops`)).rows).toEqual([{ state: "failed" }]);
  });

  it("CoreError from a claim is passed through", async () => {
    const env = await makeEnv();
    await env.db.tx((q) => claimOp(q, spec, env.clock.now(), 60_000));
    await expect(runOp(env.deps, spec, async () => 1, async () => undefined)).rejects.toBeInstanceOf(CoreError);
  });
});
