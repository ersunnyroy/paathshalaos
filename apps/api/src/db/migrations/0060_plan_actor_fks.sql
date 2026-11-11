-- 0060: an account leaving must not block, and must not erase the record.
--
-- `plan_version.created_by` and `subscription_event.actor_user_id` were plain
-- references, so deleting an account failed while any plan version or billing
-- event named it. That is the wrong trade in both directions: it blocks an
-- ordinary offboarding, and the obvious workaround — deleting the rows that
-- point at the account — destroys the billing history to tidy up a leaver.
--
-- ON DELETE SET NULL, matching `form_definition.created_by` and the others:
-- the account goes, the history stays, and the fact that somebody published
-- that version on that date is still on the row.

ALTER TABLE plan_version
  DROP CONSTRAINT plan_version_created_by_fkey,
  ADD CONSTRAINT plan_version_created_by_fkey
    FOREIGN KEY (created_by) REFERENCES user_account (id) ON DELETE SET NULL;

ALTER TABLE subscription_event
  DROP CONSTRAINT subscription_event_actor_user_id_fkey,
  ADD CONSTRAINT subscription_event_actor_user_id_fkey
    FOREIGN KEY (actor_user_id) REFERENCES user_account (id) ON DELETE SET NULL;
