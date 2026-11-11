-- 0053 — bump_grants_version() ran as the caller and could not.
--
-- Inserting a role_grant fires a trigger that increments
-- `user_account.grants_version`, which is how a revoked grant takes effect on
-- the very next request rather than when a token expires. The function ran with
-- the caller's privileges, and the platform role has no UPDATE on user_account
-- — deliberately, because a role that can edit an existing login can change the
-- email on a school owner's account and take it over.
--
-- So provisioning failed at the last step, having already created the school,
-- the campus and the owner's login. Inside one transaction, so nothing was left
-- behind — which is the argument for the transaction, arriving sooner than
-- expected.
--
-- The fix is the one 0038 reached for the same reason: a trigger that maintains
-- system bookkeeping runs as its owner. It only ever touches the row named by
-- the grant being written, and the search_path is pinned so a caller cannot
-- shadow the table it resolves.
CREATE OR REPLACE FUNCTION bump_grants_version() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE user_account
     SET grants_version = grants_version + 1
   WHERE id = COALESCE(NEW.user_account_id, OLD.user_account_id);
  RETURN COALESCE(NEW, OLD);
END;
$$;

COMMENT ON FUNCTION bump_grants_version() IS
  'Increments grants_version so a changed grant is honoured on the next '
  'request. SECURITY DEFINER because the roles that legitimately write a '
  'role_grant must not thereby gain the ability to edit a login.';
