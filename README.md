# Line by Line

Extra work at an auto repair shop gets paid only line by line, the way the customer approved it in PayPal.

When a mechanic finds something new, the customer gets each line on their phone and approves or declines it one by one. Every approved line becomes its own PayPal authorization (a hold). Declined lines never touch money. At pickup the shop captures only what was approved and voids the rest.

> Status: in active development for the PayPal AI Hackathon (submission window Oct 1 – Nov 12, 2026). This README grows with the build; every claim below links to code or a sandbox id you can check.

## Judge it in 90 seconds

| Claim | Proof | What you will see |
|---|---|---|
| Each approved line is its own PayPal hold | [sandbox evidence](docs/sandbox-evidence.md): estimate order `9R8100836T065372J`, rotor line order `0DE79626HT245092A`, declined filter line has no order | two authorizations, one per approval; nothing for the declined line |
| Capture only what was approved, void the rest | [sandbox evidence](docs/sandbox-evidence.md): capture `6G777920EC171302S` ($398 of $412, then void) and `2ST05119E70486816` ($186 in full, no void) | estimate hold `VOIDED` with $398 captured; rotor hold `CAPTURED` |
| A real reauthorization on a hold older than 3 days | _added on day 7_ | |

## How it uses PayPal

PayPal Orders v2 with `intent: AUTHORIZE`, Payments v2 authorizations (capture with `final_capture: false`, void, reauthorize), webhooks with signature verification. Sandbox only. Details and the sandbox findings we hit along the way: [docs/platform-findings.md](docs/platform-findings.md).

## How it uses AI

The module in `src/agent/` turns what a mechanic dictates into lines of the shop's price list (code, urgency, a sentence for the customer). The API offers it as a draft the mechanic confirms line by line (`POST /api/ro/:id/voice`, `/lines/draft`, and 32 recorded samples for judges, see [docs/api.md](docs/api.md)); the screens do not call it yet. The model only names price-list codes: the price always comes from the list, and a code that is not in the list is dropped and counted as invented.

What we measure: how often the lines of a note match what a service writer would add, on 32 synthetic notes (spoken by text-to-speech, labeled by us; see [eval/README.md](eval/README.md)). Without any model, keyword matching on the price list gets 16/32 notes exactly right on the note text and 12/32 after local speech recognition. A model has to beat that.

```bash
npm run eval -- --replay
```

No key and no network: it replays recorded speech recognition and prints the numbers.

## Feedback for PayPal

[docs/sponsor-feedback.md](docs/sponsor-feedback.md) — what worked and what did not, with dates and debug details.

## Run locally

Node 22 or newer. Values come from the environment only; `.env.example` lists the names, never values.

```bash
npm ci
npm test                      # unit and integration tests, no network
npm run build && npm start    # API on PORT (default 8080), migrations run on start
```

| Variable | Needed | What it is |
|---|---|---|
| `PAYPAL_SANDBOX_CLIENT_ID`, `PAYPAL_SANDBOX_CLIENT_SECRET` | yes | a PayPal sandbox REST app (live keys are refused) |
| `PUBLIC_BASE_URL` | yes | the public address of the app; PayPal sends the customer back to it |
| `DESK_TOKEN` | yes | bearer token of the desk and mechanic screens, at least 16 characters; customer links are derived from it |
| `DATABASE_URL` | for a real run | Postgres; without it a local in-process database is used (`PGLITE_DIR` keeps it on disk) |
| `PAYPAL_WEBHOOK_ID` | for webhooks | the webhook route answers 503 without it |
| `JOB_TOKEN` | for the reauthorize job | bearer token of `POST /api/jobs/reauthorize`, at least 16 characters |
| `PORT`, `BRAND_NAME` | no | listening port; the shop name on the PayPal page |
| `LBL_STT`, `LBL_LLM`, `LBL_LLM_RECORDED` | no | speech recognition for live voice notes (unset = off), line drafting (default `keywords`), recorded line answers for the samples |
| `LBL_LIVE_DAILY_CAP`, `LBL_JUDGE_DAILY_SESSIONS`, `LBL_JUDGE_LIVE_VOICE` | no | paid model calls per day (200), judge sessions per day (200), live audio for judges (`1`; default off) |
| `GROQ_API_KEY`, `LBL_LLM_LIVE` | for a `groq:` provider | both are needed; without `LBL_LLM_LIVE=1` no paid call is made |

The API contract is in [docs/api.md](docs/api.md). `npm run e2e:sandbox` walks the whole story against the sandbox; it
prints each approval link for you to approve as the sandbox buyer.

## License

MIT, see [LICENSE](LICENSE).
