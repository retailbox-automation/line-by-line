import { describe, expect, it } from "vitest";
import { classify, describeError, GuardError, isDefiniteFailure, PayPalError } from "./errors.js";

// Real error bodies from our sandbox logs (2026-10-20 reauthorize on day 0, 2026-10-24 void of a reauthorization).
const REAUTH_TOO_SOON = {
  name: "UNPROCESSABLE_ENTITY",
  message: "The requested action could not be performed, semantically incorrect, or failed business validation.",
  debug_id: "ca4d52aeb4cc6",
  details: [{ issue: "REAUTHORIZATION_TOO_SOON", description: "A reauthorization is only allowed once from Day 4 to Day 29 since the date of the original authorization." }],
  links: [{ href: "https://developer.paypal.com/docs/api/payments/v2/#error-REAUTHORIZATION_TOO_SOON", rel: "information_link", method: "GET" }],
};
const CANNOT_BE_VOIDED = {
  name: "UNPROCESSABLE_ENTITY",
  message: "The requested action could not be performed, semantically incorrect, or failed business validation.",
  debug_id: "f195459185888",
  details: [{ issue: "CANNOT_BE_VOIDED", description: "A reauthorization cannot be voided. Please void the original parent authorization." }],
  links: [{ href: "https://developer.paypal.com/docs/api/payments/v2/#error-CANNOT_BE_VOIDED", rel: "information_link" }],
};

function shaped(issue: string, status = 422) {
  return PayPalError.fromResponse(status, JSON.stringify({ name: "UNPROCESSABLE_ENTITY", message: "x", debug_id: "d1", details: [{ issue, description: `${issue} text` }] }));
}

describe("PayPalError.fromResponse", () => {
  it("reads the recorded REAUTHORIZATION_TOO_SOON body", () => {
    const e = PayPalError.fromResponse(422, JSON.stringify(REAUTH_TOO_SOON));
    expect(e).toMatchObject({ httpStatus: 422, paypalName: "UNPROCESSABLE_ENTITY", issue: "REAUTHORIZATION_TOO_SOON", debugId: "ca4d52aeb4cc6" });
    expect(e.description).toMatch(/only allowed once from Day 4/);
    expect(classify(e)).toBe("REAUTHORIZATION_TOO_SOON");
  });

  it("reads the recorded CANNOT_BE_VOIDED body", () => {
    const e = PayPalError.fromResponse(422, JSON.stringify(CANNOT_BE_VOIDED));
    expect(classify(e)).toBe("CANNOT_BE_VOIDED");
    expect(e.debugId).toBe("f195459185888");
  });

  it("takes the debug id from the header when the body has none, and survives HTML", () => {
    const e = PayPalError.fromResponse(502, "<html>Bad gateway</html>", "hdr-debug");
    expect(e).toMatchObject({ httpStatus: 502, debugId: "hdr-debug", issue: undefined });
    expect(classify(e)).toBe("UNKNOWN");
  });

  it("reads OAuth error bodies", () => {
    const e = PayPalError.fromResponse(401, JSON.stringify({ error: "invalid_client", error_description: "Client Authentication failed" }));
    expect(e).toMatchObject({ paypalName: "invalid_client", description: "Client Authentication failed" });
  });
});

describe("classify", () => {
  it.each([
    ["MAX_CAPTURE_COUNT_EXCEEDED", "MAX_CAPTURE_COUNT_EXCEEDED"],
    ["MAX_CAPTURE_AMOUNT_EXCEEDED", "MAX_CAPTURE_AMOUNT_EXCEEDED"],
    ["PREVIOUSLY_CAPTURED", "PREVIOUSLY_CAPTURED"],
    ["AUTHORIZATION_ALREADY_CAPTURED", "PREVIOUSLY_CAPTURED"],
    ["PREVIOUSLY_VOIDED", "PREVIOUSLY_VOIDED"],
    ["AUTHORIZATION_VOIDED", "PREVIOUSLY_VOIDED"],
    ["AUTHORIZATION_EXPIRED", "AUTHORIZATION_EXPIRED"],
    ["ORDER_NOT_APPROVED", "ORDER_NOT_APPROVED"],
    ["ORDER_ALREADY_AUTHORIZED", "ORDER_ALREADY_AUTHORIZED"],
    ["INSTRUMENT_DECLINED", "INSTRUMENT_DECLINED"],
    ["DUPLICATE_REQUEST_ID", "DUPLICATE_REQUEST_ID"],
  ])("%s -> %s", (issue, outcome) => expect(classify(shaped(issue))).toBe(outcome));

  it("keeps an unknown issue as UNKNOWN with its text", () => {
    const e = shaped("SOMETHING_NEW");
    expect(classify(e)).toBe("UNKNOWN");
    expect(describeError(e)).toContain("SOMETHING_NEW");
    expect(describeError(e)).toContain("debug_id d1");
  });

  it("non-PayPal errors are UNKNOWN", () => {
    expect(classify(new Error("boom"))).toBe("UNKNOWN");
    expect(classify("x")).toBe("UNKNOWN");
  });
});

describe("isDefiniteFailure", () => {
  it("4xx answers are definite; 408/409/429, 5xx and network errors are not", () => {
    expect(isDefiniteFailure(shaped("X", 422))).toBe(true);
    expect(isDefiniteFailure(shaped("X", 400))).toBe(true);
    for (const s of [408, 409, 429, 500, 503]) expect(isDefiniteFailure(shaped("X", s))).toBe(false);
    expect(isDefiniteFailure(new TypeError("fetch failed"))).toBe(false);
    expect(isDefiniteFailure(new GuardError("x"))).toBe(false);
  });
});
