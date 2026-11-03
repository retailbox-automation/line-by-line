// Screens. The server sends the HTML of web/ (working copies of design/screens, without any repair order data) and
// web/app.js fills it from the API. Access is checked here as well, so a wrong or expired link gets a clear page
// instead of an empty screen: the desk and mechanic pages need the judge session that created the repair order (or
// the desk token), the customer page needs the token `k` of its link. GET / reads and creates nothing.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { serveStatic } from "@hono/node-server/serve-static";
import type { Context, Hono } from "hono";
import { CoreError } from "../core/errors.js";
import { loadRepairOrder } from "../core/rows.js";
import type { Queryable } from "../db/db.js";
import { HttpError } from "./errors.js";

/** web/ beside src/ in the repository, beside dist/ in the container image. */
export const WEB_DIR = fileURLToPath(new URL("../../web/", import.meta.url));

/** Scripts only from our own files; styles inline (as in the reference screens) and from Google Fonts. */
export const PAGE_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self'",
  "media-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

/** Static files of the screens: scripts, styles and pictures only (the HTML goes out through the page routes). */
const ASSET = /^\/web\/[A-Za-z0-9._/-]+\.(?:js|css|png)$/;
/** The API's path id rule. */
const ID = /^[A-Za-z0-9_-]{1,64}$/;

type PageStatus = 400 | 401 | 403 | 404;
type PageKind = "desk" | "customer";

const MESSAGES: Record<PageKind, Partial<Record<PageStatus, string>>> = {
  desk: {
    400: "This address is not valid.",
    401: "There is no demo session in this browser, or it has ended.",
    403: "This repair order belongs to another demo session.",
    404: "There is no such repair order.",
  },
  customer: {
    400: "This address is not valid.",
    403: "This customer link is not valid. Open the link or scan the QR code the service desk gave you.",
    404: "There is no such repair order.",
  },
};

function errorPage(text: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Line by Line</title>
<link href="/web/app.css" rel="stylesheet">
</head>
<body class="err-page">
<main>
<h1>Line by Line</h1>
<p>${text}</p>
<p><a href="/">Start a demo repair order</a></p>
</main>
</body>
</html>
`;
}

export interface PagesOptions {
  db: Queryable;
  /** Resolves for the desk or for the judge session that created the repair order; throws HttpError/CoreError otherwise. */
  requireDeskOrJudge(c: Context, roId: string): Promise<unknown>;
  /** True when `k` is the customer link token of this repair order. */
  isCustomerToken(roId: string, k: string): boolean;
}

/** The page routes and /web/* files. The HTML is read once, here: a missing file stops the app at start. */
export function mountPages(app: Hono, o: PagesOptions): void {
  const read = (file: string) => readFileSync(join(WEB_DIR, file), "utf8");
  const s2 = read("s2.html");
  const marker = 'data-mode="desk"';
  if (!s2.includes(marker)) throw new Error(`web/s2.html: the body has no ${marker}`);
  const judge = read("judge.html");
  if (!judge.includes('data-screen="judge"')) throw new Error('web/judge.html: the body has no data-screen="judge"');
  const html = { start: s2.replace(marker, 'data-mode="start"'), s2, pickup: read("s2-pickup.html"), s1: read("s1.html"), s3: read("s3.html"), judge };

  const send = (c: Context, body: string, status: 200 | PageStatus = 200) => {
    c.header("Cache-Control", "no-store");
    c.header("Content-Security-Policy", PAGE_CSP);
    c.header("X-Content-Type-Options", "nosniff");
    // The customer link carries its token: never pass the address on (fonts, PayPal).
    c.header("Referrer-Policy", "same-origin");
    return c.html(body, status);
  };

  /** Runs the access check of a page; a refusal becomes an HTML page with the same status and no data. */
  const guarded = async (c: Context, kind: PageKind, pick: (roId: string) => Promise<string>) => {
    const roId = c.req.param("roId") ?? "";
    try {
      if (!ID.test(roId)) throw new CoreError("VALIDATION", "not a valid id");
      return send(c, await pick(roId));
    } catch (e) {
      let status: PageStatus | null = null;
      if (e instanceof HttpError && (e.status === 401 || e.status === 403)) status = e.status;
      else if (e instanceof CoreError && e.code === "NOT_FOUND") status = 404;
      else if (e instanceof CoreError && e.code === "VALIDATION") status = 400;
      const text = status === null ? undefined : MESSAGES[kind][status];
      if (status === null || text === undefined) throw e;
      return send(c, errorPage(text), status);
    }
  };

  app.get("/", (c) => send(c, html.start));

  // The judge page holds no data either: web/judge.js opens a judge session (only when the browser has none) and reads
  // the pool through /api/judge/*.
  app.get("/judge", (c) => send(c, html.judge));

  app.get("/desk/:roId", (c) =>
    guarded(c, "desk", async (roId) => {
      await o.requireDeskOrJudge(c, roId);
      const ro = await loadRepairOrder(o.db, roId);
      return ro.status === "picked_up" || c.req.query("view") === "pickup" ? html.pickup : html.s2;
    }),
  );

  app.get("/mechanic/:roId", (c) =>
    guarded(c, "desk", async (roId) => {
      await o.requireDeskOrJudge(c, roId);
      await loadRepairOrder(o.db, roId);
      return html.s3;
    }),
  );

  app.get("/c/:roId", (c) =>
    guarded(c, "customer", async (roId) => {
      const k = c.req.query("k");
      if (k !== undefined) {
        if (!o.isCustomerToken(roId, k)) throw new HttpError(403, "FORBIDDEN", "not this repair order's customer link");
        await loadRepairOrder(o.db, roId);
        return html.s1;
      }
      // PayPal's return redirect carries no token (docs/api.md): the page takes `k` from the tab it was opened in.
      // The HTML holds no data, and every API call still needs `k`.
      if (c.req.query("paypal") !== undefined) return html.s1;
      throw new HttpError(403, "FORBIDDEN", "the customer link token is missing");
    }),
  );

  const assets = serveStatic({ root: WEB_DIR, rewriteRequestPath: (p) => p.slice("/web".length) });
  app.use("/web/*", async (c, next) => {
    if (!ASSET.test(c.req.path)) return next();
    // A missing file falls through to the JSON 404; only a served file gets the cache headers.
    const res = await assets(c, next);
    if (res instanceof Response && res.ok) {
      res.headers.set("Cache-Control", "public, max-age=300");
      res.headers.set("X-Content-Type-Options", "nosniff");
    }
    return res;
  });
}
