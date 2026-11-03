# Sandbox evidence

Every id below is a PayPal sandbox id from a run against `api-m.sandbox.paypal.com`: `npm run e2e:sandbox` (the demo story, a sandbox buyer approved each order in a mobile browser) or the app's judge pool (holds a sandbox buyer approved four days earlier). Statuses were read back afterwards with a separate `GET` on each id. Dates are UTC.

## Demo story, 2026-10-31 14:31–14:35Z (9 of 9 checks passed)

| Step | PayPal object | Amount | Status after the run |
|---|---|---|---|
| Estimate: front brake pads + brake fluid flush, one order | order `9R8100836T065372J` | $412.00 | `COMPLETED` |
| Estimate hold | authorization `16P79573MF5922331` | $412.00 | `VOIDED` after pickup |
| New line approved: front brake rotors, its own order | order `0DE79626HT245092A` | $186.00 | `COMPLETED` |
| Rotor hold | authorization `03W92871522665144` | $186.00 | `CAPTURED` |
| New line declined: cabin air filter | no PayPal order | $39.00 | not billed |
| Pickup, estimate work came to $398: capture with `final_capture: false` | capture `6G777920EC171302S` | $398.00 (fee $14.38, net $383.62) | `COMPLETED` |
| Pickup, release the remaining $14 of the estimate hold | void on `16P79573MF5922331` | $14.00 released | `VOIDED` |
| Pickup, rotors done as approved: full capture with `final_capture: true`, no void | capture `2ST05119E70486816` | $186.00 (fee $6.98, net $179.02) | `COMPLETED` |
| Reconcile both holds against PayPal | `GET` on each authorization | — | 0 differences |

The customer paid $584.00 for the two approved lines; the declined line never touched money.

## Capture-count probe, 2026-10-31 14:35Z

Authorization `02279938GY4089153` ($5.00): 30 captures of $0.01 with `final_capture: false`, all `COMPLETED`, no `MAX_CAPTURE_COUNT_EXCEEDED`; a void afterwards left it `VOIDED`. See [platform-findings.md](platform-findings.md) rows 13–14.

## Judge pool reauthorize and pickup, 2026-11-02

16:06–16:14Z, through the app, not a script: `npm run seed:pool` recorded four holds of the pool made on 2026-10-29 (the sandbox buyer approved them that day): A1 and A2 as `judge`, B1 and B2 as `reserved` (kept for a recording, never handed out). A local server then took two judge sessions (`POST /api/judge/session`), each called `POST /api/judge/pool/reauthorize-next` once, and the desk picked up both repair orders (`POST /api/ro/:id/pickup`) with less work done than approved. Every id below was read back afterwards with a separate `GET` that does not use the app's PayPal client.

| Step | PayPal object | Amount | Status after the run |
|---|---|---|---|
| Hold A1, approved 2026-10-29, oil change + multi-point inspection | authorization `4RR33540BR8604004` (order `2D013382FG2239920`), expires 2026-11-27T16:02:00Z | $142.50 | `VOIDED` |
| Judge session 1: reauthorize-next took A1 at 16:12:17Z, age 4 days 10 min | new authorization `0MM670868D710561J`, expires 2026-11-27T16:02:01Z | $142.50 | `CREATED` until pickup, then `VOIDED` |
| Hold A2, approved 2026-10-29, front brake pads + labor | authorization `5YP64371F43512053` (order `6KC95743EL574562E`), expires 2026-11-27T16:02:01Z | $184.00 | `VOIDED` |
| Judge session 2: reauthorize-next took A2 at 16:12:26Z | new authorization `2DD92506PJ253491L`, expires 2026-11-27T16:02:02Z | $184.00 | `CREATED` until pickup, then `VOIDED` |
| A third judge session | no PayPal call | — | `409 POOL_EMPTY`: B1 and B2 are reserved and were not handed out |
| Pickup A1, work came to $130.00: capture on the NEW id with `final_capture: false` | capture `92984242RT203153G` on `0MM670868D710561J` | $130.00 (fee $5.03, net $124.97) | `COMPLETED` |
| Pickup A1, release the rest: void on the ORIGINAL id | void on `4RR33540BR8604004` at 16:13:02Z | $12.50 released | original and new id both `VOIDED` |
| Pickup A2, work came to $164.00: capture on the NEW id with `final_capture: false` | capture `8V639545C7025732D` on `2DD92506PJ253491L` | $164.00 (fee $6.21, net $157.79) | `COMPLETED` |
| Pickup A2, release the rest: void on the ORIGINAL id | void on `5YP64371F43512053` at 16:13:11Z | $20.00 released | original and new id both `VOIDED` |
| Reconcile the four authorizations against PayPal (`GET /api/authorizations/:id`) | — | — | 0 differences |
| Holds B1 `1CM060836C119894N` ($96.00), B2 `1Y214495HX657682L` ($128.75) | read only | — | still `CREATED`, `update_time` 2026-10-29 |

The order `GET` of `2D013382FG2239920` and `6KC95743EL574562E` lists both authorizations of each hold as `VOIDED` and the one capture as `COMPLETED`. See [platform-findings.md](platform-findings.md) rows 15–18.

## Hosted demo, the full story in a browser, 2026-11-03 14:48–14:53Z

Run on the hosted demo (desk at 1440 px, the two phones at 390 px), as a judge would: a new judge session, the sandbox buyer approving in a mobile browser, statuses read back afterwards with a separate `GET` on each id.

| Step | PayPal object | Amount | Status after the run |
|---|---|---|---|
| Estimate approved on the customer page after the Florida 559.905(2) statement and the e-records consent (four price-list lines) | order `1SB68118SA4622349` → authorization `8SL27553M3586882A` | $412.00 | `VOIDED` after pickup |
| Mechanic's recorded note F02 → line "Front brake rotors — replace (pair)", Safety, price from the list (`BRK-ROT-F`) → customer approved it on its own | order `8TD78129F1542400U` → authorization `0F2716879V776490B` | $186.00 | `CAPTURED` |
| "Cabin air filter — replace", customer tapped "Not now" | no PayPal order | $39.00 | not billed |
| Pickup: estimate work came to $398, capture with `final_capture: false`, then void of the remaining $14 | capture `8L207537F5667934E` | $398.00 (fee $14.38) | `COMPLETED` |
| Pickup: rotors in full, `final_capture: true`, no void | capture `6AV85540J9784725A` | $186.00 (fee $6.98) | `COMPLETED` |

Total $584.00, net $562.64. The cabin filter line was added through the API in this run: without a language model the keyword drafting does not match "cabin filter" in note F03 to the price-list item "Cabin air filter" (it is one of the 20 misses of the no-model baseline in `eval/`).

## A buyer from another sandbox, 2026-11-03 15:02–15:07Z

PayPal told hackathon participants on 2026-10-25 that judges test with their own sandboxes. To check that path, a judge session on the hosted demo created the $412.00 demo estimate, and a sandbox buyer from a different PayPal developer account (not the one that owns our REST app) approved it. Its default funding was the bank account in its sandbox wallet.

| Step | PayPal object | Amount | Status |
|---|---|---|---|
| `POST /api/judge/demo`, 15:02:30Z | order `3CU42758521717259` | $412.00 | `PAYER_ACTION_REQUIRED` |
| Approved by the other sandbox's buyer, "Review Order", return to `/api/paypal/return` | authorization `53712651KB727854G`, created 15:06:19Z | $412.00 | `CREATED`, expires 2026-12-02T15:06:19Z |
| `PAYMENT.AUTHORIZATION.CREATED` webhook (signature verified) marked it confirmed | `confirmedAt` 15:06:38Z, 19 s after the hold | | |
| `GET /api/authorizations/53712651KB727854G` (live read at PayPal), 15:06:57Z | | $412.00, captured $0.00 | `CREATED`, no differences from our record |

The hold was left `CREATED` (no capture, no void).
