-- 0004: the guard that makes rule 3 of the previous migration self-enforcing.
--
-- Any table with a tenant_id column must have RLS enabled, forced, at least one
-- policy, and an explicit WITH CHECK on every policy. This view is asserted by
-- the test suite and by CI, so a new table added without a policy fails the
-- build rather than quietly leaking.
--
-- The explicit-WITH-CHECK column is the non-obvious one. Postgres reuses USING
-- as the write check when WITH CHECK is absent, so an implicit policy is safe
-- today and becomes unsafe the day someone narrows USING for an unrelated
-- reason. This makes that divergence a build failure instead of a silent one.

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
    -- A policy that only restricts reads (FOR SELECT) has no write side, so it
    -- is exempt; anything that can write must say so explicitly.
    count(*) FILTER (WHERE polwithcheck IS NULL AND polcmd <> 'r') AS implicit_check_count
  FROM pg_policy GROUP BY polrelid
) p ON p.polrelid = c.oid
WHERE c.relkind = 'r' AND n.nspname = 'public';

GRANT SELECT ON rls_coverage TO paathshala_app;
