-- 0003: row-level security.
--
-- Three things matter here and each one is load-bearing:
--
--   1. USING and WITH CHECK are both written out, even though they are
--      identical today. Postgres falls back to the USING expression as the
--      write check when WITH CHECK is omitted, so omitting it is not a hole by
--      itself -- the hole opens later. The moment somebody narrows USING (say,
--      adding "AND deleted_at IS NULL" so soft-deleted rows stop appearing in
--      reads), an implicit check silently narrows the write rule with it.
--      Declaring both keeps the read rule and the write rule independently
--      reviewable, and migration 0004 fails the build if a policy ever leaves
--      WITH CHECK implicit.
--   2. FORCE ROW LEVEL SECURITY. Without it the table owner silently bypasses
--      every policy, so any job that happens to run as the owner sees
--      everything.
--   3. A NULL tenant setting denies rather than allows. If app.tenant_id is
--      unset, app_current_tenant_id() is NULL, every comparison is NULL, and no
--      row qualifies. Forgetting to set the tenant fails closed.

GRANT USAGE ON SCHEMA public TO paathshala_app;

-- Provisioning a tenant is a platform operation and runs as the owner role, so
-- the application role never inserts or deletes organizations.
GRANT SELECT, UPDATE ON organization TO paathshala_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON campus, academic_unit, academic_year TO paathshala_app;

-- The readiness probe reads this to refuse traffic while migrations are behind
-- the running code. Created by the migration runner as the owner role, so the
-- application role needs an explicit read grant. No RLS: it holds no tenant data.
GRANT SELECT ON schema_migration TO paathshala_app;

ALTER TABLE organization   ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization   FORCE  ROW LEVEL SECURITY;
ALTER TABLE campus         ENABLE ROW LEVEL SECURITY;
ALTER TABLE campus         FORCE  ROW LEVEL SECURITY;
ALTER TABLE academic_unit  ENABLE ROW LEVEL SECURITY;
ALTER TABLE academic_unit  FORCE  ROW LEVEL SECURITY;
ALTER TABLE academic_year  ENABLE ROW LEVEL SECURITY;
ALTER TABLE academic_year  FORCE  ROW LEVEL SECURITY;

-- The organization row is its own tenant boundary.
CREATE POLICY tenant_isolation ON organization
  USING (id = app_current_tenant_id())
  WITH CHECK (id = app_current_tenant_id());

CREATE POLICY tenant_isolation ON campus
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

CREATE POLICY tenant_isolation ON academic_unit
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

CREATE POLICY tenant_isolation ON academic_year
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

-- Every future tenant table must repeat this block. A CI check (M1.5) fails the
-- build when a table carrying tenant_id has no policy, so this cannot be
-- forgotten by omission.
