import { describe, expect, it, vi } from "vitest";

// Every MAC comparison must go through crypto.timingSafeEqual on two 32-byte buffers.
const seen = vi.hoisted(() => ({ compares: [] as [number, number][] }));
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return {
    ...actual,
    timingSafeEqual: (a: NodeJS.ArrayBufferView, b: NodeJS.ArrayBufferView) => {
      seen.compares.push([a.byteLength, b.byteLength]);
      return actual.timingSafeEqual(a, b);
    },
  };
});

const { JUDGE_SESSION_MS, looksLikeJudgeToken, signJudgeToken, verifyJudgeToken } = await import("./session.js");

const DESK = "test-desk-token-0123456789";
const SID = `js_${"ab".repeat(16)}`;
const NOW = Date.parse("2026-11-02T15:00:00Z");
const EXP = NOW + JUDGE_SESSION_MS;

describe("judge token", () => {
  it("signs j.<sessionId>.<expiresAt>.<hmac> and verifies it until it expires", () => {
    const token = signJudgeToken(DESK, SID, EXP);
    expect(token).toMatch(/^j\.js_[0-9a-f]{32}\.[0-9]{13}\.[0-9a-f]{64}$/);
    expect(token).not.toContain(DESK);
    expect(looksLikeJudgeToken(token)).toBe(true);
    expect(looksLikeJudgeToken(DESK)).toBe(false);
    expect(verifyJudgeToken(DESK, token, new Date(NOW))).toEqual({ sessionId: SID, expiresAt: EXP });
    expect(verifyJudgeToken(DESK, token, new Date(EXP - 1))).not.toBeNull();
    expect(verifyJudgeToken(DESK, token, new Date(EXP))).toBeNull();
  });

  it("refuses a forged MAC, a moved expiry, another session id and another DESK_TOKEN, comparing in constant time", () => {
    const token = signJudgeToken(DESK, SID, EXP);
    const last = token.at(-1) === "0" ? "1" : "0";
    seen.compares.length = 0;
    expect(verifyJudgeToken(DESK, `${token.slice(0, -1)}${last}`, new Date(NOW))).toBeNull();
    expect(verifyJudgeToken(DESK, token.replace(`.${EXP}.`, `.${EXP + JUDGE_SESSION_MS}.`), new Date(NOW))).toBeNull();
    expect(verifyJudgeToken(DESK, token.replace(SID, `js_${"cd".repeat(16)}`), new Date(NOW))).toBeNull();
    expect(verifyJudgeToken("another-desk-token-012345", token, new Date(NOW))).toBeNull();
    expect(seen.compares).toEqual([
      [32, 32],
      [32, 32],
      [32, 32],
      [32, 32],
    ]);
  });

  it("refuses malformed tokens without throwing and without comparing", () => {
    const token = signJudgeToken(DESK, SID, EXP);
    seen.compares.length = 0;
    for (const bad of ["", "j.", "j.x.y.z", DESK, token.toUpperCase(), `${token}0`, token.slice(0, -1), `${token}.x`, token.replace("j.", "k."), token.replace(`.${EXP}.`, ".1.")]) {
      expect(verifyJudgeToken(DESK, bad, new Date(NOW))).toBeNull();
    }
    expect(seen.compares).toEqual([]);
  });
});
