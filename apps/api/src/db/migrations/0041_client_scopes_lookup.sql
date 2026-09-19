-- 0041 — app_api_client_scopes() could never see anything.
--
-- Found by the first test that asserted a machine principal has staff scope. It
-- was false, and the reason is a loop that neither migration is wrong about on
-- its own:
--
--   app_actor_has_staff_scope() asks app_api_client_scopes() what the client may
--   do → that reads api_client → whose policy from 0039 requires
--   app_actor_has_integration_scope() → which 0040 makes FALSE for every API
--   client, deliberately, so a key cannot mint another key.
--
-- So the client could not read the row that describes itself, its scopes came
-- back empty, and every public-API read would have returned nothing. That is the
-- failure mode 0040's header warned about — an empty list that looks like an
-- empty school — arriving through a different door.
--
-- The fix is to make the lookup what it actually is: system bookkeeping, not a
-- tenant read. SECURITY DEFINER with a pinned search_path, filtered by both the
-- current client id and the current tenant, so it can answer only "what may the
-- caller do", never "what may anyone else do".
--
-- The alternative — a self-read policy on api_client — also works, but it puts
-- a policy evaluation inside a function that every other table's policy calls,
-- and nested policy evaluation on the hot path is a cost with no benefit here.
CREATE OR REPLACE FUNCTION app_api_client_scopes() RETURNS text[]
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(
    (SELECT c.scopes FROM api_client c
      WHERE c.id = app_current_api_client_id()
        AND c.tenant_id = app_current_tenant_id()
        AND c.status = 'active'),
    ARRAY[]::text[])
$$;

REVOKE ALL ON FUNCTION app_api_client_scopes() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_api_client_scopes() TO paathshala_app;

COMMENT ON FUNCTION app_api_client_scopes() IS
  'The current API client''s scopes. SECURITY DEFINER because api_client is '
  'readable only with integration scope, which an API client never has — '
  'without this it could not read the row that defines its own authority.';
