# Changelog

## Unreleased

- Core PayPal flows on the sandbox REST API: one `AUTHORIZE` order for the estimate and one per batch of approved new
  lines, approval links re-created after 3 hours, pickup as capture with `final_capture: false` plus void (or one full
  capture without void), reauthorization of wallet holds from day 4, reconciliation by live GET, idempotent
  PayPal-Request-Ids.
- HTTP API for the screens (`docs/api.md`), PayPal webhooks with signature verification as a second layer, sandbox
  walk-through script (`npm run e2e:sandbox`).
- Access: desk and mechanic routes need `DESK_TOKEN` (bearer); the customer page uses a per-repair-order token from
  its link (`/c/:roId?k=…`), which opens only that repair order and only the customer's steps. PayPal's redirects and
  webhooks need no token.
- Races closed: a pickup working from an old snapshot cannot capture again; pickup waits while an authorize of the same
  repair order is running; a cancel link is checked against PayPal and refused while an authorize is running or done;
  a refresh that loses to an approval of the old link keeps the old order; every authorized order is settled and a line
  is billed on one hold only.
- Webhooks: an event counts as handled only once it was processed. A processing that failed for a passing reason is
  retried on a redelivery and by a sweep (at start and every 5 minutes), at most 12 attempts.
- Approval orders use `user_action: CONTINUE`, as planned. A live side-by-side on the sandbox mobile approval page
  (2026-10-31) showed the line name, description and exact amount in both modes and no "up to" amount; `PAY_NOW` only
  relabels the button "Pay". `--user-action PAY_NOW` in the sandbox script keeps the comparison possible.
- AI module `src/agent/`: price list with validation (`data/price-list.json`), voice note to price-list lines (`keywords`,
  `recorded:` and `groq:` providers; the price always comes from the list), speech to text, and `voiceToLines`. Groq calls
  are refused before any network use unless `LBL_LLM_LIVE=1`.
- Benchmark `npm run eval` on 32 synthetic voice notes (`eval/`): exact notes, precision, recall, invented codes, urgency,
  WER with spoken numbers normalized, latency. Lower bound without a model: 16/32 on the note text, 12/32 after local speech
  recognition.
