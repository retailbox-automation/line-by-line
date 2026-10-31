import { describe, expect, it } from "vitest";
import { normalizeWords, wer } from "./wer.js";

describe("normalizeWords", () => {
  it.each([
    ["two millimeters", "2mm"],
    ["about two millimeters.", "about 2mm"],
    ["three mil", "3mm"],
    ["a hundred and ten thousand", "110,000"],
    ["P zero four two zero", "P0420"],
    ["code P zero four two zero.", "code P0420,"],
    ["sixty thousand miles", "60,000 miles"],
    ["four percent moisture", "4% moisture"],
    ["twenty one", "21"],
    ["Front-pads", "front pads"],
  ])("%j matches %j", (spoken, written) => {
    expect(normalizeWords(spoken)).toEqual(normalizeWords(written));
  });

  it("gives the digits", () => {
    expect(normalizeWords("a hundred and ten thousand")).toEqual(["110000"]);
    expect(normalizeWords("P zero four two zero")).toEqual(["p0420"]);
    expect(normalizeWords("2mm")).toEqual(["2mm"]);
    expect(normalizeWords("one hundred and five")).toEqual(["105"]);
  });

  it("leaves ordinary words alone, including a lone article and the word and", () => {
    expect(normalizeWords("Pads and rotors, a bit worn")).toEqual(["pads", "and", "rotors", "a", "bit", "worn"]);
    expect(normalizeWords("constructor toString")).toEqual(["constructor", "tostring"]);
  });
});

describe("wer", () => {
  it("is 0 for the same words spoken or written", () => {
    expect(wer("Plugs are at a hundred and ten thousand miles.", "Plugs are at 110,000 miles.")).toBe(0);
    expect(wer("Check engine light, code P zero four two zero.", "Check engine light, code P0420.")).toBe(0);
    expect(wer("Pads are down to about two millimeters.", "Pads are down to about 2mm.")).toBe(0);
  });

  it("counts substitutions, insertions and deletions over the reference length", () => {
    expect(wer("a b c d", "a x c d")).toBeCloseTo(0.25);
    expect(wer("a b c d", "a b c d e")).toBeCloseTo(0.25);
    expect(wer("a b c d", "a b")).toBeCloseTo(0.5);
    expect(wer("a b", "")).toBe(1);
  });
});
