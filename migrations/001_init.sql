-- Line by Line: only our own records (repair order, line, decision, amount, time, PayPal ids).
-- No payer data (name, e-mail, address, payer_id) is stored anywhere.

CREATE TABLE repair_orders (
  id             text PRIMARY KEY,
  customer_label text NOT NULL,              -- a made-up demo name, not PayPal data
  state          text NOT NULL DEFAULT 'FL',
  status         text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'picked_up')),
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE lines (
  id              text PRIMARY KEY,
  ro_id           text NOT NULL REFERENCES repair_orders(id),
  kind            text NOT NULL CHECK (kind IN ('estimate', 'added')),
  title           text NOT NULL,
  description     text NOT NULL DEFAULT '',
  price_cents     integer NOT NULL CHECK (price_cents > 0),
  urgency         text NULL CHECK (urgency IN ('safety', 'soon', 'can_wait')),
  source          text NOT NULL CHECK (source IN ('desk', 'mechanic')),
  status          text NOT NULL DEFAULT 'proposed'
                  CHECK (status IN ('proposed', 'sent', 'approved', 'declined', 'performed', 'not_performed')),
  performed_cents integer NULL CHECK (performed_cents >= 0),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX lines_ro ON lines (ro_id);

-- One row per customer decision on one line (KB 2.5 consent record).
CREATE TABLE consents (
  id                      text PRIMARY KEY,
  ro_id                   text NOT NULL REFERENCES repair_orders(id),
  line_id                 text NOT NULL REFERENCES lines(id),
  decision                text NOT NULL CHECK (decision IN ('approved', 'declined')),
  decided_at              timestamptz NOT NULL,
  channel                 text NOT NULL CHECK (channel IN ('qr_page', 'link', 'desk')),
  approver_name           text NOT NULL,
  esign_consent           boolean NOT NULL,
  disclosure_version      text NOT NULL,
  amount_cents            integer NOT NULL,   -- the line amount the customer saw ("added_amount")
  new_total_cents         integer NOT NULL,   -- approved total of the repair order after this decision
  paypal_order_id         text NULL,
  paypal_authorization_id text NULL
);
CREATE INDEX consents_ro ON consents (ro_id);
CREATE INDEX consents_line ON consents (line_id);

CREATE TABLE paypal_orders (
  id            text PRIMARY KEY,              -- PayPal order id
  ro_id         text NOT NULL REFERENCES repair_orders(id),
  purpose       text NOT NULL CHECK (purpose IN ('estimate', 'added')),
  line_ids      jsonb NOT NULL,                -- sorted array of line ids
  amount_cents  integer NOT NULL CHECK (amount_cents > 0),
  status        text NOT NULL,                 -- PayPal order status, or CANCELLED (payer cancelled)
  approve_url   text NULL,
  request_id    text NOT NULL UNIQUE,
  attempt       integer NOT NULL,
  superseded_by text NULL,
  created_at    timestamptz NOT NULL
);
CREATE INDEX paypal_orders_ro ON paypal_orders (ro_id);

CREATE TABLE authorizations (
  id               text PRIMARY KEY,           -- PayPal authorization id
  paypal_order_id  text NOT NULL REFERENCES paypal_orders(id),
  ro_id            text NOT NULL REFERENCES repair_orders(id),
  parent_id        text NULL REFERENCES authorizations(id),  -- set on a reauthorization
  amount_cents     integer NOT NULL,
  captured_cents   integer NOT NULL DEFAULT 0 CHECK (captured_cents >= 0),
  status           text NOT NULL,              -- PayPal authorization status
  payment_source   text NOT NULL CHECK (payment_source IN ('paypal', 'card', 'unknown')),
  expiration_time  timestamptz NULL,
  created_at       timestamptz NOT NULL,       -- PayPal create_time of this authorization
  reauthorized_to  text NULL,
  reauthorized_at  timestamptz NULL,
  needs_attention  text NULL,                  -- reason; NULL = fine
  confirmed_at     timestamptz NULL,           -- "Confirmed by PayPal" (webhook, second layer)
  CHECK (captured_cents <= amount_cents)
);
CREATE INDEX authorizations_ro ON authorizations (ro_id);
CREATE INDEX authorizations_order ON authorizations (paypal_order_id);

CREATE TABLE captures (
  id               text PRIMARY KEY,           -- PayPal capture id
  authorization_id text NOT NULL REFERENCES authorizations(id),
  amount_cents     integer NOT NULL CHECK (amount_cents > 0),
  final_capture    boolean NOT NULL,
  status           text NOT NULL,
  fee_cents        integer NULL,
  net_cents        integer NULL,
  request_id       text NOT NULL UNIQUE,
  created_at       timestamptz NOT NULL,
  confirmed_at     timestamptz NULL
);
CREATE INDEX captures_auth ON captures (authorization_id);

CREATE TABLE paypal_calls (
  id          bigserial PRIMARY KEY,
  at          timestamptz NOT NULL,
  op          text NOT NULL,
  method      text NOT NULL,
  path        text NOT NULL,
  request_id  text NULL,
  http_status integer NULL,
  debug_id    text NULL,
  resource_id text NULL,
  issue       text NULL
);

CREATE TABLE webhook_events (
  id           text PRIMARY KEY,               -- PayPal event id
  event_type   text NOT NULL,
  resource_id  text NULL,
  verified     boolean NOT NULL,
  received_at  timestamptz NOT NULL,
  processed_at timestamptz NULL,
  outcome      text NULL
);

-- Idempotency journal: a row per PayPal-Request-Id, written before the POST.
CREATE TABLE ops (
  request_id text PRIMARY KEY,
  op         text NOT NULL,
  entity_id  text NOT NULL,
  state      text NOT NULL CHECK (state IN ('started', 'done', 'failed')),
  result     jsonb NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX ops_entity ON ops (op, entity_id);
