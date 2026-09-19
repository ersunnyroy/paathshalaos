-- 0038 — the tenant_principal sync trigger could never run on a delete.
--
-- Found by the import reversal, which is the first code path in the product that
-- deletes a `person`. The trigger from 0012 writes to `tenant_principal`, but
-- the app role holds only SELECT there (deliberately — it is a projection the
-- application must never edit by hand). An INSERT happened to work because a
-- person created by the app has no user_account_id and so takes no branch that
-- writes; a DELETE always runs `DELETE FROM tenant_principal` and fails with
-- `permission denied`, whether or not a row matches.
--
-- The fix is not to grant the app write access to the projection: that would
-- reopen exactly what 0012 closed, since `app_current_person_id()` reads it and
-- a writable projection is a writable answer to "who am I". Instead the trigger
-- runs as its owner. It is system bookkeeping, it touches only rows keyed by the
-- triggering row's own tenant_id and person id, and the search_path is pinned so
-- a caller cannot shadow the table it resolves.
CREATE OR REPLACE FUNCTION sync_tenant_principal() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM tenant_principal
     WHERE tenant_id = OLD.tenant_id AND person_id = OLD.id;
    RETURN OLD;
  END IF;

  IF OLD IS NOT NULL AND OLD.user_account_id IS NOT NULL
     AND (NEW.user_account_id IS NULL OR NEW.user_account_id <> OLD.user_account_id) THEN
    DELETE FROM tenant_principal
     WHERE tenant_id = OLD.tenant_id AND user_account_id = OLD.user_account_id;
  END IF;

  IF NEW.user_account_id IS NOT NULL AND NEW.deleted_at IS NULL THEN
    INSERT INTO tenant_principal (tenant_id, user_account_id, person_id)
    VALUES (NEW.tenant_id, NEW.user_account_id, NEW.id)
    ON CONFLICT (tenant_id, user_account_id) DO UPDATE SET person_id = EXCLUDED.person_id;
  ELSIF NEW.deleted_at IS NOT NULL THEN
    DELETE FROM tenant_principal
     WHERE tenant_id = NEW.tenant_id AND person_id = NEW.id;
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION sync_tenant_principal() IS
  'Maintains the tenant_principal projection. SECURITY DEFINER because the app '
  'role deliberately holds no write privilege on that table; the function only '
  'ever touches rows keyed by the triggering person row.';
