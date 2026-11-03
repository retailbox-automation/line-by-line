// web/app.js: the pure functions that turn API answers into screen values, checked on real answers of the demo
// story (the HTTP app on the fake PayPal), and their names checked against the HTML they fill.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WEB_DIR } from "../../src/http/pages.js";
import { call, desk, makeAppEnv, type AppEnv } from "../helpers.js";

// Plain JS module without types: loaded by URL so the compiler does not look for declarations.
const APP_JS: string = new URL("../../web/app.js", import.meta.url).href;
const web: Record<string, (...args: any[]) => any> = await import(APP_JS);

const html = (file: string) => readFileSync(join(WEB_DIR, file), "utf8");
const names = (text: string, attr: "data-field" | "data-slot") => new Set([...text.matchAll(new RegExp(`${attr}="([^"]+)"`, "g"))].map((m) => m[1]!));

interface FakeEl {
  name: string;
  textContent: string;
  classes: Set<string>;
  getAttribute(a: string): string;
  classList: { add(c: string): void; remove(c: string): void; contains(c: string): boolean };
}

/** The elements of an HTML string that carry `attr`, with just what applyFields touches. */
function fakeRoot(text: string, attr: string) {
  const els: FakeEl[] = [...text.matchAll(new RegExp(`${attr}="([^"]+)"`, "g"))].map((m) => {
    const classes = new Set<string>();
    return {
      name: m[1]!,
      textContent: "",
      classes,
      getAttribute: (a: string) => (a === attr ? m[1]! : ""),
      classList: { add: (c: string) => void classes.add(c), remove: (c: string) => void classes.delete(c), contains: (c: string) => classes.has(c) },
    };
  });
  return {
    els,
    querySelectorAll(sel: string) {
      expect(sel).toBe(`[${attr}]`);
      return els;
    },
  };
}

const CUSTOMER_CONSENT = { approverName: "Dana Demo", channel: "link", esignConsent: true };

/** The demo story through the HTTP API, keeping the desk's and the customer's view of every step. */
async function story() {
  const t: AppEnv = await makeAppEnv();
  const s = await call(t.app, "POST", "/api/judge/session");
  const cookie = { cookie: `lbl_judge=${s.json.token as string}` };
  const demo = await call(t.app, "POST", "/api/judge/demo", { approverName: "Demo customer", channel: "link", esignConsent: true }, cookie);
  expect(demo.status, demo.text).toBe(201);
  const roId = demo.json.roId as string;
  const k = new URL(demo.json.customerUrl as string).searchParams.get("k")!;
  const customer = { authorization: `Bearer ${k}` };
  const deskState = async () => (await call(t.app, "GET", `/api/ro/${roId}`, undefined, cookie)).json;
  const customerState = async () => (await call(t.app, "GET", `/api/ro/${roId}`, undefined, customer)).json;
  const approve = async (orderId: string) => {
    t.fake.approve(orderId);
    expect((await call(t.app, "GET", `/api/paypal/return?token=${orderId}`)).status).toBe(303);
  };
  return { t, roId, cookie, customer, deskState, customerState, approve, estimateOrderId: demo.json.order.id as string };
}

describe("web/app.js: money, ids, text", () => {
  it("formats and parses amounts", () => {
    expect(web.money!(41200)).toBe("$412.00");
    expect(web.money!(5)).toBe("$0.05");
    expect(web.money!(123456789)).toBe("$1,234,567.89");
    expect(web.money!(-1438)).toBe("-$14.38");
    expect(web.chargedMoney!(0)).toBe("$0");
    expect(web.chargedMoney!(39800)).toBe("$398.00");
    expect(web.parseDollars!("186")).toBe(18600);
    expect(web.parseDollars!(" $186.5 ")).toBe(18650);
    expect(web.parseDollars!("0.07")).toBe(7);
    expect(web.parseDollars!("0")).toBe(0);
    for (const bad of ["", "abc", "12.345", "-5", "1,000", "1e3", "$", "9999999.999", "12345678"]) expect(web.parseDollars!(bad), bad).toBeNull();
  });

  it("ids, durations, addresses and links", () => {
    expect(web.shortId!("ro_0123456789abcdef")).toBe("ABCDEF");
    expect(web.durationText!(6.4)).toBe("0:06");
    expect(web.durationText!(59.6)).toBe("1:00");
    expect(web.durationText!(Number.NaN)).toBe("0:00");
    expect(web.roIdFromPath!("/desk/ro_abc")).toBe("ro_abc");
    expect(web.roIdFromPath!("/c/ro_abc")).toBe("ro_abc");
    expect(web.roIdFromPath!("/mechanic/ro_abc")).toBe("ro_abc");
    for (const p of ["/", "/desk/", "/desk/a.b", "/desk/ro_abc/x", "/web/app.js"]) expect(web.roIdFromPath!(p), p).toBeNull();
    expect(web.isPayPalUrl!("https://www.sandbox.paypal.com/checkoutnow?token=5O190127TN364715T")).toBe(true);
    for (const u of ["http://www.sandbox.paypal.com/x", "https://paypal.com.evil.test/x", "https://evilpaypal.com/x", "javascript:alert(1)", "not a url"]) expect(web.isPayPalUrl!(u), u).toBe(false);
    expect(web.timeText!("2026-11-02T15:00:00.000Z", "UTC")).toMatch(/^Nov 2, 3:00\sPM$/);
    expect(web.errorText!({ code: "CONFLICT", status: 409, message: "line already decided" })).toBe("CONFLICT (HTTP 409): line already decided");
    expect(web.errorText!(new Error("boom"))).toBe("ERROR: boom");
  });
});

describe("web/app.js: the screens along the demo story (real API answers)", () => {
  it("desk, customer page and pickup show what the API says at every step", async () => {
    const st = await story();

    // 1. Demo created: the estimate link waits for the customer.
    let d = web.deskView!(await st.deskState(), "UTC");
    expect(d.fields).toEqual({ "order-id": `#${web.shortId!(st.roId)}` });
    expect(d.slots).toMatchObject({ customer: "Judge demo (made-up)" });
    expect(d.slots["order-opened"]).toMatch(/^Opened Nov 2, 3:00\sPM$/);
    expect(d.rows).toEqual([{ no: "1", desc: "Estimate", amount: "$412.00", pill: "wait", pillText: "APPROVAL PENDING", pillTitle: "APPROVAL PENDING" }]);
    expect(d.fl).toEqual({ toleranceLabel: "10% of estimate", tolerance: "$41.20", max: "$453.20", newTotal: "$412.00", over: false, verdict: "No new work is waiting for approval" });
    expect(d.customerUrl).toMatch(new RegExp(`^https://lbl\\.example\\.test/c/${st.roId}\\?k=[0-9a-f]{32}$`));
    expect(d.pickupLines).toEqual([]);
    let c = web.customerView!(await st.customerState(), "UTC");
    expect(c.fields).toMatchObject({ "estimate-amount": "$412.00", "estimate-status": "awaiting approval", "estimate-charged": "$0", "approved-total": "$0.00", "charged-so-far": "$0" });
    expect(c.estimate).toEqual({ needsApproval: true, confirming: false, orderId: st.estimateOrderId });
    expect(c.needsDisclosure).toBe(true);
    expect(c.estimateRequired).toBe(true);
    expect(c.slots).toEqual({ "consent-text": null });
    expect(c.cards).toEqual([]);

    // 2. Estimate approved in PayPal: one hold.
    await st.approve(st.estimateOrderId);
    d = web.deskView!(await st.deskState(), "UTC");
    expect(d.rows.map((r: { pill: string }) => r.pill)).toEqual(["ok"]);
    expect(d.pickupLines.map((l: { value: string }) => l.value)).toEqual(["189.00", "129.00", "49.00", "45.00"]);
    c = web.customerView!(await st.customerState(), "UTC");
    expect(c.fields).toMatchObject({ "estimate-status": "held", "approved-total": "$412.00" });
    expect(c.estimate).toMatchObject({ needsApproval: false, orderId: null });
    expect(c.needsDisclosure).toBe(false);
    expect(c.approverName).toBe("Demo customer");
    expect(c.slots["consent-text"]).toMatch(/^You agreed to electronic records on Nov 2, 3:00\sPM$/);

    // 3. The mechanic sends two lines from the price list.
    for (const priceCode of ["BRK-ROT-F", "FLT-CABIN"]) {
      st.t.clock.advance(60_000); // lines are listed by creation time (the test clock stands still otherwise)
      const r = await call(st.t.app, "POST", `/api/ro/${st.roId}/lines`, { priceCode, source: "mechanic", urgency: priceCode === "BRK-ROT-F" ? "safety" : "can_wait" }, st.cookie);
      expect(r.status, r.text).toBe(201);
    }
    d = web.deskView!(await st.deskState(), "UTC");
    expect(d.rows.map((r: { desc: string; amount: string; pill: string }) => [r.desc, r.amount, r.pill])).toEqual([
      ["Estimate", "$412.00", "ok"],
      ["Front brake rotors — replace (pair)", "$186.00", "wait"],
      ["Cabin air filter — replace", "$39.00", "wait"],
    ]);
    expect(d.fl).toMatchObject({ newTotal: "$637.00", over: true, verdict: "$637.00 > $453.20 → customer consent required" });
    let state = await st.customerState();
    c = web.customerView!(state, "UTC");
    const [rotors, filter] = c.cards;
    expect(rotors).toMatchObject({ kind: "pending", title: "Front brake rotors — replace (pair)", price: "$186.00", urgency: "Safety", chip: "safety", canDecline: true, orderId: null });
    expect(rotors.thumb).toBe("/web/assets-s1/thumb-rotor.png");
    expect(rotors.photo).toBe("/web/assets-s1/photo-brake-rotor.png");
    expect(filter).toMatchObject({ kind: "pending", urgency: "Can wait", chip: "wait", thumb: "/web/assets-s1/thumb-cabin-filter.png", photo: null });
    expect(rotors.avatar).not.toBe(filter.avatar);

    // 4. The customer approves the rotors and declines the filter (as the customer page does it).
    const ok = await call(st.t.app, "POST", `/api/ro/${st.roId}/decisions`, { ...CUSTOMER_CONSENT, approve: [rotors.lineId], decline: [] }, st.customer);
    expect(ok.status, ok.text).toBe(200);
    const no = await call(st.t.app, "POST", `/api/ro/${st.roId}/decisions`, { ...CUSTOMER_CONSENT, approve: [], decline: [filter.lineId] }, st.customer);
    expect(no.status, no.text).toBe(200);
    c = web.customerView!(await st.customerState(), "UTC");
    expect(c.cards[0]).toMatchObject({ kind: "pending", orderId: ok.json.order.id, canDecline: false });
    expect(c.cards[1]).toMatchObject({ kind: "declined" });
    expect(web.deskView!(await st.deskState(), "UTC").rows.map((r: { pill: string; pillTitle: string }) => [r.pill, r.pillTitle])).toEqual([
      ["ok", "AUTHORIZED"],
      ["wait", "APPROVAL PENDING"],
      ["no", "Not billed — no PayPal order"],
    ]);

    // 5. Rotors approved in PayPal: hold no. 2; the tolerance base moves to the approved total ($598 -> $50 cap).
    await st.approve(ok.json.order.id as string);
    c = web.customerView!(await st.customerState(), "UTC");
    expect(c.cards[0]).toMatchObject({ kind: "approved", authSeq: 2 });
    expect(c.fields).toMatchObject({ "approved-total": "$598.00", "charged-so-far": "$0" });
    d = web.deskView!(await st.deskState(), "UTC");
    expect(d.fl).toEqual({ toleranceLabel: "$50 maximum", tolerance: "$50.00", max: "$648.00", newTotal: "$598.00", over: false, verdict: "No new work is waiting for approval" });
    expect(d.pickupLines.map((l: { title: string }) => l.title)).toEqual([
      "Front brake pads — replace",
      "Check engine light diagnosis",
      "Front wiper blades — replace",
      "Engine air filter — replace",
      "Front brake rotors — replace (pair)",
    ]);

    // Before pickup the pickup screen shows the holds as they stand.
    let p = web.pickupView!(await st.deskState(), "UTC");
    expect(p.pickedUp).toBe(false);
    expect(p.rows.map((r: { released: string | null }) => r.released)).toEqual(["held $412.00", "held $186.00", null]);

    // 6. Pickup: the wipers were not done; everything else in full.
    const entries = d.pickupLines.map((l: { lineId: string; title: string; value: string }) => ({ ...l, value: l.title.startsWith("Front wiper") ? "0" : l.value }));
    const b = web.pickupBody!(entries);
    expect(b.error).toBeUndefined();
    const res = await call(st.t.app, "POST", `/api/ro/${st.roId}/pickup`, b.body, st.cookie);
    expect(res.status, res.text).toBe(200);
    expect(web.pickupProblems!(res.json)).toEqual([]);
    state = await st.deskState();
    p = web.pickupView!(state, "UTC");
    expect(p.pickedUp).toBe(true);
    expect(p.rows).toEqual([
      { billed: true, desc: "Estimate", amount: "$412.00", auth: "PayPal authorization 1", chargedText: "charged $363.00", chargedShare: 36300 / 41200, released: "released $49.00", match: "Estimate work · $363.00" },
      { billed: true, desc: "Front brake rotors — replace (pair)", amount: "$186.00", auth: "PayPal authorization 2", chargedText: "charged $186.00", chargedShare: 1, released: null, match: "Front brake rotors — replace (pair) · $186.00" },
      { billed: false, desc: "Cabin air filter — replace", amount: "$39.00", auth: "no PayPal order", chargedText: "charged $0.00", chargedShare: 0, released: null, match: "Cabin air filter — replace · not billed" },
    ]);
    const fee = (cents: number) => web.money!(Math.round(cents * 0.0349) + 49);
    expect(p.fields).toEqual({ "order-id": `#${web.shortId!(st.roId)}`, "invoice-total": "$549.00", "paypal-fees": `PayPal fees ${fee(36300)} + ${fee(18600)}` });
    const captureIds = (state.captures as { id: string }[]).map((x) => x.id);
    expect(captureIds).toHaveLength(2);
    expect(p.slots["invoice-meta-2"]).toBe(`PayPal capture ${captureIds.join(", ")}`);
    expect(p.slots["invoice-meta-1"]).toBe(`Net ${web.money!(54900 - (Math.round(36300 * 0.0349) + 49) - (Math.round(18600 * 0.0349) + 49))}`);
    expect(p.unsettled).toEqual([]);
    expect(p.retry.performed).toHaveLength(5);
    c = web.customerView!(await st.customerState(), "UTC");
    expect(c.fields).toMatchObject({ "estimate-status": "settled", "estimate-charged": "$363.00", "charged-so-far": "$549.00" });
    expect(c.needsDisclosure).toBe(false);
  });

  it("the mechanic's draft from a recorded sample becomes cards with the server's prices", async () => {
    const st = await story();
    const r = await call(st.t.app, "POST", `/api/ro/${st.roId}/voice/sample/F01`, undefined, st.cookie);
    expect(r.status, r.text).toBe(200);
    const v = web.draftView!(r.json);
    expect(v.transcript).toBe(r.json.transcript);
    expect(v.cards).toHaveLength(r.json.lines.length);
    expect(v.cards.length).toBeGreaterThan(0);
    v.cards.forEach((card: { priceCode: string; price: string; body: unknown }, i: number) => {
      const line = r.json.lines[i];
      expect(card.priceCode).toBe(line.priceCode);
      expect(card.price).toBe(web.money!(line.cents));
      expect(card.body).toEqual({ priceCode: line.priceCode, source: "mechanic", urgency: line.urgency ?? null, description: line.customerText });
    });
    // Each card is a valid line for the API; the customer's decision then shows on the mechanic's button.
    const sent = await call(st.t.app, "POST", `/api/ro/${st.roId}/lines`, v.cards[0].body, st.cookie);
    expect(sent.status, sent.text).toBe(201);
    expect(web.sentState!(await st.deskState(), sent.json.line.id)).toEqual({ state: "sent", text: "Sent to customer" });
    await call(st.t.app, "POST", `/api/ro/${st.roId}/decisions`, { ...CUSTOMER_CONSENT, approve: [], decline: [sent.json.line.id] }, st.customer);
    expect(web.sentState!(await st.deskState(), sent.json.line.id)).toEqual({ state: "sent", text: "Customer said not now" });

    expect(web.draftView!({ transcript: "x", lines: [], droppedCodes: ["ZZZ-1"], priceTextCodes: [] }).note).toBe(
      "No item of the shop's price list matches this note. Not on the price list, dropped: ZZZ-1",
    );
  });

  it("a desk repair order (no judge) still renders: no Florida panel outside FL, customer page without an estimate order", async () => {
    const t = await makeAppEnv();
    const r = await desk(t.app, "POST", "/api/ro", { customerLabel: "Out of state (made-up)", state: "GA", estimateLines: [{ priceCode: "OIL-SYN", source: "desk" }] });
    expect(r.status, r.text).toBe(201);
    const d = web.deskView!(r.json, "UTC");
    expect(d.fl).toMatchObject({ tolerance: "—", over: false });
    expect(d.rows).toEqual([{ no: "1", desc: "Estimate", amount: "$89.00", pill: "wait", pillText: "APPROVAL PENDING", pillTitle: "APPROVAL PENDING" }]);
    const c = web.customerView!(r.json, "UTC");
    expect(c.estimate).toEqual({ needsApproval: true, confirming: false, orderId: null });
    expect(c.estimateRequired).toBe(false);
  });
});

describe("web/app.js: small decisions", () => {
  it("pickupBody refuses anything that is not an amount, naming the line", () => {
    expect(web.pickupBody!([{ lineId: "ln_1", title: "Pads", value: "189.00" }, { lineId: "ln_2", title: "Rotors", value: "0" }])).toEqual({
      body: { performed: [{ lineId: "ln_1", performedCents: 18900 }, { lineId: "ln_2", performedCents: 0 }] },
    });
    expect(web.pickupBody!([{ lineId: "ln_1", title: "Pads", value: "18.999" }])).toEqual({ error: 'Pads: "18.999" is not an amount in dollars' });
    expect(web.pickupBody!([])).toEqual({ body: { performed: [] } });
  });

  it("pickupProblems lists holds that did not finish and a stop", () => {
    const result = {
      authorizations: [
        { authorizationId: "A1", outcome: "done", reason: null },
        { authorizationId: "A2", outcome: "nothing_to_do", reason: "already settled" },
        { authorizationId: "A3", outcome: "retry", reason: null },
        { authorizationId: "A4", outcome: "needs_attention", reason: "MAX_CAPTURE_COUNT_EXCEEDED" },
      ],
      stopped: null,
    };
    expect(web.pickupProblems!(result)).toEqual(["PayPal hold A3: retry", "PayPal hold A4: needs_attention — MAX_CAPTURE_COUNT_EXCEEDED"]);
    expect(web.pickupProblems!({ authorizations: [], stopped: "capture refused" })).toEqual(["Pickup stopped: capture refused"]);
  });

  it("returnNotice: a message for each PayPal return", () => {
    const n = (q: string) => web.returnNotice!(new URLSearchParams(q));
    expect(n("paypal=approved&order=O1").note).toMatch(/^Approved in PayPal/);
    expect(n("paypal=pending&order=O1").note).toMatch(/still confirming/);
    expect(n("paypal=cancelled&order=O1").note).toMatch(/^You cancelled on PayPal/);
    expect(n("paypal=error&order=O1&code=CONFLICT").error).toBe("PayPal did not confirm (CONFLICT). The page shows the current state.");
    expect(n("k=abc")).toBeNull();
  });

  it("flPanel: within the tolerance, and the $10 floor", () => {
    const fl = { toleranceBaseCents: 5000, approvedTotalCents: 0, toleranceCents: 1000, ceilingCents: 6000, pendingTotalCents: 800, pendingExceedsTolerance: false };
    expect(web.flPanel!(fl)).toEqual({ toleranceLabel: "$10 minimum", tolerance: "$10.00", max: "$60.00", newTotal: "$58.00", over: false, verdict: "$58.00 ≤ $60.00 → within the tolerance" });
    expect(web.flPanel!(null).verdict).toBe("The Florida rule applies to Florida repair orders");
  });
});

describe("web/app.js: filling the HTML", () => {
  it("applyFields sets text by name, turns a slot with a value into text and puts the bar back for null", () => {
    const fields = fakeRoot('<b data-field="fl-max">—</b><i data-field="fl-tolerance">—</i><u data-field="untouched">x</u>', "data-field");
    web.applyFields!(fields, { "fl-max": "$453.20", "fl-tolerance": "$41.20", unknown: "y" });
    expect(fields.els.map((e) => [e.name, e.textContent])).toEqual([
      ["fl-max", "$453.20"],
      ["fl-tolerance", "$41.20"],
      ["untouched", ""],
    ]);
    const slots = fakeRoot('<div data-slot="customer"></div><div data-slot="order-advisor"></div>', "data-slot");
    web.applyFields!(slots, { customer: "Dana Demo (made-up)", "order-advisor": null }, "data-slot");
    expect(slots.els[0]).toMatchObject({ textContent: "Dana Demo (made-up)" });
    expect(slots.els[0]!.classes.has("slot-filled")).toBe(true);
    expect(slots.els[1]!.classes.has("slot-filled")).toBe(false);
    web.applyFields!(slots, { customer: null }, "data-slot");
    expect(slots.els[0]).toMatchObject({ textContent: "" });
    expect(slots.els[0]!.classes.has("slot-filled")).toBe(false);
  });

  it("every name the views fill exists in the HTML of its screen", async () => {
    const st = await story();
    const deskState = await st.deskState();
    const s2 = html("s2.html");
    const d = web.deskView!(deskState, "UTC");
    for (const n of [...Object.keys(d.fields), "fl-tolerance-label", "fl-tolerance", "fl-max", "fl-new-total", "fl-verdict"]) expect(names(s2, "data-field"), n).toContain(n);
    for (const n of Object.keys(d.slots)) expect(names(s2, "data-slot"), n).toContain(n);
    const pk = html("s2-pickup.html");
    const p = web.pickupView!(deskState, "UTC");
    for (const n of [...Object.keys(p.fields), "line-desc", "line-amount", "line-auth", "line-capture", "captured", "released"]) expect(names(pk, "data-field"), n).toContain(n);
    for (const n of Object.keys(p.slots)) expect(names(pk, "data-slot"), n).toContain(n);
    const s1 = html("s1.html");
    const c = web.customerView!(await st.customerState(), "UTC");
    for (const n of Object.keys(c.fields)) expect(names(s1, "data-field"), n).toContain(n);
    for (const n of [...Object.keys(c.slots), "mech-msg-l1"]) expect(names(s1, "data-slot"), n).toContain(n);
    const s3 = html("s3.html");
    for (const n of ["transcript", "voice-duration", "line-part", "line-price", "price-code"]) expect(names(s3, "data-field"), n).toContain(n);
    for (const n of ["order-ref", "line-detail-1"]) expect(names(s3, "data-slot"), n).toContain(n);
  });

  it("every element id and template app.js looks up is in the HTML", () => {
    const js = readFileSync(join(WEB_DIR, "app.js"), "utf8");
    const all = ["s1.html", "s2.html", "s2-pickup.html", "s3.html"].map(html).join("\n");
    const ids = new Set([...js.matchAll(/\$\("#([\w-]+)"\)/g)].map((m) => m[1]!));
    // Every "tpl-…" literal, including `tpl-pill-${…}` (checked as a prefix).
    const templates = new Set([...js.matchAll(/["`](tpl-[\w-]+?)(?:\$\{[^}]+\})?["`]/g)].map((m) => m[1]!));
    expect(templates.size).toBeGreaterThanOrEqual(9);
    expect(ids.size).toBeGreaterThan(20);
    for (const id of ids) expect(all, `#${id}`).toContain(`id="${id}"`);
    for (const id of templates) expect(all, id).toMatch(new RegExp(`<template id="${id}`));
    for (const pill of ["ok", "wait", "no"]) expect(html("s2.html")).toContain(`<template id="tpl-pill-${pill}">`);
  });
});

describe("web/app.js: QR code", () => {
  // Checked once with two independent decoders (macOS CoreImage and OpenCV) when the encoder was written; this hash
  // pins that output.
  it("encodes the customer link as the matrix that was verified with real decoders", () => {
    const url = "https://lbl.example.test/c/ro_0123456789abcdef?k=0123456789abcdef0123456789abcdef";
    const m: boolean[][] = web.qrMatrix!(url);
    expect(m).toHaveLength(37); // version 5
    const rows = m.map((r) => r.map((x) => (x ? "1" : "0")).join("")).join("\n");
    expect(createHash("sha256").update(rows).digest("hex")).toBe("3f6baad6731d8987e50f67b9d6ccc06d36d776481e73306f1aa2cb81acde6201");
  });

  it("has the three finder patterns, the timing lines, grows with the text and refuses what does not fit version 10", () => {
    for (const [len, size] of [[1, 21], [14, 21], [15, 25], [100, 41], [106, 41], [107, 45], [213, 57]] as const) {
      const m: boolean[][] = web.qrMatrix!("x".repeat(len));
      expect(m.length, `length ${len}`).toBe(size);
      const n = m.length;
      for (const [cx, cy] of [[3, 3], [n - 4, 3], [3, n - 4]] as const) {
        for (let d = -3; d <= 3; d++) {
          expect(m[cy - 3]![cx + d]).toBe(true);
          expect(m[cy + 3]![cx + d]).toBe(true);
          expect(m[cy + d]![cx - 3]).toBe(true);
          expect(m[cy + d]![cx + 3]).toBe(true);
        }
        expect(m[cy - 2]![cx]).toBe(false);
        expect(m[cy]![cx]).toBe(true);
      }
      for (let i = 8; i < n - 8; i++) {
        expect(m[6]![i]).toBe(i % 2 === 0);
        expect(m[i]![6]).toBe(i % 2 === 0);
      }
      expect(m[n - 8]![8]).toBe(true); // the dark module
    }
    expect(() => web.qrMatrix!("x".repeat(214))).toThrow(/too long/);
    expect(web.qrMatrix!("é")).toHaveLength(21);
  });

  it("qrPath draws one unit square per dark module, offset by the quiet zone", () => {
    const m = [
      [true, false],
      [false, true],
    ];
    expect(web.qrPath!(m)).toBe("M4 4h1v1h-1zM5 5h1v1h-1z");
  });
});

describe("web/app.js: the Florida statement the customer checked (Fla. Stat. 559.905(2))", () => {
  it("flChoiceOf sends the checked statement; the limit statement needs its dollar amount", () => {
    expect(web.flChoiceOf!(null, "")).toBeNull();
    expect(web.flChoiceOf!("written", "")).toEqual({ flChoice: "written" });
    expect(web.flChoiceOf!("none", "999")).toEqual({ flChoice: "none" });
    expect(web.flChoiceOf!("limit", "$450")).toEqual({ flChoice: "limit", flLimitCents: 45000 });
    expect(web.flChoiceOf!("limit", "450.5")).toEqual({ flChoice: "limit", flLimitCents: 45050 });
    for (const empty of ["", "0", "abc", "-5"]) expect(() => web.flChoiceOf!("limit", empty)).toThrow(/dollar amount/);
    expect(() => web.flChoiceOf!("maybe", "")).toThrow(/unknown/);
  });

  it("customerConsent carries the checked statement with the first approval only, and asks for what is missing", () => {
    const first = { needsDisclosure: true, estimateRequired: true, approverName: "" };
    const form = { flValue: "limit", flLimit: "450", esign: true, name: " Ana Driver " };
    expect(web.customerConsent!(first, form)).toEqual({ approverName: "Ana Driver", channel: "link", esignConsent: true, flChoice: "limit", flLimitCents: 45000 });
    expect(web.customerConsent!(first, { ...form, flValue: "written" })).toEqual({ approverName: "Ana Driver", channel: "link", esignConsent: true, flChoice: "written" });
    expect(() => web.customerConsent!(first, { ...form, flValue: null })).toThrow(/Florida statements/);
    expect(() => web.customerConsent!(first, { ...form, esign: false })).toThrow(/electronic records/);
    expect(() => web.customerConsent!(first, { ...form, name: "  " })).toThrow(/name/);
    // under $150 the statement is shown but not required; later decisions send no choice
    expect(web.customerConsent!({ ...first, estimateRequired: false }, { ...form, flValue: null })).toEqual({ approverName: "Ana Driver", channel: "link", esignConsent: true });
    expect(web.customerConsent!({ needsDisclosure: false, estimateRequired: true, approverName: "Ana Driver" }, { ...form, name: "" })).toEqual({ approverName: "Ana Driver", channel: "link", esignConsent: true });
  });

  it("SIGNED and DATE are in capital letters of at least 12-point type (16px), like the statement", () => {
    const css = readFileSync(join(WEB_DIR, "app.css"), "utf8");
    for (const cls of ["fl-caps", "lbl-field", "lbl-date"]) {
      const rule = new RegExp(`\\.${cls} \\{[^}]*font: \\d+ (\\d+(?:\\.\\d+)?)px`).exec(css);
      expect(Number(rule?.[1]), cls).toBeGreaterThanOrEqual(16);
    }
    const s1 = readFileSync(join(WEB_DIR, "s1.html"), "utf8");
    expect(s1).toMatch(/class="lbl-field">SIGNED /);
    expect(s1).toMatch(/class="lbl-date">DATE /);
  });
});
