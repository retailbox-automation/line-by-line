import { describe, expect, it } from "vitest";
import { addLine, createEstimateOrder, decide, getRepairOrder, onApproved, pickup } from "../../src/core/index.js";
import { approvedEstimate, CONSENT, estimateRo, makeEnv } from "../helpers.js";

const fullEstimate = (lines: { id: string }[]) => [
  { lineId: lines[0]!.id, performedCents: 26800 },
  { lineId: lines[1]!.id, performedCents: 13000 },
];

describe("pickup is idempotent", () => {
  it("a second pickup with the same numbers makes no PayPal money call", async () => {
    const env = await makeEnv();
    const { ro, lines, authorization } = await approvedEstimate(env);
    await pickup(env.deps, ro.id, fullEstimate(lines));
    const before = env.fake.calls.filter((c) => c.method === "POST").length;
    const again = await pickup(env.deps, ro.id, fullEstimate(lines));
    expect(env.fake.calls.filter((c) => c.method === "POST").length).toBe(before);
    expect(again.authorizations[0]).toMatchObject({ outcome: "nothing_to_do", reason: "authorization is VOIDED", executed: [] });
    expect(env.fake.posts(`/authorizations/${authorization.id}/capture`)).toHaveLength(1);
    expect((await getRepairOrder(env.deps, ro.id)).captures).toHaveLength(1);
  });

  it("two pickups at the same time capture once", async () => {
    const env = await makeEnv();
    const { ro, lines, authorization } = await approvedEstimate(env);
    const results = await Promise.allSettled([pickup(env.deps, ro.id, fullEstimate(lines)), pickup(env.deps, ro.id, fullEstimate(lines))]);
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    expect(env.fake.posts(`/authorizations/${authorization.id}/capture`)).toHaveLength(1);
    expect(env.fake.posts(`/authorizations/${authorization.id}/void`).length).toBeLessThanOrEqual(1);
    expect((await getRepairOrder(env.deps, ro.id)).captures).toHaveLength(1);
  });

  it("a repeated pickup with other numbers is refused", async () => {
    const env = await makeEnv();
    const { ro, lines } = await approvedEstimate(env);
    await pickup(env.deps, ro.id, fullEstimate(lines));
    await expect(pickup(env.deps, ro.id, [{ lineId: lines[0]!.id, performedCents: 26800 }])).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("the capture answer is lost: the retry carries the same PayPal-Request-Id and PayPal replays, no second capture", async () => {
    const env = await makeEnv();
    const { ro, lines, authorization } = await approvedEstimate(env);
    // PayPal performs the capture, but every answer of this call is lost (all 4 attempts).
    env.fake.script((c) => c.path.endsWith("/capture"), { kind: "dropResponse" }, 4);
    const first = await pickup(env.deps, ro.id, fullEstimate(lines));
    expect(first.authorizations[0]).toMatchObject({ outcome: "retry" });
    expect(env.fake.captures.size).toBe(1); // money moved once, the replays did nothing
    const second = await pickup(env.deps, ro.id, fullEstimate(lines));
    expect(second.authorizations[0]).toMatchObject({ outcome: "done" });
    const ids = env.fake.requestIds(`/authorizations/${authorization.id}/capture`);
    expect(new Set(ids)).toEqual(new Set([`lbl:capture:${authorization.id}:1`]));
    expect(env.fake.captures.size).toBe(1);
    const state = await getRepairOrder(env.deps, ro.id);
    expect(state.captures).toHaveLength(1);
    expect(state.authorizations[0]).toMatchObject({ capturedCents: 39800, status: "VOIDED" });
  });

  it("captured and recorded, then the void fails: the next pickup only voids", async () => {
    const env = await makeEnv();
    const { ro, lines, authorization } = await approvedEstimate(env);
    env.fake.script((c) => c.path.endsWith("/void"), { kind: "respond", status: 503, body: { name: "SERVICE_UNAVAILABLE" } }, 4);
    const first = await pickup(env.deps, ro.id, fullEstimate(lines));
    expect(first.authorizations[0]).toMatchObject({ outcome: "retry", executed: [{ kind: "capture", cents: 39800 }] });
    const second = await pickup(env.deps, ro.id, fullEstimate(lines));
    expect(second.authorizations[0]!.plan).toEqual([{ kind: "void" }]);
    expect(second.authorizations[0]!.outcome).toBe("done");
    expect(env.fake.posts(`/authorizations/${authorization.id}/capture`)).toHaveLength(1);
    expect(env.fake.auths.get(authorization.id)!.status).toBe("VOIDED");
  });
});

describe("onApproved is idempotent", () => {
  it("called twice: one authorize call, one authorization", async () => {
    const env = await makeEnv();
    const { ro } = await estimateRo(env);
    const { order } = await createEstimateOrder(env.deps, ro.id, CONSENT);
    env.fake.approve(order.id);
    const a = await onApproved(env.deps, order.id);
    const b = await onApproved(env.deps, order.id);
    expect(b.replayed).toBe(true);
    expect(b.authorization.id).toBe(a.authorization.id);
    expect(env.fake.posts(`/orders/${order.id}/authorize`)).toHaveLength(1);
  });

  it("called twice at the same time: one authorize call, one authorization", async () => {
    const env = await makeEnv();
    const { ro } = await estimateRo(env);
    const { order } = await createEstimateOrder(env.deps, ro.id, CONSENT);
    env.fake.approve(order.id);
    const rs = await Promise.allSettled([onApproved(env.deps, order.id), onApproved(env.deps, order.id)]);
    expect(rs.some((r) => r.status === "fulfilled")).toBe(true);
    for (const r of rs) if (r.status === "rejected") expect(r.reason).toMatchObject({ code: "IN_PROGRESS" });
    expect(env.fake.posts(`/orders/${order.id}/authorize`)).toHaveLength(1);
    expect((await getRepairOrder(env.deps, ro.id)).authorizations).toHaveLength(1);
  });

  it("ORDER_ALREADY_AUTHORIZED (authorized but our write was lost) reads the order and records the authorization", async () => {
    const env = await makeEnv();
    const { ro } = await estimateRo(env);
    const { order } = await createEstimateOrder(env.deps, ro.id, CONSENT);
    env.fake.approve(order.id);
    // PayPal authorizes, the answer is lost on every attempt; then the op is retried with a new process.
    env.fake.script((c) => c.path.endsWith("/authorize"), { kind: "dropResponse" }, 4);
    await expect(onApproved(env.deps, order.id)).rejects.toMatchObject({ code: "PAYPAL" });
    env.fake.idem.clear(); // a replay that PayPal no longer remembers -> ORDER_ALREADY_AUTHORIZED
    const r = await onApproved(env.deps, order.id);
    expect(r.authorization.amountCents).toBe(41200);
    expect(env.fake.auths.size).toBe(1);
    expect((await getRepairOrder(env.deps, ro.id)).lines.every((l) => l.status === "approved")).toBe(true);
  });

  it("before the payer approved: ORDER_NOT_APPROVED, nothing recorded", async () => {
    const env = await makeEnv();
    const { ro } = await estimateRo(env);
    const { order } = await createEstimateOrder(env.deps, ro.id, CONSENT);
    await expect(onApproved(env.deps, order.id)).rejects.toMatchObject({ code: "PAYPAL", details: { outcome: "ORDER_NOT_APPROVED" } });
    expect((await getRepairOrder(env.deps, ro.id)).authorizations).toHaveLength(0);
    env.fake.approve(order.id);
    await expect(onApproved(env.deps, order.id)).resolves.toMatchObject({ replayed: false });
  });

  it("an order that is not ours is NOT_FOUND", async () => {
    const env = await makeEnv();
    await expect(onApproved(env.deps, "NOTOURS000000001")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("decisions never create a second order", () => {
  it("a repeated decision on the same line is refused", async () => {
    const env = await makeEnv();
    const { ro } = await approvedEstimate(env);
    const rotor = await addLine(env.deps, ro.id, { title: "Front brake rotors", priceCents: 18600, source: "mechanic" });
    await decide(env.deps, ro.id, { approve: [rotor.id], ...CONSENT });
    await expect(decide(env.deps, ro.id, { approve: [rotor.id], ...CONSENT })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(decide(env.deps, ro.id, { decline: [rotor.id], ...CONSENT })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(env.fake.requestIds("/v2/checkout/orders").filter((r) => r.startsWith("lbl:order-add"))).toHaveLength(1);
  });

  it("two decisions at the same time create one order", async () => {
    const env = await makeEnv();
    const { ro } = await approvedEstimate(env);
    const rotor = await addLine(env.deps, ro.id, { title: "Front brake rotors", priceCents: 18600, source: "mechanic" });
    const rs = await Promise.allSettled([decide(env.deps, ro.id, { approve: [rotor.id], ...CONSENT }), decide(env.deps, ro.id, { approve: [rotor.id], ...CONSENT })]);
    expect(rs.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(env.fake.requestIds("/v2/checkout/orders").filter((r) => r.startsWith("lbl:order-add"))).toHaveLength(1);
    expect((await getRepairOrder(env.deps, ro.id)).consents.filter((c) => c.lineId === rotor.id)).toHaveLength(1);
  });

  it("decline only: no PayPal call at all", async () => {
    const env = await makeEnv();
    const { ro } = await approvedEstimate(env);
    const filter = await addLine(env.deps, ro.id, { title: "Cabin air filter", priceCents: 3900, source: "mechanic", urgency: "can_wait" });
    const posts = env.fake.calls.filter((c) => c.method === "POST").length;
    await expect(decide(env.deps, ro.id, { decline: [filter.id], ...CONSENT })).resolves.toEqual({ declined: [filter.id], order: null });
    expect(env.fake.calls.filter((c) => c.method === "POST").length).toBe(posts);
  });

  it("the estimate order is created once; a repeat returns the same order", async () => {
    const env = await makeEnv();
    const { ro } = await estimateRo(env);
    const a = await createEstimateOrder(env.deps, ro.id, CONSENT);
    const b = await createEstimateOrder(env.deps, ro.id, CONSENT);
    expect(a.created).toBe(true);
    expect(b).toEqual({ order: a.order, created: false });
    expect(env.fake.requestIds("/v2/checkout/orders")).toEqual([`lbl:order-est:${ro.id}:1`]);
  });
});
