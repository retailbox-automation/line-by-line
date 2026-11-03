-- Fla. Stat. 559.905(2): the customer checks one of three statements and signs. The consent record keeps which one:
-- 'written' (I request a written estimate), 'limit' (no written estimate as long as the repair costs do not exceed
-- the amount in fl_limit_cents), 'none' (I do not request a written estimate). Records made before this migration,
-- at the desk, or after the first approval keep null.
ALTER TABLE consents ADD COLUMN fl_choice text NULL CHECK (fl_choice IN ('written', 'limit', 'none'));
ALTER TABLE consents ADD COLUMN fl_limit_cents integer NULL CHECK (fl_limit_cents > 0);
-- COALESCE: a CHECK that evaluates to NULL passes, so a null choice must compare as false, not as unknown.
ALTER TABLE consents ADD CONSTRAINT consents_fl_limit_only_with_limit
  CHECK ((COALESCE(fl_choice, '') = 'limit') = (fl_limit_cents IS NOT NULL));
