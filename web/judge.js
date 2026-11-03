// Line by Line judge page (/judge): the texts of step 1 and the functions that turn the judge API (docs/api.md,
// "Judge mode") into screen values. The look of the page waits for the choice of its image (rule 81), so this file
// is the data layer only: pure view functions plus a thin client over any `request(method, path, body)` that answers
// `{status, json}` (the browser's fetch with the judge cookie, or the app itself in test/web/judge.test.ts).
// No libraries and no build step.
import { money, timeText } from "./app.js";

const DAY_MS = 86_400_000;

/**
 * Florida's written-estimate statement, word for word from Fla. Stat. 559.905(2) (checked against the statute on
 * flsenate.gov on 2026-11-03) and the same words as the customer page (s1.html). The statute asks for capital letters
 * of at least 12-point type, which is 16px on screen; SIGNED and DATE are part of the statement.
 */
export const FL_STATEMENT = {
  heading: "PLEASE READ CAREFULLY, CHECK ONE OF THE STATEMENTS BELOW, AND SIGN:",
  understand: "I UNDERSTAND THAT, UNDER STATE LAW, I AM ENTITLED TO A WRITTEN ESTIMATE IF MY FINAL BILL WILL EXCEED $150.",
  choices: [
    { value: "written", text: "I REQUEST A WRITTEN ESTIMATE." },
    {
      value: "limit",
      before: "I DO NOT REQUEST A WRITTEN ESTIMATE AS LONG AS THE REPAIR COSTS DO NOT EXCEED $",
      after: ". THE SHOP MAY NOT EXCEED THIS AMOUNT WITHOUT MY WRITTEN OR ORAL APPROVAL.",
    },
    { value: "none", text: "I DO NOT REQUEST A WRITTEN ESTIMATE." },
  ],
  signed: "SIGNED",
  date: "DATE",
  source: "Fla. Stat. 559.905(2)",
  minFontPx: 16,
};

/** Step 1 of the judge page. The e-records sentence is the customer page's (s1.html). */
export const STEP1 = {
  title: "Your own approval",
  intro:
    "You play the customer. The demo repair order is a $412.00 estimate of four price-list lines. You approve it in the PayPal sandbox with your own sandbox buyer, the Personal account in your developer dashboard. No real money moves.",
  esign: "I agree to receive and sign this estimate and my approvals electronically (Fla. Stat. 668.50).",
  start: "Start a demo repair order",
  approve: "Approve with your PayPal sandbox buyer",
};

/** The consent record POST /api/judge/demo takes; throws with a message for the screen when something is missing. */
export function consentBody(name, esignChecked) {
  const approverName = String(name ?? "").trim();
  if (!esignChecked) throw new Error("agree to electronic records first (the box above)");
  if (!approverName) throw new Error("type your name to sign");
  if (approverName.length > 200) throw new Error("the name is longer than 200 characters");
  return { approverName, channel: "link", esignConsent: true };
}

/** A PayPal authorization id as the Live GET box accepts it: 17 capital letters and digits. */
export function isAuthorizationId(text) {
  return /^[A-Z0-9]{17}$/.test(String(text ?? "").trim());
}

/** "Nov 27" in the viewer's time zone (tests pass one). */
export function dateText(iso, timeZone) {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone });
}

/** The reauthorize window of a pool hold at `now` (ms): open until its expiry, opening later, or closed. */
export function windowText(w, now, timeZone) {
  if (w.open) return w.closesAt ? `open until ${dateText(w.closesAt, timeZone)}` : "open";
  const opens = Date.parse(w.opensAt);
  if (opens > now) {
    const days = Math.ceil((opens - now) / DAY_MS);
    return days > 1 ? `opens in ${days} days` : `opens ${timeText(w.opensAt, timeZone)}`;
  }
  return "closed";
}

/** Status pill of a pool hold; `tone` picks the colour: go (free now), done, wait, muted. */
export function holdStatus(h) {
  if (h.reauthorized) return { status: "Reauthorized", tone: "done" };
  if (h.available) return { status: "Available", tone: "go" };
  if (h.purpose === "reserved") return { status: "Reserved", tone: "muted" };
  if (String(h.reason ?? "").startsWith("too young")) return { status: "Not yet", tone: "wait" };
  return { status: "Not available", tone: "muted" };
}

/** GET /api/judge/pool -> the rows of the pool, oldest first as the server sends them. */
export function poolView(answer, now, timeZone) {
  const rows = (answer?.holds ?? []).map((h) => ({
    id: h.authorizationId,
    label: h.label,
    amount: money(h.amountCents),
    age: `${h.ageDays} ${h.ageDays === 1 ? "day" : "days"}`,
    window: windowText(h.window, now, timeZone),
    ...holdStatus(h),
    available: h.available,
    reason: h.available ? null : h.reason,
    live: h.live?.status ?? null,
    liveError: h.liveError,
    expires: h.expirationTime ? dateText(h.expirationTime, timeZone) : null,
    newId: h.reauthorized?.newId ?? null,
  }));
  return { rows, available: rows.filter((r) => r.available).length };
}

/** Within a minute counts as the same expiry: PayPal gives the new id the parent's expiry plus a second (findings 4, 15). */
function sameExpiry(a, b) {
  return Boolean(a && b) && Math.abs(Date.parse(a) - Date.parse(b)) <= 60_000;
}

/** POST /api/judge/pool/reauthorize-next (200) -> the result card. `parentExpiry` comes from the pool listing. */
export function reauthView(r, parentExpiry, timeZone) {
  const expires = r.live?.expirationTime ?? r.expirationTime;
  return {
    label: r.label,
    oldId: r.parentId,
    newId: r.newId,
    amount: money(r.amountCents),
    status: r.live?.status ?? null,
    liveError: r.liveError,
    expires: expires ? dateText(expires, timeZone) : null,
    sameExpiry: parentExpiry ? sameExpiry(expires, parentExpiry) : null,
  };
}

/**
 * The result card of a reauthorized pool hold, from its row in GET /api/judge/pool: the two ids, and the small timeline
 * on one scale from the hold's first authorization to its expiry. The new id's bar starts at the reauthorization and
 * ends where PayPal says the new id expires (the parent's expiry plus a second: no new 29 days).
 */
export function resultCard(h, timeZone) {
  const r = h.reauthorized;
  const created = Date.parse(h.createdAt);
  const end = r.expirationTime ?? h.expirationTime;
  const span = Date.parse(end) - created;
  const at = r.at ? Date.parse(r.at) : created;
  const pct = (t) => Math.min(100, Math.max(0, span > 0 ? ((t - created) / span) * 100 : 0));
  const same = sameExpiry(r.expirationTime, h.expirationTime);
  const round = (x) => Math.round(x * 10) / 10;
  return {
    oldId: h.authorizationId,
    newId: r.newId,
    amount: money(h.amountCents),
    status: r.live?.status ?? null,
    startDate: dateText(h.createdAt, timeZone),
    endDate: end ? dateText(end, timeZone) : null,
    newStartDate: r.at ? dateText(r.at, timeZone) : null,
    barOld: { left: 0, width: round(pct(Date.parse(h.expirationTime ?? end))) },
    barNew: { left: round(pct(at)), width: round(pct(Date.parse(end)) - pct(at)) },
    note: same ? "same end date · no new 29 days" : `new id expires ${end ? dateText(end, timeZone) : "(not read)"}`,
  };
}

/** The pool row that is the hold a reauthorize answer (or a POOL_EMPTY's last) is about. */
export function holdOf(poolAnswer, parentId) {
  return (poolAnswer?.holds ?? []).find((h) => h.authorizationId === parentId && h.reauthorized) ?? null;
}

/** "1:58:12" until the judge session ends; "0:00:00" once it has. */
export function sessionLeft(expiresAt, now) {
  const s = Math.max(0, Math.floor((Date.parse(expiresAt) - now) / 1000));
  return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/** A refused reauthorize-next -> what the page says instead of the card. */
export function reauthRefusal(status, json, timeZone) {
  const code = json?.code ?? "";
  if (status === 409 && code === "POOL_EMPTY") {
    const l = json.details?.lastReauthorized ?? null;
    return {
      code,
      message: "No free hold right now. This is the hold reauthorized last:",
      last: l && { label: l.label, oldId: l.parentId, newId: l.newId, amount: money(l.amountCents), status: l.live?.status ?? null, expires: l.expirationTime ? dateText(l.expirationTime, timeZone) : null },
    };
  }
  if (status === 409 && code === "ALREADY_USED") return { code, message: "This session has used its reauthorization. Start a new session to do it again.", last: null };
  return { code: code || String(status), message: `${code || status}: ${json?.error ?? "the request failed"}`, last: null };
}

/** GET /api/authorizations/:id -> the Live GET answer: PayPal's status and whether it agrees with our record. */
export function liveGetView(answer, timeZone) {
  const live = answer.live;
  return {
    id: answer.authorization.id,
    status: live.status,
    amount: money(live.amountCents),
    captured: money(live.capturedCents),
    expires: live.expirationTime ? dateText(live.expirationTime, timeZone) : null,
    matches: answer.ok === true && answer.diffs.length === 0,
    diffs: answer.diffs.map((d) => `${d.field}: ours ${d.db ?? "none"}, PayPal ${d.paypal ?? "none"}`),
  };
}

// ---------- the client: any request(method, path, body) -> {status, json} ----------

/** The error a refused request throws: "CODE: message", with the status and the JSON body attached. */
function requestError(r) {
  const e = new Error(`${r.json?.code ?? r.status}: ${r.json?.error ?? "the request failed"}`);
  e.status = r.status;
  e.json = r.json;
  return e;
}

async function ok(request, method, path, body) {
  const r = await request(method, path, body);
  if (r.status >= 200 && r.status < 300) return r.json;
  throw requestError(r);
}

/** Session if there is none yet (401), then the demo repair order with the judge's consent. */
export async function startDemo(request, consent) {
  let r = await request("POST", "/api/judge/demo", consent);
  if (r.status === 401) {
    await ok(request, "POST", "/api/judge/session");
    r = await request("POST", "/api/judge/demo", consent);
  }
  if (r.status !== 201) throw requestError(r);
  return { roId: r.json.roId, approveUrl: r.json.approveUrl, customerUrl: r.json.customerUrl, order: r.json.order };
}

export async function loadPool(request, now, timeZone) {
  const answer = await ok(request, "GET", "/api/judge/pool");
  return { answer, view: poolView(answer, now, timeZone) };
}

/** Reauthorize the next free hold; a refusal comes back as `{refused}`, not as an exception. */
export async function reauthorizeNext(request, poolAnswer, timeZone) {
  const r = await request("POST", "/api/judge/pool/reauthorize-next");
  if (r.status !== 200) return { refused: reauthRefusal(r.status, r.json, timeZone) };
  const parent = (poolAnswer?.holds ?? []).find((h) => h.authorizationId === r.json.parentId);
  return { card: reauthView(r.json, parent?.expirationTime ?? null, timeZone) };
}

/** A pool hold (or the new id of one) as Live GET shows it: GET /api/judge/pool reads each of them at PayPal. */
export function poolLiveView(h, id, timeZone) {
  const child = h.reauthorized && h.reauthorized.newId === id ? h.reauthorized : null;
  const live = child ? child.live : h.live;
  const expires = live?.expirationTime ?? (child ? child.expirationTime : h.expirationTime);
  return {
    id,
    status: live?.status ?? null,
    amount: money(h.amountCents),
    captured: null,
    expires: expires ? dateText(expires, timeZone) : null,
    matches: null,
    diffs: [],
    liveError: (child ? child.liveError : h.liveError) ?? null,
    source: "pool",
  };
}

/**
 * Live GET of an id. A judge may read through GET /api/authorizations/:id only the holds of repair orders made in
 * their own session; the pool's holds and their new ids are read through GET /api/judge/pool, which asks PayPal for
 * each of them.
 */
export async function liveGet(request, id, timeZone) {
  const clean = String(id ?? "").trim();
  if (!isAuthorizationId(clean)) throw new Error("a PayPal authorization id is 17 capital letters and digits");
  const pool = await ok(request, "GET", "/api/judge/pool");
  const h = (pool?.holds ?? []).find((x) => x.authorizationId === clean || x.reauthorized?.newId === clean);
  if (h) return poolLiveView(h, clean, timeZone);
  return { ...liveGetView(await ok(request, "GET", `/api/authorizations/${clean}`), timeZone), liveError: null, source: "authorization" };
}

/** The browser's request: same origin, the judge cookie travels by itself. */
export function browserRequest(method, path, body) {
  return fetch(path, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (res) => {
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: res.status, json };
  });
}
