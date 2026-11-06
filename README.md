# Line by Line

Extra work at an auto repair shop gets paid only line by line, the way the customer approved it in PayPal.

When a mechanic finds something new, the customer gets each line on their phone and approves or declines it one by one. Each approval becomes its own PayPal authorization (a hold): the customer page approves one line at a time, and the API also takes several lines in one approval. A declined line gets no PayPal order. At pickup the shop captures the final amount of each approved job from its hold, and the unused part of the hold is released.

Why: in Cox Automotive's November 2025 service study, 45% of vehicle owners were dissatisfied with dealership service, "primarily due to unexpected costs and poor communication" ([press release, PDF](https://www.coxautoinc.com/wp-content/uploads/2025/11/Press-Release_CAI-Service-Study-Nov-2025_FINAL.pdf)). The idea came from the author's own service visit: $801 of recommended work, about $391 of it needed, four lines declined.

> Status: in active development for the PayPal AI Hackathon (submission window Oct 1 to Nov 12, 2026). This README grows with the build; the claims below point to code or to sandbox ids you can check.

**Live demo (PayPal sandbox):** https://linebyline.retailbox-automation.com. Press "Start a demo repair order" and approve with your own PayPal sandbox buyer.

**Video (2:22):** https://youtu.be/stZtetLOE2s

## Judge it in 90 seconds

| Claim | Proof | What you will see |
|---|---|---|
| Each approved line is its own PayPal hold | [hosted demo run](docs/sandbox-evidence.md#hosted-demo-the-full-story-in-a-browser-2026-11-03-14481453z): estimate order `1SB68118SA4622349`, rotor line order `8TD78129F1542400U`, the declined cabin filter line has no order | two authorizations, one per approval; nothing for the declined line |
| Pickup takes the final amount of each approved job from its own hold | same run: capture `8L207537F5667934E` ($398 of the $412 estimate hold, then a void) and `6AV85540J9784725A` ($186 in full, no void) | estimate hold `VOIDED` with $398 captured; rotor hold `CAPTURED` |
| A real reauthorization on a hold older than 3 days | [sandbox evidence](docs/sandbox-evidence.md#judge-pool-reauthorize-and-pickup-2026-11-02): 4-day-old holds `4RR33540BR8604004` → `0MM670868D710561J` and `5YP64371F43512053` → `2DD92506PJ253491L` through `POST /api/judge/pool/reauthorize-next` (a local server on 2 Nov), then pickup captured $130.00 (`92984242RT203153G`) and $164.00 (`8V639545C7025732D`) on the new ids and voided the originals | new ids `CREATED` with the same amount and no new 29 days (expiry one second after the original's); after pickup the captures `COMPLETED`, both ids of each hold `VOIDED` |
| An AI model drafts each repair line from the mechanic's voice note; the price always comes from the shop's list | [eval/README.md](eval/README.md): 32 synthetic voice notes labeled by us; keyword matching gets 12/32 after speech recognition, `gpt-oss-120b` on Groq gets 32/32 with no invented codes; on 48 harder, noisier notes it gets 37/48 (`gpt-oss-20b` 32/48) | `npm run eval -- --replay --llm recorded:gpt-oss-120b-parakeet` with no key and no network prints the same numbers |
| The reauthorization in the video is real | [sandbox evidence](docs/sandbox-evidence.md#two-real-reauthorizations-on-day-7-2026-11-05): holds approved on October 29, reauthorized through the hosted judge page on November 5: `1CM060836C119894N` → `9ET49300M3905934C` ($96.00) and `1Y214495HX657682L` → `1E838569N46612115` ($128.75) | new ids `CREATED`, same amounts, expiry one second after the parent's |
| Your own sandbox buyer works | [sandbox evidence](docs/sandbox-evidence.md#a-buyer-from-another-sandbox-2026-11-03-15021507z): a buyer from another developer's sandbox approved order `3CU42758521717259` → authorization `53712651KB727854G` ($412.00) | `CREATED`; our webhook handler confirmed it 19 seconds later |

What you can check live yourself: the judge page (https://linebyline.retailbox-automation.com/judge) reads at PayPal the holds of your own run and of the pool. Holds for judges are added in waves from mid-November; until then the page says "No free hold right now". The other ids above are recorded with their statuses in [docs/sandbox-evidence.md](docs/sandbox-evidence.md).

## Try the demo

1. Open the [demo](https://linebyline.retailbox-automation.com) and press "Start a demo repair order". You get the service desk with a $412 estimate of four price-list lines.
2. Open the customer page ("Copy link" or "QR code"). It shows Florida's estimate statement and asks for consent to electronic records, then "Approve with PayPal". Approve as your own sandbox buyer.
3. "Open mechanic phone": pick one of the recorded notes, check the drafted line, "Send to customer". Do it twice.
4. On the customer page, approve one new line and tap "Not now" on the other.
5. Back at the desk, "Pickup": enter what the work came to. The desk shows each capture, its fee and what was released, from PayPal's answer.

| Step | Live or prepared |
|---|---|
| Repair order, PayPal orders, your approval, authorization, decisions, pickup, captures and voids | live, PayPal sandbox |
| Voice step | prepared: 32 recorded notes (synthetic voices), their speech recognition and the model's answers recorded on 2026-11-03 (see "How it uses AI"); text you type into the draft box goes to the model live |
| Reauthorization | a live call on a hold made days earlier (`/api/judge/pool`), because PayPal allows it only from day 4 |
| Shop, price list, customer | made up for the demo |

## How it uses PayPal

- Orders v2 with `intent: AUTHORIZE`: one order for the estimate and one for each approval of new lines (the customer page approves one line at a time; the API also takes several at once). A declined line creates no order.
- Payments v2 authorizations: capture with `final_capture: false` and then a void of the rest, or one full capture with no void; reauthorize once, for the same amount, on PayPal-wallet holds from day 4. A reauthorized hold keeps its original expiry, so the screens show that date.
- Every capture pays its own fee, read from PayPal's answer: $14.38 on $398 and $6.98 on $186 in the run above (3.49% + $0.49). That is why the shop captures once per hold at pickup.
- `PayPal-Request-Id` on every POST that creates an order or moves money; a live `GET` of each hold after pickup and whenever you ask (`GET /api/authorizations/:id` compares PayPal with our record); webhooks with signature verification as a second layer, since a webhook can come late and the screens poll.
- Sandbox only. What we ran into along the way: [docs/platform-findings.md](docs/platform-findings.md).

## Florida's repair rules, in code

Before the first approval the customer page shows the written-estimate statement of Fla. Stat. 559.905(2) and asks for consent to electronic records; each approval's consent record is kept with its PayPal id (a declined line has none, since no order is made). One gap in the demo: "Start a demo repair order" writes a placeholder consent for the estimate ("Demo customer") before the customer signs; their signature then replaces the placeholder name and adds the statement they chose, but the consent time stays the button's. The desk shows the 559.909 tolerance computed in code ([src/rules/florida.ts](src/rules/florida.ts): $10 or 10%, whichever is greater, at most $50). The demo is stricter than the statute: a new line always gets its own approval, whatever the tolerance. Not legal advice.

## How it uses AI

`src/agent/` turns a mechanic's voice note into lines of the shop's price list: the code, the urgency and a sentence for the customer. The price always comes from the list. A code that is not in the list is dropped and counted as invented. The mechanic confirms each line before it goes to the customer.

The demo drafts lines with `openai/gpt-oss-120b` on Groq (free tier, with zero data retention switched on). The mechanic's screen uses 32 recorded notes: their speech recognition was recorded with a local model (parakeet), and the model's answers for them are cached, so a click on a sample makes no model call. Text typed into the draft box goes to the model live, within a daily ceiling on the server.

What we measure: how often the lines of a note match what a service writer would add, on 32 synthetic notes (spoken by text-to-speech, labeled by us; see [eval/README.md](eval/README.md)). Keyword matching on the price list gets 16/32 notes exactly right on the note text and 12/32 after speech recognition. `gpt-oss-120b` gets 32/32 on both, with no invented codes, and the urgency right on 25 of 33 lines after speech recognition (`gpt-oss-20b`: also 32/32, urgency 19/33). On this set the models no longer differ on codes, so we added a harder set of 48 notes (several jobs in one note, work already done or declined, price-list words that are not a job, shop slang, self-corrections, louder shop noise; labels checked blind by two independent labelers). After speech recognition `gpt-oss-120b` gets 37/48, `gpt-oss-20b` 32/48 (5 of its answers broke the JSON schema), keyword matching 8/48; five of the 48 transcripts are noise, so 43 is the ceiling. On the clean note text `gpt-oss-20b` gets 47/48: the hard part is the noisy transcript, not the line step.

```bash
npm run eval -- --replay
```

No key and no network: it replays recorded speech recognition and prints the numbers; add `--llm recorded:gpt-oss-120b-parakeet` to replay the model's answers, and `--set hard` for the hard set.

## PayPal's AI tools

The product does not use them. We tried PayPal's hosted sandbox MCP server on 2026-10-29. It lists 46 tools, none of them for the authorization lifecycle (authorize, capture of an authorization, void, reauthorize), and `get_order` answered `Unsupported cache mode: default` as a normal result. A product built on holds cannot move its money through it, so the money path is plain REST. Details: rows 7 and 8 of [docs/platform-findings.md](docs/platform-findings.md).

## Feedback for PayPal

[docs/sponsor-feedback.md](docs/sponsor-feedback.md) lists what worked and what did not, with dates and debug details.

## Run locally

Node 22 or newer. Values come from the environment only; `.env.example` lists the names, never values.

```bash
npm ci
npm test                      # 430 unit and integration tests in 36 files, no network
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
