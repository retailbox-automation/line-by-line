# Line by Line HTTP API

The contract between the server and the screens (service desk, mechanic phone, customer page). Everything here is
checked by `test/integration/http.test.ts` and `test/integration/webhooks.test.ts`. Sandbox only: the server talks to
`api-m.sandbox.paypal.com` and refuses any other PayPal origin.

## Basics

- **JSON in, JSON out.** Requests with a body must send `Content-Type: application/json` (otherwise `415`). Bodies
  larger than 256 KB get `413`.
- **Money** is whole US cents. Every `fooCents` field comes with a `foo` string in dollars, and a bare `cents` field
  comes with `amount`: `"priceCents": 18600, "price": "186.00"`. A `null` amount stays `null` in both fields. Requests
  take cents only.
- **Dates** are ISO 8601 strings in UTC.
- **Ids**: ours look like `ro_…`, `ln_…`, `cn_…`; PayPal ids (orders, authorizations, captures) are PayPal's own.
  Path ids must match `[A-Za-z0-9_-]{1,64}` (otherwise `400`).
- **No payer data** in any response, redirect or table: no name, e-mail, address or payer id from PayPal. The
  `approverName` of a consent is what the customer typed on our page, not PayPal data.
- **No login yet.** The routes are open apart from the reauthorize job. The UI is expected on the same origin (no CORS
  headers are sent).

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
| 401 | `UNAUTHORIZED` | Reauthorize job without a valid bearer token | |
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
is never billed.

### Approval order (`orders[]`)

One PayPal order (`intent: AUTHORIZE`) for the whole estimate, and one per batch of added lines approved in one tap.
`lineIds` says which lines it carries; `approveUrl` is the PayPal page (`rel: payer-action`).

```
PAYER_ACTION_REQUIRED ──customer approves──▶ APPROVED ──we authorize──▶ COMPLETED
PAYER_ACTION_REQUIRED ──customer cancels──▶ CANCELLED
PAYER_ACTION_REQUIRED, link older than 3 h ──refresh──▶ supersededBy = <new order id>   (same lines, new link)
```

The approval page uses `user_action: PAY_NOW`, so PayPal shows exactly the line amount. With `CONTINUE` PayPal shows
the payer an "up to" amount above the hold, which our customer never agreed to.

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

`201` with the full state, the same shape as `GET /api/ro/:id`. Errors: `400 VALIDATION`.

### `GET /api/ro/:id` — everything a screen needs

From our database, no PayPal call. `200`:

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
      "newTotalCents": 41200, "newTotal": "412.00", "paypalOrderId": "5O190127TN364715T", "paypalAuthorizationId": "0VF52814937998046" }
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

Errors: `404 NOT_FOUND`, `400 VALIDATION` (malformed id).

### `POST /api/ro/:id/estimate/approval` — approval link for the estimate

Body (the consent record, sent when the customer taps "I approve" on our page, before PayPal):

```json
{ "approverName": "Dana Demo", "channel": "qr_page", "esignConsent": true, "disclosureVersion": "FL-559.905-2026-10-31" }
```

- `channel`: `qr_page` | `link` | `desk`. On the phone (`qr_page`, `link`) `esignConsent` must be `true`: the customer
  first agrees to electronic records (UETA, FL 668.50(5)(b)). At the desk it may be `false`.
- `disclosureVersion` is optional; default is the version the server ships.

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
Errors: `400 VALIDATION`, `404 NOT_FOUND`, `409 CONFLICT` (already approved, picked up, a line already decided),
`409 IN_PROGRESS`, `502 PAYPAL`.

### `POST /api/ro/:id/lines` — a new line from the mechanic or the desk

Body: one line, as in `POST /api/ro` (`title`, `priceCents`, `source`, optional `description`, `urgency`).
`201 {"line": {…, "kind": "added", "status": "proposed"}}`.
Errors: `400 VALIDATION`, `404 NOT_FOUND`, `409 CONFLICT` (repair order already picked up).

### `POST /api/ro/:id/decisions` — the customer decides on added lines

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
Errors: `400 VALIDATION` (also for an estimate line), `404 NOT_FOUND` (line not on this repair order),
`409 CONFLICT`, `409 IN_PROGRESS`, `502 PAYPAL`.

### `POST /api/orders/:orderId/refresh` — re-create an expired approval link

No body. If the link is younger than 3 hours (or PayPal already shows it approved) nothing changes:
`{"order": {…}, "refreshed": false, "approveUrl": "…"}`. Otherwise a new order with the same lines is created
(`attempt + 1`), the old one gets `supersededBy`, the consents move to the new order:
`{"order": {…new…}, "refreshed": true, "approveUrl": "…new…"}`. Calling it before showing a link is cheap (no PayPal
call while the link is fresh).
Errors: `404 NOT_FOUND`, `409 CONFLICT` (already authorized, cancelled, replaced, picked up), `502 PAYPAL`.

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
desk, nothing more happens to that hold); `in_progress` (another request is doing it; retry in a few seconds);
`retry` (PayPal gave no definite answer; send the same pickup again, it reuses the same PayPal-Request-Id and cannot
capture twice). `live` is the status from a live GET after the steps. `stopped` is set if pickup stopped early
(a capture refused for exceeding the hold, which our guard should make impossible).
Errors: `400 VALIDATION`, `404 NOT_FOUND`, `409 CONFLICT`.

### `GET /api/authorizations/:id` — live check

Live GET of the authorization and its order at PayPal, compared with our records. Statuses are taken from PayPal;
amounts are never rewritten and no money moves.

```json
{ "ok": true, "diffs": [],
  "live": { "status": "VOIDED", "amountCents": 41200, "amount": "412.00", "capturedCents": 39800, "captured": "398.00", "expirationTime": "…" },
  "authorization": { "id": "A…", "status": "VOIDED", "capturedCents": 39800, "…": "…" } }
```

A difference looks like `{"field": "captured_cents", "db": 0, "paypal": 39800}`.
Errors: `404 NOT_FOUND`, `502 PAYPAL`.

### `POST /api/jobs/reauthorize` — the scheduled job

Header `Authorization: Bearer <JOB_TOKEN>`; no body. Reauthorizes, once and for the same amount, every hold paid
with a PayPal wallet that is at least 4 days 10 minutes old, still `CREATED`, not captured, not expired, not already
reauthorized, on a repair order not picked up. `200`:

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
| event id already accepted | `200 {"received": true, "duplicate": true}` | nothing |
| verified | `200 {"received": true, "duplicate": false}` at once; processed in the background | event row, then `processed_at` and `outcome` |

What processing does:

- `CHECKOUT.ORDER.APPROVED`: if the order is ours and not yet authorized, authorize it (the same idempotent step as
  the return redirect, for a customer whose browser never came back).
- `PAYMENT.AUTHORIZATION.CREATED`: sets `confirmedAt`. `PAYMENT.AUTHORIZATION.VOIDED`: status `VOIDED` + `confirmedAt`.
- `PAYMENT.CAPTURE.COMPLETED` / `PENDING` / `DECLINED` / `REFUNDED` / `REVERSED`: the capture status, moving forward
  only (a late `PENDING` never overwrites `COMPLETED`), and `confirmedAt`. Amounts are never changed by a webhook.
- Anything else, or ids that are not ours: recorded as ignored.

PayPal says delivery is usually within 30 minutes but can take up to 3 hours, so no screen waits for a webhook.

## Screen flow (customer page `/c/:roId`)

1. `GET /api/ro/:id` → show the lines; before the first approval show the FL 559.905(2) disclosure and ask for the
   electronic-records consent.
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
the new ids. `--user-action CONTINUE` switches the approval page for a comparison. Output: `e2e-out/` (git-ignored).
