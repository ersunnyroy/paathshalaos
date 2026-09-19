-- 0064: the app role loses its grant on the catalogue.
--
-- Adopted from a parallel implementation of M16 built in another session, which
-- got this part righter than 0059 did. 0059 granted the app role SELECT on
-- `plan`, `plan_version`, `plan_limit` and `plan_feature` and relied on the
-- service's WHERE clauses to show a school only published, public plans. Those
-- tables are not tenant-scoped, so there is no row-level security underneath to
-- catch a query that forgets the filter — the grant was the whole boundary, and
-- it permitted reading draft prices and private negotiated plans.
--
-- So the grant goes and the questions become functions. A school can ask what
-- plan it is on, what its limits and features are, and what else is on offer.
-- It cannot ask what a draft of next year's pricing looks like.
--
-- `subscription` and `subscription_event` keep their SELECT grant and their
-- policies, deliberately and in the other direction: those ARE tenant-scoped,
-- so row-level security is available as a second line, and a definer function
-- reading tenant data has no second line at all. Use the strongest mechanism
-- each table can support rather than one pattern everywhere.

REVOKE SELECT ON plan, plan_version, plan_limit, plan_feature FROM paathshala_app;

-- ---------------------------------------------------------------------------
-- What a school may ask about its own plan
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app_tenant_plan()
RETURNS TABLE (
  subscription_id uuid, plan_version_id uuid, plan_code text, plan_name text,
  version integer, price_monthly text, price_annual text, currency text,
  status text, billing_period text, trial_ends_on date,
  period_start date, period_end date, past_due_since date
)
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT s.id, s.plan_version_id, p.code, p.name, pv.version,
         pv.price_monthly::text, pv.price_annual::text, pv.currency,
         s.status, s.billing_period, s.trial_ends_on,
         s.period_start, s.period_end, s.past_due_since
    FROM subscription s
    JOIN plan_version pv ON pv.id = s.plan_version_id
    JOIN plan p ON p.id = pv.plan_id
   WHERE s.tenant_id = app_current_tenant_id()
     AND s.ended_at IS NULL
$$;

-- Limits and usage together, because the number on its own means nothing:
-- "412 learners" is only useful beside "500 included, 600 cap".
CREATE OR REPLACE FUNCTION app_tenant_plan_limits()
RETURNS TABLE (metric text, included integer, hard_cap integer, used integer)
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT pl.metric, pl.included, pl.hard_cap, app_tenant_usage(pl.metric)
    FROM subscription s
    JOIN plan_limit pl ON pl.plan_version_id = s.plan_version_id
   WHERE s.tenant_id = app_current_tenant_id()
     AND s.ended_at IS NULL
   ORDER BY pl.metric
$$;

CREATE OR REPLACE FUNCTION app_tenant_plan_features()
RETURNS TABLE (feature text, enabled boolean)
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT pf.feature, pf.enabled
    FROM subscription s
    JOIN plan_feature pf ON pf.plan_version_id = s.plan_version_id
   WHERE s.tenant_id = app_current_tenant_id()
     AND s.ended_at IS NULL
   ORDER BY pf.feature
$$;

-- What else is on offer: the newest published version of each public plan.
-- A retired version is not on offer and a draft is not real, and neither is
-- something a school should be able to see by asking a different way.
CREATE OR REPLACE FUNCTION app_plan_options()
RETURNS TABLE (
  plan_version_id uuid, plan_code text, plan_name text,
  price_monthly text, price_annual text,
  limits jsonb, features jsonb
)
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT DISTINCT ON (p.id)
         pv.id, p.code, p.name, pv.price_monthly::text, pv.price_annual::text,
         COALESCE((SELECT jsonb_agg(jsonb_build_object(
                     'metric', metric, 'included', included, 'hard_cap', hard_cap)
                   ORDER BY metric)
              FROM plan_limit WHERE plan_version_id = pv.id), '[]'::jsonb),
         COALESCE((SELECT jsonb_agg(jsonb_build_object(
                     'feature', feature, 'enabled', enabled) ORDER BY feature)
              FROM plan_feature WHERE plan_version_id = pv.id), '[]'::jsonb)
    FROM plan_version pv
    JOIN plan p ON p.id = pv.plan_id
   WHERE pv.status = 'published' AND p.is_public
   ORDER BY p.id, pv.version DESC
$$;

REVOKE ALL ON FUNCTION app_tenant_plan() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_tenant_plan_limits() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_tenant_plan_features() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_plan_options() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_tenant_plan() TO paathshala_app;
GRANT EXECUTE ON FUNCTION app_tenant_plan_limits() TO paathshala_app;
GRANT EXECUTE ON FUNCTION app_tenant_plan_features() TO paathshala_app;
GRANT EXECUTE ON FUNCTION app_plan_options() TO paathshala_app;

COMMENT ON FUNCTION app_plan_options() IS
  'The public catalogue, as a school may see it. A function rather than a '
  'SELECT grant because these tables carry no tenant column and therefore no '
  'row-level security to fall back on if a query forgets its filter.';
