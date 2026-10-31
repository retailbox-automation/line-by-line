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
- Change from the original plan: approval orders use `user_action: PAY_NOW` instead of `CONTINUE`. With `CONTINUE`
  PayPal shows the payer an "up to" amount above the hold, while our customer approves exactly the listed lines. The
  option stays available (`--user-action CONTINUE` in the sandbox script) for a side-by-side check.
