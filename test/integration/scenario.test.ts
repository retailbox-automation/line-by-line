import { describe, expect, it } from "vitest";
import { addLine, decide, getRepairOrder, onApproved, onCancelled, pickup, reconcile } from "../../src/core/index.js";
import { PAYER_MARKERS } from "../fake-paypal.js";
import { approvedEstimate, CONSENT, dumpTables, makeEnv } from "../helpers.js";

describe("estimate -> decision -> return -> pickup (fake PayPal, PGlite)", () => {
  it("runs the demo story end to end", async () => {
    const env = await makeEnv();
    const { ro, lines, order: estOrder, authorization: estAuth } = await approvedEstimate(env);
    expect(estOrder.amountCents).toBe(41200);
    expect(estOrder.approveUrl).toBe(`https://www.sandbox.paypal.com/checkoutnow?token=${estOrder.id}`);
    expect(estAuth).toMatchObject({ amountCents: 41200, status: "CREATED", paymentSource: "paypal", parentId: null, capturedCents: 0 });

    const rotor = await addLine(env.deps, ro.id, { title: "Front brake rotors", priceCents: 18600, urgency: "safety", source: "mechanic" });
    const filter = await addLine(env.deps, ro.id, { title: "Cabin air filter", priceCents: 3900, urgency: "can_wait", source: "mechanic" });
    const ordersBefore = env.fake.posts("/v2/checkout/orders").filter((c) => c.path === "/v2/checkout/orders").length;
    const d = await decide(env.deps, ro.id, { approve: [rotor.id], decline: [filter.id], ...CONSENT });
    expect(d.declined).toEqual([filter.id]);
    expect(d.order).toMatchObject({ amountCents: 18600, lineIds: [rotor.id], purpose: "added", status: "PAYER_ACTION_REQUIRED" });
    // Exactly one new PayPal order, carrying only the approved line.
    const created = env.fake.posts("/v2/checkout/orders").filter((c) => c.path === "/v2/checkout/orders");
    expect(created.length - ordersBefore).toBe(1);
    const body = JSON.parse(created.at(-1)!.body!);
    expect(body.purchase_units[0].items).toEqual([{ name: "Front brake rotors", quantity: "1", unit_amount: { currency_code: "USD", value: "186.00" }, category: "PHYSICAL_GOODS" }]);
    expect(body.purchase_units[0].amount).toEqual({ currency_code: "USD", value: "186.00", breakdown: { item_total: { currency_code: "USD", value: "186.00" } } });
    expect(body.payment_source.paypal.experience_context).toMatchObject({ user_action: "CONTINUE", shipping_preference: "NO_SHIPPING", brand_name: "Bayside Auto Care" });

    env.fake.approve(d.order!.id);
    const { authorization: rotorAuth } = await onApproved(env.deps, d.order!.id);
    expect(rotorAuth.amountCents).toBe(18600);

    let state = await getRepairOrder(env.deps, ro.id);
    expect(state.lines.find((l) => l.id === filter.id)?.status).toBe("declined");
    expect(state.lines.find((l) => l.id === rotor.id)?.status).toBe("approved");
    const filterConsent = state.consents.find((c) => c.lineId === filter.id)!;
    expect(filterConsent).toMatchObject({ decision: "declined", paypalOrderId: null, paypalAuthorizationId: null, approverName: "Dana Demo", esignConsent: true });
    const rotorConsent = state.consents.find((c) => c.lineId === rotor.id)!;
    expect(rotorConsent).toMatchObject({ decision: "approved", paypalOrderId: d.order!.id, paypalAuthorizationId: rotorAuth.id, amountCents: 18600, newTotalCents: 41200 + 18600 });

    // Pickup: estimate done for $398 (pads $268 + flush $130), rotors in full.
    const r = await pickup(env.deps, ro.id, [
      { lineId: lines[0]!.id, performedCents: 26800 },
      { lineId: lines[1]!.id, performedCents: 13000 },
      { lineId: rotor.id, performedCents: 18600 },
      { lineId: filter.id, performedCents: 3900 },
    ]);
    expect(r.notBilled).toEqual([{ lineId: filter.id, reason: expect.stringContaining("not billed") }]);
    const est = r.authorizations.find((a) => a.authorizationId === estAuth.id)!;
    expect(est.plan).toEqual([{ kind: "capture", cents: 39800, finalCapture: false }, { kind: "void" }]);
    expect(est.outcome).toBe("done");
    expect(est.executed.map((e) => e.kind)).toEqual(["capture", "void"]);
    expect(est.live[estAuth.id]).toBe("VOIDED");
    const rot = r.authorizations.find((a) => a.authorizationId === rotorAuth.id)!;
    expect(rot.plan).toEqual([{ kind: "capture", cents: 18600, finalCapture: true }]);
    expect(rot.executed).toHaveLength(1);
    expect(rot.live[rotorAuth.id]).toBe("CAPTURED");
    expect(env.fake.posts(`/v2/payments/authorizations/${rotorAuth.id}/void`)).toHaveLength(0);

    state = await getRepairOrder(env.deps, ro.id);
    expect(state.repairOrder.status).toBe("picked_up");
    expect(state.captures.map((c) => [c.amountCents, c.finalCapture, c.feeCents, c.netCents])).toEqual([
      [39800, false, Math.round(39800 * 0.0349) + 49, 39800 - (Math.round(39800 * 0.0349) + 49)],
      [18600, true, Math.round(18600 * 0.0349) + 49, 18600 - (Math.round(18600 * 0.0349) + 49)],
    ]);
    const capRequestIds = env.fake.requestIds("/capture");
    expect(capRequestIds).toEqual([`lbl:capture:${estAuth.id}:1`, `lbl:capture:${rotorAuth.id}:1`]);

    const rec = await reconcile(env.deps, estAuth.id);
    expect(rec).toMatchObject({ ok: true, diffs: [], live: { status: "VOIDED", capturedCents: 39800 } });

    // No payer data anywhere in our tables (journal included).
    const dump = await dumpTables(env.db);
    for (const marker of PAYER_MARKERS) expect(dump).not.toContain(marker);
    const calls = await env.db.query<{ op: string; request_id: string | null }>(`SELECT op, request_id FROM paypal_calls ORDER BY id`);
    expect(calls.rows.length).toBeGreaterThan(5);
  });

  it("cancel on PayPal puts the lines back to sent and allows a new decision", async () => {
    const env = await makeEnv();
    const { ro } = await approvedEstimate(env);
    const rotor = await addLine(env.deps, ro.id, { title: "Front brake rotors", priceCents: 18600, source: "mechanic" });
    const d1 = await decide(env.deps, ro.id, { approve: [rotor.id], ...CONSENT });
    const cancelled = await onCancelled(env.deps, d1.order!.id);
    expect(cancelled.status).toBe("CANCELLED");
    const d2 = await decide(env.deps, ro.id, { approve: [rotor.id], ...CONSENT });
    expect(d2.order!.id).not.toBe(d1.order!.id);
    expect(env.fake.requestIds("/v2/checkout/orders").filter((id) => id.startsWith("lbl:order-add"))).toEqual([d1.order!.requestId, d2.order!.requestId]);
    expect(d2.order!.attempt).toBe(2);
  });
});
