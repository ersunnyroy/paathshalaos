-- 0088: a person can say they have read a message (M43.1).
--
-- Everything the school sends a person is already a row in `message_recipient`,
-- and 0036 already lets that person read their own rows. What nobody could do
-- is record that they had: the only write policy on the table is for staff, so
-- a parent's bell had nothing to count and no way to stop counting.
--
-- ## Why a new column and not the existing `status`
--
-- `status` is the delivery record — what the provider told us happened to an
-- SMS or a WhatsApp message — and `'read'` there means a provider's read
-- receipt. "The parent opened it in the app" is a different fact from a
-- different witness. Writing it into `status` would let a tap in the app
-- overwrite `failed` with `read`, and the delivery record is what answers
-- "I never got it".
--
-- ## Why a function and not an UPDATE policy
--
-- A policy cannot say "this column only". `paathshala_app` holds UPDATE on the
-- whole table because the dispatcher needs it, so an own-row UPDATE policy
-- would let any query run for a guardian rewrite the body of a message the
-- school sent them. The function touches one column, on the caller's own rows,
-- and there is no other door.
--
-- ## Why SECURITY DEFINER is safe here, stated rather than assumed
--
-- `search_path` is pinned (the rule from 0069). The function takes one uuid and
-- no text. As definer it runs with row-level security bypassed, so both guards
-- are written out rather than inherited: the tenant is the caller's tenant and
-- the person is the caller's person. `app_current_person_id()` is NULL for an
-- account with no person row here, and `person_id = NULL` matches nothing.
--
-- Only a message that was actually sent can be read. A suppressed or failed
-- row is the school's operational record, not something in anybody's inbox,
-- and marking it read would be a write to a row its owner cannot see.

ALTER TABLE message_recipient ADD COLUMN read_at timestamptz;

COMMENT ON COLUMN message_recipient.read_at IS
  'When the recipient marked it read in the app. Not the provider''s read receipt: that is status.';

-- The inbox is "mine, newest first", and the bell is "mine, unread".
CREATE INDEX message_recipient_inbox_idx
  ON message_recipient (tenant_id, person_id, created_at DESC, id DESC);

CREATE OR REPLACE FUNCTION mark_my_messages_read(only_id uuid) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  me      uuid := app_current_person_id();
  changed integer;
BEGIN
  IF me IS NULL THEN RETURN 0; END IF;
  UPDATE message_recipient
     SET read_at = now()
   WHERE tenant_id = app_current_tenant_id()
     AND person_id = me
     AND read_at IS NULL
     AND status IN ('sent', 'delivered', 'read')
     -- NULL means "all of mine"; an id means that one, if it is mine.
     AND (only_id IS NULL OR id = only_id);
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed;
END;
$$;

REVOKE ALL ON FUNCTION mark_my_messages_read(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mark_my_messages_read(uuid) TO paathshala_app;
