// web/judge.js: the texts of step 1 checked against the statute and the customer page, and the view functions and
// the client checked on real answers of the judge API (the HTTP app on the fake PayPal), with the clock moved past
// the 4-day reauthorize window.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/http/app.js";
import { WEB_DIR } from "../../src/http/pages.js";
import { REAUTH_MIN_AGE_MS } from "../../src/core/reauthorize.js";
import { seedPool } from "../../src/judge/pool.js";
import { call, CONSENT, DESK_TOKEN, JOB_TOKEN, makeAppEnv, PUBLIC_BASE, type AppEnv } from "../helpers.js";

const JUDGE_JS: string = new URL("../../web/judge.js", import.meta.url).href;
const judge: Record<string, any> = await import(JUDGE_JS);
const TZ = "America/New_York";

/** Fla. Stat. 559.905(2), the statement only, as flsenate.gov prints it for 2026 (read 2026-11-03). */
const STATUTE =
  "PLEASE READ CAREFULLY, CHECK ONE OF THE STATEMENTS BELOW, AND SIGN: I UNDERSTAND THAT, UNDER STATE LAW, I AM ENTITLED TO A WRITTEN ESTIMATE IF MY FINAL BILL WILL EXCEED $150. I REQUEST A WRITTEN ESTIMATE. I DO NOT REQUEST A WRITTEN ESTIMATE AS LONG AS THE REPAIR COSTS DO NOT EXCEED $ . THE SHOP MAY NOT EXCEED THIS AMOUNT WITHOUT MY WRITTEN OR ORAL APPROVAL. I DO NOT REQUEST A WRITTEN ESTIMATE. SIGNED DATE";

const flat = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

describe("step 1 texts", () => {
  it("the Florida statement is the statute word for word, in its order", () => {
    const f = judge.FL_STATEMENT;
    const [w, l, n] = f.choices;
    const ours = [f.heading, f.understand, w.text, `${l.before} ${l.after.trimStart()}`, n.text, f.signed, f.date].join(" ");
    expect(ours).toBe(STATUTE);
    expect(f.minFontPx).toBeGreaterThanOrEqual(16); // 12-point type
  });

  it("the customer page carries the same statement and the same e-records sentence", () => {
    const s1 = flat(readFileSync(join(WEB_DIR, "s1.html"), "utf8"));
    const f = judge.FL_STATEMENT;
    for (const piece of [f.heading, f.understand, ...f.choices.flatMap((c: any) => (c.text ? [c.text] : [c.before, c.after])), f.source])
      expect(s1).toContain(piece);
    expect(s1).toContain(judge.STEP1.esign);
  });

  it("consentBody asks for the box and a name, and sends what POST /api/judge/demo takes", () => {
    expect(() => judge.consentBody("Ana", false)).toThrow(/electronic records/);
    expect(() => judge.consentBody("   ", true)).toThrow(/name/);
    expect(() => judge.consentBody("x".repeat(201), true)).toThrow(/200/);
    expect(judge.consentBody("  Ana Judge ", true)).toEqual({ approverName: "Ana Judge", channel: "link", esignConsent: true });
  });

  it("isAuthorizationId takes 17 capital letters and digits only", () => {
    expect(judge.isAuthorizationId(" 53712651KB727854G ")).toBe(true);
    for (const bad of ["53712651kb727854g", "53712651KB727854", "53712651KB727854G1", "../authorizations", ""]) expect(judge.isAuthorizationId(bad)).toBe(false);
  });
});

async function env() {
  const t = await makeAppEnv();
  const app = createApp({ deps: t.deps, publicBaseUrl: PUBLIC_BASE, deskToken: DESK_TOKEN, jobToken: JOB_TOKEN, webhooks: t.webhooks });
  return { ...t, app };
}

let seq = 0;
async function hold(t: AppEnv, cents: number) {
  const rid = `judge-js:${++seq}`;
  const o = await t.paypal.createAuthorizeOrder({
    requestId: `${rid}:order`, referenceId: `RO-J-${seq}`, customId: `RO-J-${seq}`, description: "judge.js test",
    items: [{ name: "Estimate: coolant service", unitCents: cents, category: "PHYSICAL_GOODS" }],
    returnUrl: "https://example.com/return", cancelUrl: "https://example.com/cancel",
  });
  t.fake.approve(o.id, "paypal");
  return (await t.paypal.authorizeOrder({ orderId: o.id, requestId: `${rid}:auth` })).authorizations[0]!.id;
}

/** A judge's request function over the app, as browserRequest is over fetch; the cookie comes from the session. */
function judgeRequest(t: AppEnv) {
  let cookie = "";
  return async (method: string, path: string, body?: unknown) => {
    const r = await call(t.app, method, path, body, cookie ? { cookie } : {});
    const set = r.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0]!;
    return { status: r.status, json: r.json };
  };
}

describe("the judge flow on the app", () => {
  it("startDemo opens a session on 401 and returns the PayPal approval link of the $412 estimate", async () => {
    const t = await env();
    const d = await judge.startDemo(judgeRequest(t), CONSENT);
    expect(d.roId).toMatch(/^ro_/);
    expect(d.approveUrl).toContain("token=");
    expect(d.order.amount).toBe("412.00");
  });

  it("pool rows, the reauthorize card with the same expiry, the refusals, and Live GET", async () => {
    const t = await env();
    const old = await hold(t, 14250);
    const kept = await hold(t, 9600);
    await seedPool(t.deps, { purpose: "judge", wave: 1, label: "RO-A", note: "", ids: [old] });
    await seedPool(t.deps, { purpose: "reserved", wave: 0, label: "RO-B", note: "video", ids: [kept] });
    const req = judgeRequest(t);
    await judge.startDemo(req, CONSENT);

    const young = await judge.loadPool(req, t.clock.now().getTime(), TZ);
    expect(young.view.available).toBe(0);
    expect(young.view.rows.map((r: any) => [r.label, r.amount, r.status, r.window])).toEqual([
      ["RO-A", "$142.50", "Not yet", "opens in 5 days"],
      ["RO-B", "$96.00", "Reserved", "opens in 5 days"],
    ]);
    expect((await judge.reauthorizeNext(req, young.answer, TZ)).refused).toMatchObject({ code: "POOL_EMPTY", last: null });

    t.clock.advance(REAUTH_MIN_AGE_MS + 60_000); // the holds are 4 days old; a judge session lives 2 hours, so a new judge
    const req2 = judgeRequest(t);
    await judge.startDemo(req2, CONSENT);
    const aged = await judge.loadPool(req2, t.clock.now().getTime(), TZ);
    expect(aged.view.rows[0]).toMatchObject({ id: old, status: "Available", tone: "go", available: true, reason: null, live: "CREATED", age: "4 days" });
    expect(aged.view.rows[0].window).toMatch(/^open until /);
    expect(aged.view.rows[1]).toMatchObject({ status: "Reserved", available: false });

    const { card } = await judge.reauthorizeNext(req2, aged.answer, TZ);
    expect(card).toMatchObject({ label: "RO-A", oldId: old, amount: "$142.50", status: "CREATED", sameExpiry: true });
    expect(card.newId).not.toBe(old);
    expect(card.expires).toBe(aged.view.rows[0].expires);

    expect((await judge.reauthorizeNext(req2, aged.answer, TZ)).refused).toMatchObject({ code: "ALREADY_USED" });
    const other = judgeRequest(t);
    await judge.startDemo(other, CONSENT);
    const empty = (await judge.reauthorizeNext(other, aged.answer, TZ)).refused;
    expect(empty).toMatchObject({ code: "POOL_EMPTY", last: { label: "RO-A", oldId: old, newId: card.newId, amount: "$142.50", status: "CREATED" } });

    const after = await judge.loadPool(req2, t.clock.now().getTime(), TZ);
    expect(after.view.rows[0]).toMatchObject({ status: "Reauthorized", tone: "done", newId: card.newId, available: false });
    const real = judge.resultCard(judge.holdOf(after.answer, old), TZ);
    expect(real).toMatchObject({ oldId: old, newId: card.newId, amount: "$142.50", status: "CREATED", note: "same end date · no new 29 days" });
    expect(real.barNew.left).toBeGreaterThan(13); // reauthorized after 4 days 11 minutes of 29 days
    expect(judge.holdOf(after.answer, "NOPE0000000000000")).toBeNull();
    expect(judge.latestReauthorized(after.answer)?.authorizationId).toBe(old);
    expect(judge.latestReauthorized({ holds: [] })).toBeNull();

    // a browser with no session: the pool read opens one and says when it ends
    const fresh = judgeRequest(t);
    const s3 = await judge.ensureSession(fresh);
    expect(s3.expiresAt).toMatch(/^2026-/);
    expect(s3.pool.holds).toHaveLength(2);
    expect((await judge.ensureSession(fresh)).expiresAt).toBeNull(); // the cookie is there now: no second session

    // the pool's ids are read through the pool listing (a judge may not GET another repair order's authorization)
    expect(await req2("GET", `/api/authorizations/${card.newId}`)).toMatchObject({ status: 403, json: { code: "FORBIDDEN" } });
    expect(await judge.liveGet(req2, card.newId, TZ)).toMatchObject({ id: card.newId, status: "CREATED", amount: "$142.50", source: "pool", liveError: null });
    expect(await judge.liveGet(req2, old, TZ)).toMatchObject({ id: old, source: "pool" });
    const listed = after.answer.holds[0];
    const voidedParent = { ...listed, live: { ...listed.live, status: "VOIDED" } };
    expect(judge.poolLiveView(voidedParent, card.newId, TZ).status).toBe("CREATED"); // the new id's own read
    expect(judge.poolLiveView(voidedParent, old, TZ).status).toBe("VOIDED");

    // the judge's own estimate hold is read through GET /api/authorizations/:id and compared with our record
    const mine = await judge.startDemo(req2, CONSENT);
    t.fake.approve(mine.order.id, "paypal");
    expect((await call(t.app, "GET", `/api/paypal/return?token=${mine.order.id}`)).status).toBe(303);
    const state = await req2("GET", `/api/ro/${mine.roId}`);
    const authId = state.json.authorizations[0].id;
    expect(await judge.liveGet(req2, authId, TZ)).toMatchObject({ id: authId, status: "CREATED", amount: "$412.00", captured: "$0.00", matches: true, diffs: [], source: "authorization" });
    await expect(judge.liveGet(req2, "not-an-id", TZ)).rejects.toThrow(/17 capital letters/);
  });

  it("resultCard places the old and the new id on one scale: the new bar starts at the reauthorization, both end together", () => {
    const h = {
      authorizationId: "4RR33540BR8604004", amountCents: 14250, createdAt: "2026-10-29T16:02:00Z", expirationTime: "2026-11-27T16:02:00Z",
      reauthorized: { at: "2026-11-02T16:12:17Z", newId: "0MM670868D710561J", expirationTime: "2026-11-27T16:02:01Z", live: { status: "CREATED" }, liveError: null },
    };
    const c = judge.resultCard(h, "UTC");
    expect(c).toMatchObject({ oldId: "4RR33540BR8604004", newId: "0MM670868D710561J", amount: "$142.50", status: "CREATED", startDate: "Oct 29", endDate: "Nov 27", newStartDate: "Nov 2", note: "same end date · no new 29 days" });
    expect(c.barOld).toEqual({ left: 0, width: 100 });
    expect(c.barNew.left).toBeCloseTo(13.8, 1); // 4 days 10 minutes of 29 days
    expect(c.barNew.left + c.barNew.width).toBeCloseTo(100, 1);
    const longer = judge.resultCard({ ...h, reauthorized: { ...h.reauthorized, expirationTime: "2026-12-01T16:12:17Z" } }, "UTC");
    expect(longer.note).toBe("new id expires Dec 1");
    expect(longer.barOld.width).toBeLessThan(100);
  });

  it("sessionLeft counts down to 0:00:00", () => {
    expect(judge.sessionLeft("2026-11-03T18:00:00Z", Date.parse("2026-11-03T16:01:48Z"))).toBe("1:58:12");
    expect(judge.sessionLeft("2026-11-03T18:00:00Z", Date.parse("2026-11-03T19:00:00Z"))).toBe("0:00:00");
  });

  it("a refusal other than the two pool answers shows its code and message", () => {
    expect(judge.reauthRefusal(502, { code: "PAYPAL", error: "PayPal did not answer" }, TZ)).toEqual({ code: "PAYPAL", message: "PAYPAL: PayPal did not answer", last: null });
    expect(judge.reauthRefusal(500, null, TZ)).toMatchObject({ code: "500" });
  });
});
