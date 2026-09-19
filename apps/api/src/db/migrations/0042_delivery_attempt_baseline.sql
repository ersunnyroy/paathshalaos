-- 0042 — replaying a dead delivery crashed on its own history.
--
-- Found by the test that replays a delivery after it gave up. `replay()` reset
-- attempt_count to 0 so the retry budget started over; the next attempt was
-- therefore numbered 1, and webhook_attempt already held a row numbered 1 from
-- the first cycle. Unique violation, and the replay a school asked for fails.
--
-- The two things were conflated. attempt_count was being used both as "how many
-- times have we ever tried this" — which the append-only log also records, and
-- which must never go backwards — and as "how much budget is left in this retry
-- cycle", which has to reset when a human replays.
--
-- So they become two columns. attempt_count only ever rises. attempt_baseline
-- marks where the current cycle started, and the budget is the difference. An
-- institute that replays a delivery three times gets three full cycles and a
-- log that reads 1..8, 9..16, 17..24 — a history, not a series of overwrites.

ALTER TABLE webhook_delivery
  ADD COLUMN attempt_baseline integer NOT NULL DEFAULT 0
    CHECK (attempt_baseline >= 0);

ALTER TABLE webhook_delivery
  ADD CONSTRAINT webhook_delivery_baseline_not_ahead
    CHECK (attempt_baseline <= attempt_count);

COMMENT ON COLUMN webhook_delivery.attempt_baseline IS
  'attempt_count when the current retry cycle began. Set by a replay so the '
  'budget restarts without the attempt numbers restarting — they are the keys '
  'of an append-only log.';
