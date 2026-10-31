import { describe, expect, it } from "vitest";
import { withUsd } from "./serialize.js";

describe("withUsd", () => {
  it("adds a dollar string next to every cents field, nested and in arrays", () => {
    expect(
      withUsd({
        priceCents: 18400,
        feeCents: null,
        lines: [{ amountCents: 5, title: "x" }],
        plan: [{ kind: "capture", cents: 39800 }],
        live: { capturedCents: 0 },
      }),
    ).toEqual({
      priceCents: 18400,
      price: "184.00",
      feeCents: null,
      fee: null,
      lines: [{ amountCents: 5, amount: "0.05", title: "x" }],
      plan: [{ kind: "capture", cents: 39800, amount: "398.00" }],
      live: { capturedCents: 0, captured: "0.00" },
    });
  });

  it("turns dates into ISO strings and leaves other values alone", () => {
    expect(withUsd({ at: new Date("2026-11-02T15:00:00Z"), n: 3, s: "a", b: true, x: null })).toEqual({ at: "2026-11-02T15:00:00.000Z", n: 3, s: "a", b: true, x: null });
  });

  it("never overwrites a real field and skips values that are not whole cents", () => {
    expect(withUsd({ priceCents: 100, price: "kept" })).toEqual({ priceCents: 100, price: "kept" });
    expect(withUsd({ priceCents: -1, otherCents: 1.5, textCents: "7" })).toEqual({ priceCents: -1, otherCents: 1.5, textCents: "7" });
  });
});
