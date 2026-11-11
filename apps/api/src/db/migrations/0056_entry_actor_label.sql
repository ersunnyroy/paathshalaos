-- 0056: the school must be able to read the name of whoever entered.
--
-- `impersonation_session` records actor_user_id, and the obvious way to show it
-- to the institute is to join `user_account`. That join returns NULL, correctly:
-- a platform administrator holds no role grant in the school, so the school's
-- row-level security policy on `user_account` does not admit them — as it should
-- not, or any tenant could enumerate the platform's staff.
--
-- The result was a screen that said somebody had been in their records and could
-- not say who, which is most of the promise gone. So the identity is written
-- onto the session row at entry, by the platform role, and read from there. It
-- is denormalised on purpose and it is better than the join in one more way:
-- it survives the account being deleted, and an access log that loses names when
-- staff leave is not an access log.

ALTER TABLE impersonation_session
  ADD COLUMN actor_label text;

COMMENT ON COLUMN impersonation_session.actor_label IS
  'Who entered, as the school should see them. Written at entry rather than '
  'joined, because the school cannot read user_account rows for platform staff.';

-- The column is part of the existing table-level grants for both roles, but say
-- so explicitly: a future migration that narrows these to a column list should
-- have to delete this line to drop it.
GRANT SELECT (actor_label) ON impersonation_session TO paathshala_app;
GRANT SELECT (actor_label), INSERT (actor_label), UPDATE (actor_label)
  ON impersonation_session TO paathshala_platform;
