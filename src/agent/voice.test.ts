import { describe, expect, it } from "vitest";
import { voiceToLines } from "./voice.js";

const audio = (id: string) => decodeURIComponent(new URL(`../../eval/audio/${id}.wav`, import.meta.url).pathname);

describe("voiceToLines", () => {
  it("turns a recorded note into priced lines; the price is the list's, not the model's", async () => {
    const r = await voiceToLines(audio("F13"), { stt: "recorded:parakeet-local", llm: "keywords" });
    expect(r.transcript).toBe("Front struts are leaking and the car keeps bouncing after bumps.");
    expect(r.lines).toEqual([{ code: "SUSP-STRUT-F", urgency: "soon", customerText: "Front struts — replace (pair)", title: "Front struts — replace (pair)", priceCents: 68900 }]);
    expect(r.droppedCodes).toEqual([]);
    expect(r.timings).toEqual({ sttMs: 670, llmMs: 0 });
  });

  it("returns no lines for a note with no work", async () => {
    const r = await voiceToLines(audio("F20"), { stt: "recorded:parakeet-local", llm: "keywords" });
    expect(r.lines).toEqual([]);
  });
});
