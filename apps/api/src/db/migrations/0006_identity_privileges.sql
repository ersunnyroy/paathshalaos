-- 0006: privilege separation between the two application roles.
--
-- Credentials and tenant data are reached by different database roles, so a SQL
-- injection in a student search cannot read a password hash, and a bug in the
-- login path cannot read a fee ledger. This is the control that would have
-- bounded a PowerSchool-shaped incident, and it costs one extra connection pool.
--
--   paathshala_auth  identity tables only. Cannot see a single student.
--   paathshala_app   tenant tables. Sees users only through the grants that
--                    link them to the current tenant, and never a credential.

GRANT USAGE ON SCHEMA public TO paathshala_auth;
GRANT CONNECT ON DATABASE paathshala TO paathshala_auth;

-- The auth role: full access to identity, nothing else. Note the absence of any
-- grant on campus, academic_unit or academic_year.
GRANT SELECT, INSERT, UPDATE ON user_account TO paathshala_auth;
GRANT SELECT, INSERT, UPDATE, DELETE ON session, device TO paathshala_auth;
GRANT SELECT ON role_grant TO paathshala_auth;

-- The app role: column-level grants, so password_hash and mfa_secret_ref are
-- unreadable even by a raw query with a wildcard. A column grant is enforced by
-- the planner; a convention in a repository class is not.
GRANT SELECT (id, login_email, login_phone, status, grants_version, last_login_at)
  ON user_account TO paathshala_app;
GRANT SELECT, INSERT, UPDATE ON role_grant TO paathshala_app;

ALTER TABLE user_account ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_account FORCE  ROW LEVEL SECURITY;
ALTER TABLE role_grant   ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_grant   FORCE  ROW LEVEL SECURITY;
ALTER TABLE session      ENABLE ROW LEVEL SECURITY;
ALTER TABLE session      FORCE  ROW LEVEL SECURITY;
ALTER TABLE device       ENABLE ROW LEVEL SECURITY;
ALTER TABLE device       FORCE  ROW LEVEL SECURITY;

-- Identity is deliberately global: one guardian, one login, children at two
-- different institutes. So user_account has no tenant_id and cannot use the
-- usual policy. Instead the app role sees a user only while a live grant ties
-- that user to the current tenant.
CREATE POLICY tenant_visible_users ON user_account
  FOR SELECT TO paathshala_app
  USING (EXISTS (
    SELECT 1 FROM role_grant g
     WHERE g.user_account_id = user_account.id
       AND g.tenant_id = app_current_tenant_id()
       AND g.revoked_at IS NULL
  ));

-- The auth role's access is a policy of its own rather than a bypass flag, so
-- it is visible in pg_policy and reviewable like everything else.
CREATE POLICY auth_role_full_access ON user_account FOR ALL TO paathshala_auth USING (true) WITH CHECK (true);
CREATE POLICY auth_role_full_access ON session      FOR ALL TO paathshala_auth USING (true) WITH CHECK (true);
CREATE POLICY auth_role_full_access ON device       FOR ALL TO paathshala_auth USING (true) WITH CHECK (true);
CREATE POLICY auth_role_reads_grants ON role_grant  FOR SELECT TO paathshala_auth USING (true);

CREATE POLICY tenant_isolation ON role_grant
  FOR ALL TO paathshala_app
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());
