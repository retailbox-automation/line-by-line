import { describe, expect, it } from "vitest";
import { addLine, createEstimateOrder, decide, getRepairOrder, onApproved, refreshApproval } from "../../src/core/index.js";
import { approvedEstimate, CONSENT, estimateRo, makeEnv } from "../helpers.js";

const HOUR = 60 * 60 * 1000;

describe("expired approval link", () => {
  it("a stale link becomes a new order with the same lines; the old one is superseded and consents follow", async () => {
    const env = await makeEnv();
    const { ro } = await approvedEstimate(env);
    const rotor = await addLine(env.deps, ro.id, { title: "Front brake rotors", priceCents: 18600, source: "mechanic" });
    const { order: old } = await decide(env.deps, ro.id, { approve: [rotor.id], ...CONSENT });
    env.clock.advance(3 * HOUR + 1);
    const r = await refreshApproval(env.deps, old!.id);
    expect(r.refreshed).toBe(true);
    expect(r.order).toMatchObject({ lineIds: [rotor.id], amountCents: 18600, purpose: "added", attempt: 2, supersededBy: null });
    expect(r.order.id).not.toBe(old!.id);
    expect(r.order.requestId).toBe(old!.requestId.replace(/:1$/, ":2"));
    const state = await getRepairOrder(env.deps, ro.id);
    expect(state.orders.find((o) => o.id === old!.id)!.supersededBy).toBe(r.order.id);
    expect(state.consents.filter((c) => c.lineId === rotor.id).map((c) => c.paypalOrderId)).toEqual([r.order.id]);
    // the old link cannot be authorized any more; the new one can
    env.fake.approve(old!.id);
    await expect(onApproved(env.deps, old!.id)).rejects.toMatchObject({ code: "CONFLICT" });
    env.fake.approve(r.order.id);
    await expect(onApproved(env.deps, r.order.id)).resolves.toMatchObject({ authorization: { amountCents: 18600 } });
    expect((await getRepairOrder(env.deps, ro.id)).consents.find((c) => c.lineId === rotor.id)!.paypalAuthorizationId).toBeTruthy();
  });

  it("a fresh link is left alone", async () => {
    const env = await makeEnv();
    const { ro } = await estimateRo(env);
    const { order } = await createEstimateOrder(env.deps, ro.id, CONSENT);
    env.clock.advance(2 * HOUR);
    await expect(refreshApproval(env.deps, order.id)).resolves.toEqual({ order, refreshed: false });
    expect(env.fake.requestIds("/v2/checkout/orders")).toHaveLength(1);
  });

  it("a stale link that the payer approved meanwhile is not replaced", async () => {
    const env = await makeEnv();
    const { ro } = await estimateRo(env);
    const { order } = await createEstimateOrder(env.deps, ro.id, CONSENT);
    env.fake.approve(order.id);
    env.clock.advance(4 * HOUR);
    const r = await refreshApproval(env.deps, order.id);
    expect(r).toMatchObject({ refreshed: false, order: { id: order.id, status: "APPROVED" } });
    await expect(onApproved(env.deps, order.id)).resolves.toMatchObject({ replayed: false });
  });

  it("createEstimateOrder re-creates a stale estimate link by itself", async () => {
    const env = await makeEnv();
    const { ro } = await estimateRo(env);
    const a = await createEstimateOrder(env.deps, ro.id, CONSENT);
    env.clock.advance(3 * HOUR + 1);
    const b = await createEstimateOrder(env.deps, ro.id, CONSENT);
    expect(b.created).toBe(true);
    expect(b.order.id).not.toBe(a.order.id);
    expect(env.fake.requestIds("/v2/checkout/orders")).toEqual([`lbl:order-est:${ro.id}:1`, `lbl:order-est:${ro.id}:2`]);
  });

  it("refuses to refresh an authorized, cancelled or replaced order", async () => {
    const env = await makeEnv();
    const { order } = await approvedEstimate(env);
    env.clock.advance(4 * HOUR);
    await expect(refreshApproval(env.deps, order.id)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(refreshApproval(env.deps, "UNKNOWN00000001")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
