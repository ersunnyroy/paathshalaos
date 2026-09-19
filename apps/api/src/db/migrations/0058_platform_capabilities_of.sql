-- 0058: what a console login is allowed to ask.
--
-- `platform_admin_has()` answers one capability at a time, which is right for a
-- guard checking a route. A login needs the whole set, to decide whether this
-- account may open the console at all and to tell the client which parts of it
-- to draw.
--
-- Same shape as its sibling and for the same reason: the auth role holds no
-- grant on `platform_admin` and must not gain one, because that role also holds
-- every password hash in the system and the two should stay as far apart as the
-- schema can keep them.

CREATE OR REPLACE FUNCTION platform_capabilities_of(p_user uuid)
RETURNS TABLE (capability text)
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT pa.capability FROM platform_admin pa
   WHERE pa.user_account_id = p_user
     AND pa.revoked_at IS NULL
   ORDER BY pa.capability
$$;

REVOKE ALL ON FUNCTION platform_capabilities_of(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_capabilities_of(uuid)
  TO paathshala_platform, paathshala_auth;

COMMENT ON FUNCTION platform_capabilities_of(uuid) IS
  'Every live capability this account holds. Used by the console login; '
  'SECURITY DEFINER because the auth role has no grant on platform_admin.';
