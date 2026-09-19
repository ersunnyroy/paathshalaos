-- 0016: correct a false positive in the rls_coverage guard.
--
-- Migration 0004 required an explicit WITH CHECK on every policy whose command
-- was not SELECT. That was too broad: Postgres rejects WITH CHECK on DELETE
-- policies outright ("WITH CHECK cannot be applied to SELECT or DELETE"),
-- because a DELETE has no new row to check. The per-command policies added in
-- 0015 therefore tripped a guard that was asking for something impossible.
--
-- The rule that actually matters is unchanged: any policy that can put a row
-- into the table — ALL, INSERT, UPDATE — must say so explicitly, so that
-- narrowing the read rule later cannot silently narrow the write rule with it.

CREATE OR REPLACE VIEW rls_coverage AS
SELECT
  c.relname                                   AS table_name,
  c.relrowsecurity                            AS rls_enabled,
  c.relforcerowsecurity                       AS rls_forced,
  COALESCE(p.policy_count, 0)                 AS policy_count,
  COALESCE(p.implicit_check_count, 0)         AS policies_without_explicit_with_check,
  (
    c.relrowsecurity
    AND c.relforcerowsecurity
    AND COALESCE(p.policy_count, 0) > 0
    AND COALESCE(p.implicit_check_count, 0) = 0
  ) AS is_covered
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND a.attnum > 0 AND NOT a.attisdropped
LEFT JOIN (
  SELECT
    polrelid,
    count(*) AS policy_count,
    -- polcmd: '*' = ALL, 'r' = SELECT, 'a' = INSERT, 'w' = UPDATE, 'd' = DELETE.
    -- Only the three that can write a row are required to be explicit.
    count(*) FILTER (
      WHERE polwithcheck IS NULL AND polcmd IN ('*', 'a', 'w')
    ) AS implicit_check_count
  FROM pg_policy GROUP BY polrelid
) p ON p.polrelid = c.oid
WHERE c.relkind = 'r' AND n.nspname = 'public';

GRANT SELECT ON rls_coverage TO paathshala_app;
