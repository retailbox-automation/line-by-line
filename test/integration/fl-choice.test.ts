// Fla. Stat. 559.905(2): which of the three statements the customer checked is kept in the consent record
// (migration 004). Optional in the API: the desk, older clients and approvals after the first one send none.
import { describe, expect, it } from "vitest";
import { customerToken } from "../../src/http/app.js";
import { call, CONSENT, desk, DESK_TOKEN, makeAppEnv, type AppEnv } from "../helpers.js";

const NEW_RO = {
  customerLabel: "Dana Demo (made-up)",
  estimateLines: [
    { title: "Front brake pads", priceCents: 26800, source: "desk", urgency: "safety" },
    { title: "Brake fluid flush", priceCents: 14400, source: "desk", urgency: "soon" },
  ],
};

async function newRo(t: AppEnv) {
  const r = await desk(t.app, "POST", "/api/ro", NEW_RO);
  expect(r.status).toBe(201);
  return r.json.repairOrder.id as string;
}

async function consents(t: AppEnv, roId: string) {
  return (await desk(t.app, "GET", `/api/ro/${roId}`)).json.consents as { lineId: string; decision: string; flChoice: string | null; flLimitCents: number | null }[];
}

describe("Florida statement choice in the consent record", () => {
  it("the estimate approval keeps the checked statement and the dollar limit on every line's record", async () => {
    const t = await makeAppEnv();
    const roId = await newRo(t);
    const a = await desk(t.app, "POST", `/api/ro/${roId}/estimate/approval`, { ...CONSENT, flChoice: "limit", flLimitCents: 45000 });
    expect(a.status, a.text).toBe(201);
    const c = await consents(t, roId);
    expect(c).toHaveLength(2);
    for (const r of c) expect(r).toMatchObject({ decision: "approved", flChoice: "limit", flLimitCents: 45000 });
  });

  it("'written' and 'none' are kept without an amount; no choice stays null (desk, older clients)", async () => {
    const t = await makeAppEnv();
    const written = await newRo(t);
    expect((await desk(t.app, "POST", `/api/ro/${written}/estimate/approval`, { ...CONSENT, flChoice: "written" })).status).toBe(201);
    expect((await consents(t, written)).map((r) => [r.flChoice, r.flLimitCents])).toEqual([["written", null], ["written", null]]);
    const plain = await newRo(t);
    expect((await desk(t.app, "POST", `/api/ro/${plain}/estimate/approval`, CONSENT)).status).toBe(201);
    expect((await consents(t, plain)).map((r) => [r.flChoice, r.flLimitCents])).toEqual([[null, null], [null, null]]);
  });

  it("a decision on an added line keeps the choice too (declined line, no PayPal order)", async () => {
    const t = await makeAppEnv();
    const roId = await newRo(t);
    const a = await desk(t.app, "POST", `/api/ro/${roId}/estimate/approval`, CONSENT);
    t.fake.approve(a.json.order.id);
    expect((await call(t.app, "GET", `/api/paypal/return?token=${a.json.order.id}`)).status).toBe(303);
    const line = await desk(t.app, "POST", `/api/ro/${roId}/lines`, { title: "Cabin air filter", priceCents: 3900, source: "desk" });
    const d = await desk(t.app, "POST", `/api/ro/${roId}/decisions`, { decline: [line.json.line.id], ...CONSENT, flChoice: "none" });
    expect(d.status, d.text).toBe(200);
    expect((await consents(t, roId)).find((r) => r.lineId === line.json.line.id)).toMatchObject({ decision: "declined", flChoice: "none", flLimitCents: null });
  });

  it("an order the desk already made with its consent gets the customer's statement when the customer page approves (first choice stays)", async () => {
    const t = await makeAppEnv();
    const roId = await newRo(t);
    const made = await desk(t.app, "POST", `/api/ro/${roId}/estimate/approval`, { ...CONSENT, channel: "desk" });
    expect(made.status).toBe(201);
    expect((await consents(t, roId)).map((r) => r.flChoice)).toEqual([null, null]);
    const customer = { authorization: `Bearer ${customerToken(DESK_TOKEN, roId)}` };
    const page = await call(t.app, "POST", `/api/ro/${roId}/estimate/approval`, { ...CONSENT, channel: "link", flChoice: "limit", flLimitCents: 45000 }, customer);
    expect(page.status, page.text).toBe(200);
    expect(page.json.order.id).toBe(made.json.order.id);
    expect((await consents(t, roId)).map((r) => [r.flChoice, r.flLimitCents])).toEqual([["limit", 45000], ["limit", 45000]]);
    const again = await call(t.app, "POST", `/api/ro/${roId}/estimate/approval`, { ...CONSENT, channel: "link", flChoice: "written" }, customer);
    expect(again.status).toBe(200);
    expect((await consents(t, roId)).map((r) => r.flChoice)).toEqual(["limit", "limit"]);
    expect(t.fake.posts("/v2/checkout/orders")).toHaveLength(1);
  });

  it("refuses a limit without an amount, an amount without 'limit', a zero amount and an unknown statement; no PayPal call", async () => {
    const t = await makeAppEnv();
    const roId = await newRo(t);
    for (const bad of [
      { flChoice: "limit" },
      { flChoice: "written", flLimitCents: 45000 },
      { flLimitCents: 45000 },
      { flChoice: "limit", flLimitCents: 0 },
      { flChoice: "limit", flLimitCents: 450.5 },
      { flChoice: "maybe" },
    ]) {
      const r = await desk(t.app, "POST", `/api/ro/${roId}/estimate/approval`, { ...CONSENT, ...bad });
      expect(r.status, JSON.stringify(bad)).toBe(400);
      expect(r.json).toMatchObject({ code: "VALIDATION" });
    }
    expect(t.fake.posts("/v2/checkout/orders")).toHaveLength(0);
  });

  it("the database refuses a limit without an amount and an amount on another statement", async () => {
    const t = await makeAppEnv();
    const roId = await newRo(t);
    const lineId = ((await desk(t.app, "GET", `/api/ro/${roId}`)).json.lines[0].id) as string;
    const insert = (choice: string | null, cents: number | null) =>
      t.db.query(
        `INSERT INTO consents (id, ro_id, line_id, decision, decided_at, channel, approver_name, esign_consent, disclosure_version, amount_cents, new_total_cents, fl_choice, fl_limit_cents)
         VALUES ($1, $2, $3, 'approved', now(), 'link', 'x', true, 'v', 1, 1, $4, $5)`,
        [`cn_test_${choice}_${cents}`, roId, lineId, choice, cents],
      );
    await expect(insert("limit", null)).rejects.toThrow();
    await expect(insert("written", 100)).rejects.toThrow();
    await expect(insert(null, 100)).rejects.toThrow();
    await expect(insert("limit", 100)).resolves.toBeTruthy();
    await expect(insert(null, null)).resolves.toBeTruthy();
  });
});
