# PayPal sandbox: what we found while building

Every row was observed in the PayPal sandbox (REST, `api-m.sandbox.paypal.com`) or the hosted sandbox MCP server (`mcp.sandbox.paypal.com/sse`). Ids are sandbox ids. Dates are UTC.

| # | Finding | Evidence | What we do about it |
|---|---|---|---|
| 1 | Several partial captures on one PayPal-wallet authorization work out of the box; void after them releases the rest and keeps the captures `COMPLETED` | 2026-10-20: authorization `1H7592654L254671E` ($100) → captures `69B57704CF822280F` ($31.20) and `95949137LX651323E` ($18.72) with `final_capture: false`, then void → `VOIDED` | capture approved lines with `final_capture: false`, then void the remainder |
| 2 | Each capture pays its own fee: 3.49% + $0.49 | same captures: fee $1.58 on $31.20, $1.14 on $18.72 (`seller_receivable_breakdown.paypal_fee`) | one capture per approved order at pickup, never per minute or per line item |
| 3 | Reauthorize on day 0 is refused | 2026-10-20: 422 `REAUTHORIZATION_TOO_SOON` | the reauthorize job runs from day 4 |
| 4 | Reauthorize on day 4 succeeds but does not move the 29-day horizon | 2026-10-24 09:42Z: `7CC573503L377791N` → new id `2G84834775966423X`, `expiration_time` stays 2026-11-18T04:09Z; the parent stays `CREATED` | the UI shows the original expiry; we never promise a longer hold |
| 5 | A reauthorization cannot be voided; only the parent can | void of `2G84834775966423X` → 422 `CANNOT_BE_VOIDED` ("void the original parent authorization") | void always goes to the parent id |
| 6 | The `links` in the POST reauthorize response point to the old id | same call; GET on the new id returns the right links | we store the id from the body, not from `links` |
| 7 | Hosted sandbox MCP: `initialize` and `tools/list` work (46 tools), but `get_order` and `list_transactions` return `{"ok":false,"code":"PAYPAL_API_SETUP_ERROR","message":"Unsupported cache mode: default"}` with `isError` unset, so a client cannot tell the call failed without parsing the text. The same token gets 200 from REST in the same second | 2026-10-29 15:59Z, order `7LK770742U167582X`; also reported on `paypal/AI-Toolkit#34` (2026-10-29 00:00Z) | money moves through REST only; the MCP read is an optional second witness, and its error text is checked explicitly |
| 8 | The MCP tool list has `create_order`, `get_order`, `pay_order` but no authorize, capture of an authorization, void or reauthorize | same `tools/list`, 2026-10-29 | the hold lifecycle is REST (Orders v2 + Payments v2) |
| 9 | Payouts to Venmo are not available in sandbox | 2026-10-20: 400 "Recipient wallet not supported in sandbox" | not used |
