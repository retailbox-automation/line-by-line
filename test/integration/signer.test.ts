// The demo's start button records the estimate consent under a placeholder name ("Demo customer") before the customer
// sees the Florida statement. When the customer page then approves with the name typed into SIGNED, that name and
// its channel go into the same records. The first real signature stays; the placeholder never overwrites a real name.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEMO_START_APPROVER } from "../../src/core/orders.js";
import { customerToken } from "../../src/http/app.js";
import { WEB_DIR } from "../../src/http/pages.js";
import { call, desk, DESK_TOKEN, makeAppEnv, type AppEnv } from "../helpers.js";

const NEW_RO = {
  customerLabel: "Dana Demo (made-up)",
  estimateLines: [
    { title: "Front brake pads", priceCents: 26800, source: "desk", urgency: "safety" },
    { title: "Brake fluid flush", priceCents: 14400, source: "desk", urgency: "soon" },
  ],
};

async function orderMadeBy(t: AppEnv, approverName: string) {
  const r = await desk(t.app, "POST", "/api/ro", NEW_RO);
  const roId = r.json.repairOrder.id as string;
  const made = await desk(t.app, "POST", `/api/ro/${roId}/estimate/approval`, { approverName, channel: "link", esignConsent: true });
  expect(made.status, made.text).toBe(201);
  return roId;
}

const customerPage = (t: AppEnv, roId: string, approverName: string, channel = "link") =>
  call(t.app, "POST", `/api/ro/${roId}/estimate/approval`, { approverName, channel, esignConsent: true }, { authorization: `Bearer ${customerToken(DESK_TOKEN, roId)}` });

async function signers(t: AppEnv, roId: string) {
  return ((await desk(t.app, "GET", `/api/ro/${roId}`)).json.consents as { approverName: string; channel: string }[]).map((c) => [c.approverName, c.channel]);
}

describe("the customer's signature on an estimate the demo start made", () => {
  it("the start button's placeholder is the same name in app.js and on the server", () => {
    expect(DEMO_START_APPROVER).toBe("Demo customer");
    expect(readFileSync(join(WEB_DIR, "app.js"), "utf8")).toContain(`approverName: "${DEMO_START_APPROVER}"`);
  });

  it("the name typed on the customer page replaces the placeholder with its channel; the first real name stays", async () => {
    const t = await makeAppEnv();
    const roId = await orderMadeBy(t, DEMO_START_APPROVER);
    expect(await signers(t, roId)).toEqual([[DEMO_START_APPROVER, "link"], [DEMO_START_APPROVER, "link"]]);
    expect((await customerPage(t, roId, "  Ana Driver ", "qr_page")).status).toBe(200);
    expect(await signers(t, roId)).toEqual([["Ana Driver", "qr_page"], ["Ana Driver", "qr_page"]]);
    expect((await customerPage(t, roId, "Bob Other")).status).toBe(200);
    expect((await customerPage(t, roId, DEMO_START_APPROVER)).status).toBe(200);
    expect(await signers(t, roId)).toEqual([["Ana Driver", "qr_page"], ["Ana Driver", "qr_page"]]);
  });

  it("a consent recorded under a real name is never rewritten", async () => {
    const t = await makeAppEnv();
    const roId = await orderMadeBy(t, "Dana Demo");
    expect((await customerPage(t, roId, "Ana Driver")).status).toBe(200);
    expect(await signers(t, roId)).toEqual([["Dana Demo", "link"], ["Dana Demo", "link"]]);
  });

  it("the desk does not sign for the customer", async () => {
    const t = await makeAppEnv();
    const roId = await orderMadeBy(t, DEMO_START_APPROVER);
    expect((await desk(t.app, "POST", `/api/ro/${roId}/estimate/approval`, { approverName: "Front desk", channel: "desk", esignConsent: false })).status).toBe(200);
    expect(await signers(t, roId)).toEqual([[DEMO_START_APPROVER, "link"], [DEMO_START_APPROVER, "link"]]);
  });
});
