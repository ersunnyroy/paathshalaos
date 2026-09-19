-- 0009: close a cross-tenant leak in the audit partitions.
--
-- Found by the rls_coverage guard from migration 0004, and confirmed by probing
-- a live database: a row-level security policy on a partitioned parent is
-- applied to queries that go THROUGH the parent, but a query naming a partition
-- directly is checked against that partition's own policies. Migration 0007
-- granted SELECT on each partition, so `SELECT * FROM audit_log_2026_09`
-- returned every tenant's audit trail.
--
-- Two independent fixes, because either alone would be enough and neither is
-- worth relying on by itself:
--
--   1. No direct privileges on partitions. Access flows through the parent,
--      which is sufficient: Postgres checks privileges on the parent when a row
--      is routed to a partition, so inserts and selects keep working.
--   2. RLS and the same policies on every partition anyway, so that a future
--      grant (or a partition created by a different code path) cannot reopen it.

CREATE OR REPLACE FUNCTION secure_audit_partition(part_name text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('REVOKE ALL ON %I FROM PUBLIC, paathshala_app, paathshala_auth', part_name);
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', part_name);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', part_name);

  IF NOT EXISTS (
    SELECT 1 FROM pg_policy WHERE polrelid = part_name::regclass AND polname = 'tenant_isolation'
  ) THEN
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I FOR ALL TO paathshala_app
         USING (tenant_id = app_current_tenant_id())
         WITH CHECK (tenant_id = app_current_tenant_id())', part_name);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policy WHERE polrelid = part_name::regclass AND polname = 'auth_role_appends'
  ) THEN
    EXECUTE format(
      'CREATE POLICY auth_role_appends ON %I FOR INSERT TO paathshala_auth WITH CHECK (true)',
      part_name);
  END IF;
END;
$$;

-- Future partitions are secured at creation.
CREATE OR REPLACE FUNCTION ensure_audit_partition(for_month date) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  start_date date := date_trunc('month', for_month)::date;
  end_date   date := (date_trunc('month', for_month) + interval '1 month')::date;
  part_name  text := 'audit_log_' || to_char(start_date, 'YYYY_MM');
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = part_name) THEN
    EXECUTE format(
      'CREATE TABLE %I PARTITION OF audit_log FOR VALUES FROM (%L) TO (%L)',
      part_name, start_date, end_date);
  END IF;
  PERFORM secure_audit_partition(part_name);
  RETURN part_name;
END;
$$;

-- Retrofit every partition that already exists.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.relname
      FROM pg_class c
      JOIN pg_inherits i ON i.inhrelid = c.oid
     WHERE i.inhparent = 'audit_log'::regclass
  LOOP
    PERFORM secure_audit_partition(r.relname);
  END LOOP;
END;
$$;

-- audit_checkpoint carries tenant_id and had no policy either. The digests
-- reveal audit volume and sealing cadence per tenant, which is not catastrophic
-- but is nobody else's business.
ALTER TABLE audit_checkpoint ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_checkpoint FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON audit_checkpoint
  FOR ALL TO paathshala_app
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());
