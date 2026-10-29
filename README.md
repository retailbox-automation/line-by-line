# Line by Line

Extra work at an auto repair shop gets paid only line by line, the way the customer approved it in PayPal.

When a mechanic finds something new, the customer gets each line on their phone and approves or declines it one by one. Every approved line becomes its own PayPal authorization (a hold). Declined lines never touch money. At pickup the shop captures only what was approved and voids the rest.

> Status: in active development for the PayPal AI Hackathon (submission window Oct 1 – Nov 12, 2026). This README grows with the build; every claim below links to code or a sandbox id you can check.

## Judge it in 90 seconds

| Claim | Proof | What you will see |
|---|---|---|
| Each approved line is its own PayPal hold | _added on day 2_ | |
| Capture only what was approved, void the rest | _added on day 2_ | |
| A real reauthorization on a hold older than 3 days | _added on day 7_ | |

## How it uses PayPal

PayPal Orders v2 with `intent: AUTHORIZE`, Payments v2 authorizations (capture with `final_capture: false`, void, reauthorize), webhooks with signature verification. Sandbox only. Details and the sandbox findings we hit along the way: [docs/platform-findings.md](docs/platform-findings.md).

## How it uses AI

_Filled in after the model benchmark (day 4)._

## Feedback for PayPal

[docs/sponsor-feedback.md](docs/sponsor-feedback.md) — what worked and what did not, with dates and debug details.

## License

MIT, see [LICENSE](LICENSE).
