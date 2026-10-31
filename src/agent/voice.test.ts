import { afterEach, describe, expect, it, vi } from "vitest";
import { voiceToLines } from "./voice.js";

const audio = (id: string) => decodeURIComponent(new URL(`../../eval/audio/${id}.wav`, import.meta.url).pathname);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("voiceToLines", () => {
  it("turns a recorded note into priced lines; the price is the list's, not the model's", async () => {
    const r = await voiceToLines(audio("F13"), { stt: "recorded:parakeet-local", llm: "keywords" });
    expect(r.transcript).toBe("Front struts are leaking and the car keeps bouncing after bumps.");
    expect(r.lines).toEqual([{ code: "SUSP-STRUT-F", urgency: "soon", customerText: "Front struts — replace (pair)", title: "Front struts — replace (pair)", priceCents: 68900 }]);
    expect(r.droppedCodes).toEqual([]);
    expect(r.priceTextCodes).toEqual([]);
    expect(r.timings).toEqual({ sttMs: 670, llmMs: 0 });
  });

  it("returns no lines for a note with no work", async () => {
    const r = await voiceToLines(audio("F20"), { stt: "recorded:parakeet-local", llm: "keywords" });
    expect(r.lines).toEqual([]);
  });
});

describe("voiceToLines with a model that writes a price in the customer text", () => {
  const answer = (customerText: string) =>
    new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ lines: [{ code: "BRK-PAD-F", urgency: "safety", customerText }] }) } }] }), { status: 200 });

  it.each(["Replacing your front pads runs about $150.", "That is 150 dollars.", "About a hundred fifty bucks.", "Roughly 150 USD", "It costs 15000 cents", "Ca. 150 \u20ac"])(
    "replaces %j by the item name, so the screen shows one price, the list's",
    async (customerText) => {
      const fake = vi.fn(async () => answer(customerText));
      vi.stubGlobal("fetch", fake);
      vi.stubEnv("LBL_LLM_LIVE", "1");
      vi.stubEnv("GROQ_API_KEY", "fake-test-key-not-real");
      const r = await voiceToLines(audio("F01"), { stt: "recorded:parakeet-local", llm: "groq:openai/gpt-oss-120b" });
      expect(r.lines).toHaveLength(1);
      expect(r.lines[0]).toMatchObject({ code: "BRK-PAD-F", priceCents: 18900, customerText: r.lines[0]?.title });
      expect(r.priceTextCodes).toEqual(["BRK-PAD-F"]);
    },
  );

  it("keeps plain customer text, including a percent sign word like percent", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => answer("Your front pads are down to 20 percent and should be replaced soon.")));
    vi.stubEnv("LBL_LLM_LIVE", "1");
    vi.stubEnv("GROQ_API_KEY", "fake-test-key-not-real");
    const r = await voiceToLines(audio("F01"), { stt: "recorded:parakeet-local", llm: "groq:openai/gpt-oss-120b" });
    expect(r.lines[0]?.customerText).toBe("Your front pads are down to 20 percent and should be replaced soon.");
    expect(r.priceTextCodes).toEqual([]);
  });
});
