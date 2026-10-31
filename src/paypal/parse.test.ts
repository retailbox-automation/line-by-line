import { describe, expect, it } from "vitest";
import { parseAuthorization, parseCapture, parseOrder, PayPalParseError } from "./parse.js";

// Shapes from the recorded sandbox calls; payer data replaced by placeholders.
const PAYER_EMAIL = "payer.placeholder@example.test";

const authorizedOrder = {
  id: "2D013382FG2239920",
  intent: "AUTHORIZE",
  status: "COMPLETED",
  payment_source: { paypal: { email_address: PAYER_EMAIL, account_id: "PAYERPLACEHOLDER1", account_status: "VERIFIED", name: { given_name: "PlaceholderGiven", surname: "PlaceholderSurname" }, address: { country_code: "US" } } },
  purchase_units: [
    {
      reference_id: "RO-2910-A-A1",
      amount: { currency_code: "USD", value: "142.50", breakdown: { item_total: { currency_code: "USD", value: "142.50" } } },
      payee: { email_address: "merchant.placeholder@example.test", merchant_id: "MERCHANTPLACEHLD" },
      payments: {
        authorizations: [
          {
            status: "CREATED",
            id: "4RR33540BR8604004",
            amount: { currency_code: "USD", value: "142.50" },
            expiration_time: "2026-11-27T16:02:00Z",
            create_time: "2026-10-29T16:02:00Z",
            links: [{ href: "https://api.sandbox.paypal.com/v2/payments/authorizations/4RR33540BR8604004", rel: "self", method: "GET" }],
          },
        ],
      },
    },
  ],
  payer: { name: { given_name: "PlaceholderGiven", surname: "PlaceholderSurname" }, email_address: PAYER_EMAIL, payer_id: "PAYERPLACEHOLDER1" },
};

describe("parseOrder", () => {
  it("reads a created order and its payer-action link", () => {
    const o = parseOrder({
      id: "2D013382FG2239920",
      status: "PAYER_ACTION_REQUIRED",
      payment_source: { paypal: {} },
      purchase_units: [{ amount: { currency_code: "USD", value: "142.50" } }],
      links: [
        { href: "https://api.sandbox.paypal.com/v2/checkout/orders/2D013382FG2239920", rel: "self", method: "GET" },
        { href: "https://www.sandbox.paypal.com/checkoutnow?token=2D013382FG2239920", rel: "payer-action", method: "GET" },
      ],
    });
    expect(o).toMatchObject({ id: "2D013382FG2239920", status: "PAYER_ACTION_REQUIRED", amountCents: 14250, approveUrl: "https://www.sandbox.paypal.com/checkoutnow?token=2D013382FG2239920", authorizations: [] });
  });

  it("reads the authorization from an authorized order and keeps no payer data", () => {
    const o = parseOrder(authorizedOrder);
    expect(o.paymentSource).toBe("paypal");
    expect(o.authorizations).toEqual([
      { id: "4RR33540BR8604004", status: "CREATED", amountCents: 14250, expirationTime: new Date("2026-11-27T16:02:00Z"), createTime: new Date("2026-10-29T16:02:00Z"), orderId: "2D013382FG2239920" },
    ]);
    const s = JSON.stringify(o);
    for (const m of [PAYER_EMAIL, "PlaceholderGiven", "PAYERPLACEHOLDER1", "merchant.placeholder"]) expect(s).not.toContain(m);
  });

  it("tells card from wallet", () => {
    expect(parseOrder({ ...authorizedOrder, payment_source: { card: { last_digits: "1881" } } }).paymentSource).toBe("card");
    expect(parseOrder({ ...authorizedOrder, payment_source: {} }).paymentSource).toBe("unknown");
  });

  it("refuses an order without id or status", () => {
    expect(() => parseOrder({ status: "CREATED" })).toThrow(PayPalParseError);
    expect(() => parseOrder({ id: "X" })).toThrow(PayPalParseError);
    expect(() => parseOrder(null)).toThrow(PayPalParseError);
  });

  it("reads captures listed in an order with their authorization from the up link", () => {
    const o = parseOrder({
      ...authorizedOrder,
      purchase_units: [
        {
          ...authorizedOrder.purchase_units[0],
          payments: {
            authorizations: authorizedOrder.purchase_units[0]!.payments.authorizations,
            captures: [
              {
                id: "69B57704CF822280F",
                status: "COMPLETED",
                amount: { currency_code: "USD", value: "31.20" },
                final_capture: false,
                links: [{ href: "https://api.sandbox.paypal.com/v2/payments/authorizations/1H7592654L254671E", rel: "up", method: "GET" }],
              },
            ],
          },
        },
      ],
    });
    expect(o.captures).toEqual([{ id: "69B57704CF822280F", status: "COMPLETED", amountCents: 3120, finalCapture: false, feeCents: null, netCents: null, authorizationId: "1H7592654L254671E" }]);
  });
});

describe("parseAuthorization", () => {
  it("takes the id from the body, not from links (reauthorize 2026-10-24)", () => {
    const a = parseAuthorization({
      id: "2G84834775966423X",
      status: "CREATED",
      amount: { currency_code: "USD", value: "50.00" },
      supplementary_data: { related_ids: { order_id: "7HJ605220P754121R" } },
      expiration_time: "2026-11-18T04:09:32Z",
      create_time: "2026-10-24T09:42:57Z",
      links: [{ href: "https://api.sandbox.paypal.com/v2/payments/authorizations/7CC573503L377791N", rel: "self", method: "GET" }],
    });
    expect(a).toMatchObject({ id: "2G84834775966423X", orderId: "7HJ605220P754121R", amountCents: 5000 });
    expect(a.expirationTime?.toISOString()).toBe("2026-11-18T04:09:32.000Z");
  });

  it("reads offset timestamps of a void answer", () => {
    const a = parseAuthorization({ id: "1H7592654L254671E", status: "VOIDED", amount: { currency_code: "USD", value: "100.00" }, expiration_time: "2026-11-17T20:08:43-08:00", create_time: "2026-10-19T21:08:43-07:00" });
    expect(a.expirationTime?.toISOString()).toBe("2026-11-18T04:08:43.000Z");
    expect(a.createTime?.toISOString()).toBe("2026-10-20T04:08:43.000Z");
  });

  it("is strict about the amount (it guards captures)", () => {
    expect(() => parseAuthorization({ id: "A", status: "CREATED", amount: { currency_code: "EUR", value: "1.00" } })).toThrow(PayPalParseError);
    expect(() => parseAuthorization({ id: "A", status: "CREATED" })).toThrow(PayPalParseError);
  });
});

describe("parseCapture", () => {
  it("reads fee and net (capture 2026-10-20)", () => {
    const c = parseCapture({
      id: "69B57704CF822280F",
      amount: { currency_code: "USD", value: "31.20" },
      final_capture: false,
      seller_receivable_breakdown: { gross_amount: { currency_code: "USD", value: "31.20" }, paypal_fee: { currency_code: "USD", value: "1.58" }, net_amount: { currency_code: "USD", value: "29.62" }, exchange_rate: {} },
      status: "COMPLETED",
    });
    expect(c).toEqual({ id: "69B57704CF822280F", status: "COMPLETED", amountCents: 3120, finalCapture: false, feeCents: 158, netCents: 2962, authorizationId: null });
  });

  it("never throws on an odd breakdown after money moved", () => {
    const c = parseCapture({ id: "C1", status: "COMPLETED", amount: { currency_code: "USD", value: "bad" }, seller_receivable_breakdown: { paypal_fee: { currency_code: "XAF", value: "1" } } });
    expect(c).toMatchObject({ id: "C1", amountCents: null, feeCents: null, netCents: null, finalCapture: null });
  });

  it("requires id and status", () => {
    expect(() => parseCapture({ status: "COMPLETED" })).toThrow(PayPalParseError);
  });
});
