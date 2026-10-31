import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { MoneyError } from "../money.js";
import { billable, MoneyGuardError, planPickup } from "./plan.js";

const auth = (amountCents: number, capturedCents = 0, status = "CREATED") => ({ amountCents, capturedCents, status });

describe("planPickup branches", () => {
  it("full amount: one capture with final_capture true, no void", () => {
    expect(planPickup(auth(18600), 18600, 18600)).toEqual({ steps: [{ kind: "capture", cents: 18600, finalCapture: true }], captureCents: 18600, warnings: [], reason: null });
  });

  it("part of the hold: capture with final_capture false, then void", () => {
    expect(planPickup(auth(41200), 41200, 39800).steps).toEqual([{ kind: "capture", cents: 39800, finalCapture: false }, { kind: "void" }]);
  });

  it("nothing performed: void only", () => {
    expect(planPickup(auth(41200), 41200, 0)).toMatchObject({ steps: [{ kind: "void" }], captureCents: 0 });
  });

  it("overrun: captures the approved amount only and warns", () => {
    const p = planPickup(auth(41200), 41200, 45000);
    expect(p.steps).toEqual([{ kind: "capture", cents: 41200, finalCapture: true }]);
    expect(p.warnings[0]).toMatch(/new consent/);
  });

  it("partially captured before: the rest is what is left", () => {
    expect(planPickup(auth(10000, 3120, "PARTIALLY_CAPTURED"), 6880, 6880).steps).toEqual([{ kind: "capture", cents: 6880, finalCapture: true }]);
    expect(planPickup(auth(10000, 3120, "PARTIALLY_CAPTURED"), 6880, 1872).steps).toEqual([{ kind: "capture", cents: 1872, finalCapture: false }, { kind: "void" }]);
  });

  it("nothing left on the hold: no steps (a void would only get PREVIOUSLY_CAPTURED)", () => {
    expect(planPickup(auth(10000, 10000, "PARTIALLY_CAPTURED"), 0, 0)).toMatchObject({ steps: [], reason: "nothing is left on the authorization" });
  });

  it.each(["VOIDED", "CAPTURED", "EXPIRED", "DENIED"])("%s: no steps, with the reason", (status) => {
    expect(planPickup(auth(10000, 0, status), 10000, 10000)).toEqual({ steps: [], captureCents: 0, warnings: [], reason: `authorization is ${status}` });
  });
});

describe("planPickup guards (no network involved)", () => {
  it("refuses a capture above what is left on the hold", () => {
    expect(() => planPickup(auth(10000, 5000, "PARTIALLY_CAPTURED"), 10000, 8000)).toThrow(MoneyGuardError);
    expect(() => planPickup(auth(10000), 12000, 12000)).toThrow(MoneyGuardError);
  });

  it("refuses captured above the authorization", () => {
    expect(() => planPickup(auth(10000, 10001, "PARTIALLY_CAPTURED"), 0, 0)).toThrow(MoneyGuardError);
  });

  it.each([
    [auth(-1), 0, 0],
    [auth(100.5), 0, 0],
    [auth(100), -5, 0],
    [auth(100), 0, 1.25],
    [auth(100), Number.NaN, 0],
    [auth(100, -1), 0, 0],
  ])("refuses negative or fractional cents %#", (a, approved, performed) => {
    expect(() => planPickup(a, approved, performed)).toThrow(MoneyError);
  });
});

describe("planPickup properties", () => {
  const capturable = fc.constantFrom("CREATED", "PARTIALLY_CAPTURED");

  it("never captures more than approved or more than left, and voids exactly when something stays held", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 5_000_000 }), fc.integer({ min: 0, max: 5_000_000 }), fc.integer({ min: 0, max: 6_000_000 }), fc.integer({ min: 0, max: 6_000_000 }), capturable, (amount, capturedRaw, approvedRaw, performed, status) => {
        const captured = Math.min(capturedRaw, amount);
        const left = amount - captured;
        const approved = Math.min(approvedRaw, left); // what pickup passes: never above the hold
        const plan = planPickup({ amountCents: amount, capturedCents: captured, status }, approved, performed);
        const captures = plan.steps.filter((s) => s.kind === "capture");
        const total = captures.reduce((a, s) => a + (s.kind === "capture" ? s.cents : 0), 0);
        expect(captures.length).toBeLessThanOrEqual(1);
        expect(total).toBeLessThanOrEqual(approved);
        expect(total).toBeLessThanOrEqual(left);
        expect(total).toBe(Math.min(performed, approved));
        const voids = plan.steps.filter((s) => s.kind === "void").length;
        expect(voids).toBe(total < left ? 1 : 0);
        if (captures[0]?.kind === "capture") expect(captures[0].finalCapture).toBe(total === left);
        // void, when present, is always the last step
        if (voids) expect(plan.steps.at(-1)).toEqual({ kind: "void" });
      }),
      { numRuns: 2000 },
    );
  });

  it("throws instead of planning when approved is above what is left", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1_000_000 }), fc.integer({ min: 1, max: 1_000_000 }), (amount, extra) => {
        expect(() => planPickup({ amountCents: amount, capturedCents: 0, status: "CREATED" }, amount + extra, amount + extra)).toThrow(MoneyGuardError);
      }),
    );
  });
});

describe("billable", () => {
  it("clamps per line: an overrun on one line is not paid by savings on another", () => {
    const b = billable([
      { lineId: "a", priceCents: 20000, performedCents: 25000 },
      { lineId: "b", priceCents: 21200, performedCents: 14800 },
    ]);
    expect(b).toEqual({ approvedCents: 41200, billableCents: 20000 + 14800, overruns: [{ lineId: "a", approvedCents: 20000, performedCents: 25000 }] });
  });

  it("property: per line never above the approved price, total never above approved", () => {
    fc.assert(
      fc.property(fc.array(fc.record({ priceCents: fc.integer({ min: 1, max: 1_000_000 }), performedCents: fc.integer({ min: 0, max: 2_000_000 }) }), { maxLength: 20 }), (ls) => {
        const lines = ls.map((l, i) => ({ lineId: `l${i}`, ...l }));
        const b = billable(lines);
        expect(b.billableCents).toBeLessThanOrEqual(b.approvedCents);
        expect(b.billableCents).toBe(lines.reduce((a, l) => a + Math.min(l.priceCents, l.performedCents), 0));
        expect(b.overruns.map((o) => o.lineId)).toEqual(lines.filter((l) => l.performedCents > l.priceCents).map((l) => l.lineId));
        // and the plan on top never captures more than the per-line sum
        const plan = planPickup({ amountCents: Math.max(1, b.approvedCents), capturedCents: 0, status: "CREATED" }, b.approvedCents, b.billableCents);
        const cap = plan.steps.find((s) => s.kind === "capture");
        expect(cap?.kind === "capture" ? cap.cents : 0).toBeLessThanOrEqual(b.billableCents);
      }),
    );
  });
});
