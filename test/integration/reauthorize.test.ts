import { describe, expect, it } from "vitest";
import { addLine, decide, findReauthorizable, getRepairOrder, onApproved, pickup, reconcile, runReauthorize } from "../../src/core/index.js";
import { approvedEstimate, CONSENT, makeEnv, START } from "../helpers.js";

const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;

describe("findReauthorizable windows", () => {
  it("3 days 23:59 no; 4 days 10 minutes yes; after expiration no", async () => {
    const env = await makeEnv();
    const { authorization } = await approvedEstimate(env);
    expect(await findReauthorizable(env.deps, new Date(START + 3 * DAY + 23 * 60 * MIN + 59 * MIN))).toEqual([]);
    expect(await findReauthorizable(env.deps, new Date(START + 4 * DAY + 9 * MIN))).toEqual([]);
    expect((await findReauthorizable(env.deps, new Date(START + 4 * DAY + 10 * MIN))).map((a) => a.id)).toEqual([authorization.id]);
    expect(await findReauthorizable(env.deps, new Date(START + 29 * DAY))).toEqual([]);
    expect(await findReauthorizable(env.deps, new Date(START + 30 * DAY))).toEqual([]);
  });

  it("card holds, already reauthorized, partly captured and picked-up orders are not candidates", async () => {
    const card = await makeEnv();
    await approvedEstimate(card, "card");
    expect(await findReauthorizable(card.deps, new Date(START + 5 * DAY))).toEqual([]);

    const done = await makeEnv();
    const { ro, lines } = await approvedEstimate(done);
    await pickup(done.deps, ro.id, [{ lineId: lines[0]!.id, performedCents: 100 }]);
    expect(await findReauthorizable(done.deps, new Date(START + 5 * DAY))).toEqual([]);

    const twice = await makeEnv();
    await approvedEstimate(twice);
    twice.clock.advance(5 * DAY);
    await runReauthorize(twice.deps);
    expect(await findReauthorizable(twice.deps, new Date(START + 6 * DAY))).toEqual([]);
  });
});

describe("runReauthorize", () => {
  it("reauthorizes every wallet hold of the repair order for the same amount; the child keeps the expiry", async () => {
    const env = await makeEnv();
    const { ro, authorization: est } = await approvedEstimate(env);
    const rotor = await addLine(env.deps, ro.id, { title: "Front brake rotors", priceCents: 18600, source: "mechanic" });
    const { order } = await decide(env.deps, ro.id, { approve: [rotor.id], ...CONSENT });
    env.fake.approve(order!.id);
    const { authorization: rot } = await onApproved(env.deps, order!.id);

    env.clock.advance(4 * DAY + 11 * MIN);
    const r = await runReauthorize(env.deps);
    expect(r.skipped).toEqual([]);
    expect(r.askCustomer).toEqual([]);
    expect(r.reauthorized.map((x) => [x.parentId, x.amountCents])).toEqual([
      [est.id, 41200],
      [rot.id, 18600],
    ]);
    expect(env.fake.requestIds("/reauthorize")).toEqual([`lbl:reauth:${est.id}:1`, `lbl:reauth:${rot.id}:1`]);

    const state = await getRepairOrder(env.deps, ro.id);
    const parent = state.authorizations.find((a) => a.id === est.id)!;
    const child = state.authorizations.find((a) => a.parentId === est.id)!;
    // the id comes from the body: the fake (like the sandbox) points `links` at the old id
    expect(child.id).toBe(r.reauthorized[0]!.newId);
    expect(child.id).not.toBe(est.id);
    expect(parent.reauthorizedTo).toBe(child.id);
    expect(parent.reauthorizedAt).not.toBeNull();
    expect(child.expirationTime!.getTime()).toBe(parent.expirationTime!.getTime());
    expect(child).toMatchObject({ amountCents: 41200, status: "CREATED", paymentSource: "paypal", capturedCents: 0 });

    // A second run does nothing.
    const again = await runReauthorize(env.deps);
    expect(again.reauthorized).toEqual([]);
    expect(env.fake.posts("/reauthorize")).toHaveLength(2);
  });

  it("pickup after reauthorize: capture on the new id, void on the parent", async () => {
    const env = await makeEnv();
    const { ro, lines, authorization: est } = await approvedEstimate(env);
    env.clock.advance(4 * DAY + 11 * MIN);
    const { reauthorized } = await runReauthorize(env.deps);
    const childId = reauthorized[0]!.newId;
    const r = await pickup(env.deps, ro.id, [
      { lineId: lines[0]!.id, performedCents: 26800 },
      { lineId: lines[1]!.id, performedCents: 13000 },
    ]);
    expect(r.authorizations[0]).toMatchObject({ authorizationId: est.id, captureAuthorizationId: childId, outcome: "done" });
    expect(env.fake.posts(`/authorizations/${childId}/capture`)).toHaveLength(1);
    expect(env.fake.posts(`/authorizations/${est.id}/capture`)).toHaveLength(0);
    expect(env.fake.posts(`/authorizations/${est.id}/void`)).toHaveLength(1);
    expect(env.fake.posts(`/authorizations/${childId}/void`)).toHaveLength(0);
    const state = await getRepairOrder(env.deps, ro.id);
    expect(state.captures).toMatchObject([{ authorizationId: childId, amountCents: 39800, finalCapture: false }]);
    expect(state.authorizations.find((a) => a.id === est.id)!.status).toBe("VOIDED");
    const rec = await reconcile(env.deps, childId);
    expect(rec.live.capturedCents).toBe(39800);
  });

  it("REAUTHORIZATION_TOO_SOON is skipped and recorded, the job goes on", async () => {
    const env = await makeEnv();
    const { authorization } = await approvedEstimate(env);
    // Our window says yes (day 4 + 11 min by our clock) but PayPal's clock says no: shift the fake's view.
    env.fake.auths.get(authorization.id)!.createTime = env.clock.now().getTime() + 1 * DAY;
    env.clock.advance(4 * DAY + 11 * MIN);
    const r = await runReauthorize(env.deps);
    expect(r.reauthorized).toEqual([]);
    expect(r.skipped).toEqual([{ authorizationId: authorization.id, roId: expect.any(String), reason: expect.stringContaining("REAUTHORIZATION_TOO_SOON") }]);
    const ops = await env.db.query<{ state: string; request_id: string }>(`SELECT state, request_id FROM ops WHERE op = 'reauth'`);
    expect(ops.rows).toEqual([{ state: "failed", request_id: `lbl:reauth:${authorization.id}:1` }]);
    // next day PayPal agrees; the job retries with a fresh request id
    env.clock.advance(1 * DAY);
    const r2 = await runReauthorize(env.deps);
    expect(r2.reauthorized).toHaveLength(1);
    expect(env.fake.requestIds("/reauthorize")).toEqual([`lbl:reauth:${authorization.id}:1`, `lbl:reauth:${authorization.id}:2`]);
  });

  it("card holds are not extended: the customer is asked to approve again", async () => {
    const env = await makeEnv();
    const { authorization } = await approvedEstimate(env, "card");
    env.clock.advance(5 * DAY);
    const r = await runReauthorize(env.deps);
    expect(r.reauthorized).toEqual([]);
    expect(r.askCustomer).toEqual([{ authorizationId: authorization.id, roId: expect.any(String), paymentSource: "card" }]);
    expect(env.fake.posts("/reauthorize")).toHaveLength(0);
  });

  it("void of a reauthorization is refused by PayPal (CANNOT_BE_VOIDED), which is why we void the parent", async () => {
    const env = await makeEnv();
    await approvedEstimate(env);
    env.clock.advance(4 * DAY + 11 * MIN);
    const { reauthorized } = await runReauthorize(env.deps);
    await expect(env.paypal.voidAuthorization({ authorizationId: reauthorized[0]!.newId, requestId: "probe:void:1" })).rejects.toMatchObject({ issue: "CANNOT_BE_VOIDED" });
  });
});
