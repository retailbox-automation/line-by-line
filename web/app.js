// Line by Line screens: s1.html (customer phone), s2.html (service desk), s2-pickup.html (desk at pickup), s3.html
// (mechanic phone). The server sends the HTML without any repair order data; this file reads GET /api/ro/:id and
// fills `data-field` (values) and `data-slot` (grey bars that become text where the data has it), then wires the
// buttons to the API (docs/api.md). No libraries and no build step.
// The functions that turn API data into screen values are pure and exported (test/web/app.test.ts); the browser part
// at the bottom only applies them. The desk and mechanic screens ride on the judge session cookie; the customer page
// sends its own link token `k`. No other credential ever reaches this file.

// ---------- money, ids, text ----------

/** 41200 -> "$412.00", 123456 -> "$1,234.56". */
export function money(cents) {
  const c = Math.abs(Math.round(cents));
  const dollars = String(Math.floor(c / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${cents < 0 ? "-" : ""}$${dollars}.${String(c % 100).padStart(2, "0")}`;
}

/** "charged $0" as on the reference screens; any other amount with cents. */
export function chargedMoney(cents) {
  return cents === 0 ? "$0" : money(cents);
}

/** Dollars typed by the desk ("186", "186.5", "$186.50") -> whole cents; null when it is not an amount. */
export function parseDollars(text) {
  const m = /^\$?\s*(\d{1,7})(?:\.(\d{1,2}))?$/.exec(String(text).trim());
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
}

/**
 * The Florida statement the customer checked (Fla. Stat. 559.905(2)) as the consent record takes it; the "limit"
 * statement needs the dollar amount typed into it. null when nothing is checked.
 */
export function flChoiceOf(value, limitText) {
  if (!value) return null;
  if (value === "written" || value === "none") return { flChoice: value };
  if (value !== "limit") throw new ApiError(0, "CONSENT", "unknown Florida statement");
  const cents = parseDollars(limitText ?? "");
  if (!cents) throw new ApiError(0, "CONSENT", "type the dollar amount in the statement you checked");
  return { flChoice: "limit", flLimitCents: cents };
}

/** The short order number the screens show: the last 6 characters of the repair order id. */
export function shortId(roId) {
  return String(roId).replace(/^ro_/, "").slice(-6).toUpperCase();
}

/** "Nov 2, 3:00 PM" in the viewer's time zone (tests pass one). */
export function timeText(iso, timeZone) {
  return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone });
}

/** 6.4 seconds -> "0:06". */
export function durationText(seconds) {
  const t = Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds) : 0;
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
}

/** The repair order id of a screen address (/desk/:id, /c/:id, /mechanic/:id); null otherwise. */
export function roIdFromPath(pathname) {
  return /^\/(?:desk|c|mechanic)\/([A-Za-z0-9_-]{1,64})$/.exec(pathname)?.[1] ?? null;
}

/** Only PayPal's own pages are opened from an approval button. */
export function isPayPalUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && (u.hostname === "paypal.com" || u.hostname.endsWith(".paypal.com"));
  } catch {
    return false;
  }
}

export const URGENCY = { safety: "Safety", soon: "Soon", can_wait: "Can wait" };

// Demo pictures exist for these price-list items only; any other line gets a plain box, never another part's photo.
const S1_THUMB = { "BRK-ROT-F": "/web/assets-s1/thumb-rotor.png", "BRK-ROT-R": "/web/assets-s1/thumb-rotor.png", "FLT-CABIN": "/web/assets-s1/thumb-cabin-filter.png" };
const S1_PHOTO = { "BRK-ROT-F": "/web/assets-s1/photo-brake-rotor.png", "BRK-ROT-R": "/web/assets-s1/photo-brake-rotor.png" };
const S3_THUMB = { "BRK-ROT-F": "/web/assets-s3/rotors-thumb.png", "BRK-ROT-R": "/web/assets-s3/rotors-thumb.png" };
const S3_PHOTO = { "BRK-ROT-F": "/web/assets-s3/brake-rotor-photo.png", "BRK-ROT-R": "/web/assets-s3/brake-rotor-photo.png" };

// ---------- repair order -> rows ----------

const APPROVED = new Set(["approved", "performed", "not_performed"]);
const COUNTED = new Set(["COMPLETED", "PENDING"]);
const liveOrder = (o) => o.supersededBy === null && o.status !== "CANCELLED";

/**
 * One row per PayPal hold, the way the desk reads the order: the estimate (all estimate lines), then each added
 * line, or the lines one approval order carries together. A line without a live order is a row of its own.
 * `status`: authorized (a hold exists), pending (waiting for the customer), declined, or not_billed (picked up
 * without an approval). Money: `cents` = the lines, `held` = the hold, `charged` = completed captures, `released`
 * = held minus charged once PayPal settled the hold (voided or fully captured).
 */
export function rowsOf(state) {
  const orderOf = (lineId) => {
    let found = null;
    for (const o of state.orders) if (liveOrder(o) && o.lineIds.includes(lineId)) found = o;
    return found;
  };
  const groups = [];
  const estimate = state.lines.filter((l) => l.kind === "estimate");
  if (estimate.length) groups.push({ kind: "estimate", order: orderOf(estimate[0].id), lines: estimate });
  const byOrder = new Map();
  for (const line of state.lines.filter((l) => l.kind === "added")) {
    const order = orderOf(line.id);
    const same = order ? byOrder.get(order.id) : undefined;
    if (same) {
      same.lines.push(line);
      continue;
    }
    const g = { kind: "added", order, lines: [line] };
    if (order) byOrder.set(order.id, g);
    groups.push(g);
  }
  const parents = state.authorizations.filter((a) => a.parentId === null);
  const pickedUp = state.repairOrder.status === "picked_up";
  return groups.map((g) => {
    const auths = g.order ? state.authorizations.filter((a) => a.paypalOrderId === g.order.id) : [];
    const parent = auths.find((a) => a.parentId === null) ?? null;
    const ids = new Set(auths.map((a) => a.id));
    const captures = state.captures.filter((c) => ids.has(c.authorizationId) && COUNTED.has(c.status));
    const cents = g.lines.reduce((s, l) => s + l.priceCents, 0);
    const held = parent ? parent.amountCents : cents;
    const charged = captures.reduce((s, c) => s + c.amountCents, 0);
    const settled = auths.some((a) => a.status === "VOIDED" || a.status === "CAPTURED");
    let status = "pending";
    if (g.lines.every((l) => l.status === "declined")) status = "declined";
    else if (parent) status = "authorized";
    else if (pickedUp) status = "not_billed";
    return {
      key: g.order ? g.order.id : g.lines[0].id,
      kind: g.kind,
      title: g.kind === "estimate" ? "Estimate" : g.lines.map((l) => l.title).join(" + "),
      lines: g.lines,
      order: g.order,
      parent,
      captures,
      cents,
      held,
      charged,
      released: settled ? Math.max(0, held - charged) : 0,
      settled,
      status,
      seq: parent ? parents.indexOf(parent) + 1 : null,
    };
  });
}

// ---------- S2: service desk ----------

const PILL = { authorized: "ok", pending: "wait", declined: "no", not_billed: "no" };
const PILL_TEXT = { ok: "AUTHORIZED", wait: "APPROVAL PENDING", no: "Not billed" };

/** The Florida panel from the API's `fl` (Fla. Stat. 559.909; computed by the server, explained here). */
export function flPanel(fl) {
  if (!fl) return { toleranceLabel: "Tolerance", tolerance: "—", max: "—", newTotal: "—", over: false, verdict: "The Florida rule applies to Florida repair orders" };
  const base = fl.toleranceBaseCents;
  const of = fl.approvedTotalCents > 0 ? "approved total" : "estimate";
  const toleranceLabel = fl.toleranceCents === Math.floor(base / 10) ? `10% of ${of}` : fl.toleranceCents === 1000 ? "$10 minimum" : "$50 maximum";
  const common = { toleranceLabel, tolerance: money(fl.toleranceCents), max: money(fl.ceilingCents) };
  if (fl.pendingTotalCents === 0) return { ...common, newTotal: money(base), over: false, verdict: "No new work is waiting for approval" };
  const total = base + fl.pendingTotalCents;
  if (fl.pendingExceedsTolerance) return { ...common, newTotal: money(total), over: true, verdict: `${money(total)} > ${money(fl.ceilingCents)} → customer consent required` };
  return { ...common, newTotal: money(total), over: false, verdict: `${money(total)} ≤ ${money(fl.ceilingCents)} → within the tolerance` };
}

/** Everything the desk screen shows for one repair order. */
export function deskView(state, timeZone) {
  const id = shortId(state.repairOrder.id);
  return {
    title: `Line by Line — Service desk · Order #${id}`,
    fields: { "order-id": `#${id}` },
    slots: { "order-opened": `Opened ${timeText(state.repairOrder.createdAt, timeZone)}`, customer: state.repairOrder.customerLabel },
    rows: rowsOf(state).map((r, i) => {
      const pill = PILL[r.status];
      return { no: String(i + 1), desc: r.title, amount: money(r.cents), pill, pillText: PILL_TEXT[pill], pillTitle: pill === "no" ? "Not billed — no PayPal order" : PILL_TEXT[pill] };
    }),
    fl: flPanel(state.fl ?? null),
    customerUrl: state.customerUrl ?? null,
    pickedUp: state.repairOrder.status === "picked_up",
    // The pickup form: every approved line, prefilled with what the customer approved.
    pickupLines: state.lines.filter((l) => l.status === "approved").map((l) => ({ lineId: l.id, title: l.title, approvedCents: l.priceCents, value: (l.priceCents / 100).toFixed(2) })),
  };
}

/** The pickup form -> POST /api/ro/:id/pickup body; `error` names the first amount that is not one. */
export function pickupBody(entries) {
  const performed = [];
  for (const e of entries) {
    const cents = parseDollars(e.value);
    if (cents === null) return { error: `${e.title}: "${e.value}" is not an amount in dollars` };
    performed.push({ lineId: e.lineId, performedCents: cents });
  }
  return { body: { performed } };
}

/** Holds of a pickup answer that did not finish (anything but done / nothing_to_do), as text for the desk. */
export function pickupProblems(result) {
  const out = result.authorizations
    .filter((a) => a.outcome !== "done" && a.outcome !== "nothing_to_do")
    .map((a) => `PayPal hold ${a.authorizationId}: ${a.outcome}${a.reason ? ` — ${a.reason}` : ""}`);
  if (result.stopped) out.push(`Pickup stopped: ${typeof result.stopped === "string" ? result.stopped : JSON.stringify(result.stopped)}`);
  return out;
}

// ---------- S2: pickup state ----------

/** The pickup screen: money bars per hold, the invoice check, totals and PayPal's capture ids and fees. */
export function pickupView(state, timeZone) {
  const id = shortId(state.repairOrder.id);
  const pickedUp = state.repairOrder.status === "picked_up";
  const rows = rowsOf(state);
  const captures = rows.flatMap((r) => r.captures);
  const total = captures.reduce((s, c) => s + c.amountCents, 0);
  const fees = captures.filter((c) => c.feeCents !== null).map((c) => money(c.feeCents));
  const nets = captures.filter((c) => c.netCents !== null);
  const last = captures.at(-1);
  return {
    title: `Line by Line — Service desk · Order #${id} · Pickup`,
    pickedUp,
    fields: {
      "order-id": `#${id}`,
      "invoice-total": money(total),
      "paypal-fees": fees.length ? `PayPal fees ${fees.join(" + ")}` : "PayPal fees: no capture",
    },
    slots: {
      "pickup-sub-1": state.repairOrder.customerLabel,
      "pickup-sub-2": last ? `Captured ${timeText(last.createdAt, timeZone)}` : null,
      "invoice-meta-1": nets.length ? `Net ${money(nets.reduce((s, c) => s + c.netCents, 0))}` : null,
      "invoice-meta-2": captures.length ? `PayPal capture ${captures.map((c) => c.id).join(", ")}` : null,
    },
    rows: rows.map((r) => {
      const billed = r.status === "authorized";
      const label = r.kind === "estimate" ? "Estimate work" : r.title;
      return {
        billed,
        desc: r.title,
        amount: money(r.held),
        auth: r.parent ? `PayPal authorization ${r.seq}` : "no PayPal order",
        chargedText: `charged ${money(r.charged)}`,
        chargedShare: r.held > 0 ? Math.min(1, r.charged / r.held) : 0,
        released: r.released > 0 ? `released ${money(r.released)}` : billed && !r.settled ? `held ${money(r.held - r.charged)}` : null,
        match: `${label} · ${billed ? money(r.charged) : "not billed"}`,
      };
    }),
    // Picked up, but PayPal has not settled a hold (a capture without an answer): the desk sends the same pickup again.
    unsettled: pickedUp ? rows.filter((r) => r.status === "authorized" && !r.settled).map((r) => `PayPal hold ${r.parent.id} is not settled yet`) : [],
    retry: { performed: state.lines.filter((l) => l.performedCents !== null).map((l) => ({ lineId: l.id, performedCents: l.performedCents })) },
  };
}

// ---------- S1: customer page ----------

/** The customer page: the estimate, a card per added line, totals, and whether the disclosure is still due. */
export function customerView(state, timeZone) {
  const rows = rowsOf(state);
  const open = state.repairOrder.status === "open";
  const est = rows.find((r) => r.kind === "estimate") ?? null;
  const approvedCents = state.lines.filter((l) => APPROVED.has(l.status)).reduce((s, l) => s + l.priceCents, 0);
  const firstApprovalDone = state.lines.some((l) => APPROVED.has(l.status));
  const esign = state.consents.filter((c) => c.esignConsent).at(-1) ?? null;
  const confirming = (r) => r.order !== null && r.order.status === "APPROVED" && r.parent === null;
  const word = !est ? "no estimate" : est.parent ? (est.settled ? "settled" : "held") : confirming(est) ? "confirming" : "awaiting approval";
  const id = shortId(state.repairOrder.id);
  let addedNo = 0;
  return {
    title: `Line by Line — Order #${id}`,
    fields: {
      "order-id": id,
      "estimate-amount": est ? money(est.cents) : "—",
      "estimate-status": word,
      "estimate-charged": chargedMoney(est ? est.charged : 0),
      "approved-total": money(approvedCents),
      "charged-so-far": chargedMoney(rows.reduce((s, r) => s + r.charged, 0)),
    },
    slots: { "consent-text": firstApprovalDone && esign ? `You agreed to electronic records on ${timeText(esign.decidedAt, timeZone)}` : null },
    estimate: est && {
      needsApproval: open && est.parent === null && !confirming(est),
      confirming: confirming(est),
      // A live link waiting for the customer is refreshed (cheap while fresh) instead of making a second order.
      orderId: est.order && est.order.status === "PAYER_ACTION_REQUIRED" ? est.order.id : null,
    },
    needsDisclosure: open && !firstApprovalDone,
    estimateRequired: Boolean(state.fl && state.fl.estimateRequired),
    approverName: state.consents.at(-1)?.approverName ?? "",
    cards: rows
      .filter((r) => r.kind === "added")
      .flatMap((r) =>
        r.lines.map((l) => {
          addedNo += 1;
          let kind;
          if (APPROVED.has(l.status) && r.parent) kind = "approved";
          else if (l.status === "declined" || !open) kind = "declined";
          else if (confirming(r)) kind = "confirming";
          else kind = "pending";
          return {
            lineId: l.id,
            kind,
            title: l.title,
            price: money(l.priceCents),
            urgency: l.urgency ? URGENCY[l.urgency] : null,
            // The red chip is for safety; anything else uses the grey "Can wait" chip of the design.
            chip: l.urgency === "safety" ? "safety" : "wait",
            message: l.description && l.description !== l.title ? l.description : null,
            thumb: S1_THUMB[l.priceCode] ?? null,
            photo: S1_PHOTO[l.priceCode] ?? null,
            avatar: addedNo % 2 === 1 ? "/web/assets-s1/avatar-mechanic-1.png" : "/web/assets-s1/avatar-mechanic-2.png",
            authSeq: r.seq,
            orderId: kind === "pending" && r.order && r.order.status === "PAYER_ACTION_REQUIRED" ? r.order.id : null,
            canDecline: kind === "pending" && r.order === null,
          };
        }),
      ),
  };
}

/** What the page says after PayPal sent the customer back (`?paypal=…`). */
export function returnNotice(params) {
  switch (params.get("paypal")) {
    case "approved":
      return { note: "Approved in PayPal. The money is held, not charged; the shop charges only the work it does." };
    case "pending":
      return { note: "PayPal is still confirming your approval. This page updates by itself." };
    case "cancelled":
      return { note: "You cancelled on PayPal. Nothing was approved; you can decide again." };
    case "error":
      return { error: `PayPal did not confirm (${params.get("code") ?? "unknown"}). The page shows the current state.` };
    default:
      return null;
  }
}

// ---------- S3: mechanic phone ----------

/** Draft lines of a voice note as cards; prices come from the shop list (the server's answer), never from the screen. */
export function draftView(draft) {
  return {
    transcript: draft.transcript,
    cards: draft.lines.map((l) => ({
      priceCode: l.priceCode,
      part: l.name,
      price: money(l.cents),
      urgency: l.urgency ? URGENCY[l.urgency] : "No urgency",
      urgencyKind: l.urgency ?? "none",
      detail: l.customerText && l.customerText !== l.name ? l.customerText : null,
      thumb: S3_THUMB[l.priceCode] ?? null,
      body: { priceCode: l.priceCode, source: "mechanic", urgency: l.urgency ?? null, description: l.customerText ?? "" },
    })),
    photo: draft.lines.map((l) => S3_PHOTO[l.priceCode]).find(Boolean) ?? null,
    note: [
      draft.lines.length === 0 ? "No item of the shop's price list matches this note." : null,
      draft.droppedCodes.length ? `Not on the price list, dropped: ${draft.droppedCodes.join(", ")}` : null,
    ].filter(Boolean).join(" ") || null,
  };
}

/** The send button of a line the mechanic already sent, as the customer's decision comes in. */
export function sentState(state, lineId) {
  const line = state.lines.find((l) => l.id === lineId);
  if (!line) return { state: "sent", text: "Sent to customer" };
  if (APPROVED.has(line.status)) return { state: "sent", text: "Approved by the customer" };
  if (line.status === "declined") return { state: "sent", text: "Customer said not now" };
  return { state: "sent", text: "Sent to customer" };
}

// ---------- filling the HTML ----------

/**
 * Sets the text of every `[data-field]` (or `[data-slot]`) whose name is in `values`. A slot with a value becomes
 * text (class slot-filled); a slot whose value is null stays the grey bar of the design.
 */
export function applyFields(root, values, attr = "data-field") {
  for (const el of root.querySelectorAll(`[${attr}]`)) {
    const name = el.getAttribute(attr);
    if (!Object.hasOwn(values, name)) continue;
    const v = values[name];
    if (v === null || v === undefined) {
      if (attr === "data-slot" && el.classList.contains("slot-filled")) {
        el.textContent = "";
        el.classList.remove("slot-filled");
      }
      continue;
    }
    el.textContent = String(v);
    if (attr === "data-slot") el.classList.add("slot-filled");
  }
}

/** One readable line for a failed call: code, HTTP status and the server's text. */
export function errorText(e) {
  if (e && typeof e === "object" && "code" in e && "status" in e) return `${e.code}${e.status ? ` (HTTP ${e.status})` : ""}: ${e.message}`;
  return `ERROR: ${e instanceof Error ? e.message : String(e)}`;
}

// ---------- QR code (byte mode, error correction M, versions 1–10) ----------

const QR_ECC_PER_BLOCK = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
const QR_BLOCKS = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];

function qrRawModules(ver) {
  let n = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const align = Math.floor(ver / 7) + 2;
    n -= (25 * align - 10) * align - 55;
    if (ver >= 7) n -= 36;
  }
  return n;
}

const qrDataCodewords = (ver) => Math.floor(qrRawModules(ver) / 8) - QR_ECC_PER_BLOCK[ver] * QR_BLOCKS[ver];

function gfMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

function rsDivisor(degree) {
  const out = new Array(degree).fill(0);
  out[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      out[j] = gfMul(out[j], root);
      if (j + 1 < degree) out[j] ^= out[j + 1];
    }
    root = gfMul(root, 2);
  }
  return out;
}

function rsRemainder(data, divisor) {
  const out = divisor.map(() => 0);
  for (const b of data) {
    const factor = b ^ out.shift();
    out.push(0);
    divisor.forEach((coef, i) => (out[i] ^= gfMul(coef, factor)));
  }
  return out;
}

/** Penalty of a masked matrix (the four rules of the standard); the mask with the lowest one is used. */
function qrPenalty(m) {
  const size = m.length;
  let score = 0;
  const lines = (get) => {
    for (let a = 0; a < size; a++) {
      let run = 0;
      let color = false;
      const hist = [0, 0, 0, 0, 0, 0, 0];
      const push = (len) => {
        if (hist[0] === 0) len += size; // the light border before the first run
        hist.pop();
        hist.unshift(len);
      };
      const finder = () => {
        const n = hist[1];
        const core = n > 0 && hist[2] === n && hist[3] === n * 3 && hist[4] === n && hist[5] === n;
        return (core && hist[0] >= n * 4 && hist[6] >= n ? 1 : 0) + (core && hist[6] >= n * 4 && hist[0] >= n ? 1 : 0);
      };
      for (let b = 0; b < size; b++) {
        if (get(a, b) === color) {
          run++;
          if (run === 5) score += 3;
          else if (run > 5) score++;
        } else {
          push(run);
          if (!color) score += finder() * 40;
          color = get(a, b);
          run = 1;
        }
      }
      if (color) {
        push(run);
        run = 0;
      }
      push(run + size);
      score += finder() * 40;
    }
  };
  lines((a, b) => m[a][b]);
  lines((a, b) => m[b][a]);
  let dark = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (m[y][x]) dark++;
      if (y < size - 1 && x < size - 1 && m[y][x] === m[y][x + 1] && m[y][x] === m[y + 1][x] && m[y][x] === m[y + 1][x + 1]) score += 3;
    }
  }
  const total = size * size;
  return score + (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
}

/** The module matrix (true = dark) of `text` as UTF-8 bytes; throws when it does not fit version 10 (213 bytes). */
export function qrMatrix(text) {
  const bytes = Array.from(new TextEncoder().encode(text));
  let ver = 1;
  while (ver <= 10 && 4 + (ver < 10 ? 8 : 16) + bytes.length * 8 > qrDataCodewords(ver) * 8) ver++;
  if (ver > 10) throw new Error("the link is too long for the QR code");
  const capBits = qrDataCodewords(ver) * 8;
  const bits = [];
  const put = (v, n) => {
    for (let i = n - 1; i >= 0; i--) bits.push((v >>> i) & 1);
  };
  put(4, 4); // byte mode
  put(bytes.length, ver < 10 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  put(0, Math.min(4, capBits - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capBits; pad ^= 0xec ^ 0x11) put(pad, 8);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));

  // Reed-Solomon blocks, then interleaved.
  const nBlocks = QR_BLOCKS[ver];
  const eccLen = QR_ECC_PER_BLOCK[ver];
  const raw = Math.floor(qrRawModules(ver) / 8);
  const nShort = nBlocks - (raw % nBlocks);
  const shortLen = Math.floor(raw / nBlocks);
  const div = rsDivisor(eccLen);
  const blocks = [];
  for (let i = 0, k = 0; i < nBlocks; i++) {
    const dat = data.slice(k, k + shortLen - eccLen + (i < nShort ? 0 : 1));
    k += dat.length;
    const ecc = rsRemainder(dat, div);
    if (i < nShort) dat.push(0);
    blocks.push(dat.concat(ecc));
  }
  const codewords = [];
  for (let i = 0; i < blocks[0].length; i++) {
    blocks.forEach((blk, j) => {
      if (i !== shortLen - eccLen || j >= nShort) codewords.push(blk[i]);
    });
  }

  const size = ver * 4 + 17;
  const m = Array.from({ length: size }, () => new Array(size).fill(false));
  const fn = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (x, y, dark) => {
    m[y][x] = dark;
    fn[y][x] = true;
  };
  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, d !== 2 && d !== 4);
      }
    }
  }
  if (ver > 1) {
    const n = Math.floor(ver / 7) + 2;
    const step = Math.floor((ver * 8 + n * 3 + 5) / (n * 4 - 4)) * 2;
    const pos = [6];
    for (let p = size - 7; pos.length < n; p -= step) pos.splice(1, 0, p);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(pos[i] + dx, pos[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  }
  const drawFormat = (mask) => {
    let rem = mask; // level M: the two level bits are 00
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const f = ((mask << 10) | rem) ^ 0x5412;
    const bit = (i) => ((f >>> i) & 1) === 1;
    for (let i = 0; i <= 5; i++) set(8, i, bit(i));
    set(8, 7, bit(6));
    set(8, 8, bit(7));
    set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
    set(8, size - 8, true);
  };
  drawFormat(0);
  if (ver >= 7) {
    let rem = ver;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const v = (ver << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const dark = ((v >>> i) & 1) === 1;
      set(size - 11 + (i % 3), Math.floor(i / 3), dark);
      set(Math.floor(i / 3), size - 11 + (i % 3), dark);
    }
  }
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert;
        if (!fn[y][x] && i < codewords.length * 8) {
          m[y][x] = ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) === 1;
          i++;
        }
      }
    }
  }
  const masks = [
    (x, y) => (x + y) % 2 === 0,
    (x, y) => y % 2 === 0,
    (x) => x % 3 === 0,
    (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
    (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
    (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
    (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
  ];
  const applyMask = (k) => {
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fn[y][x] && masks[k](x, y)) m[y][x] = !m[y][x];
  };
  let best = 0;
  let bestScore = Infinity;
  for (let k = 0; k < 8; k++) {
    applyMask(k);
    drawFormat(k);
    const s = qrPenalty(m);
    if (s < bestScore) {
      best = k;
      bestScore = s;
    }
    applyMask(k);
  }
  applyMask(best);
  drawFormat(best);
  return m;
}

/** SVG path of the dark modules with a 4-module quiet zone (viewBox "0 0 size+8 size+8"). */
export function qrPath(m) {
  let d = "";
  m.forEach((row, y) =>
    row.forEach((dark, x) => {
      if (dark) d += `M${x + 4} ${y + 4}h1v1h-1z`;
    }),
  );
  return d;
}

// ---------- browser ----------

class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** One API call. `k` is the customer page's link token; the desk and mechanic screens send the session cookie. */
async function api(method, path, body, k) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (k) headers.authorization = `Bearer ${k}`;
  let res;
  try {
    res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: "same-origin" });
  } catch {
    throw new ApiError(0, "NETWORK", "the server did not answer; check the connection");
  }
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const issue = json?.details?.issues?.[0];
    const where = issue ? ` (${[].concat(issue.path ?? []).join(".")}: ${issue.message})` : "";
    throw new ApiError(res.status, json?.code ?? `HTTP_${res.status}`, `${json?.error ?? res.statusText}${where}`, json?.details);
  }
  return json;
}

const $ = (sel, root = document) => root.querySelector(sel);
let errorFrom = null;

function showError(e, from = "action") {
  const el = $("#lbl-error");
  if (!el) return;
  el.textContent = typeof e === "string" ? e : errorText(e);
  el.hidden = false;
  errorFrom = from;
}

function clearError(from = "action") {
  const el = $("#lbl-error");
  if (el && (from === "action" || errorFrom === from)) el.hidden = true;
}

function showNote(text) {
  const el = $("#lbl-note");
  if (!el) return;
  el.textContent = text ?? "";
  el.hidden = !text;
}

function clone(id) {
  return document.getElementById(id).content.firstElementChild.cloneNode(true);
}

function goPayPal(url) {
  if (!isPayPalUrl(url)) throw new ApiError(0, "BAD_LINK", "the approval link is not a PayPal page");
  location.assign(url);
}

/**
 * Reads the state now and every 5 s and calls `onState` when it changed; stops when access ends (401, 403, 404).
 * Returns a function that reads again at once (after an action).
 */
function poll(fetchState, onState) {
  let lastSig = null;
  let timer = null;
  let running = false;
  let again = false;
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    if (running) {
      again = true;
      return;
    }
    running = true;
    clearTimeout(timer);
    try {
      const state = await fetchState();
      clearError("poll");
      const sig = JSON.stringify(state);
      if (sig !== lastSig) {
        lastSig = sig;
        onState(state);
      }
    } catch (e) {
      showError(e, "poll");
      if (e instanceof ApiError && [401, 403, 404].includes(e.status)) stopped = true;
    }
    running = false;
    if (stopped) return;
    if (again) {
      again = false;
      tick();
      return;
    }
    timer = setTimeout(tick, 5000);
  };
  tick();
  return tick;
}

/** Runs a button's action with the button disabled; errors go to the error line. */
function act(button, fn) {
  return async () => {
    if (button) button.disabled = true;
    clearError();
    try {
      await fn();
    } catch (e) {
      showError(e);
    } finally {
      if (button) button.disabled = false;
    }
  };
}

function setImg(img, src) {
  if (src) {
    img.src = src;
    img.classList.remove("noimg");
  } else {
    img.removeAttribute("src");
    img.classList.add("noimg");
  }
}

// S2 at "/": one button that starts a judge session (if there is none) and a demo repair order.
function initStart() {
  const btn = $("#start-demo");
  btn.addEventListener(
    "click",
    act(btn, async () => {
      const consent = { approverName: "Demo customer", channel: "link", esignConsent: true };
      let r;
      try {
        r = await api("POST", "/api/judge/demo", consent);
      } catch (e) {
        if (!(e instanceof ApiError && e.status === 401)) {
          if (e instanceof ApiError && e.details?.roId) showNote(`The repair order was created (${e.details.roId}); open /desk/${e.details.roId} and ask for the approval again.`);
          throw e;
        }
        await api("POST", "/api/judge/session");
        r = await api("POST", "/api/judge/demo", consent);
      }
      location.assign(`/desk/${encodeURIComponent(r.roId)}`);
    }),
  );
}

function initDesk() {
  if (document.body.dataset.mode === "start") return initStart();
  const roId = roIdFromPath(location.pathname);
  if (!roId) return showError("No repair order in the address.");
  let view = null;
  const lines = $(".lines");
  const render = () => {
    document.title = view.title;
    applyFields(document, view.fields);
    applyFields(document, view.slots, "data-slot");
    lines.querySelectorAll(".gen").forEach((el) => el.remove());
    view.rows.forEach((r, i) => {
      // The table is one CSS grid: a row is five cells appended to it.
      const cells = [...clone("tpl-desk-row").children];
      const [no, desc, amount, status] = cells;
      const n = i + 1;
      no.dataset.field = `line-no-${n}`;
      no.textContent = r.no;
      desc.dataset.field = `line-desc-${n}`;
      desc.textContent = r.desc;
      desc.title = r.desc;
      amount.dataset.field = `line-amount-${n}`;
      amount.textContent = r.amount;
      const pill = clone(`tpl-pill-${r.pill}`);
      pill.dataset.field = `line-status-${n}`;
      pill.title = r.pillTitle;
      pill.querySelector("span").textContent = r.pillText;
      status.appendChild(pill);
      for (const cell of cells) {
        cell.classList.add("gen");
        if (i % 2 === 1) cell.classList.add("alt");
        lines.appendChild(cell);
      }
    });
    lines.style.gridTemplateRows = `55px ${view.rows.map(() => "72px").join(" ")} 1fr`;
    lines.classList.toggle("many", view.rows.length > 3);
    applyFields(document, { "fl-tolerance-label": view.fl.toleranceLabel, "fl-tolerance": view.fl.tolerance, "fl-max": view.fl.max, "fl-new-total": view.fl.newTotal, "fl-verdict": view.fl.verdict });
    $('[data-field="fl-new-total"]').classList.toggle("over", view.fl.over);
    const link = $("#customer-link");
    if (view.customerUrl) link.href = view.customerUrl;
    $("#mechanic-link").href = `/mechanic/${encodeURIComponent(roId)}`;
    $("#pickup-open").disabled = view.pickedUp;
  };

  $("#copy-link").addEventListener("click", async () => {
    if (!view?.customerUrl) return;
    try {
      await navigator.clipboard.writeText(view.customerUrl);
      showNote("Customer link copied.");
    } catch {
      showNote(view.customerUrl);
    }
  });
  const qrDialog = $("#qr-dialog");
  $("#qr-open").addEventListener("click", () => {
    if (!view?.customerUrl) return;
    try {
      const m = qrMatrix(view.customerUrl);
      $("#qr-svg").setAttribute("viewBox", `0 0 ${m.length + 8} ${m.length + 8}`);
      $("#qr-path").setAttribute("d", qrPath(m));
    } catch (e) {
      showError(e);
    }
    $("#qr-url").textContent = view.customerUrl;
    qrDialog.showModal();
  });
  $("#qr-close").addEventListener("click", () => qrDialog.close());

  const pickupDialog = $("#pickup-dialog");
  const pickupRows = $("#pickup-rows");
  $("#pickup-open").addEventListener("click", () => {
    if (!view) return;
    pickupRows.replaceChildren();
    for (const l of view.pickupLines) {
      const row = clone("tpl-pickup-row");
      row.querySelector(".pickup-title").textContent = l.title;
      row.querySelector(".pickup-approved").textContent = `approved ${money(l.approvedCents)}`;
      const input = row.querySelector("input");
      input.value = l.value;
      input.dataset.lineId = l.lineId;
      input.dataset.title = l.title;
      pickupRows.appendChild(row);
    }
    $("#pickup-empty").hidden = view.pickupLines.length > 0;
    pickupDialog.showModal();
  });
  $("#pickup-cancel").addEventListener("click", () => pickupDialog.close());
  const submit = $("#pickup-submit");
  $("#pickup-form").addEventListener("submit", (ev) => {
    ev.preventDefault();
    act(submit, async () => {
      const entries = [...pickupRows.querySelectorAll("input")].map((i) => ({ lineId: i.dataset.lineId, title: i.dataset.title, value: i.value }));
      const b = pickupBody(entries);
      if (b.error) throw new ApiError(0, "VALIDATION", b.error);
      const result = await api("POST", `/api/ro/${encodeURIComponent(roId)}/pickup`, b.body);
      const problems = pickupProblems(result);
      if (problems.length) {
        showError(`${problems.join(". ")}. Send the same pickup again in a few seconds.`);
        return;
      }
      pickupDialog.close();
      location.assign(`/desk/${encodeURIComponent(roId)}`);
    })();
  });

  poll(
    () => api("GET", `/api/ro/${encodeURIComponent(roId)}`),
    (state) => {
      // Picked up elsewhere (another tab): the server answers this address with the pickup screen now.
      if (state.repairOrder.status === "picked_up") return location.replace(`/desk/${encodeURIComponent(roId)}`);
      view = deskView(state);
      render();
    },
  );
}

function initPickup() {
  const roId = roIdFromPath(location.pathname);
  if (!roId) return showError("No repair order in the address.");
  $("#back-to-order").href = `/desk/${encodeURIComponent(roId)}`;
  let view = null;
  const list = $(".pk-lines");
  const matches = $("#pk-matches");
  const retry = $("#pickup-retry");
  const render = () => {
    document.title = view.title;
    applyFields(document, view.fields);
    applyFields(document, view.slots, "data-slot");
    list.querySelectorAll(".gen").forEach((el) => el.remove());
    matches.replaceChildren();
    view.rows.forEach((r, i) => {
      const n = i + 1;
      const row = clone(r.billed ? "tpl-pk-row" : "tpl-pk-notbilled");
      row.classList.add("gen");
      const f = (name) => row.querySelector(`[data-field="${name}"]`);
      f("line-desc").textContent = r.desc;
      f("line-amount").textContent = r.amount;
      f("line-auth").textContent = r.auth;
      if (r.billed) {
        const charged = row.querySelector(".charged");
        charged.style.width = `${(r.chargedShare * 100).toFixed(2)}%`;
        charged.hidden = r.chargedShare === 0;
        f("captured").textContent = r.chargedText;
        f("released").textContent = r.released ?? "";
        f("released").hidden = r.released === null;
        f("captured").dataset.field = `captured-${n}`;
        f("released").dataset.field = `released-${n}`;
      }
      for (const name of ["line-desc", "line-amount", "line-auth", "line-capture"]) f(name).dataset.field = `${name}-${n}`;
      list.appendChild(row);
      const check = clone("tpl-pk-check");
      check.querySelector("span").textContent = r.match;
      check.querySelector("span").title = r.match;
      check.querySelector("span").dataset.field = `match-${n}`;
      matches.appendChild(check);
    });
    list.classList.toggle("many", view.rows.length > 3);
    const notes = [...(view.pickedUp ? [] : ["Not picked up yet: these are the holds as they stand."]), ...view.unsettled];
    showNote(notes.join(" ") || null);
    retry.hidden = view.unsettled.length === 0;
  };
  retry.addEventListener(
    "click",
    act(retry, async () => {
      const result = await api("POST", `/api/ro/${encodeURIComponent(roId)}/pickup`, view.retry);
      const problems = pickupProblems(result);
      // Keep PayPal's outcome on screen; the poll below refreshes the holds in place.
      if (problems.length) {
        showError(problems.join(". "));
        return;
      }
      location.reload();
    }),
  );
  poll(
    () => api("GET", `/api/ro/${encodeURIComponent(roId)}`),
    (state) => {
      view = pickupView(state);
      render();
    },
  );
}

function initCustomer() {
  const roId = roIdFromPath(location.pathname);
  if (!roId) return showError("No repair order in the address.");
  const params = new URLSearchParams(location.search);
  const store = `lbl:k:${roId}`;
  if (params.get("k")) sessionStorage.setItem(store, params.get("k"));
  const k = params.get("k") ?? sessionStorage.getItem(store);
  if (!k) return showError("This page needs the customer link from the service desk: open the link or scan the QR code again.");
  const back = returnNotice(params);
  if (back?.note) showNote(back.note);
  if (back?.error) showError(back.error);
  $("#consent-date").textContent = new Date().toLocaleDateString("en-US");

  let view = null;
  const groups = $("#line-groups");
  const nameInput = $("#approver-name");
  const consent = () => {
    let fl = null;
    if (view.needsDisclosure) {
      const checked = document.querySelector('input[name="fl-choice"]:checked');
      if (view.estimateRequired && !checked) throw new ApiError(0, "CONSENT", "check one of the Florida statements first");
      fl = flChoiceOf(checked?.value ?? null, $(".fl-limit")?.value);
      if (!$("#esign-consent").checked) throw new ApiError(0, "CONSENT", "agree to electronic records first (the box above)");
    }
    const approverName = (view.needsDisclosure ? nameInput.value : view.approverName || nameInput.value).trim();
    if (!approverName) throw new ApiError(0, "CONSENT", "type your name to sign");
    return { approverName, channel: "link", esignConsent: true, ...(fl ?? {}) };
  };
  const render = () => {
    document.title = view.title;
    applyFields(document, view.fields);
    applyFields(document, view.slots, "data-slot");
    $("#consent-box").hidden = !view.needsDisclosure;
    $("#fl-disclosure").hidden = !view.estimateRequired;
    if (!nameInput.value && view.approverName) nameInput.value = view.approverName;
    $("#estimate-actions").hidden = !(view.estimate && view.estimate.needsApproval);
    $("#estimate-confirming").hidden = !(view.estimate && view.estimate.confirming);
    groups.replaceChildren();
    view.cards.forEach((c, i) => {
      const g = clone("tpl-line-group");
      g.classList.add(i % 2 === 0 ? "g1" : "g2");
      g.querySelector(".avatar").src = c.avatar;
      applyFields(g, { "mech-msg-l1": c.message }, "data-slot");
      setImg(g.querySelector(".photo"), c.photo);
      g.querySelector(".photo").hidden = !c.photo;
      const card = clone(c.kind === "declined" ? "tpl-card-none" : "tpl-card-ok");
      card.dataset.lineId = c.lineId;
      card.classList.toggle("pending", c.kind === "pending");
      card.classList.toggle("decided", c.kind === "approved" || c.kind === "confirming");
      setImg(card.querySelector(".thumb"), c.thumb);
      card.querySelector(".line-title").textContent = c.title;
      card.querySelector(".price").textContent = c.price;
      const chip = card.querySelector(".chip");
      chip.classList.add(c.chip);
      chip.querySelector("span").textContent = c.urgency ?? "";
      chip.hidden = !c.urgency;
      card.querySelector(".pdot").hidden = !c.urgency;
      if (c.kind !== "declined") {
        const approve = card.querySelector('[data-action="approve-line"]');
        const later = card.querySelector('[data-action="decline-line"]');
        approve.hidden = c.kind !== "pending";
        later.hidden = !c.canDecline;
        const status = card.querySelector(".line-status");
        status.hidden = c.kind === "pending";
        card.querySelector(".st b").textContent = c.kind === "approved" ? "Approved" : "PayPal is confirming";
        card.querySelector(".st i").hidden = c.kind !== "approved";
        card.querySelector(".auth-seq").textContent = String(c.authSeq ?? "");
      }
      g.querySelector(".stack").appendChild(card);
      groups.appendChild(g);
    });
  };

  $("#approve-estimate").addEventListener(
    "click",
    act($("#approve-estimate"), async () => {
      const body = consent();
      const r = view.estimate.orderId
        ? await api("POST", `/api/orders/${encodeURIComponent(view.estimate.orderId)}/refresh`, undefined, k)
        : await api("POST", `/api/ro/${encodeURIComponent(roId)}/estimate/approval`, body, k);
      goPayPal(r.approveUrl);
    }),
  );
  groups.addEventListener("click", (ev) => {
    const button = ev.target.closest("[data-action]");
    const card = button?.closest("[data-line-id]");
    if (!button || !card) return;
    const c = view.cards.find((x) => x.lineId === card.dataset.lineId);
    if (!c) return;
    if (button.dataset.action === "approve-line") {
      act(button, async () => {
        const body = consent();
        const r = c.orderId
          ? await api("POST", `/api/orders/${encodeURIComponent(c.orderId)}/refresh`, undefined, k)
          : await api("POST", `/api/ro/${encodeURIComponent(roId)}/decisions`, { ...body, approve: [c.lineId], decline: [] }, k);
        goPayPal(r.approveUrl);
      })();
    } else if (button.dataset.action === "decline-line") {
      act(button, async () => {
        await api("POST", `/api/ro/${encodeURIComponent(roId)}/decisions`, { ...consent(), approve: [], decline: [c.lineId] }, k);
        showNote("Not billed: no PayPal order was made for this line.");
        reload();
      })();
    }
  });
  const reload = poll(
    () => api("GET", `/api/ro/${encodeURIComponent(roId)}`, undefined, k),
    (state) => {
      view = customerView(state);
      render();
    },
  );
}

async function initMechanic() {
  const roId = roIdFromPath(location.pathname);
  if (!roId) return showError("No repair order in the address.");
  const select = $("#sample-select");
  const audio = $("#sample-audio");
  const use = $("#sample-use");
  const drafts = $("#draft-lines");
  const sent = new Map(); // card index -> line id created by "Send to customer"
  let state = null;
  let cards = [];

  const { samples } = await api("GET", "/api/samples");
  for (const s of samples) {
    const o = document.createElement("option");
    o.value = s.id;
    o.textContent = `${s.id} · ${s.text.length > 70 ? `${s.text.slice(0, 69)}…` : s.text}`;
    select.appendChild(o);
  }
  const pick = () => {
    const s = samples.find((x) => x.id === select.value);
    if (s) audio.src = s.audioUrl;
  };
  select.addEventListener("change", pick);
  pick();
  audio.addEventListener("loadedmetadata", () => applyFields(document, { "voice-duration": durationText(audio.duration) }));

  const renderSent = () => {
    if (!state) return;
    for (const [i, lineId] of sent) {
      const btn = drafts.querySelector(`[data-card="${i}"] .send`);
      if (!btn) continue;
      const s = sentState(state, lineId);
      btn.dataset.state = s.state;
      btn.querySelector("span").textContent = s.text;
    }
  };

  use.addEventListener(
    "click",
    act(use, async () => {
      const draft = await api("POST", `/api/ro/${encodeURIComponent(roId)}/voice/sample/${encodeURIComponent(select.value)}`);
      const v = draftView(draft);
      cards = v.cards;
      sent.clear();
      applyFields(document, { transcript: v.transcript });
      $(".transcript").classList.remove("placeholder");
      setImg($(".photo"), v.photo);
      $(".photo").hidden = !v.photo;
      showNote(v.note);
      drafts.replaceChildren();
      v.cards.forEach((c, i) => {
        const el = clone("tpl-draft-line");
        el.dataset.card = String(i);
        applyFields(el, { "line-part": c.part, "line-price": c.price, "price-code": c.priceCode });
        applyFields(el, { "line-detail-1": c.detail }, "data-slot");
        setImg(el.querySelector(".thumb"), c.thumb);
        const badge = el.querySelector(".badge");
        badge.dataset.kind = c.urgencyKind;
        badge.querySelector("span").textContent = c.urgency;
        drafts.appendChild(el);
      });
    }),
  );
  drafts.addEventListener("click", (ev) => {
    const btn = ev.target.closest(".send");
    const card = btn?.closest("[data-card]");
    if (!btn || !card || btn.dataset.state !== "ready") return;
    const i = Number(card.dataset.card);
    const c = cards[i];
    btn.dataset.state = "sending";
    btn.querySelector("span").textContent = "Sending…";
    act(null, async () => {
      try {
        const r = await api("POST", `/api/ro/${encodeURIComponent(roId)}/lines`, c.body);
        sent.set(i, r.line.id);
        btn.dataset.state = "sent";
        btn.querySelector("span").textContent = "Sent to customer";
      } catch (e) {
        btn.dataset.state = "ready";
        btn.querySelector("span").textContent = "Send to customer";
        throw e;
      }
    })();
  });

  poll(
    () => api("GET", `/api/ro/${encodeURIComponent(roId)}`),
    (s) => {
      state = s;
      const id = shortId(s.repairOrder.id);
      document.title = `Line by Line — mechanic phone · Order #${id}`;
      applyFields(document, { "order-ref": `Bayside Auto Care · Order #${id}` }, "data-slot");
      const closed = s.repairOrder.status === "picked_up";
      use.disabled = closed;
      if (closed) showNote("This repair order is picked up; no new lines.");
      renderSent();
    },
  );
}

const SCREENS = { s1: initCustomer, s2: initDesk, "s2-pickup": initPickup, s3: initMechanic };

if (typeof document !== "undefined" && document.body && SCREENS[document.body.dataset.screen]) {
  Promise.resolve()
    .then(() => SCREENS[document.body.dataset.screen]())
    .catch((e) => showError(e));
}
