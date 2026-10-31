// The live sandbox scenarios, run against the fake PayPal so a broken script never wastes a live approval.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { demoStory, probeCaptureLimit, PROBE_MAX, reauthorizeIds, type Check, type ScenarioContext } from "../../scripts/e2e-scenarios.js";
import { approvedEstimate, makeEnv, type Env } from "../helpers.js";

const DAY = 24 * 60 * 60 * 1000;

function ctxFor(env: Env): { ctx: ScenarioContext; checks: Check[]; approvals: string[] } {
  const checks: Check[] = [];
  const approvals: string[] = [];
  const ctx: ScenarioContext = {
    deps: env.deps,
    async waitForApproval(orderId, approveUrl) {
      expect(approveUrl).toContain(orderId);
      approvals.push(orderId);
      env.fake.approve(orderId);
    },
    check: (name, ok, detail) => checks.push({ name, ok, detail }),
  };
  return { ctx, checks, approvals };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

describe("sandbox e2e scenarios (fake PayPal)", () => {
  it("demo story: two approvals, every check passes", async () => {
    const env = await makeEnv();
    const { ctx, checks, approvals } = ctxFor(env);
    const r = await demoStory(ctx);
    expect(approvals).toHaveLength(2);
    expect(checks.filter((c) => !c.ok)).toEqual([]);
    expect(checks.map((c) => c.name)).toEqual(
      expect.arrayContaining(["estimate: capture $398.00 final_capture:false, then void", "rotors: full capture, no void", "declined line got no order"]),
    );
    expect(r.roId).toEqual(expect.any(String));
    expect(env.fake.posts("/capture").map((c) => JSON.parse(c.body!))).toEqual([
      { amount: { currency_code: "USD", value: "398.00" }, final_capture: false },
      { amount: { currency_code: "USD", value: "186.00" }, final_capture: true },
    ]);
  });

  it("probe: finds the capture count limit, then voids the rest", async () => {
    const env = await makeEnv();
    env.fake.maxCaptureCount = 10;
    const { ctx, checks } = ctxFor(env);
    const r = await probeCaptureLimit(ctx);
    expect(r).toMatchObject({ capturesSucceeded: 10, limitSeen: true, firstError: { at: 11, outcome: "MAX_CAPTURE_COUNT_EXCEEDED" }, void: { status: "VOIDED" } });
    expect(checks[0]!.detail).toBe("MAX_CAPTURE_COUNT_EXCEEDED on capture #11");
    expect(env.fake.requestIds("/capture").slice(0, 2)).toEqual([`lbl:probe:${r.authorizationId}:1`, `lbl:probe:${r.authorizationId}:2`]);
  });

  it("probe: reports when no refusal came within the limit", async () => {
    const env = await makeEnv();
    env.fake.maxCaptureCount = 1000;
    const { ctx, checks } = ctxFor(env);
    const r = await probeCaptureLimit(ctx);
    expect(r).toMatchObject({ capturesSucceeded: PROBE_MAX, limitSeen: false, firstError: null });
    expect(checks[0]!.detail).toBe(`no refusal in ${PROBE_MAX} captures`);
  });

  it("reauthorize ids: too soon is a failed check with the issue; from day 4 a new id with the same expiry", async () => {
    const env = await makeEnv();
    const { authorization } = await approvedEstimate(env);
    const first = ctxFor(env);
    const early = await reauthorizeIds(first.ctx, [authorization.id], 1);
    expect(first.checks[0]!.ok).toBe(false);
    expect(early).toMatchObject({ reauthorize: [{ parentId: authorization.id, error: { outcome: "REAUTHORIZATION_TOO_SOON", httpStatus: 422 } }] });

    env.clock.advance(4 * DAY + 11 * 60 * 1000);
    const second = ctxFor(env);
    const later = (await reauthorizeIds(second.ctx, [authorization.id], 2)) as { reauthorize: { newId: string; parentStatusAfter: string; newExpiration: Date; parentExpiration: Date }[] };
    expect(second.checks[0]!.ok).toBe(true);
    const row = later.reauthorize[0]!;
    expect(row.newId).not.toBe(authorization.id);
    expect(row.parentStatusAfter).toBe("CREATED");
    expect(row.newExpiration.getTime()).toBe(row.parentExpiration.getTime());
    expect(env.fake.requestIds("/reauthorize")).toEqual([`lbl:reauth:${authorization.id}:1`, `lbl:reauth:${authorization.id}:2`]);
  });
});
