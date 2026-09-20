-- 0070 — backlog counts for the platform, without giving it the rows.
--
-- M23's gauges asked the platform role for three numbers: webhook deliveries
-- waiting, outbox events undispatched, and how many migrations this database
-- has. The platform role has no grant on any of those tables — deliberately,
-- and a boot assertion proves it — so every query failed, the sampler caught
-- the error, and the scrape reported `paathshala_webhook_backlog 0`.
--
-- A confident zero is the worst answer a backlog gauge can give. "Nothing is
-- stuck" and "I cannot see" look identical on a dashboard, and the second is
-- the state an alert most needs to fire in. The comment above the sampler even
-- said so, about a different way of getting it wrong.
--
-- The fix is not to grant the tables. The platform role reading inside a school
-- is precisely what impersonation exists for, and the assertion that it cannot
-- is load-bearing. What it gets instead is a function that returns three
-- integers — an aggregate over every tenant, which discloses no row to anybody
-- and answers a question that is genuinely platform-wide.
--
-- Same shape as 0064, where the plan catalogue went behind functions for the
-- same reason: the caller needs an answer, not a table.

CREATE OR REPLACE FUNCTION app_platform_backlogs()
RETURNS TABLE (webhooks bigint, outbox bigint, migrations bigint)
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT
    (SELECT count(*) FROM webhook_delivery
      WHERE status IN ('pending', 'retrying')),
    (SELECT count(*) FROM outbox_event WHERE published_at IS NULL),
    (SELECT count(*) FROM schema_migration)
$$;

REVOKE ALL ON FUNCTION app_platform_backlogs() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_platform_backlogs() TO paathshala_platform;

COMMENT ON FUNCTION app_platform_backlogs() IS
  'Three integers for the metrics scrape. SECURITY DEFINER so the platform '
  'role keeps having no grant on webhook_delivery, outbox_event or '
  'schema_migration — it needs the counts, not the rows. Returns no row from '
  'any school.';
