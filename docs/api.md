# Line by Line HTTP API

The contract between the server and the screens (service desk, mechanic phone, customer page, judge mode). Everything
here is checked by `test/integration/http.test.ts`, `webhooks.test.ts`, `voice.test.ts` and `judge.test.ts`. Sandbox
only: the server talks to `api-m.sandbox.paypal.com` and refuses any other PayPal origin.

## Basics

- **JSON in, JSON out.** Requests with a body must send `Content-Type: application/json` (otherwise `415`). Bodies
  larger than 256 KB get `413`. The one exception is `POST /api/ro/:id/voice`: raw audio, up to 2 MB.
- **Money** is whole US cents. Every `fooCents` field comes with a `foo` string in dollars, and a bare `cents` field
  comes with `amount`: `"priceCents": 18600, "price": "186.00"`. A `null` amount stays `null` in both fields. Requests
  take cents only.
- **Dates** are ISO 8601 strings in UTC.
- **Ids**: ours look like `ro_…`, `ln_…`, `cn_…`; PayPal ids (orders, authorizations, captures) are PayPal's own.
  Path ids must match `[A-Za-z0-9_-]{1,64}` (otherwise `400`).
- **No payer data** in any response, redirect or table: no name, e-mail, address or payer id from PayPal. The
  `approverName` of a consent is what the customer typed on our page, not PayPal data.
- **Access.** The UI is expected on the same origin (no CORS headers are sent). Who may call what:

  | Caller | Sends | May call |
  |---|---|---|
  | Desk and mechanic screens | `Authorization: Bearer <DESK_TOKEN>` | every route below except the job, the webhook and `/api/judge/*` |
  | Customer page `/c/:roId` | `Authorization: Bearer <k>`, where `k` is the query parameter of the customer link | for **its own** repair order only: `GET /api/ro/:id`, `POST /api/ro/:id/estimate/approval`, `POST /api/ro/:id/decisions`, `POST /api/orders/:orderId/refresh`; never `channel: "desk"` (`403 FORBIDDEN`) |
  | Judge (no login) | `Authorization: Bearer <judge token>` or the `lbl_judge` cookie, both from `POST /api/judge/session` | `/api/judge/*`, and with the desk's rights **only on repair orders created in its session**: `GET /api/ro/:id`, `POST /api/ro/:id/estimate/approval`, `/lines`, `/lines/draft`, `/voice/sample/:sampleId`, `/decisions`, `/pickup`, `GET /api/authorizations/:id` (of those repair orders); `POST /api/ro/:id/voice` only when `LBL_JUDGE_LIVE_VOICE=1`. Another repair order: `403 FORBIDDEN` |
  | Anyone | nothing | `POST /api/judge/session`, `GET /api/samples`, `GET /api/samples/:id.wav`, `GET /healthz` |
  | PayPal (browser redirect) | nothing | `GET /api/paypal/return`, `GET /api/paypal/cancel` |
  | PayPal (webhook) | its signature | `POST /api/webhooks/paypal` |
  | Scheduler | `Authorization: Bearer <JOB_TOKEN>` | `POST /api/jobs/reauthorize` |

  The desk gets the customer link as `customerUrl` (`PUBLIC_BASE_URL/c/<roId>?k=<token>`) in `POST /api/ro` and
  `GET /api/ro/:id`; show it as the QR code or send it. The token is derived from `DESK_TOKEN` and the repair order id
  (nothing stored; a new `DESK_TOKEN` invalidates every link). The bare repair order id opens nothing. PayPal's return
  redirect does **not** carry the token: the customer page keeps `k` from the link it was opened with (for example in
  `sessionStorage`) and sends it again after the redirect.
- **Which credential counts.** A bearer token decides: the desk token, a judge token (`j.…`), or a customer token. The
  `lbl_judge` cookie is used only when there is no `Authorization` header, so a judge who opens the customer link in
  the same browser acts as the customer there. `DESK_TOKEN` itself never appears in any answer to a judge.

### Errors

Every error is JSON: `{"error": "<readable text>", "code": "<CODE>", "details": {…}}` (`details` only when there is
something useful, for example the list of validation issues or the PayPal issue).

| HTTP | `code` | Meaning | What the screen does |
|---|---|---|---|
| 400 | `VALIDATION` | The input is wrong (`details.issues[]` has `path` and `message`) | show the message, fix the input |
| 404 | `NOT_FOUND` | No such repair order, line, order or authorization (or a PayPal order that is not ours) | reload |
| 409 | `CONFLICT` | The state does not allow it (line already decided, repair order already picked up, order replaced, …) | reload the state, do not retry blindly |
| 409 | `IN_PROGRESS` | The same PayPal operation is running right now (double click, webhook at the same moment) | retry in a few seconds |
| 502 | `PAYPAL` | PayPal refused or did not answer. `details`: `outcome`, `issue`, `httpStatus`, `debugId`, `text` | show "PayPal did not confirm", let the desk retry |
| 413 | `TOO_LARGE` | Body over 256 KB | |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | Body not sent as `application/json` | |
| 401 | `UNAUTHORIZED` | No or wrong bearer token for this route (desk token, this repair order's customer token, a judge session, or `JOB_TOKEN`); also a judge token that is forged, expired or of an ended session; `WWW-Authenticate: Bearer` | ask for the link or sign in again; a judge starts a new session |
| 403 | `FORBIDDEN` | The customer page tried to record a decision with `channel: "desk"`; a judge on a repair order of another session (or of the shop); a judge sending live audio while `LBL_JUDGE_LIVE_VOICE` is off | |
| 409 | `ALREADY_USED` | The judge session has already reauthorized a hold | start a new session |
| 409 | `POOL_EMPTY` | No free aged hold; `details.lastReauthorized` is the hold reauthorized last, with a live GET (or `null`) | show that one instead |
| 413 | `TOO_LARGE` | Voice note over 2 MB | record a shorter note |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | Voice note not sent as `audio/webm`, `audio/mp4`, `audio/mpeg`, `audio/wav` or `audio/ogg` (parameters such as `;codecs=opus` are fine) | |
| 429 | `DAILY_CAP` | The day's (UTC) ceiling of paid model calls (`LBL_LIVE_DAILY_CAP`) or of new judge sessions (`LBL_JUDGE_DAILY_SESSIONS`) is reached | use a sample; try after 00:00 UTC |
| 429 | `DEMO_LIMIT` | The judge session already created 5 demo repair orders | start a new session |
| 429 | `RATE_LIMITED` | More than 60 PayPal-shaped webhook deliveries a minute, or more than 10 judge sessions an hour, from one address (`Retry-After` in seconds) | PayPal delivers again later; a judge waits or uses the open session |
| 502 | `MODEL_ERROR` | Speech recognition or line drafting failed (provider error or no answer); the text says which | let the mechanic type the note or pick lines by hand |
| 503 | `VOICE_DISABLED` | `POST /api/ro/:id/voice` called, but `LBL_STT` is not set ("speech recognition is not configured") | use `/lines/draft` or a sample |
| 503 | `JOB_DISABLED` | Reauthorize job called, but `JOB_TOKEN` is not set on the server | |
| 503 | `UNAVAILABLE` | `/healthz`: the database does not answer | |
| 500 | `INTERNAL` | A bug; the server log has the stack | |

PayPal `outcome` values: `MAX_CAPTURE_COUNT_EXCEEDED`, `MAX_CAPTURE_AMOUNT_EXCEEDED`, `PREVIOUSLY_CAPTURED`,
`PREVIOUSLY_VOIDED`, `AUTHORIZATION_EXPIRED`, `REAUTHORIZATION_TOO_SOON`, `CANNOT_BE_VOIDED`, `ORDER_NOT_APPROVED`,
`ORDER_ALREADY_AUTHORIZED`, `INSTRUMENT_DECLINED`, `DUPLICATE_REQUEST_ID`, `UNKNOWN` (the text is kept).

## Lifecycles

### Line (`lines[].status`)

```
estimate line:  proposed ──approval link──▶ sent ──PayPal authorized──▶ approved ──pickup──▶ performed | not_performed
added line:     proposed ──decision: approve──▶ sent ──PayPal authorized──▶ approved ──pickup──▶ performed | not_performed
                proposed | sent ──decision: decline──▶ declined          (no PayPal order, never billed)
                sent ──customer cancels on PayPal──▶ sent                (order CANCELLED; a new decision is allowed)
```

`kind` is `estimate` (from the desk, approved as a whole) or `added` (found during the repair; the customer decides
each one). `performed` means `performedCents > 0` at pickup, `not_performed` means 0. A line that was never approved
is never billed. `priceCode` is the price-list code when the line came from the list (`data/price-list.json`), else
`null`. `repairOrder.kind` is `shop`, or `pool` for the repair orders `npm run seed:pool` makes around aged holds.

### Approval order (`orders[]`)

One PayPal order (`intent: AUTHORIZE`) for the whole estimate, and one per batch of added lines approved in one tap.
`lineIds` says which lines it carries; `approveUrl` is the PayPal page (`rel: payer-action`).

```
PAYER_ACTION_REQUIRED ──customer approves──▶ APPROVED ──we authorize──▶ COMPLETED
PAYER_ACTION_REQUIRED ──customer cancels──▶ CANCELLED
PAYER_ACTION_REQUIRED, link older than 3 h ──refresh──▶ supersededBy = <new order id>   (same lines, new link)
```

The approval page uses `user_action: CONTINUE` (button "Review Order"). On the sandbox mobile page the customer sees
each line's name, description and exact amount; there is no "up to" amount (checked 2026-10-31 against `PAY_NOW`, whose
button reads "Pay", which misdescribes a hold).

### Authorization (`authorizations[]`)

The hold behind a `COMPLETED` order. `amountCents` never changes; `capturedCents` is what pickup took.

```
CREATED ──pickup, part performed──▶ capture (final_capture:false) + void ──▶ VOIDED   (captures stay COMPLETED)
CREATED ──pickup, all performed───▶ capture (final_capture:true), no void ──▶ CAPTURED
CREATED ──pickup, nothing performed──▶ void ──▶ VOIDED
CREATED ──day 4+, PayPal wallet only──▶ reauthorize: new row with parentId; the parent keeps CREATED and gets reauthorizedTo
```

- After a reauthorization the capture goes to the new (child) id and the void always goes to the parent: PayPal
  refuses to void a reauthorization (`CANNOT_BE_VOIDED`). The new hold keeps the old `expirationTime`.
- `paymentSource`: `paypal` (wallet), `card`, or `unknown`. Card holds are never reauthorized; the job lists them under
  `askCustomer`.
- `needsAttention`: a reason text when something needs the service desk (for example `MAX_CAPTURE_COUNT_EXCEEDED`, a
  capture that came back `DECLINED`, an authorized amount that differs from the lines). Pickup and the reauthorize job
  skip such a hold; nothing is voided automatically. `null` = fine.
- `confirmedAt` / `captures[].confirmedAt`: when a PayPal webhook confirmed the current status ("Confirmed by PayPal").
  It is a second layer only; the screens must not wait for it.

## Routes

### `GET /healthz`

`200 {"ok": true}`; `503 {"ok": false, "error": "database unavailable", "code": "UNAVAILABLE"}`.

### `POST /api/ro` — create a repair order with its estimate

```json
{
  "customerLabel": "Dana Demo (made-up)",
  "state": "FL",
  "estimateLines": [
    { "title": "Front brake pads", "priceCents": 26800, "source": "desk", "urgency": "safety" },
    { "title": "Brake fluid flush", "priceCents": 14400, "source": "desk", "urgency": "soon", "description": "" }
  ]
}
```

- `customerLabel` 1–100 characters (a demo label, not a real customer record); `state` two capital letters, default
  `FL`; `estimateLines` 1–50.
- A line: `title` 1–127, `description` up to 2000 (default `""`), `priceCents` whole number 1 to 1,000,000,
  `urgency` `safety` | `soon` | `can_wait` | `null` (default), `source` `desk` | `mechanic`.
- Or a line from the price list: `priceCode` (for example `"BRK-ROT-F"`) instead of `title` and `priceCents`. The
  title and price are the list's. A `title` or `priceCents` sent along must equal the list's, otherwise `400
  VALIDATION` (nothing is silently overridden). `description` is then the text for the customer: at most 300
  characters, and a text that names a price (`$`, `€`, `£`, dollars, USD, bucks, cents) is replaced by the item name, so
  the customer sees one price, the list's. An unknown code is `400 VALIDATION` with the path
  (`estimateLines.1.priceCode`).

Desk only. `201` with the full state, the same shape as `GET /api/ro/:id`, plus `customerUrl`. Errors: `400 VALIDATION`,
`401 UNAUTHORIZED`.

### `GET /api/ro/:id` — everything a screen needs

Desk, or this repair order's customer page. From our database, no PayPal call. `200` (the desk also gets
`"customerUrl": "https://…/c/ro_…?k=…"`):

```json
{
  "repairOrder": { "id": "ro_…", "customerLabel": "Dana Demo (made-up)", "state": "FL", "status": "open", "createdAt": "2026-11-02T15:00:00.000Z" },
  "lines": [
    { "id": "ln_…", "roId": "ro_…", "kind": "estimate", "title": "Front brake pads", "description": "", "priceCents": 26800, "price": "268.00",
      "urgency": "safety", "source": "desk", "status": "approved", "performedCents": null, "performed": null, "createdAt": "…" }
  ],
  "consents": [
    { "id": "cn_…", "roId": "ro_…", "lineId": "ln_…", "decision": "approved", "decidedAt": "…", "channel": "qr_page", "approverName": "Dana Demo",
      "esignConsent": true, "disclosureVersion": "FL-559.905-2026-10-31", "amountCents": 26800, "amount": "268.00",
      "newTotalCents": 41200, "newTotal": "412.00", "paypalOrderId": "5O190127TN364715T", "paypalAuthorizationId": "0VF52814937998046",
      "flChoice": "written", "flLimitCents": null }
  ],
  "orders": [
    { "id": "5O190127TN364715T", "roId": "ro_…", "purpose": "estimate", "lineIds": ["ln_…", "ln_…"], "amountCents": 41200, "amount": "412.00",
      "status": "COMPLETED", "approveUrl": "https://www.sandbox.paypal.com/checkoutnow?token=5O190127TN364715T",
      "requestId": "lbl:order-est:ro_…:1", "attempt": 1, "supersededBy": null, "createdAt": "…" }
  ],
  "authorizations": [
    { "id": "0VF52814937998046", "paypalOrderId": "5O190127TN364715T", "roId": "ro_…", "parentId": null, "amountCents": 41200, "amount": "412.00",
      "capturedCents": 0, "captured": "0.00", "status": "CREATED", "paymentSource": "paypal", "expirationTime": "2026-12-01T15:00:00.000Z",
      "createdAt": "…", "reauthorizedTo": null, "reauthorizedAt": null, "needsAttention": null, "confirmedAt": null }
  ],
  "captures": [
    { "id": "…", "authorizationId": "…", "amountCents": 39800, "amount": "398.00", "finalCapture": false, "status": "COMPLETED",
      "feeCents": 1438, "fee": "14.38", "netCents": 38362, "net": "383.62", "requestId": "lbl:capture:…:1", "createdAt": "…", "confirmedAt": null }
  ],
  "fl": {
    "estimateCents": 41200, "estimate": "412.00", "estimateRequired": true,
    "approvedTotalCents": 41200, "approvedTotal": "412.00",
    "toleranceBaseCents": 41200, "toleranceBase": "412.00", "toleranceCents": 4120, "tolerance": "41.20", "ceilingCents": 45320, "ceiling": "453.20",
    "newLineNeedsConsent": true, "disclosureVersion": "FL-559.905-2026-10-31",
    "pendingTotalCents": 22500, "pendingTotal": "225.00", "pendingExceedsTolerance": true,
    "pendingLines": [ { "lineId": "ln_…", "exceedsTolerance": true }, { "lineId": "ln_…", "exceedsTolerance": false } ]
  }
}
```

- Which hold covers a line: find the order whose `lineIds` has it (not `supersededBy`, not `CANCELLED`), then the
  authorization with that `paypalOrderId` and `parentId: null`; a row with `parentId` is its reauthorization.
- `fl` (Florida, Fla. Stat. 559.905 and 559.909; not legal advice; `null` for other states): `estimateRequired` is true
  above $150; the tolerance is "$10 or 10 percent, whichever is greater, but not more than $50" of the last approved
  total (of the estimate before anything is approved); `exceedsTolerance` says whether that line alone, on top of the
  approved total, goes past the ceiling. Badge text: "FL: notice and consent are needed when the total exceeds the
  estimate by more than $41.20 (559.909). New work: a separate approval." In this app every new line asks for the
  customer's approval anyway (`newLineNeedsConsent: true`); the tolerance only explains the badge.

Errors: `404 NOT_FOUND`, `400 VALIDATION` (malformed id), `401 UNAUTHORIZED`.

### `POST /api/ro/:id/estimate/approval` — approval link for the estimate

Desk, or this repair order's customer page. Body (the consent record, sent when the customer taps "I approve" on our
page, before PayPal):

```json
{ "approverName": "Dana Demo", "channel": "qr_page", "esignConsent": true, "disclosureVersion": "FL-559.905-2026-10-31" }
```

- `channel`: `qr_page` | `link` | `desk`. On the phone (`qr_page`, `link`) `esignConsent` must be `true`: the customer
  first agrees to electronic records (UETA, FL 668.50(5)(b)). At the desk it may be `false`.
- `disclosureVersion` is optional; default is the version the server ships.
- `flChoice` (optional): which statement of Fla. Stat. 559.905(2) the customer checked: `written` (I request a written
  estimate), `limit` (no written estimate as long as the repair costs do not exceed an amount) or `none`. With `limit`,
  `flLimitCents` (a positive whole number of cents, the amount the customer wrote) is required; with anything else it
  is refused (`400 VALIDATION`). The customer page sends them with the first approval, where it shows the statement;
  the desk and later decisions send none, and the record keeps `null`. When the estimate order already exists (the desk
  or the judge's start made it with its own consent) and the customer page approves with a statement, that statement
  is written onto the estimate's records that have none; the first choice stays. The same holds for the signature:
  the demo's start button records the estimate consent as `"Demo customer"`, and the customer page's approval (any
  channel but `desk`) puts the name typed into SIGNED and its channel into those records. A real name is never
  overwritten, neither by a later name nor by the placeholder. `POST /api/ro/:id/decisions` takes the same two
  fields. Every consent record in `GET /api/ro/:id` carries `flChoice` and `flLimitCents` (`null` for records made
  before 2026-11-03).

`201` (new order) or `200` (the live order already exists and is returned):

```json
{
  "order": { "id": "O…", "purpose": "estimate", "lineIds": ["ln_…", "ln_…"], "amountCents": 41200, "amount": "412.00",
             "status": "PAYER_ACTION_REQUIRED", "approveUrl": "https://www.sandbox.paypal.com/checkoutnow?token=O…", "attempt": 1, "supersededBy": null, "…": "…" },
  "created": true,
  "approveUrl": "https://www.sandbox.paypal.com/checkoutnow?token=O…"
}
```

Send the customer to `approveUrl`. An existing link older than 3 hours is replaced by a new order first.
Errors: `400 VALIDATION`, `401 UNAUTHORIZED`, `403 FORBIDDEN` (customer page with `channel: "desk"`), `404 NOT_FOUND`,
`409 CONFLICT` (already approved, picked up, a line already decided), `409 IN_PROGRESS`, `502 PAYPAL`.

### `POST /api/ro/:id/lines` — a new line from the mechanic or the desk

Desk, or a judge on its own repair order. Body: one line, as in `POST /api/ro` (`title`, `priceCents`, `source`,
optional `description`, `urgency`; or `priceCode` instead of title and price — the way a drafted voice line is
confirmed). `201 {"line": {…, "kind": "added", "status": "proposed", "priceCode": "BRK-ROT-F"}}`.
Errors: `400 VALIDATION`, `401 UNAUTHORIZED`, `404 NOT_FOUND`, `409 CONFLICT` (repair order already picked up).

### `POST /api/ro/:id/decisions` — the customer decides on added lines

Desk, or this repair order's customer page (which may not send `channel: "desk"`).

```json
{ "approve": ["ln_rotors"], "decline": ["ln_filter"], "approverName": "Dana Demo", "channel": "qr_page", "esignConsent": true }
```

- Declined lines: status `declined` and a consent record; **no PayPal order**.
- Approved lines (all of them in this request): **one** PayPal order with these lines as items.
- At least one line; a line id at most once; only `added` lines that are `proposed` or `sent` and have no live order.

`200`:

```json
{ "declined": ["ln_filter"], "order": { "id": "O…", "purpose": "added", "lineIds": ["ln_rotors"], "amountCents": 18600, "amount": "186.00", "…": "…" },
  "approveUrl": "https://www.sandbox.paypal.com/checkoutnow?token=O…" }
```

`order` and `approveUrl` are `null` when nothing was approved.

Declines are saved before the PayPal order is created. If the answer is `502 PAYPAL` (or the connection drops), resend
**only the `approve` list**: sending a declined line again is `409 CONFLICT` ("already declined").
Errors: `400 VALIDATION` (also for an estimate line), `401 UNAUTHORIZED`, `403 FORBIDDEN`, `404 NOT_FOUND` (line not
on this repair order), `409 CONFLICT`, `409 IN_PROGRESS`, `502 PAYPAL`.

### `POST /api/orders/:orderId/refresh` — re-create an expired approval link

Desk, or the customer page of the order's repair order. No body. If the link is younger than 3 hours (or PayPal
already shows it approved) nothing changes: `{"order": {…}, "refreshed": false, "approveUrl": "…"}`. Otherwise a new
order with the same lines is created (`attempt + 1`), the old one gets `supersededBy`, the consents move to the new
order: `{"order": {…new…}, "refreshed": true, "approveUrl": "…new…"}`. If the customer finishes approving the old link
while the new order is being created, the old order wins: the answer is `refreshed: false` with the old order, and the
new order is recorded with `supersededBy` = the old id (never used). Calling it before showing a link is cheap (no
PayPal call while the link is fresh).
Errors: `401 UNAUTHORIZED`, `404 NOT_FOUND`, `409 CONFLICT` (already authorized, cancelled, replaced, picked up),
`502 PAYPAL`.

### `GET /api/paypal/return?token=<orderId>` and `GET /api/paypal/cancel?token=<orderId>`

PayPal sends the customer's browser here (these are the order's `return_url` and `cancel_url`). The server
authorizes the order (return) or marks it `CANCELLED` and puts its lines back to `sent` (cancel), then answers
`303 See Other` to the customer page:

```
PUBLIC_BASE_URL/c/<roId>?paypal=approved&order=<orderId>
PUBLIC_BASE_URL/c/<roId>?paypal=pending&order=<orderId>             the same authorize is running (webhook); reload shortly
PUBLIC_BASE_URL/c/<roId>?paypal=cancelled&order=<orderId>
PUBLIC_BASE_URL/c/<roId>?paypal=error&order=<orderId>&code=<CODE>   PAYPAL or CONFLICT; the page reloads the state and shows it
```

The page always re-reads `GET /api/ro/:id`; the query only picks the message. The payer id PayPal adds to the URL is
ignored and never stored. A repeated return is harmless (one authorization). Errors before the redirect (JSON):
`400 VALIDATION` (no or malformed `token`), `404 NOT_FOUND` (not our order).

The cancel link carries only the order id, so before cancelling the server asks PayPal for the order. It is **not**
cancelled (`paypal=error&code=CONFLICT`) when PayPal shows it `APPROVED` or `COMPLETED`, or while our authorize for it
is running or done; the return redirect or the `CHECKOUT.ORDER.APPROVED` webhook then turns the approval into a hold.
If PayPal does not answer, nothing is cancelled (`code=PAYPAL`).

### `POST /api/ro/:id/pickup` — capture what was done, release the rest

```json
{ "performed": [ { "lineId": "ln_pads", "performedCents": 26800 }, { "lineId": "ln_flush", "performedCents": 13000 }, { "lineId": "ln_rotors", "performedCents": 18600 } ] }
```

- Per hold: `X = min(performed, approved)` line by line (an overrun on one line is never paid from savings on another).
  `X` equal to what is left on the hold → one capture with `final_capture: true`, no void. Less → capture with
  `final_capture: false`, then void. Zero → void. Never more than approved, never more than held; this is checked
  before any PayPal call.
- An approved line not listed counts as not performed (0). Lines that were never approved go to `notBilled`.
- The first pickup freezes the numbers and marks the repair order `picked_up`. Repeating it (double click, crash) with
  the **same** numbers only finishes steps that did not complete; different numbers are `409 CONFLICT`.
- Two pickups at the same moment: a capture is made only if the hold still holds what the plan was made from;
  the other request reports `in_progress` for that hold and never captures again.
- While PayPal is authorizing an approval of this repair order (the customer approved new work at the same moment),
  pickup answers `409 IN_PROGRESS`: try again in a few seconds, and the new hold is settled too. If that authorize
  never finished (`409 CONFLICT`, "did not finish"), open the order's return link again, then pick up.
- Every authorized order of the repair order is settled. A line is billed on one hold only (the earliest); should a
  second hold carry the same line, it bills nothing for it and the warning says so.
- Desk, or a judge on its own repair order.

`200`:

```json
{
  "roId": "ro_…",
  "authorizations": [
    { "paypalOrderId": "O…", "authorizationId": "A…", "captureAuthorizationId": "A…",
      "approvedCents": 41200, "approved": "412.00", "billableCents": 39800, "billable": "398.00", "capturedBeforeCents": 0, "capturedBefore": "0.00",
      "plan": [ { "kind": "capture", "cents": 39800, "amount": "398.00", "finalCapture": false }, { "kind": "void" } ],
      "executed": [
        { "kind": "capture", "authorizationId": "A…", "requestId": "lbl:capture:A…:1", "captureId": "C…", "cents": 39800, "amount": "398.00",
          "finalCapture": false, "status": "COMPLETED", "feeCents": 1438, "fee": "14.38", "netCents": 38362, "net": "383.62" },
        { "kind": "void", "authorizationId": "A…", "requestId": "lbl:void:A…:1", "status": "VOIDED" }
      ],
      "outcome": "done", "reason": null, "warnings": [], "live": { "A…": "VOIDED" } }
  ],
  "notBilled": [ { "lineId": "ln_filter", "reason": "not billed — no PayPal authorization for this line" } ],
  "overruns": [ { "lineId": "ln_…", "approvedCents": 18600, "performedCents": 20000, "approved": "186.00", "performed": "200.00" } ],
  "stopped": null
}
```

`outcome` per hold: `done`; `nothing_to_do` (already settled; `reason` says why); `needs_attention` (`reason` for the
desk, nothing more happens to that hold; also when PayPal refuses a capture because the hold is already captured or
voided, since no capture of ours was recorded); `in_progress` (another request is doing it; retry in a few seconds);
`retry` (PayPal gave no definite answer; send the same pickup again, it reuses the same PayPal-Request-Id and cannot
capture twice). `live` is the status from a live GET after the steps. `stopped` is set if pickup stopped early
(a capture refused for exceeding the hold, which our guard should make impossible).
Errors: `400 VALIDATION`, `401 UNAUTHORIZED`, `404 NOT_FOUND`, `409 CONFLICT`, `409 IN_PROGRESS`.

### `GET /api/authorizations/:id` — live check

Desk, or a judge for an authorization of its own repair order. Live GET of the authorization and its order at PayPal,
compared with our records. Statuses are taken from PayPal; amounts are never rewritten and no money moves.

```json
{ "ok": true, "diffs": [],
  "live": { "status": "VOIDED", "amountCents": 41200, "amount": "412.00", "capturedCents": 39800, "captured": "398.00", "expirationTime": "…" },
  "authorization": { "id": "A…", "status": "VOIDED", "capturedCents": 39800, "…": "…" } }
```

A difference looks like `{"field": "captured_cents", "db": 0, "paypal": 39800}`.
Errors: `401 UNAUTHORIZED`, `404 NOT_FOUND`, `502 PAYPAL`.

### `POST /api/jobs/reauthorize` — the scheduled job

Header `Authorization: Bearer <JOB_TOKEN>`; no body. Reauthorizes, once and for the same amount, every hold paid
with a PayPal wallet that is at least 4 days 10 minutes old, still `CREATED`, not captured, not expired, not already
reauthorized, on a repair order not picked up, and **not in the judge pool** (a pool hold's one reauthorization
belongs to a judge or, if `reserved`, to a test or a recording). `200`:

```json
{ "reauthorized": [ { "parentId": "A…", "newId": "A…", "roId": "ro_…", "amountCents": 41200, "amount": "412.00", "expirationTime": "…" } ],
  "skipped": [ { "authorizationId": "A…", "roId": "ro_…", "reason": "REAUTHORIZATION_TOO_SOON: …" } ],
  "askCustomer": [ { "authorizationId": "A…", "roId": "ro_…", "paymentSource": "card" } ] }
```

Errors: `401 UNAUTHORIZED` (no or wrong token, with `WWW-Authenticate: Bearer`), `503 JOB_DISABLED`.

### `POST /api/webhooks/paypal` — PayPal webhooks (second layer)

For PayPal only. The raw body is sent byte for byte to `verify-webhook-signature` with `PAYPAL_WEBHOOK_ID`.

| Case | Answer | Stored |
|---|---|---|
| `PAYPAL_WEBHOOK_ID` not set | `503 WEBHOOK_NOT_CONFIGURED` | nothing |
| body not JSON, no `id` or `event_type` | `400 BAD_WEBHOOK` | nothing |
| PayPal headers missing or verification not `SUCCESS` | `400 BAD_SIGNATURE` | event row with `verified=false`; nothing else changes |
| PayPal did not answer the verification | `502 PAYPAL` | nothing (PayPal delivers again) |
| event id already processed, or being processed right now | `200 {"received": true, "duplicate": true}` | nothing |
| verified (new, or open for a retry) | `200 {"received": true, "duplicate": false}` at once; processed in the background | event row, then `processed_at` and `outcome` |
| more than 60 PayPal-shaped deliveries a minute from one address | `429 RATE_LIMITED` with `Retry-After`, before PayPal is asked | nothing |

The limit is kept in the server's memory per client address: the last `X-Forwarded-For` entry (the one the
platform's proxy appends; what a client puts in front of it does not count) when it is a valid IP address, else the
socket address. Only requests shaped like a PayPal delivery are counted (JSON with a string `id` and `event_type`, sent
with the `PAYPAL-TRANSMISSION-ID` and `PAYPAL-TRANSMISSION-SIG` headers): junk is refused with 400 without a PayPal
call and cannot use up the bucket that PayPal's real deliveries may share. Every counted request past the limit is
refused before any call to PayPal's verification.

An event counts as handled only once it was processed. If processing fails for a reason that may pass (PayPal 5xx
or no answer, the return redirect authorizing the same order at that moment, our database), the row keeps
`processed_at = null` with `outcome = "retry: …"`; a processing cut off by a crash shows as no outcome for more than
5 minutes. Such an event is processed again by a redelivery with the same id and by a sweep the server runs at start
and every 5 minutes (PayPal itself does not deliver again after a 200). After 12 attempts the outcome is
`"gave up after 12 attempts: …"`. The sweep rebuilds events from the stored type and resource id; refund and reversal
events need their body and are retried only on a redelivery.

What processing does:

- `CHECKOUT.ORDER.APPROVED`: if the order is ours and not yet authorized, authorize it (the same idempotent step as
  the return redirect, for a customer whose browser never came back).
- `PAYMENT.AUTHORIZATION.CREATED`: sets `confirmedAt`. `PAYMENT.AUTHORIZATION.VOIDED`: status `VOIDED` + `confirmedAt`.
- `PAYMENT.CAPTURE.COMPLETED` / `PENDING` / `DECLINED` / `REFUNDED` / `REVERSED`: the capture status, moving forward
  only (a late `PENDING` never overwrites `COMPLETED`), and `confirmedAt`. Amounts are never changed by a webhook.
- Anything else, or ids that are not ours: recorded as ignored.

PayPal says delivery is usually within 30 minutes but can take up to 3 hours, so no screen waits for a webhook.

## Voice note → draft lines

The mechanic dictates what was found; the server turns it into lines of the shop's price list. The answer is a
**draft**: nothing is created until the mechanic (or the desk) confirms each line with `POST /api/ro/:id/lines` and its
`priceCode`. Every price comes from the price list, never from a model; a code the model invents is dropped and listed
in `droppedCodes`. Desk, or a judge on its own repair order. No audio and no transcript is stored anywhere (a judge's
voice is personal data).

The draft (same shape for all three routes):

```json
{
  "transcript": "Front pads are down to about two millimeters. The wipers are streaking.",
  "lines": [
    { "priceCode": "BRK-PAD-F", "name": "Front brake pads — replace", "cents": 18900, "amount": "189.00", "usd": "189.00",
      "urgency": "safety", "customerText": "Front brake pads — replace" }
  ],
  "droppedCodes": [],
  "priceTextCodes": [],
  "provider": "keywords",
  "ms": 0
}
```

- `usd` and `amount` are the same dollar string (`amount` follows the money rule above).
- `customerText`: at most 300 characters; a text that named a price was replaced by the item name and its code is in
  `priceTextCodes`.
- `provider` is the line drafting provider (`LBL_LLM`: `keywords` by default, no model; or `groq:<model>`); `ms` is the
  providers' time.

### `POST /api/ro/:id/lines/draft` — from text

`{"text": "…"}`, 1–1000 characters after trimming. `200` with the draft (`transcript` is the text). Errors: `400
VALIDATION`, `401`, `403`, `404`, `415`, `429 DAILY_CAP` (paid provider only), `502 MODEL_ERROR`.

### `POST /api/ro/:id/voice` — from live audio

The body is the raw recording with its type in `Content-Type` (`audio/webm`, `audio/mp4`, `audio/mpeg`, `audio/wav`,
`audio/ogg`; `MediaRecorder`'s `audio/webm;codecs=opus` is fine), at most 2 MB (this route only; the rest keep 256
KB). The audio is written to a temporary file readable only by the server (mode `0600`, in its own temporary folder),
recognized (`LBL_STT`), drafted (`LBL_LLM`), and the folder is deleted when the request ends, also on errors.
`200` with the draft plus `stt` (the speech provider) and `timings` (`sttMs`, `llmMs`). Errors: `503 VOICE_DISABLED`
when `LBL_STT` is not set, `415`, `413`, `400` (empty body), `401`, `403` (a judge while `LBL_JUDGE_LIVE_VOICE` is off),
`404`, `429 DAILY_CAP`, `502 MODEL_ERROR`.

### Ceiling on paid model calls

Each live call of a `groq:` provider (speech recognition or line drafting) is counted in `model_calls` per UTC day
**before** the call; a voice note with both providers on Groq counts two. Past `LBL_LIVE_DAILY_CAP` (default 200) the
answer is `429 DAILY_CAP` and nothing is sent to the provider. `keywords` and recorded providers are not counted. A
`groq:` provider also needs `LBL_LLM_LIVE=1` and `GROQ_API_KEY` (the server refuses to start without them).

## Samples

32 synthetic voice notes (macOS text-to-speech, labeled by us; the benchmark set in `eval/`), so a judge can try the
voice step without recording and without a live model call. Their speech recognition is recorded
(`recorded:parakeet-local`); their lines come from recorded model answers (`LBL_LLM_RECORDED`) when there is one for
that note, otherwise from `keywords`.

- `GET /api/samples` (anyone): `{"samples": [{"id": "F01", "text": "Front pads are down to about two millimeters. …",
  "voice": "Eddy (English (US))", "audioUrl": "/api/samples/F01.wav", "synthetic": true}, …]}`.
- `GET /api/samples/:id.wav` (anyone): the WAV file (`audio/wav`). Only ids `F` + two digits from the set; the file path
  comes from the manifest, never from the request. Anything else is `404`.
- `POST /api/ro/:id/voice/sample/:sampleId` (desk, or a judge on its own repair order; no body): the draft plus
  `sampleId`, `stt`, `timings`, `source: "recorded"` and `recordings: {"stt": "recorded:parakeet-local", "llm":
  "recorded:<name>" | "keywords"}` (which recordings were used). Unknown sample: `404`.

## Judge mode

A judge proves the whole path in three minutes without a login, with **their own** PayPal sandbox buyer, and sees a
real reauthorization on a hold older than 3 days. What is live and what is prepared:

| Step | Live or prepared |
|---|---|
| Session, demo repair order, PayPal order, approval, authorize, decisions, pickup, captures and voids | live (sandbox) |
| Voice step | prepared by default: recorded samples; live audio only with `LBL_JUDGE_LIVE_VOICE=1` |
| Reauthorization | live call on a hold made days earlier (the pool), because PayPal allows it only from day 4 |

### The flow

1. `POST /api/judge/session` (anyone, no body) → `201 {"token": "j.<sessionId>.<expiresAt>.<hmac>", "expiresAt": "…",
   "liveVoice": false}` and the cookie `lbl_judge` (HttpOnly, Secure, SameSite=Lax, Path=/, 2 hours). The token is an
   HMAC-SHA256 under a key derived from `DESK_TOKEN` with its own label (checked in constant time); a new `DESK_TOKEN`
   ends every session. At most `LBL_JUDGE_DAILY_SESSIONS` (default 200) new sessions per UTC day, then `429 DAILY_CAP`; at most 10 per
   client address an hour (same address rule as the webhook limit), then `429 RATE_LIMITED` with `Retry-After`.
2. `POST /api/judge/demo` (judge) with the consent record, exactly as `POST /api/ro/:id/estimate/approval` takes it
   (`{"approverName": "…", "channel": "link", "esignConsent": true}`; the judge screen shows the FL disclosure and the
   e-records consent first) → `201 {"roId", "order", "approveUrl", "customerUrl"}`. The estimate is $412 in four
   price-list lines: front brake pads $189 (`BRK-PAD-F`), check engine light diagnosis $129 (`DIAG-CEL`), front wiper
   blades $49 (`WIPER-F`), engine air filter $45 (`FLT-ENGINE`); no two or three items of the list add up to $412, and
   every price comes from the list. At most 5 per session (`429 DEMO_LIMIT`). If PayPal fails, the repair order exists:
   `502 PAYPAL` with `details.roId`, and `POST /api/ro/:roId/estimate/approval` asks again.
3. The judge opens `approveUrl` and approves as their own sandbox buyer; PayPal returns to `/api/paypal/return` as usual.
4. `POST /api/ro/:id/voice/sample/:sampleId` → draft → `POST /api/ro/:id/lines` with `priceCode` → `POST
   /api/ro/:id/decisions` → approve the new link → `POST /api/ro/:id/pickup` → `GET /api/authorizations/:id`. All as
   for the desk, on this repair order only.
5. `GET /api/judge/pool` (judge): the aged holds (below).
6. `POST /api/judge/pool/reauthorize-next` (judge, no body): once per session, the oldest free hold.

### Pool of aged holds

Holds are made in the sandbox days ahead and recorded with `npm run seed:pool -- --purpose judge|reserved --wave N
--label L [--note "…"] <authId>…` (explicit ids only; nothing is searched or listed at PayPal). Per id: live GET of the
authorization and of its order; only a `CREATED` hold paid from a PayPal wallet is taken. A new hold becomes a repair
order of kind `pool` (lines from the order's items with PayPal's prices, its order and authorization), so pickup,
reconcile and the reauthorize step work on it like on our own. Running it again with the same id only updates the pool
row (label, purpose, wave, note). Refused: another status, a card, an order with more than one authorization (already
reauthorized), items that do not add up to the hold, a hold of a shop repair order.

`GET /api/judge/pool` → `{"holds": [ … ]}`, oldest first, each with a live GET (its status is written back; amounts are
never touched):

```json
{ "authorizationId": "4RR33540BR8604004", "label": "RO-2910-A", "purpose": "judge", "wave": 1,
  "roId": "ro_pool_4RR33540BR8604004", "amountCents": 14250, "amount": "142.50", "createdAt": "…", "ageDays": 6,
  "expirationTime": "…", "status": "CREATED", "live": { "status": "CREATED", "expirationTime": "…" }, "liveError": null,
  "window": { "opensAt": "…", "closesAt": "…", "open": true },
  "reauthorized": null, "available": true, "reason": null }
```

- `window`: reauthorize is allowed from 4 days 10 minutes after the hold was created until it expires.
- `reauthorized`: `{ "at", "newId", "expirationTime", "live", "liveError" }` once done (the new id keeps the old expiry).
- `available` is `false` with a `reason` for a `reserved` hold (kept for a test or a recording; listed, never handed
  out), one already reauthorized, too young, expired, picked up or flagged. A flagged hold only says
  `flagged for the service desk`: the flag's text (PayPal's refusal) and the operator's `--note` are not on this public
  listing; the desk reads the flag as `needsAttention` on `GET /api/ro/ro_pool_<authId>`.

`POST /api/judge/pool/reauthorize-next` → `200`:

```json
{ "label": "RO-2910-A", "parentId": "4RR33540BR8604004", "newId": "…", "requestId": "lbl:reauth:4RR33540BR8604004:1",
  "amountCents": 14250, "amount": "142.50", "ageDays": 6, "expirationTime": "…",
  "live": { "status": "CREATED", "amountCents": 14250, "amount": "142.50", "expirationTime": "…" }, "liveError": null }
```

- It takes the oldest `judge` hold whose window is open and that is free, and calls the core's reauthorize step for it
  (same amount, the same PayPal-Request-Id scheme as the job). Two judges at the same moment get two different holds:
  before it claims a hold, the call locks its row and checks again that it is still free, so a judge working from a
  list read just before another judge's reauthorize (or PayPal's refusal) of that hold took effect moves on to the
  next one instead of sending a second reauthorize under a new PayPal-Request-Id.
- Second call in the same session: `409 ALREADY_USED`. No free hold: `409 POOL_EMPTY` with
  `details.lastReauthorized` (the hold reauthorized last, with a live GET of its new id; `null` if there is none); the
  session is not used up.
- PayPal refuses or does not answer: `502 PAYPAL`, and the session gets its one use back. After no answer the next call
  retries the same hold with the same PayPal-Request-Id; a hold PayPal refused for good (not
  `REAUTHORIZATION_TOO_SOON`) gets `needsAttention` in the same transaction that records the refusal, so the next call
  takes the next hold.
- The reauthorize job never touches pool holds (`judge` or `reserved`).

## Pages

The screens are HTML from `web/` (working copies of the reference screens in `design/screens/`), sent without any
repair order data; `web/app.js` fills them from the routes above and polls `GET /api/ro/:id` every 5 seconds. Every
page answer has `Cache-Control: no-store`, `Referrer-Policy: same-origin` (the customer link carries its token) and a
`Content-Security-Policy` that allows scripts only from our own files (`script-src 'self'`; styles inline and from
Google Fonts). No page and no file under `/web/` contains `DESK_TOKEN` or `JOB_TOKEN`.

| Page | Screen | Access |
|---|---|---|
| `GET /` | the service desk, empty, with "Start a demo repair order" | anyone; reads and creates nothing (no session, no order, no PayPal call) |
| `GET /desk/:roId` | the service desk; the pickup screen once the repair order is picked up, or with `?view=pickup` | the judge session that created the repair order (cookie `lbl_judge`) or the desk token |
| `GET /mechanic/:roId` | the mechanic's phone (recorded voice samples, draft lines, "Send to customer") | as `/desk/:roId` |
| `GET /c/:roId?k=…` | the customer's phone (FL 559.905(2) disclosure and e-records consent before the first approval, the estimate, a decision per added line) | the customer link token `k`; without `k` only with `paypal=` (PayPal's return), where the page takes `k` from the browser tab it was opened in |

A refused page is an HTML page with the same status and no data: `401` (no or an ended judge session), `403` (another
session's repair order, or a wrong customer link), `404` (no such repair order), `400` (malformed id).

The start button calls `POST /api/judge/demo` and, if that answers `401` (no session in this browser yet),
`POST /api/judge/session` and the demo again, with the consent `{"approverName": "Demo customer", "channel": "link",
"esignConsent": true}`. The live microphone is not offered: the mechanic's screen uses the recorded samples.

`GET /web/*.js|css|png` serves the screens' script, style and pictures (`Cache-Control: public, max-age=300`); the HTML
templates themselves are not served there, and nothing outside `web/` is.

## Screen flow (customer page `/c/:roId`)

1. `GET /api/ro/:id` → show the lines; before the first approval show the FL 559.905(2) disclosure and ask for the
   electronic-records consent.
0. The desk creates the repair order and shows `customerUrl` as a QR code; the page keeps `k` from it and sends
   `Authorization: Bearer <k>` on every call.
2. Estimate: `POST /api/ro/:id/estimate/approval` → open `approveUrl`.
3. PayPal sends the browser to `/api/paypal/return` → the server authorizes → `303` to `/c/:roId?paypal=approved…` →
   step 1 again.
4. New lines appear (`kind: added`, `status: proposed`): the customer approves or declines each one, then
   `POST /api/ro/:id/decisions` → open `approveUrl` if there is one.
5. Desk at pickup: `POST /api/ro/:id/pickup`, then `GET /api/authorizations/:id` for each hold to show the live status.

## Sandbox walk-through script

`npm run e2e:sandbox` runs the demo story against the real sandbox and a local database: estimate $412 in two lines →
approval link → (a person approves in the browser as the sandbox buyer; the script polls the order) → authorize; then
"Front brake rotors $186" approved and "Cabin air filter $39" declined in one decision → second link → authorize;
pickup with the estimate done for $398 (capture `final_capture:false` + void) and the rotors in full (capture, no
void); live check of each hold. `--probe-capture-limit` puts $0.01 captures on a $5.00 hold until PayPal refuses one
(at most 30) and voids the rest. `--reauthorize <authId>…` reauthorizes existing holds for the same amount and reads
the new ids. `--user-action PAY_NOW` switches the approval page for a comparison. Output: `e2e-out/` (git-ignored).
