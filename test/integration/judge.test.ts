import { afterEach, describe, expect, it, vi } from "vitest";
import { findReauthorizable, getRepairOrder, pickup, reconcile, runReauthorize, type CoreDeps } from "../../src/core/index.js";
import type { Db, Queryable } from "../../src/db/db.js";
import { createApp } from "../../src/http/app.js";
import { reauthorizeNext, seedPool, type PoolSeedInput, type ReauthorizeNextResult } from "../../src/judge/pool.js";
import { createPayPalClient } from "../../src/paypal/client.js";
import { dbCallSink } from "../../src/paypal/journal.js";
import { JUDGE_SESSION_MS, signJudgeToken } from "../../src/judge/session.js";
import { formatResults, parseSeedArgs } from "../../scripts/seed-pool.js";
import { approvedEstimate, call, CONSENT, desk, DESK_TOKEN, JOB_TOKEN, makeAppEnv, PUBLIC_BASE, START, type AppEnv, type Reply } from "../helpers.js";

const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;

afterEach(() => vi.restoreAllMocks());

function expectError(r: Reply, status: number, code: string) {
  expect(r.status, r.text).toBe(status);
  expect(r.json).toMatchObject({ code, error: expect.any(String) });
}

async function judgeEnv(judge: { dailySessions?: number; liveVoice?: boolean } = {}): Promise<AppEnv> {
  const t = await makeAppEnv();
  return { ...t, app: createApp({ deps: t.deps, publicBaseUrl: PUBLIC_BASE, deskToken: DESK_TOKEN, jobToken: JOB_TOKEN, webhooks: t.webhooks, judge }) };
}

interface Judge {
  token: string;
  auth: Record<string, string>;
  cookie: Record<string, string>;
  replies: Reply[];
  /** A request as this judge (bearer token); every reply is kept to check for DESK_TOKEN. */
  go(method: string, path: string, body?: unknown): Promise<Reply>;
}

async function newJudge(t: AppEnv): Promise<Judge> {
  const r = await call(t.app, "POST", "/api/judge/session");
  expect(r.status, r.text).toBe(201);
  const token = r.json.token as string;
  const auth = { authorization: `Bearer ${token}` };
  const replies: Reply[] = [r];
  return {
    token,
    auth,
    cookie: { cookie: `lbl_judge=${token}` },
    replies,
    async go(method, path, body) {
      const reply = await call(t.app, method, path, body, auth);
      replies.push(reply);
      return reply;
    },
  };
}

async function demo(t: AppEnv, j: Judge) {
  const r = await j.go("POST", "/api/judge/demo", CONSENT);
  expect(r.status, r.text).toBe(201);
  return { roId: r.json.roId as string, orderId: r.json.order.id as string, reply: r };
}

let seq = 0;
/** A hold made at PayPal directly (as the hold-pool script did), not known to our database. */
async function paypalHold(t: AppEnv, items: { name: string; cents: number }[] = [{ name: "Estimate: oil change + multi-point inspection", cents: 14250 }], source: "paypal" | "card" = "paypal") {
  const rid = `pool-test:${++seq}`;
  const o = await t.paypal.createAuthorizeOrder({
    requestId: `${rid}:order`,
    referenceId: `RO-TEST-${seq}`,
    customId: `RO-TEST-${seq}`,
    description: "Pool test",
    items: items.map((i) => ({ name: i.name, unitCents: i.cents, category: "PHYSICAL_GOODS" as const })),
    returnUrl: "https://example.com/return",
    cancelUrl: "https://example.com/cancel",
  });
  t.fake.approve(o.id, source);
  const done = await t.paypal.authorizeOrder({ orderId: o.id, requestId: `${rid}:auth` });
  return { orderId: o.id, authId: done.authorizations[0]!.id };
}

function seed(t: AppEnv, ids: string[], o: Partial<PoolSeedInput> = {}) {
  return seedPool(t.deps, { purpose: "judge", wave: 1, label: "wave 1", note: "", ids, ...o });
}

async function count(t: AppEnv, table: string): Promise<number> {
  return (await t.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]!.n;
}

describe("judge session", () => {
  it("hands out a signed 2-hour token as JSON and as an HttpOnly, Secure, SameSite=Lax cookie", async () => {
    const t = await judgeEnv();
    const r = await call(t.app, "POST", "/api/judge/session");
    expect(r.status).toBe(201);
    expect(r.json.token).toMatch(/^j\.js_[0-9a-f]{32}\.[0-9]{13}\.[0-9a-f]{64}$/);
    expect(r.json.expiresAt).toBe(new Date(START + JUDGE_SESSION_MS).toISOString());
    const cookie = r.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`lbl_judge=${r.json.token}`);
    for (const attr of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/", "Max-Age=7200"]) expect(cookie).toContain(attr);
    const row = (await t.db.query<{ ro_count: number; reauthorized: boolean }>(`SELECT ro_count, reauthorized FROM judge_sessions`)).rows;
    expect(row).toEqual([{ ro_count: 0, reauthorized: false }]);
  });

  it("works as a bearer token or as the cookie; refuses forged, expired and unknown sessions", async () => {
    const t = await judgeEnv();
    const j = await newJudge(t);
    expect((await call(t.app, "GET", "/api/judge/pool", undefined, j.auth)).status).toBe(200);
    expect((await call(t.app, "GET", "/api/judge/pool", undefined, j.cookie)).status).toBe(200);
    const last = j.token.at(-1) === "0" ? "1" : "0";
    expectError(await call(t.app, "GET", "/api/judge/pool", undefined, { authorization: `Bearer ${j.token.slice(0, -1)}${last}` }), 401, "UNAUTHORIZED");
    expectError(await call(t.app, "GET", "/api/judge/pool", undefined, { cookie: "lbl_judge=j.forged" }), 401, "UNAUTHORIZED");
    // A correct signature for a session that was never created.
    const ghost = signJudgeToken(DESK_TOKEN, `js_${"0".repeat(32)}`, START + JUDGE_SESSION_MS);
    expectError(await call(t.app, "GET", "/api/judge/pool", undefined, { authorization: `Bearer ${ghost}` }), 401, "UNAUTHORIZED");
    // Signed with another DESK_TOKEN.
    const other = signJudgeToken("another-desk-token-0123", j.token.split(".")[1]!, START + JUDGE_SESSION_MS);
    expectError(await call(t.app, "GET", "/api/judge/pool", undefined, { authorization: `Bearer ${other}` }), 401, "UNAUTHORIZED");
    expectError(await call(t.app, "GET", "/api/judge/pool"), 401, "UNAUTHORIZED");
    expectError(await desk(t.app, "GET", "/api/judge/pool"), 401, "UNAUTHORIZED");
    t.clock.advance(JUDGE_SESSION_MS);
    expectError(await call(t.app, "GET", "/api/judge/pool", undefined, j.auth), 401, "UNAUTHORIZED");
    expectError(await call(t.app, "GET", "/api/judge/pool", undefined, j.cookie), 401, "UNAUTHORIZED");
  });

  it("at most LBL_JUDGE_DAILY_SESSIONS new sessions per UTC day", async () => {
    const t = await judgeEnv({ dailySessions: 2 });
    expect((await call(t.app, "POST", "/api/judge/session")).status).toBe(201);
    expect((await call(t.app, "POST", "/api/judge/session")).status).toBe(201);
    expectError(await call(t.app, "POST", "/api/judge/session"), 429, "DAILY_CAP");
    t.clock.advance(DAY);
    expect((await call(t.app, "POST", "/api/judge/session")).status).toBe(201);
    const closed = await judgeEnv({ dailySessions: 0 });
    expectError(await call(closed.app, "POST", "/api/judge/session"), 429, "DAILY_CAP");
  });
});

describe("judge access", () => {
  it("a judge sees and works only on its own repair orders; DESK_TOKEN never reaches a judge", async () => {
    const t = await judgeEnv();
    const a = await newJudge(t);
    const b = await newJudge(t);
    const mine = await demo(t, a);
    const shop = await desk(t.app, "POST", "/api/ro", { customerLabel: "Shop customer (made-up)", estimateLines: [{ priceCode: "OIL-SYN", source: "desk" }] });
    const shopRo = shop.json.repairOrder.id as string;

    const own = await a.go("GET", `/api/ro/${mine.roId}`);
    expect(own.status).toBe(200);
    expect(own.json.customerUrl).toMatch(new RegExp(`^${PUBLIC_BASE}/c/${mine.roId}\\?k=[0-9a-f]{32}$`));
    expectError(await b.go("GET", `/api/ro/${mine.roId}`), 403, "FORBIDDEN");
    expectError(await a.go("GET", `/api/ro/${shopRo}`), 403, "FORBIDDEN");
    expectError(await b.go("POST", `/api/ro/${mine.roId}/pickup`, { performed: [] }), 403, "FORBIDDEN");
    expectError(await b.go("POST", `/api/ro/${mine.roId}/lines`, { priceCode: "BRK-ROT-F", source: "mechanic" }), 403, "FORBIDDEN");
    expectError(await b.go("POST", `/api/ro/${mine.roId}/decisions`, { approve: ["ln_x"], ...CONSENT }), 403, "FORBIDDEN");
    expectError(await b.go("POST", `/api/ro/${mine.roId}/voice/sample/F01`), 403, "FORBIDDEN");
    expectError(await b.go("POST", `/api/ro/${mine.roId}/lines/draft`, { text: "front pads" }), 403, "FORBIDDEN");
    expectError(await b.go("POST", `/api/ro/${mine.roId}/estimate/approval`, CONSENT), 403, "FORBIDDEN");
    expectError(await a.go("GET", "/api/ro/ro_missing"), 404, "NOT_FOUND");
    // Desk-only routes stay closed to a judge.
    expectError(await a.go("POST", "/api/ro", { customerLabel: "x", estimateLines: [{ priceCode: "OIL-SYN", source: "desk" }] }), 401, "UNAUTHORIZED");
    expectError(await a.go("POST", "/api/jobs/reauthorize"), 401, "UNAUTHORIZED");
    expectError(await a.go("POST", `/api/orders/${mine.orderId}/refresh`), 401, "UNAUTHORIZED");
    // Live audio is off for judges by default.
    const audio = await t.app.request(`/api/ro/${mine.roId}/voice`, { method: "POST", headers: { ...a.auth, "content-type": "audio/webm" }, body: new Uint8Array(10) });
    expect(audio.status).toBe(403);
    // The cookie gives the same rights; a customer token in the header wins over the cookie.
    expect((await call(t.app, "GET", `/api/ro/${mine.roId}`, undefined, a.cookie)).status).toBe(200);
    const k = new URL(own.json.customerUrl).searchParams.get("k")!;
    const asCustomer = await call(t.app, "GET", `/api/ro/${mine.roId}`, undefined, { ...b.cookie, authorization: `Bearer ${k}` });
    expect(asCustomer.status).toBe(200);
    expect(asCustomer.json.customerUrl).toBeUndefined();
    expectError(await call(t.app, "POST", `/api/ro/${mine.roId}/decisions`, { approve: ["ln_x"], ...CONSENT, channel: "desk" }, { authorization: `Bearer ${k}` }), 403, "FORBIDDEN");

    for (const r of [...a.replies, ...b.replies]) {
      expect(r.text).not.toContain(DESK_TOKEN);
      expect(r.headers.get("set-cookie") ?? "").not.toContain(DESK_TOKEN);
    }
  });

  it("authorizations: a judge reads only those of its own repair orders", async () => {
    const t = await judgeEnv();
    const a = await newJudge(t);
    const b = await newJudge(t);
    const mine = await demo(t, a);
    t.fake.approve(mine.orderId);
    expect((await call(t.app, "GET", `/api/paypal/return?token=${mine.orderId}`)).status).toBe(303);
    const authId = (await a.go("GET", `/api/ro/${mine.roId}`)).json.authorizations[0].id as string;
    const live = await a.go("GET", `/api/authorizations/${authId}`);
    expect(live.status, live.text).toBe(200);
    expect(live.json).toMatchObject({ ok: true, live: { status: "CREATED", amountCents: 41200 } });
    expectError(await b.go("GET", `/api/authorizations/${authId}`), 403, "FORBIDDEN");
    expectError(await a.go("GET", "/api/authorizations/A_missing"), 404, "NOT_FOUND");
    expectError(await call(t.app, "GET", `/api/authorizations/${authId}`), 401, "UNAUTHORIZED");
    const shop = await approvedEstimate(t);
    expectError(await a.go("GET", `/api/authorizations/${shop.authorization.id}`), 403, "FORBIDDEN");
  });
});

describe("POST /api/judge/demo", () => {
  it("the $412 estimate from the price list, approval link and customer link; at most 5 per session", async () => {
    const t = await judgeEnv();
    const j = await newJudge(t);
    const d = await demo(t, j);
    expect(d.reply.json).toMatchObject({ order: { purpose: "estimate", amountCents: 41200, amount: "412.00", status: "PAYER_ACTION_REQUIRED" } });
    expect(d.reply.json.approveUrl).toBe(`https://www.sandbox.paypal.com/checkoutnow?token=${d.orderId}`);
    expect(d.reply.json.customerUrl).toMatch(new RegExp(`^${PUBLIC_BASE}/c/${d.roId}\\?k=[0-9a-f]{32}$`));
    const state = await getRepairOrder(t.deps, d.roId);
    expect(state.lines.map((l) => [l.priceCode, l.priceCents, l.kind])).toEqual([
      ["BRK-PAD-F", 18900, "estimate"],
      ["DIAG-CEL", 12900, "estimate"],
      ["WIPER-F", 4900, "estimate"],
      ["FLT-ENGINE", 4500, "estimate"],
    ]);
    expect(state.lines.reduce((a, l) => a + l.priceCents, 0)).toBe(41200);
    expect(state.consents.map((c) => [c.approverName, c.channel])).toEqual(Array(4).fill([CONSENT.approverName, CONSENT.channel]));
    for (let i = 0; i < 4; i++) await demo(t, j);
    expectError(await j.go("POST", "/api/judge/demo", CONSENT), 429, "DEMO_LIMIT");
    expect(await count(t, "repair_orders")).toBe(5);
    // Another session has its own five.
    await demo(t, await newJudge(t));
  });

  it("a bad consent body creates nothing and does not count", async () => {
    const t = await judgeEnv();
    const j = await newJudge(t);
    expectError(await j.go("POST", "/api/judge/demo", { approverName: "Judge", channel: "link", esignConsent: false }), 400, "VALIDATION");
    expectError(await j.go("POST", "/api/judge/demo", "not json"), 415, "UNSUPPORTED_MEDIA_TYPE");
    expectError(await call(t.app, "POST", "/api/judge/demo", CONSENT), 401, "UNAUTHORIZED");
    expect(await count(t, "repair_orders")).toBe(0);
    expect((await t.db.query(`SELECT ro_count FROM judge_sessions`)).rows).toEqual([{ ro_count: 0 }]);
  });

  it("a PayPal failure names the created repair order, whose estimate can be asked for again", async () => {
    const t = await judgeEnv();
    const j = await newJudge(t);
    t.fake.script((c) => c.method === "POST" && c.path === "/v2/checkout/orders", { kind: "respond", status: 422, body: { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "PAYEE_ACCOUNT_RESTRICTED", description: "restricted" }] } });
    const r = await j.go("POST", "/api/judge/demo", CONSENT);
    expectError(r, 502, "PAYPAL");
    const roId = r.json.details.roId as string;
    const again = await j.go("POST", `/api/ro/${roId}/estimate/approval`, CONSENT);
    expect(again.status, again.text).toBe(201);
    expect(again.json.order.amountCents).toBe(41200);
  });

  it("the judge's whole path over HTTP: estimate, a sample note, a line by its code, decision, pickup, live check", async () => {
    const t = await judgeEnv();
    const j = await newJudge(t);
    const d = await demo(t, j);
    t.fake.approve(d.orderId);
    expect((await call(t.app, "GET", `/api/paypal/return?token=${d.orderId}`)).status).toBe(303);
    const draft = await j.go("POST", `/api/ro/${d.roId}/voice/sample/F02`);
    expect(draft.status, draft.text).toBe(200);
    expect(draft.json.lines).toEqual([expect.objectContaining({ priceCode: "BRK-ROT-F", cents: 18600, urgency: "safety" })]);
    const line = await j.go("POST", `/api/ro/${d.roId}/lines`, { priceCode: "BRK-ROT-F", urgency: "safety", source: "mechanic", description: draft.json.lines[0].customerText });
    expect(line.status, line.text).toBe(201);
    const decision = await j.go("POST", `/api/ro/${d.roId}/decisions`, { approve: [line.json.line.id], ...CONSENT });
    expect(decision.status, decision.text).toBe(200);
    t.fake.approve(decision.json.order.id);
    expect((await call(t.app, "GET", `/api/paypal/return?token=${decision.json.order.id}`)).status).toBe(303);
    const state = await j.go("GET", `/api/ro/${d.roId}`);
    const performed = state.json.lines.map((l: { id: string; priceCents: number }) => ({ lineId: l.id, performedCents: l.priceCents }));
    const p = await j.go("POST", `/api/ro/${d.roId}/pickup`, { performed });
    expect(p.status, p.text).toBe(200);
    expect(p.json.authorizations.map((a: { outcome: string }) => a.outcome)).toEqual(["done", "done"]);
    for (const a of state.json.authorizations) expect((await j.go("GET", `/api/authorizations/${a.id}`)).json.live.status).toBe("CAPTURED");
    for (const r of j.replies) expect(r.text).not.toContain(DESK_TOKEN);
  });
});

describe("seed-pool", () => {
  it("records an aged sandbox hold as a pool repair order with lines from the order's items; a repeat makes no duplicate", async () => {
    const t = await judgeEnv();
    const h = await paypalHold(t, [
      { name: "Estimate: oil change + multi-point inspection", cents: 14250 },
      { name: "Added line: front brake pads + labor", cents: 18400 },
    ]);
    const posts = () => t.fake.calls.filter((c) => c.method === "POST" && !c.path.startsWith("/v1/oauth2")).length;
    const postsBefore = posts();
    const [r] = await seed(t, [h.authId], { purpose: "reserved", wave: 0, label: "RO-2910-A", note: "job test 04.11" });
    expect(r).toEqual({ authorizationId: h.authId, outcome: "added", reason: null, roId: `ro_pool_${h.authId}`, amountCents: 32650 });
    const state = await getRepairOrder(t.deps, r!.roId!);
    expect(state.repairOrder).toMatchObject({ kind: "pool", customerLabel: "RO-2910-A", status: "open" });
    expect(state.lines.map((l) => [l.title, l.priceCents, l.status, l.priceCode])).toEqual([
      ["Estimate: oil change + multi-point inspection", 14250, "approved", null],
      ["Added line: front brake pads + labor", 18400, "approved", null],
    ]);
    expect(state.orders).toMatchObject([{ id: h.orderId, amountCents: 32650, status: "COMPLETED", purpose: "estimate" }]);
    expect(state.authorizations).toMatchObject([{ id: h.authId, amountCents: 32650, status: "CREATED", paymentSource: "paypal", capturedCents: 0, parentId: null }]);
    expect(state.authorizations[0]!.createdAt.getTime()).toBe(START);
    expect((await t.db.query(`SELECT label, purpose, wave, note FROM judge_pool`)).rows).toEqual([{ label: "RO-2910-A", purpose: "reserved", wave: 0, note: "job test 04.11" }]);

    const tables = ["repair_orders", "lines", "paypal_orders", "authorizations", "judge_pool"];
    const before = await Promise.all(tables.map((x) => count(t, x)));
    const [again] = await seed(t, [h.authId], { purpose: "judge", wave: 2, label: "RO-2910-A", note: "released after filming" });
    expect(again).toMatchObject({ outcome: "updated", roId: `ro_pool_${h.authId}` });
    expect(await Promise.all(tables.map((x) => count(t, x)))).toEqual(before);
    expect((await t.db.query(`SELECT purpose, wave, note FROM judge_pool`)).rows).toEqual([{ purpose: "judge", wave: 2, note: "released after filming" }]);
    // Seeding only reads PayPal: a GET of the authorization and of its order per id and run, no POST.
    expect(posts()).toBe(postsBefore);
    expect(t.fake.calls.filter((c) => c.method === "GET" && (c.path.endsWith(h.authId) || c.path.endsWith(h.orderId)))).toHaveLength(4);
  });

  it("refuses a captured hold, a card hold, an unknown id, a hold of a shop repair order and an already reauthorized one", async () => {
    const t = await judgeEnv();
    const captured = await paypalHold(t);
    await t.paypal.captureAuthorization({ authorizationId: captured.authId, requestId: "pool-test:capture", cents: 14250, finalCapture: true });
    const card = await paypalHold(t, undefined, "card");
    const shop = await approvedEstimate(t);
    const twice = await paypalHold(t);
    t.clock.advance(5 * DAY);
    await t.paypal.reauthorize({ authorizationId: twice.authId, requestId: "pool-test:reauth", cents: 14250 });
    const results = await seed(t, [captured.authId, card.authId, "A0000000000UNKNOWN", shop.authorization.id, twice.authId]);
    expect(results.map((r) => r.outcome)).toEqual(["refused", "refused", "refused", "refused", "refused"]);
    expect(results.map((r) => r.reason)).toEqual([
      "status CAPTURED; only a CREATED hold is seeded",
      "paid by card; only a hold paid from a PayPal wallet can be reauthorized",
      expect.stringContaining("PayPal: HTTP 404"),
      expect.stringContaining("not a pool repair order"),
      expect.stringContaining("carries 2 authorizations"),
    ]);
    expect(await count(t, "judge_pool")).toBe(0);
    expect((await t.db.query(`SELECT count(*)::int AS n FROM repair_orders WHERE kind = 'pool'`)).rows).toEqual([{ n: 0 }]);
    expect(formatResults(results)).toContain("refused  A0000000000UNKNOWN");
  });

  it("a quantity above 1 becomes one line with the item total; items that do not add up are refused", async () => {
    const t = await judgeEnv();
    const h = await paypalHold(t, [{ name: "Front wiper blades", cents: 4900 }]);
    const items = t.fake.orders.get(h.orderId)!.req.purchase_units[0]!.items as { quantity: string; unit_amount: { value: string } }[];
    items[0]!.quantity = "2";
    items[0]!.unit_amount.value = "24.50";
    const [ok] = await seed(t, [h.authId]);
    expect(ok!.outcome).toBe("added");
    expect((await getRepairOrder(t.deps, ok!.roId!)).lines.map((l) => [l.title, l.priceCents])).toEqual([["Front wiper blades x 2", 4900]]);
    const off = await paypalHold(t, [{ name: "Coolant service", cents: 9600 }]);
    (t.fake.orders.get(off.orderId)!.req.purchase_units[0]!.items as { unit_amount: { value: string } }[])[0]!.unit_amount.value = "90.00";
    const [bad] = await seed(t, [off.authId]);
    expect(bad).toMatchObject({ outcome: "refused", reason: expect.stringContaining("total 9000 cents but the hold is 9600") });
  });

  it("validates its input; the command line gives the same input", async () => {
    const t = await judgeEnv();
    await expect(seedPool(t.deps, { purpose: "everyone" as "judge", wave: 1, label: "x", ids: ["A0000000000000001"] })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(seed(t, ["not-an-id"])).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(seed(t, ["A0000000000000001", "A0000000000000001"])).rejects.toMatchObject({ code: "VALIDATION" });
    expect(parseSeedArgs(["--purpose", "reserved", "--wave", "0", "--label", "RO-2910-B", "--note", "filming 05.11", "1CM060836C119894N", "1Y214495HX657682L"])).toEqual({
      purpose: "reserved",
      wave: 0,
      label: "RO-2910-B",
      note: "filming 05.11",
      ids: ["1CM060836C119894N", "1Y214495HX657682L"],
    });
    expect(() => parseSeedArgs(["--purpose", "judge", "--wave", "1", "--label", "x"])).toThrow(/at least one authorization id/);
    expect(() => parseSeedArgs(["--purpose", "x", "--wave", "1", "--label", "x", "A1"])).toThrow(/--purpose/);
    expect(() => parseSeedArgs(["--purpose", "judge", "--wave", "-1", "--label", "x", "A1"])).toThrow();
    expect(() => parseSeedArgs(["--purpose", "judge", "--wave", "1", "A1"])).toThrow(/--label/);
    expect(() => parseSeedArgs(["--purpose", "judge", "--wave", "1", "--label", "x", "--search", "A1"])).toThrow();
  });
});

/** Pool at START + 7 days: R reserved (7 d old), H1 judge (6 d), H2 judge (5 d), Y judge (2 d, too young). */
async function agedPool(t: AppEnv) {
  const r = await paypalHold(t, [{ name: "Estimate: coolant service", cents: 9600 }]);
  t.clock.advance(DAY);
  const h1 = await paypalHold(t, [{ name: "Estimate: oil change + multi-point inspection", cents: 14250 }]);
  t.clock.advance(DAY);
  const h2 = await paypalHold(t, [{ name: "Added line: serpentine belt + labor", cents: 12875 }]);
  t.clock.advance(3 * DAY);
  const y = await paypalHold(t, [{ name: "Added line: front brake pads + labor", cents: 18400 }]);
  t.clock.advance(2 * DAY);
  expect((await seed(t, [r.authId], { purpose: "reserved", wave: 0, label: "R" })).map((x) => x.outcome)).toEqual(["added"]);
  for (const [h, label] of [
    [h1, "H1"],
    [h2, "H2"],
    [y, "Y"],
  ] as const) {
    expect((await seed(t, [h.authId], { label })).map((x) => x.outcome)).toEqual(["added"]);
  }
  return { r, h1, h2, y };
}

/** The session id inside a judge token (j.<sessionId>.<expiresAt>.<hmac>). */
function sessionOf(j: Judge): string {
  return j.token.split(".")[1]!;
}

/**
 * deps whose every statement runs on `q`, an open transaction of another caller (a nested tx is just `q`), with a
 * PayPal client that journals on `q` too. PGlite runs one transaction at a time, so this is how a second caller's
 * writes can land between two statements of the first: the first caller's later statements see them as they would
 * see a commit under READ COMMITTED.
 */
function onTx(t: AppEnv, q: Queryable): CoreDeps {
  const db: Db = { ...t.db, query: q.query, exec: q.exec, tx: (fn) => fn(q) };
  const paypal = createPayPalClient({
    clientId: "test-client-id",
    clientSecret: "test-client-secret",
    brandName: "Bayside Auto Care",
    fetch: t.fake.fetch,
    now: () => t.clock.now().getTime(),
    onCall: dbCallSink(q),
    retryDelayMs: 0,
    timeoutMs: 200,
  });
  return { ...t.deps, db, paypal };
}

/** deps whose transactions run `between(q)` once, right after the first statement that reads judge_pool (the list of free holds). */
function afterFirstPoolRead(deps: CoreDeps, between: (q: Queryable) => Promise<void>): CoreDeps {
  let fired = false;
  const tx: Db["tx"] = (fn) =>
    deps.db.tx((q) =>
      fn({
        ...q,
        async query<T>(sql: string, params?: unknown[]) {
          const r = await q.query<T>(sql, params);
          if (!fired && sql.includes("judge_pool")) {
            fired = true;
            await between(q);
          }
          return r;
        },
      }),
    );
  return { ...deps, db: { ...deps.db, tx } };
}

/** deps that run `after()` each time one of their own statements or transactions has finished (and committed). */
function afterEachWrite(deps: CoreDeps, after: () => Promise<void>): CoreDeps {
  const db: Db = {
    ...deps.db,
    async query<T>(sql: string, params?: unknown[]) {
      const r = await deps.db.query<T>(sql, params);
      await after();
      return r;
    },
    async tx(fn) {
      const r = await deps.db.tx(fn);
      await after();
      return r;
    },
  };
  return { ...deps, db };
}

describe("judge pool: reauthorize-next", () => {
  it("takes the oldest free judge hold with an open window, skips reserved and young ones, once per session, then POOL_EMPTY", async () => {
    const t = await judgeEnv();
    const { r, h1, h2, y } = await agedPool(t);
    const a = await newJudge(t);
    const first = await a.go("POST", "/api/judge/pool/reauthorize-next");
    expect(first.status, first.text).toBe(200);
    expect(first.json).toMatchObject({ label: "H1", parentId: h1.authId, amountCents: 14250, amount: "142.50", ageDays: 6, requestId: `lbl:reauth:${h1.authId}:1`, live: { status: "CREATED", amountCents: 14250 } });
    expect(first.json.newId).not.toBe(h1.authId);
    expect(first.json.expirationTime).toBe(new Date(START + DAY + 29 * DAY).toISOString());
    expect(first.json.live.expirationTime).toBe(first.json.expirationTime);
    expectError(await a.go("POST", "/api/judge/pool/reauthorize-next"), 409, "ALREADY_USED");

    t.clock.advance(MIN);
    const b = await newJudge(t);
    const second = await b.go("POST", "/api/judge/pool/reauthorize-next");
    expect(second.json).toMatchObject({ label: "H2", parentId: h2.authId });

    const c = await newJudge(t);
    const empty = await c.go("POST", "/api/judge/pool/reauthorize-next");
    expectError(empty, 409, "POOL_EMPTY");
    expect(empty.json.details.lastReauthorized).toMatchObject({ label: "H2", parentId: h2.authId, newId: second.json.newId, live: { status: "CREATED" }, amountCents: 12875, amount: "128.75" });
    // POOL_EMPTY does not use up the session.
    expect((await t.db.query(`SELECT reauthorized FROM judge_sessions ORDER BY created_at, id`)).rows.filter((x) => (x as { reauthorized: boolean }).reauthorized)).toHaveLength(2);

    expect(t.fake.posts(`/authorizations/${r.authId}/reauthorize`)).toHaveLength(0);
    expect(t.fake.posts(`/authorizations/${y.authId}/reauthorize`)).toHaveLength(0);
    // The core recorded the child like its own reauthorization.
    const parent = (await getRepairOrder(t.deps, `ro_pool_${h1.authId}`)).authorizations;
    expect(parent.find((x) => x.id === h1.authId)!.reauthorizedTo).toBe(first.json.newId);
    expect(parent.find((x) => x.id === first.json.newId)).toMatchObject({ parentId: h1.authId, amountCents: 14250 });

    // The listing shows each hold, its window and what happened to it.
    const list = await c.go("GET", "/api/judge/pool");
    expect(list.status).toBe(200);
    const byLabel = Object.fromEntries((list.json.holds as { label: string }[]).map((x) => [x.label, x]));
    expect(list.json.holds.map((x: { label: string }) => x.label)).toEqual(["R", "H1", "H2", "Y"]);
    expect(byLabel.R).toMatchObject({ purpose: "reserved", available: false, reason: expect.stringContaining("reserved"), ageDays: 7, window: { open: true }, live: { status: "CREATED" }, amount: "96.00" });
    expect(byLabel.H1).toMatchObject({ purpose: "judge", available: false, reauthorized: { newId: first.json.newId, live: { status: "CREATED" } }, reason: expect.stringContaining("already reauthorized") });
    expect(byLabel.Y).toMatchObject({ available: false, ageDays: 2, window: { open: false }, reason: expect.stringContaining("too young") });
  });

  it("a hold that becomes old enough is handed out later; the reserved one never", async () => {
    const t = await judgeEnv();
    const { r, y } = await agedPool(t);
    for (let i = 0; i < 2; i++) expect((await (await newJudge(t)).go("POST", "/api/judge/pool/reauthorize-next")).status).toBe(200);
    expectError(await (await newJudge(t)).go("POST", "/api/judge/pool/reauthorize-next"), 409, "POOL_EMPTY");
    t.clock.advance(2 * DAY + 11 * MIN);
    const late = await (await newJudge(t)).go("POST", "/api/judge/pool/reauthorize-next");
    expect(late.json).toMatchObject({ parentId: y.authId, label: "Y" });
    expectError(await (await newJudge(t)).go("POST", "/api/judge/pool/reauthorize-next"), 409, "POOL_EMPTY");
    expect(t.fake.posts(`/authorizations/${r.authId}/reauthorize`)).toHaveLength(0);
  });

  it("an empty pool answers POOL_EMPTY with no fallback hold", async () => {
    const t = await judgeEnv();
    const r = await (await newJudge(t)).go("POST", "/api/judge/pool/reauthorize-next");
    expectError(r, 409, "POOL_EMPTY");
    expect(r.json.details).toEqual({ lastReauthorized: null });
  });

  it("PayPal refuses for good: 502, the hold is flagged, the session may try again and gets the next hold", async () => {
    const t = await judgeEnv();
    const { h1, h2 } = await agedPool(t);
    const j = await newJudge(t);
    t.fake.script((c) => c.path.endsWith("/reauthorize"), { kind: "respond", status: 422, body: { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "AUTHORIZATION_VOIDED", description: "A voided authorization cannot be captured or reauthorized." }] } });
    const refused = await j.go("POST", "/api/judge/pool/reauthorize-next");
    expectError(refused, 502, "PAYPAL");
    expect(refused.json.details.issue).toBe("AUTHORIZATION_VOIDED");
    expect((await t.db.query(`SELECT needs_attention FROM authorizations WHERE id = $1`, [h1.authId])).rows[0]).toEqual({ needs_attention: expect.stringContaining("judge reauthorize refused") });
    const next = await j.go("POST", "/api/judge/pool/reauthorize-next");
    expect(next.json).toMatchObject({ parentId: h2.authId });

    // The public listing says the hold is flagged, without PayPal's text or the operator's note; the desk keeps both.
    expect((await seed(t, [h1.authId], { label: "H1", note: "filming 05.11" })).map((x) => x.outcome)).toEqual(["updated"]);
    const list = await (await newJudge(t)).go("GET", "/api/judge/pool");
    expect(list.status, list.text).toBe(200);
    const h1Row = (list.json.holds as { authorizationId: string }[]).find((x) => x.authorizationId === h1.authId);
    expect(h1Row).toMatchObject({ available: false, reason: "flagged for the service desk" });
    for (const hold of list.json.holds) expect(hold).not.toHaveProperty("note");
    expect(list.text).not.toContain("filming");
    expect(list.text).not.toContain("AUTHORIZATION_VOIDED");
    expect(list.text).not.toContain("refused");
    const atDesk = await desk(t.app, "GET", `/api/ro/ro_pool_${h1.authId}`);
    expect(atDesk.json.authorizations.find((x: { id: string }) => x.id === h1.authId).needsAttention).toContain("AUTHORIZATION_VOIDED");
  });

  it("REAUTHORIZATION_TOO_SOON is not held against the hold: the next call retries it with a new request id", async () => {
    const t = await judgeEnv();
    const { h1 } = await agedPool(t);
    const j = await newJudge(t);
    t.fake.script((c) => c.path.endsWith("/reauthorize"), { kind: "respond", status: 422, body: { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "REAUTHORIZATION_TOO_SOON", description: "too soon" }] } });
    expectError(await j.go("POST", "/api/judge/pool/reauthorize-next"), 502, "PAYPAL");
    expect((await t.db.query(`SELECT needs_attention FROM authorizations WHERE id = $1`, [h1.authId])).rows[0]).toEqual({ needs_attention: null });
    const ok = await j.go("POST", "/api/judge/pool/reauthorize-next");
    expect(ok.json).toMatchObject({ parentId: h1.authId, requestId: `lbl:reauth:${h1.authId}:2` });
  });

  it("no answer from PayPal: the retry goes to the same hold with the same PayPal-Request-Id", async () => {
    const t = await judgeEnv();
    const { h1 } = await agedPool(t);
    const j = await newJudge(t);
    t.fake.script((c) => c.path.endsWith("/reauthorize"), { kind: "network" }, 4);
    expectError(await j.go("POST", "/api/judge/pool/reauthorize-next"), 502, "PAYPAL");
    const ok = await j.go("POST", "/api/judge/pool/reauthorize-next");
    expect(ok.status, ok.text).toBe(200);
    expect(ok.json).toMatchObject({ parentId: h1.authId, requestId: `lbl:reauth:${h1.authId}:1` });
    expect(new Set(t.fake.requestIds(`/authorizations/${h1.authId}/reauthorize`))).toEqual(new Set([`lbl:reauth:${h1.authId}:1`]));
  });

  it("two judges at the same moment get two different holds", async () => {
    const t = await judgeEnv();
    const { h1, h2 } = await agedPool(t);
    const [a, b] = [await newJudge(t), await newJudge(t)];
    const [ra, rb] = await Promise.all([a.go("POST", "/api/judge/pool/reauthorize-next"), b.go("POST", "/api/judge/pool/reauthorize-next")]);
    expect([ra.status, rb.status]).toEqual([200, 200]);
    expect(new Set([ra.json.parentId, rb.json.parentId])).toEqual(new Set([h1.authId, h2.authId]));
  });

  it("a judge whose list of free holds was read before another judge's reauthorize of the first one landed takes the next hold, never the same one again", async () => {
    const t = await judgeEnv();
    const { h1, h2 } = await agedPool(t);
    const [a, b] = [await newJudge(t), await newJudge(t)];
    // B reads the free holds (H1 is first); A's whole reauthorize-next on H1 then lands before B's next statement.
    // Before the fix B claimed H1 again: one finished operation moved the attempt to 2, so a new PayPal-Request-Id.
    let ra: ReauthorizeNextResult | null = null;
    const depsB = afterFirstPoolRead(t.deps, async (q) => {
      ra = await reauthorizeNext(onTx(t, q), sessionOf(a));
    });
    const rb = await reauthorizeNext(depsB, sessionOf(b));
    expect(ra).toMatchObject({ parentId: h1.authId, requestId: `lbl:reauth:${h1.authId}:1` });
    expect(rb).toMatchObject({ parentId: h2.authId, requestId: `lbl:reauth:${h2.authId}:1` });
    expect(t.fake.requestIds(`/authorizations/${h1.authId}/reauthorize`)).toEqual([`lbl:reauth:${h1.authId}:1`]);
    expect((await t.db.query(`SELECT reauthorized_to, needs_attention FROM authorizations WHERE id = $1`, [h1.authId])).rows[0]).toEqual({ reauthorized_to: ra!.newId, needs_attention: null });
    const ops = (await t.db.query(`SELECT request_id, state FROM ops WHERE op = 'reauth'`)).rows;
    expect(ops).toHaveLength(2);
    expect(ops).toEqual(
      expect.arrayContaining([
        { request_id: `lbl:reauth:${h1.authId}:1`, state: "done" },
        { request_id: `lbl:reauth:${h2.authId}:1`, state: "done" },
      ]),
    );
  });

  it("a judge who comes in the moment PayPal's refusal of a hold is on record does not try that hold again", async () => {
    const t = await judgeEnv();
    const { h1, h2 } = await agedPool(t);
    const [a, b] = [await newJudge(t), await newJudge(t)];
    t.fake.script((c) => c.path.endsWith(`/authorizations/${h1.authId}/reauthorize`), {
      kind: "respond",
      status: 422,
      body: { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "AUTHORIZATION_VOIDED", description: "A voided authorization cannot be captured or reauthorized." }] },
    });
    // B runs whole right after the first of A's writes that records H1's operation as failed. Before the fix that
    // write and the needs_attention flag were two commits, and B sent a second reauthorize to H1 in between.
    let rb: ReauthorizeNextResult | null = null;
    const depsA = afterEachWrite(t.deps, async () => {
      if (rb) return;
      const op = (await t.db.query<{ state: string }>(`SELECT state FROM ops WHERE request_id = $1`, [`lbl:reauth:${h1.authId}:1`])).rows[0];
      if (op?.state === "failed") rb = await reauthorizeNext(t.deps, sessionOf(b));
    });
    await expect(reauthorizeNext(depsA, sessionOf(a))).rejects.toMatchObject({ code: "PAYPAL", details: { issue: "AUTHORIZATION_VOIDED" } });
    expect(rb).toMatchObject({ parentId: h2.authId, requestId: `lbl:reauth:${h2.authId}:1` });
    expect(t.fake.requestIds(`/authorizations/${h1.authId}/reauthorize`)).toEqual([`lbl:reauth:${h1.authId}:1`]);
    expect((await t.db.query(`SELECT needs_attention, reauthorized_to FROM authorizations WHERE id = $1`, [h1.authId])).rows[0]).toEqual({
      needs_attention: expect.stringContaining("AUTHORIZATION_VOIDED"),
      reauthorized_to: null,
    });
  });

  it("the core works on a pool hold like on its own: pickup after the judge's reauthorization captures the child and voids the parent", async () => {
    const t = await judgeEnv();
    const { h1 } = await agedPool(t);
    const r = await (await newJudge(t)).go("POST", "/api/judge/pool/reauthorize-next");
    const roId = `ro_pool_${h1.authId}`;
    const p = await pickup(t.deps, roId, [{ lineId: `ln_pool_${h1.authId}_0`, performedCents: 10000 }]);
    expect(p.authorizations[0]).toMatchObject({ authorizationId: h1.authId, captureAuthorizationId: r.json.newId, outcome: "done" });
    expect(t.fake.posts(`/authorizations/${r.json.newId}/capture`)).toHaveLength(1);
    expect(t.fake.posts(`/authorizations/${h1.authId}/void`)).toHaveLength(1);
    expect((await reconcile(t.deps, r.json.newId)).live.capturedCents).toBe(10000);
  });
});

describe("the reauthorize job leaves the judge pool alone", () => {
  it("findReauthorizable and runReauthorize skip reserved and judge pool holds; a shop hold of the same age is still due", async () => {
    const t = await judgeEnv();
    const shop = await approvedEstimate(t);
    const { r, h1, h2 } = await agedPool(t);
    expect((await findReauthorizable(t.deps, t.clock.now())).map((a) => a.id)).toEqual([shop.authorization.id]);
    const run = await runReauthorize(t.deps);
    expect(run.reauthorized.map((x) => x.parentId)).toEqual([shop.authorization.id]);
    for (const id of [r.authId, h1.authId, h2.authId]) expect(t.fake.posts(`/authorizations/${id}/reauthorize`)).toHaveLength(0);
    // The job route is the same function.
    const job = await call(t.app, "POST", "/api/jobs/reauthorize", undefined, { authorization: `Bearer ${JOB_TOKEN}` });
    expect(job.status).toBe(200);
    expect(job.json.reauthorized).toEqual([]);
    for (const id of [r.authId, h1.authId, h2.authId]) expect(t.fake.posts(`/authorizations/${id}/reauthorize`)).toHaveLength(0);
  });
});
