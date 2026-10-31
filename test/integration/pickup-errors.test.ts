import { describe, expect, it } from "vitest";
import { addLine, decide, getRepairOrder, onApproved, pickup, reconcile } from "../../src/core/index.js";
import { approvedEstimate, CONSENT, makeEnv } from "../helpers.js";

const partial = (lines: { id: string }[]) => [{ lineId: lines[0]!.id, performedCents: 26800 }];

describe("pickup error classes", () => {
  it("MAX_CAPTURE_COUNT_EXCEEDED: needs_attention with the reason, no void, not retried", async () => {
    const env = await makeEnv();
    const { ro, lines, authorization } = await approvedEstimate(env);
    env.fake.maxCaptureCount = 0;
    const r = await pickup(env.deps, ro.id, partial(lines));
    expect(r.authorizations[0]).toMatchObject({ outcome: "needs_attention", reason: expect.stringContaining("MAX_CAPTURE_COUNT_EXCEEDED") });
    expect(env.fake.posts(`/authorizations/${authorization.id}/capture`)).toHaveLength(1);
    expect(env.fake.posts(`/authorizations/${authorization.id}/void`)).toHaveLength(0);
    const state = await getRepairOrder(env.deps, ro.id);
    expect(state.authorizations[0]!.needsAttention).toMatch(/MAX_CAPTURE_COUNT_EXCEEDED/);
    // a second pickup does not hammer PayPal: the desk decides first
    const again = await pickup(env.deps, ro.id, partial(lines));
    expect(again.authorizations[0]).toMatchObject({ outcome: "needs_attention" });
    expect(env.fake.posts(`/authorizations/${authorization.id}/capture`)).toHaveLength(1);
  });

  it("MAX_CAPTURE_AMOUNT_EXCEEDED: treated as a guard bug, the pickup stops", async () => {
    const env = await makeEnv();
    const { ro, lines, authorization } = await approvedEstimate(env);
    const rotor = await addLine(env.deps, ro.id, { title: "Front brake rotors", priceCents: 18600, source: "mechanic" });
    const { order } = await decide(env.deps, ro.id, { approve: [rotor.id], ...CONSENT });
    env.fake.approve(order!.id);
    const { authorization: rot } = await onApproved(env.deps, order!.id);
    env.fake.script((c) => c.path === `/v2/payments/authorizations/${authorization.id}/capture`, {
      kind: "respond",
      status: 422,
      body: { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "MAX_CAPTURE_AMOUNT_EXCEEDED", description: "Capture amount exceeds allowable limit." }] },
    });
    const r = await pickup(env.deps, ro.id, [...partial(lines), { lineId: rotor.id, performedCents: 18600 }]);
    expect(r.stopped).toMatch(/guard bug/);
    expect(r.authorizations).toHaveLength(1);
    expect(env.fake.posts(`/authorizations/${rot.id}/capture`)).toHaveLength(0);
    expect(env.fake.posts(`/authorizations/${authorization.id}/void`)).toHaveLength(0);
  });

  it("PREVIOUSLY_VOIDED on void: reads the live status and does not fail", async () => {
    const env = await makeEnv();
    const { ro, lines, authorization } = await approvedEstimate(env);
    env.fake.auths.get(authorization.id)!.status = "VOIDED"; // voided elsewhere (dashboard)
    // our DB still thinks CREATED: nothing performed -> plan [void]
    const r = await pickup(env.deps, ro.id, []);
    expect(r.authorizations[0]).toMatchObject({ outcome: "done", live: { [authorization.id]: "VOIDED" } });
    expect(r.authorizations[0]!.warnings.join(" ")).toMatch(/PREVIOUSLY_VOIDED/);
    expect((await getRepairOrder(env.deps, ro.id)).authorizations[0]!.status).toBe("VOIDED");
  });

  it("PREVIOUSLY_CAPTURED on capture: reads the live status and does not fail", async () => {
    const env = await makeEnv();
    const { ro, lines, authorization } = await approvedEstimate(env);
    env.fake.auths.get(authorization.id)!.status = "CAPTURED";
    const r = await pickup(env.deps, ro.id, partial(lines));
    expect(r.authorizations[0]).toMatchObject({ outcome: "done", live: { [authorization.id]: "CAPTURED" } });
    expect(env.fake.posts(`/authorizations/${authorization.id}/void`)).toHaveLength(0);
  });

  it("another definite refusal: needs_attention with the PayPal text", async () => {
    const env = await makeEnv();
    const { ro, lines, authorization } = await approvedEstimate(env);
    env.fake.script((c) => c.path.endsWith("/capture"), { kind: "respond", status: 422, body: { name: "UNPROCESSABLE_ENTITY", debug_id: "dbg42", details: [{ issue: "INSTRUMENT_DECLINED", description: "The instrument presented was either declined by the processor or bank." }] } });
    const r = await pickup(env.deps, ro.id, partial(lines));
    expect(r.authorizations[0]).toMatchObject({ outcome: "needs_attention", reason: expect.stringContaining("INSTRUMENT_DECLINED") });
    expect(r.authorizations[0]!.reason).toContain("dbg42");
    expect(env.fake.posts(`/authorizations/${authorization.id}/void`)).toHaveLength(0);
  });

  it("lines without a PayPal authorization are reported and never billed", async () => {
    const env = await makeEnv();
    const { ro, lines } = await approvedEstimate(env);
    const pending = await addLine(env.deps, ro.id, { title: "Wiper blades", priceCents: 4500, source: "desk" });
    const { order: late } = await decide(env.deps, ro.id, { approve: [pending.id], ...CONSENT }); // link sent, not approved yet
    const r = await pickup(env.deps, ro.id, [...partial(lines), { lineId: pending.id, performedCents: 4500 }]);
    expect(r.notBilled).toEqual([{ lineId: pending.id, reason: expect.stringContaining("not billed") }]);
    expect(r.authorizations).toHaveLength(1);
    const state = await getRepairOrder(env.deps, ro.id);
    expect(state.captures.reduce((a, c) => a + c.amountCents, 0)).toBe(26800);
    // the customer approves the old link after pickup: no hold is created
    env.fake.approve(late!.id);
    await expect(onApproved(env.deps, late!.id)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(env.fake.posts(`/orders/${late!.id}/authorize`)).toHaveLength(0);
  });

  it("an overrun on one line is reported and not captured", async () => {
    const env = await makeEnv();
    const { ro, lines } = await approvedEstimate(env);
    const r = await pickup(env.deps, ro.id, [
      { lineId: lines[0]!.id, performedCents: 30000 },
      { lineId: lines[1]!.id, performedCents: 10000 },
    ]);
    expect(r.overruns).toEqual([{ lineId: lines[0]!.id, approvedCents: 26800, performedCents: 30000 }]);
    expect(r.authorizations[0]!.plan).toEqual([{ kind: "capture", cents: 36800, finalCapture: false }, { kind: "void" }]);
  });

  it("validates input: unknown line, duplicate line, negative cents", async () => {
    const env = await makeEnv();
    const { ro, lines } = await approvedEstimate(env);
    await expect(pickup(env.deps, ro.id, [{ lineId: "ln_nope", performedCents: 1 }])).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(pickup(env.deps, ro.id, [{ lineId: lines[0]!.id, performedCents: 1 }, { lineId: lines[0]!.id, performedCents: 2 }])).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(pickup(env.deps, ro.id, [{ lineId: lines[0]!.id, performedCents: -1 }])).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(pickup(env.deps, "ro_missing", [])).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(env.fake.posts("/capture")).toHaveLength(0);
  });
});

describe("reconcile", () => {
  it("reports a difference and takes the status from PayPal without touching money", async () => {
    const env = await makeEnv();
    const { authorization } = await approvedEstimate(env);
    env.fake.auths.get(authorization.id)!.status = "VOIDED"; // changed outside our app
    const r = await reconcile(env.deps, authorization.id);
    expect(r.ok).toBe(false);
    expect(r.diffs).toEqual([{ field: "status", db: "CREATED", paypal: "VOIDED" }]);
    expect(r.authorization.status).toBe("VOIDED");
    expect(r.authorization.capturedCents).toBe(0);
    expect(env.fake.calls.filter((c) => c.method === "POST" && !c.path.includes("oauth")).map((c) => c.path).filter((p) => p.includes("/capture") || p.includes("/void"))).toEqual([]);
  });

  it("is ok when everything matches", async () => {
    const env = await makeEnv();
    const { authorization } = await approvedEstimate(env);
    await expect(reconcile(env.deps, authorization.id)).resolves.toMatchObject({ ok: true, diffs: [], live: { status: "CREATED", amountCents: 41200, capturedCents: 0 } });
    await expect(reconcile(env.deps, "NOPE0000000001")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
