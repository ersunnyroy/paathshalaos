-- 0061: undo half of 0060. Append-only means append-only.
--
-- 0060 made `subscription_event.actor_user_id` ON DELETE SET NULL, reasoning
-- that offboarding an account should not be blocked by billing history. The
-- append-only trigger caught it immediately: SET NULL is an UPDATE, and this
-- table refuses updates. Ten minutes of thinking the trigger was in the way,
-- and then the obvious point — the trigger is the feature.
--
-- Two promises were in conflict and the stronger one wins. "This billing
-- history cannot be altered" is what settles a disagreement with a school about
-- what they were moved to and when. "An account can be hard-deleted" is not a
-- thing this product does: accounts are soft-deleted with `deleted_at`, and the
-- only code that hard-deletes is the test teardown, which already disables
-- append-only triggers to do it.
--
-- So the reference goes back to RESTRICT. `plan_version.created_by` keeps its
-- SET NULL from 0060 — that table is editable while a version is a draft, so
-- nulling a column on it breaks no promise.

ALTER TABLE subscription_event
  DROP CONSTRAINT subscription_event_actor_user_id_fkey,
  ADD CONSTRAINT subscription_event_actor_user_id_fkey
    FOREIGN KEY (actor_user_id) REFERENCES user_account (id);

COMMENT ON COLUMN subscription_event.actor_user_id IS
  'Deliberately RESTRICT, not SET NULL: this table refuses UPDATE, so a '
  'cascading null would fail anyway — and who moved a school between plans is '
  'part of what makes this history worth keeping.';
