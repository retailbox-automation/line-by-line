# Feedback for PayPal (kept from day 1 of the build)

What helped and what got in the way while integrating PayPal for Line by Line. Dates are UTC. Technical details for each item are in [platform-findings.md](platform-findings.md).

## What worked well
- Partial captures plus void on a wallet authorization worked in sandbox with no account switch to flip (2026-10-20).
- Sandbox buyer approval with `user_action: CONTINUE` and `shipping_preference: NO_SHIPPING` is a short flow: email, password, Review Order, back to the shop (2026-10-29, four orders approved in a row in one browser session).
- The DevRel team answers in Discord fast and with doc quotes (webhook timing, disputes, partial capture limits).

## What got in the way
- Hosted sandbox MCP returned `Unsupported cache mode: default` again on 2026-10-29 15:59Z for `get_order` and `list_transactions`, after the 2026-10-09 fix. The error comes back as a normal tool result (`isError` unset).
- The MCP server has no tools for the authorization lifecycle (authorize, capture an authorization, void, reauthorize), so a hold-based product cannot run its money path through MCP.
- Reauthorize documentation reads three ways ("only once", "multiple re-authorizations", "from 4 to 29 days after the 3-day honor period"); in sandbox the new id keeps the parent's expiry.
- The POST reauthorize response links point to the parent id.

## Rating draft
To be set in the submission form after the build; this file is the source for the "why".
