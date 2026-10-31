-- A verified webhook is "done" only once it was processed. A processing that failed for a reason that may pass
-- (PayPal 5xx or no answer, the same operation running, a crash after the 200) is retried; these columns let a
-- redelivery or the retry sweep take the event over without two takers, and cap the attempts.
ALTER TABLE webhook_events ADD COLUMN attempts integer NOT NULL DEFAULT 0;
ALTER TABLE webhook_events ADD COLUMN claimed_at timestamptz NULL;
