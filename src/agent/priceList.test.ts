import { describe, expect, it } from "vitest";
import { loadPriceList, parsePriceList } from "./priceList.js";

const item = (code: string, cents: number) => ({ code, name: `Item ${code}`, cents, aliases: [] as string[] });
const file = (items: unknown[]) => ({ shop: "Test Shop", currency: "USD", items });

describe("parsePriceList", () => {
  it("looks items up by code", () => {
    const list = parsePriceList(file([item("A", 100), item("B", 250)]));
    expect(list.byCode("B")?.cents).toBe(250);
    expect(list.byCode("NOPE")).toBeUndefined();
  });

  it("refuses a duplicate code", () => {
    expect(() => parsePriceList(file([item("A", 100), item("A", 200)]))).toThrow(/duplicate code A/);
  });

  it.each([0, -5, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])("refuses cents %s", (cents) => {
    expect(() => parsePriceList(file([item("A", cents)]))).toThrow();
  });

  it("refuses a missing code, an empty list, a non-USD currency and a string price", () => {
    expect(() => parsePriceList(file([{ name: "x", cents: 100, aliases: [] }]))).toThrow();
    expect(() => parsePriceList(file([]))).toThrow();
    expect(() => parsePriceList({ ...file([item("A", 100)]), currency: "EUR" })).toThrow();
    expect(() => parsePriceList(file([{ ...item("A", 100), cents: "100" }]))).toThrow();
  });
});

describe("the shipped price list", () => {
  it("loads, and every price is whole cents", () => {
    const list = loadPriceList();
    expect(list.items).toHaveLength(32);
    expect(list.byCode("BRK-PAD-F")?.cents).toBe(18900);
  });
});
