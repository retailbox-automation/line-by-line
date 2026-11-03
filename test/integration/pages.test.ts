import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { customerToken } from "../../src/http/app.js";
import { PAGE_CSP, WEB_DIR } from "../../src/http/pages.js";
import { call, desk, DESK_TOKEN, dumpTables, JOB_TOKEN, makeAppEnv, type AppEnv, type Reply } from "../helpers.js";

afterEach(() => vi.restoreAllMocks());

/** The consent the desk's "Start a demo" button sends (web/app.js). */
const DEMO_CONSENT = { approverName: "Demo customer", channel: "link", esignConsent: true };

async function newJudge(t: AppEnv) {
  const r = await call(t.app, "POST", "/api/judge/session");
  expect(r.status, r.text).toBe(201);
  return { cookie: { cookie: `lbl_judge=${r.json.token as string}` } };
}

async function judgeDemo(t: AppEnv, cookie: Record<string, string>) {
  const r = await call(t.app, "POST", "/api/judge/demo", DEMO_CONSENT, cookie);
  expect(r.status, r.text).toBe(201);
  return { roId: r.json.roId as string, orderId: r.json.order.id as string, customerUrl: r.json.customerUrl as string };
}

function expectPage(r: Reply, status: number, screen?: string) {
  expect(r.status, r.text.slice(0, 300)).toBe(status);
  expect(r.headers.get("content-type")).toMatch(/^text\/html/);
  expect(r.headers.get("content-security-policy")).toBe(PAGE_CSP);
  expect(r.headers.get("cache-control")).toBe("no-store");
  expect(r.headers.get("referrer-policy")).toBe("same-origin");
  if (screen) expect(r.text).toContain(`data-screen="${screen}"`);
}

async function judgeSessions(t: AppEnv): Promise<number> {
  return (await t.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM judge_sessions`)).rows[0]!.n;
}

/** Every text file under web/, with its path. */
function webFiles(dir = WEB_DIR): { path: string; text: string }[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return webFiles(p);
    return /\.(html|js|css)$/.test(e.name) ? [{ path: p, text: readFileSync(p, "utf8") }] : [];
  });
}

// "Bearer " followed by a literal token (a variable after it, as in `Bearer ${k}`, is not a literal).
const BEARER_LITERAL = /Bearer\s+[A-Za-z0-9._~+/=-]{6,}/;

function expectNoSecret(where: string, text: string) {
  expect(text, where).not.toContain("DESK_TOKEN");
  expect(text, where).not.toContain("JOB_TOKEN");
  expect(text, where).not.toContain(DESK_TOKEN);
  expect(text, where).not.toContain(JOB_TOKEN);
  expect(text, where).not.toMatch(BEARER_LITERAL);
}

describe("pages: GET /", () => {
  it("is the empty desk with the start button, and reads or creates nothing (no session, no order, no PayPal call)", async () => {
    const t = await makeAppEnv();
    const before = await dumpTables(t.db);
    const calls = t.fake.calls.length;
    const r = await call(t.app, "GET", "/");
    expectPage(r, 200, "s2");
    expect(r.text).toContain('data-mode="start"');
    expect(r.text).not.toContain('data-mode="desk"');
    expect(r.text).toContain("Start a demo repair order");
    expect(r.text).toContain("Sandbox demo. You approve with your own PayPal sandbox buyer.");
    expect(r.text).toContain("https://github.com/retailbox-automation/line-by-line#readme");
    expect(r.text).toContain('<script type="module" src="/web/app.js"></script>');
    expect(r.headers.get("set-cookie")).toBeNull();
    expect(await dumpTables(t.db)).toBe(before);
    expect(await judgeSessions(t)).toBe(0);
    expect(t.fake.calls.length).toBe(calls);
  });
});

describe("pages: desk and mechanic (judge session cookie)", () => {
  it("open for the session that created the repair order; picked up (or ?view=pickup) is the pickup screen", async () => {
    const t = await makeAppEnv();
    const j = await newJudge(t);
    const { roId, orderId } = await judgeDemo(t, j.cookie);

    const deskPage = await call(t.app, "GET", `/desk/${roId}`, undefined, j.cookie);
    expectPage(deskPage, 200, "s2");
    expect(deskPage.text).toContain('data-mode="desk"');
    expectPage(await call(t.app, "GET", `/mechanic/${roId}`, undefined, j.cookie), 200, "s3");
    expectPage(await call(t.app, "GET", `/desk/${roId}?view=pickup`, undefined, j.cookie), 200, "s2-pickup");
    // The desk token (a script, never a browser) may open them too.
    expectPage(await desk(t.app, "GET", `/desk/${roId}`), 200, "s2");

    t.fake.approve(orderId);
    expect((await call(t.app, "GET", `/api/paypal/return?token=${orderId}`)).status).toBe(303);
    const state = (await call(t.app, "GET", `/api/ro/${roId}`, undefined, j.cookie)).json;
    const performed = (state.lines as { id: string; priceCents: number }[]).map((l) => ({ lineId: l.id, performedCents: l.priceCents }));
    const p = await call(t.app, "POST", `/api/ro/${roId}/pickup`, { performed }, j.cookie);
    expect(p.status, p.text).toBe(200);
    expectPage(await call(t.app, "GET", `/desk/${roId}`, undefined, j.cookie), 200, "s2-pickup");
  });

  it("another session's repair order is a 403 page without its data; no or a forged session 401; unknown 404; bad id 400", async () => {
    const t = await makeAppEnv();
    const owner = await newJudge(t);
    const other = await newJudge(t);
    const { roId } = await judgeDemo(t, owner.cookie);
    for (const path of [`/desk/${roId}`, `/mechanic/${roId}`]) {
      const r = await call(t.app, "GET", path, undefined, other.cookie);
      expectPage(r, 403);
      expect(r.text).toContain("another demo session");
      expect(r.text).not.toContain(roId);
      expect(r.text).not.toContain("Judge demo");
      expect(r.text).not.toContain("data-screen");
    }
    const none = await call(t.app, "GET", `/desk/${roId}`);
    expectPage(none, 401);
    expect(none.text).toContain('<a href="/">Start a demo repair order</a>');
    expectPage(await call(t.app, "GET", `/mechanic/${roId}`, undefined, { cookie: "lbl_judge=j.forged" }), 401);
    expectPage(await call(t.app, "GET", "/desk/ro_0000000000000000", undefined, owner.cookie), 404);
    expectPage(await call(t.app, "GET", "/desk/not.an.id", undefined, owner.cookie), 400);
  });
});

describe("pages: customer page /c/:roId", () => {
  it("opens with the link's token; a wrong or missing token is a 403 page; PayPal's return (no token) opens it", async () => {
    const t = await makeAppEnv();
    const created = await desk(t.app, "POST", "/api/ro", { customerLabel: "Dana Demo (made-up)", estimateLines: [{ priceCode: "BRK-PAD-F", source: "desk" }] });
    expect(created.status, created.text).toBe(201);
    const roId = created.json.repairOrder.id as string;
    const link = new URL(created.json.customerUrl as string);
    const k = link.searchParams.get("k")!;

    const ok = await call(t.app, "GET", `${link.pathname}${link.search}`);
    expectPage(ok, 200, "s1");
    expect(ok.text).not.toContain(k);

    for (const bad of [`/c/${roId}?k=${"0".repeat(32)}`, `/c/${roId}?k=`, `/c/${roId}`, `/c/${roId}?k=${customerToken(DESK_TOKEN, "ro_other")}`]) {
      const r = await call(t.app, "GET", bad);
      expectPage(r, 403);
      expect(r.text).toContain("customer link is not valid");
      expect(r.text).not.toContain(roId);
      expect(r.text).not.toContain("Dana Demo");
    }
    // The judge cookie is not a customer credential.
    const j = await newJudge(t);
    expectPage(await call(t.app, "GET", `/c/${roId}`, undefined, j.cookie), 403);

    // PayPal sends the customer back without the token; the page takes it from the tab and holds no data itself.
    expectPage(await call(t.app, "GET", `/c/${roId}?paypal=approved&order=5O190127TN364715T`), 200, "s1");
    // A valid token for a repair order that does not exist.
    expectPage(await call(t.app, "GET", `/c/ro_0000000000000000?k=${customerToken(DESK_TOKEN, "ro_0000000000000000")}`), 404);
  });
});

describe("pages: static files and secrets", () => {
  it("serves scripts, styles and pictures from web/ with a short cache; not the HTML templates, nothing outside web/", async () => {
    const t = await makeAppEnv();
    const js = await call(t.app, "GET", "/web/app.js");
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toMatch(/javascript/);
    expect(js.headers.get("cache-control")).toBe("public, max-age=300");
    expect(js.text).toBe(readFileSync(join(WEB_DIR, "app.js"), "utf8"));
    const css = await call(t.app, "GET", "/web/app.css");
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toMatch(/^text\/css/);
    const png = await t.app.request("/web/assets-s1/thumb-rotor.png");
    expect(png.status).toBe(200);
    expect(png.headers.get("content-type")).toBe("image/png");
    expect((await png.arrayBuffer()).byteLength).toBe(readFileSync(join(WEB_DIR, "assets-s1/thumb-rotor.png")).byteLength);

    for (const path of ["/web/s1.html", "/web/s2.html", "/web/nope.js", "/web/../package.json", "/web/%2e%2e/package.json", "/web/assets-s1/../../package.json"]) {
      const r = await call(t.app, "GET", path);
      expect(r.status, path).toBe(404);
      expect(r.text, path).not.toContain('"name": "line-by-line"');
    }
  });

  it("no desk or job token, and no literal bearer token, in web/ files or in any page answer", async () => {
    // The pattern must light on a literal token and stay dark on the variable form used by app.js.
    expect("Authorization: Bearer abc123def456").toMatch(BEARER_LITERAL);
    expect("headers.authorization = `Bearer ${k}`;").not.toMatch(BEARER_LITERAL);

    const files = webFiles();
    expect(files.map((f) => f.path.slice(WEB_DIR.length)).sort()).toEqual(["app.css", "app.js", "judge.js", "s1.html", "s2-pickup.html", "s2.html", "s3.html"]);
    for (const f of files) expectNoSecret(f.path, f.text);

    const t = await makeAppEnv();
    const j = await newJudge(t);
    const { roId, customerUrl } = await judgeDemo(t, j.cookie);
    const link = new URL(customerUrl);
    const answers: [string, Reply][] = [];
    for (const [path, headers] of [
      ["/", {}],
      [`/desk/${roId}`, j.cookie],
      [`/desk/${roId}?view=pickup`, j.cookie],
      [`/mechanic/${roId}`, j.cookie],
      [`${link.pathname}${link.search}`, {}],
      [`/desk/${roId}`, {}],
      [`/c/${roId}`, {}],
      ["/web/app.js", {}],
      ["/web/app.css", {}],
    ] as [string, Record<string, string>][]) {
      answers.push([path, await call(t.app, "GET", path, undefined, headers)]);
    }
    for (const [path, r] of answers) {
      expect(r.status, path).toBeLessThan(500);
      expectNoSecret(path, r.text);
    }
  });

  it("the HTML runs no inline script: one module script from /web/app.js, no inline handlers", () => {
    for (const f of webFiles().filter((x) => x.path.endsWith(".html"))) {
      const scripts = [...f.text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)];
      expect(scripts.map((m) => m[0]), f.path).toEqual(['<script type="module" src="/web/app.js"></script>']);
      expect(f.text, f.path).not.toMatch(/\son[a-z]+\s*=/i);
      expect(f.text, f.path).not.toMatch(/javascript:/i);
    }
  });
});
