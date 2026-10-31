import { afterEach, describe, expect, it, vi } from "vitest";
import { noteId, transcribe } from "./transcribe.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("transcribe", () => {
  it("replays the stored parakeet answer by the audio file's note id", async () => {
    expect(noteId("/any/where/F22.wav")).toBe("F22");
    const r = await transcribe("/any/where/F22.wav", "recorded:parakeet-local");
    expect(r.text).toBe("Check engine light is on, code P0420, needs a diagnosis.");
    expect(r.ms).toBe(858);
  });

  it("fails clearly on a note that was not recorded and on unknown providers", async () => {
    await expect(transcribe("F99.wav", "recorded:parakeet-local")).rejects.toThrow(/no answer for F99/);
    await expect(transcribe("F01.wav", "groq:some-other-model")).rejects.toThrow(/unknown Groq speech model/);
    await expect(transcribe("F01.wav", "whisper")).rejects.toThrow(/unknown speech provider/);
  });

  it.each(["groq:whisper-large-v3", "groq:whisper-large-v3-turbo"])("%s refuses without the live flag, before reading the file or calling fetch", async (provider) => {
    const fake = vi.fn();
    vi.stubGlobal("fetch", fake);
    vi.stubEnv("GROQ_API_KEY", "fake-test-key-not-real");
    vi.stubEnv("LBL_LLM_LIVE", "");
    // The path does not exist: reaching the file would give ENOENT instead of the guard's message.
    await expect(transcribe("/no/such/dir/F01.wav", provider)).rejects.toThrow(/LBL_LLM_LIVE=1/);
    expect(fake).not.toHaveBeenCalled();
  });

  it("refuses with the flag but without a key", async () => {
    const fake = vi.fn();
    vi.stubGlobal("fetch", fake);
    vi.stubEnv("LBL_LLM_LIVE", "1");
    vi.stubEnv("GROQ_API_KEY", "");
    await expect(transcribe("/no/such/dir/F01.wav", "groq:whisper-large-v3-turbo")).rejects.toThrow(/GROQ_API_KEY/);
    expect(fake).not.toHaveBeenCalled();
  });

  it("posts the audio as multipart and reads the text (fake fetch)", async () => {
    const fake = vi.fn(async () => new Response(JSON.stringify({ text: " Front pads are thin. " }), { status: 200 }));
    vi.stubGlobal("fetch", fake);
    vi.stubEnv("LBL_LLM_LIVE", "1");
    vi.stubEnv("GROQ_API_KEY", "fake-test-key-not-real");
    const audio = new URL("../../eval/audio/F16.wav", import.meta.url).pathname;
    const r = await transcribe(decodeURIComponent(audio), "groq:whisper-large-v3-turbo");
    expect(r.text).toBe("Front pads are thin.");
    const [url, init] = fake.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.groq.com/openai/v1/audio/transcriptions");
    const form = init.body as FormData;
    expect(form.get("model")).toBe("whisper-large-v3-turbo");
    expect((form.get("file") as File).size).toBeGreaterThan(1000);
  });
});
