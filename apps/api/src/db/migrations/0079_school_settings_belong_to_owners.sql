-- 0079: a school's own settings are an owner's to change (M29.3).
--
-- `tenant_isolation` on `organization` was written when the only question was
-- which tenant a row belongs to, and it answers that correctly. What it does
-- not do is distinguish reading from writing: it is FOR ALL, so every principal
-- of a tenant — including a parent with a GUARDIAN grant — could UPDATE the
-- organization row. The grant has existed since 0003 (`GRANT SELECT, UPDATE ON
-- organization TO paathshala_app`).
--
-- Nothing exploited it, because no endpoint wrote to that table. M29.3 adds the
-- first one — setting the school's language — and an endpoint is exactly what
-- turns a latent hole into a live one. The fix belongs in the policy rather
-- than in the controller: a rule enforced in one controller is a rule the
-- second controller will not have.
--
-- Split, not tightened: reading stays open to every principal of the tenant,
-- because the sign-in screen, the branding and the timezone are things a parent
-- legitimately sees. Only the write narrows.

CREATE OR REPLACE FUNCTION app_actor_may_change_school_settings() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM role_grant g
     WHERE g.tenant_id = app_current_tenant_id()
       AND g.user_account_id = app_current_actor_id()
       AND g.revoked_at IS NULL
       AND (g.expires_at IS NULL OR g.expires_at > now())
       AND g.role IN ('ORG_OWNER', 'CAMPUS_ADMIN')
       -- School-wide, so the grant has to be school-wide. An admin of one
       -- campus changing the language every campus sends in is a scope
       -- escalation that looks like a settings change.
       AND g.scope_type = 'organization'
  )
$$;

COMMENT ON FUNCTION app_actor_may_change_school_settings() IS
  'True when the actor holds an organisation-wide ORG_OWNER or CAMPUS_ADMIN '
  'grant. Used by the organization write policy; deliberately narrower than '
  'app_actor_has_staff_scope(), which a teacher satisfies.';

DROP POLICY tenant_isolation ON organization;

CREATE POLICY tenant_read ON organization
  FOR SELECT TO paathshala_app
  USING (id = app_current_tenant_id());

CREATE POLICY tenant_settings_write ON organization
  FOR UPDATE TO paathshala_app
  USING (id = app_current_tenant_id() AND app_actor_may_change_school_settings())
  WITH CHECK (id = app_current_tenant_id() AND app_actor_may_change_school_settings());
