# Changelog

## Unreleased

- Core PayPal flows on the sandbox REST API: one `AUTHORIZE` order for the estimate and one per batch of approved new
  lines, approval links re-created after 3 hours, pickup as capture with `final_capture: false` plus void (or one full
  capture without void), reauthorization of wallet holds from day 4, reconciliation by live GET, idempotent
  PayPal-Request-Ids.
- HTTP API for the screens (`docs/api.md`), PayPal webhooks with signature verification as a second layer, sandbox
  walk-through script (`npm run e2e:sandbox`).
- Change from the original plan: approval orders use `user_action: PAY_NOW` instead of `CONTINUE`. With `CONTINUE`
  PayPal shows the payer an "up to" amount above the hold, while our customer approves exactly the listed lines. The
  option stays available (`--user-action CONTINUE` in the sandbox script) for a side-by-side check.
