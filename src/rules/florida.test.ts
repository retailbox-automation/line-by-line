import { describe, expect, it } from "vitest";
import { flEstimateRequired, flNeedsNewAuthorization, flNewLineNeedsConsent, flToleranceCents } from "./florida.js";

describe("Florida 559.909 tolerance (KB 2.2 table)", () => {
  it.each([
    [8000, 1000, 9000],
    [10000, 1000, 11000],
    [41200, 4120, 45320],
    [50000, 5000, 55000],
    [120000, 5000, 125000],
  ])("estimate %i cents -> tolerance %i, ceiling %i", (estimate, tolerance, ceiling) => {
    expect(flToleranceCents(estimate)).toBe(tolerance);
    // "more than": the ceiling itself needs no new consent, one cent above does
    expect(flNeedsNewAuthorization(estimate, ceiling)).toBe(false);
    expect(flNeedsNewAuthorization(estimate, ceiling + 1)).toBe(true);
  });

  it("floor and cap", () => {
    expect(flToleranceCents(0)).toBe(1000);
    expect(flToleranceCents(9999)).toBe(1000);
    expect(flToleranceCents(10010)).toBe(1001);
    expect(flToleranceCents(10_000_000)).toBe(5000);
  });
});

describe("559.905(1) written estimate", () => {
  it("required when the work will exceed $150, not at exactly $150", () => {
    expect(flEstimateRequired(15000)).toBe(false);
    expect(flEstimateRequired(15001)).toBe(true);
  });
});

describe("demo policy", () => {
  it("a new line always asks for consent", () => expect(flNewLineNeedsConsent()).toBe(true));
});
