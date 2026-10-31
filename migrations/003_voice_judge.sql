-- Voice note lines and judge mode. Audio and transcripts are never stored (a judge's voice is personal data).

-- A line taken from the price list keeps its code; its price and title came from the list.
ALTER TABLE lines ADD COLUMN price_code text NULL;

-- 'pool': a repair order made by scripts/seed-pool.ts around an aged hold that already exists at PayPal.
ALTER TABLE repair_orders ADD COLUMN kind text NOT NULL DEFAULT 'shop' CHECK (kind IN ('shop', 'pool'));

-- One row per judge session (POST /api/judge/session). The token is signed; this row holds the counters.
CREATE TABLE judge_sessions (
  id           text PRIMARY KEY,
  created_at   timestamptz NOT NULL,
  expires_at   timestamptz NOT NULL,
  ro_count     integer NOT NULL DEFAULT 0 CHECK (ro_count >= 0),
  reauthorized boolean NOT NULL DEFAULT false
);
CREATE INDEX judge_sessions_created ON judge_sessions (created_at);

-- A repair order created in a judge session is open to that session only.
ALTER TABLE repair_orders ADD COLUMN judge_session_id text NULL REFERENCES judge_sessions(id);
CREATE INDEX repair_orders_judge ON repair_orders (judge_session_id);

-- Aged holds for the judges. 'reserved' holds are listed but never handed out and never reauthorized automatically.
CREATE TABLE judge_pool (
  authorization_id text PRIMARY KEY REFERENCES authorizations(id),
  label            text NOT NULL,
  purpose          text NOT NULL CHECK (purpose IN ('judge', 'reserved')),
  wave             integer NOT NULL CHECK (wave >= 0),
  note             text NOT NULL DEFAULT '',
  added_at         timestamptz NOT NULL
);

-- Live (paid) model calls per UTC day, counted before each call.
CREATE TABLE model_calls (
  day   date PRIMARY KEY,
  count integer NOT NULL DEFAULT 0 CHECK (count >= 0)
);
