import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { assertCents, fromPayPal, fromPayPalAmount, MoneyError, toPayPal, usd } from "./money.js";

describe("toPayPal", () => {
  it.each([
    [0, "0.00"],
    [1, "0.01"],
    [10, "0.10"],
    [18400, "184.00"],
    [41220, "412.20"],
    [123456789, "1234567.89"],
  ])("%i -> %s", (cents, s) => expect(toPayPal(cents)).toBe(s));

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])("refuses %s", (bad) => {
    expect(() => toPayPal(bad)).toThrow(MoneyError);
  });
});

describe("fromPayPal", () => {
  it.each([
    ["184.00", 18400],
    ["0.00", 0],
    ["0.01", 1],
    ["142.5", 14250],
    ["7", 700],
    ["1234567.89", 123456789],
  ])("%s -> %i", (s, cents) => expect(fromPayPal(s)).toBe(cents));

  it.each(["", " 1.00", "1.00 ", "-1.00", "+1.00", "1.001", "1.", ".50", "01.00", "1e3", "1,00", "abc", "1.0a", "0x10", "99999999999999999999.00"])("refuses %j", (bad) => {
    expect(() => fromPayPal(bad)).toThrow(MoneyError);
  });

  it("round-trips every amount", () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 10_000_000_000 }), (c) => fromPayPal(toPayPal(c)) === c));
  });
});

describe("fromPayPalAmount / usd / assertCents", () => {
  it("reads USD only", () => {
    expect(fromPayPalAmount({ currency_code: "USD", value: "50.00" })).toBe(5000);
    expect(() => fromPayPalAmount({ currency_code: "EUR", value: "50.00" })).toThrow(MoneyError);
    expect(() => fromPayPalAmount({ currency_code: "USD", value: 50 })).toThrow(MoneyError);
    expect(() => fromPayPalAmount(null)).toThrow(MoneyError);
  });
  it("builds the PayPal money object", () => expect(usd(3120)).toEqual({ currency_code: "USD", value: "31.20" }));
  it("assertCents names the field", () => expect(() => assertCents(-5, "capture")).toThrow(/capture/));
});
