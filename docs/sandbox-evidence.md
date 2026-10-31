# Sandbox evidence

Every id below is a PayPal sandbox id from a run of `npm run e2e:sandbox` (the demo story) against `api-m.sandbox.paypal.com`. A sandbox buyer approved each order in a mobile browser. Statuses were read back afterwards with a separate `GET` on each id. Dates are UTC.

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
