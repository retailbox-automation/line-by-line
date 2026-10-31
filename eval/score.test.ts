import { describe, expect, it } from "vitest";
import { scoreLines, type Finding, type Prediction } from "./score.js";

const f = (id: string, ...expected: Array<[string, "safety" | "soon" | "can_wait"]>): Finding => ({
  id,
  note: id,
  expected: expected.map(([code, urgency]) => ({ code, urgency })),
  tags: [],
});
const p = (...lines: Array<[string, "safety" | "soon" | "can_wait"]>): Prediction => ({ lines: lines.map(([code, urgency]) => ({ code, urgency })), droppedCodes: [] });

describe("scoreLines", () => {
  it("counts an exact match, an extra code, a missing code, a missing prediction and an empty expectation", () => {
    const findings = [
      f("N1", ["A", "safety"]), // exact
      f("N2"), // nothing expected...
      f("N3", ["B", "soon"], ["C", "soon"]), // C missing, B urgency wrong
      f("N4", ["D", "soon"]), // no prediction at all
      f("N5"), // nothing expected, nothing predicted: exact
    ];
    const preds = new Map<string, Prediction>([
      ["N1", p(["A", "safety"])],
      ["N2", { lines: [{ code: "X", urgency: "soon" }], droppedCodes: ["MADE-UP"] }], // ...but an extra code, plus one invented
      ["N3", p(["B", "can_wait"])],
      ["N5", p()],
    ]);
    const s = scoreLines(findings, preds);
    expect(s.exact).toBe(2);
    expect(s.notes).toBe(5);
    // tp: N1 A, N3 B = 2; fp: N2 X = 1; fn: N3 C + N4 D = 2
    expect(s.precision).toBeCloseTo(2 / 3);
    expect(s.recall).toBeCloseTo(2 / 4);
    expect(s.invented).toBe(1);
    expect(s.urgencyN).toBe(2);
    expect(s.urgencyOk).toBe(1);
    expect(s.rows.map((r) => r.ok)).toEqual([true, false, false, false, true]);
    expect(s.rows[2]).toMatchObject({ expected: ["B", "C"], got: ["B"] });
  });

  it("counts a dropped code once per note, however often it was named", () => {
    const s = scoreLines([f("N1")], new Map([["N1", { lines: [], droppedCodes: ["Z", "Z", "Y"] }]]));
    expect(s.invented).toBe(2);
  });

  it("does not divide by zero when nothing was predicted or expected", () => {
    const s = scoreLines([f("N1")], new Map());
    expect(s).toMatchObject({ exact: 1, precision: 0, recall: 0, invented: 0 });
  });
});
