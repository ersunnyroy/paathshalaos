-- 0062: metering and the hard cap (M16.4, the cap rung of M16.5).
--
-- **Counted from the real rows, never from a counter.** The tempting design is
-- a `usage` table somebody increments on insert, because counting is cheap
-- then. It is also wrong within a month: an increment missed by a failed
-- transaction, a bulk import that bypasses the service, a row deleted by a
-- correction — each one silently drifts the number a school is billed against,
-- and nobody notices until a school is refused at a cap it is not actually at.
-- Counting the rows cannot drift. If it ever becomes slow, the fix is a
-- materialised view with a known refresh lag, not a counter.
--
-- **The cap is a trigger, not a service check.** "New records are refused past
-- the cap, existing ones keep working" is a promise about every code path —
-- the API, an import, a script, a future endpoint. A check in one service is a
-- promise about one service.

CREATE OR REPLACE FUNCTION app_tenant_usage(p_metric text)
RETURNS integer
LANGUAGE plpgsql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  t uuid := app_current_tenant_id();
  n integer;
BEGIN
  IF t IS NULL THEN RETURN 0; END IF;

  CASE p_metric
    -- Learners on the roll. An alumnus or a withdrawn learner is history, not
    -- a seat: billing a school for children who left is how a renewal
    -- conversation turns into an argument.
    WHEN 'learners' THEN
      SELECT count(*)::int INTO n FROM student
       WHERE tenant_id = t AND deleted_at IS NULL
         AND lifecycle_status IN ('enrolled', 'admitted');
    WHEN 'staff' THEN
      SELECT count(*)::int INTO n FROM staff
       WHERE tenant_id = t AND deleted_at IS NULL;
    WHEN 'campuses' THEN
      SELECT count(*)::int INTO n FROM campus
       WHERE tenant_id = t AND deleted_at IS NULL;
    -- The billing period is the calendar month. Not a rolling window: a school
    -- needs to be able to check the number against their own sent folder.
    WHEN 'messages_per_month' THEN
      SELECT count(*)::int INTO n FROM message_recipient
       WHERE tenant_id = t
         AND created_at >= date_trunc('month', now())
         AND status NOT IN ('suppressed', 'failed');
    WHEN 'storage_mb' THEN
      SELECT COALESCE(sum(size_bytes), 0)::bigint / 1048576 INTO n FROM file
       WHERE tenant_id = t AND deleted_at IS NULL;
    ELSE
      RAISE EXCEPTION 'unknown metric %', p_metric;
  END CASE;

  RETURN COALESCE(n, 0);
END;
$$;

-- ---------------------------------------------------------------------------
-- The cap
-- ---------------------------------------------------------------------------
--
-- Fires only on INSERT. That is the entire difference between this ladder and
-- the one every other product ships: going over the cap stops you adding the
-- 601st learner, and does nothing whatever to the 600 already enrolled. They
-- are marked present, their fees are collected, their reports are printed.

CREATE OR REPLACE FUNCTION enforce_plan_cap() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_metric  text := TG_ARGV[0];
  v_cap     integer;
  v_used    integer;
BEGIN
  SELECT pl.hard_cap INTO v_cap
    FROM subscription s
    JOIN plan_limit pl ON pl.plan_version_id = s.plan_version_id
   WHERE s.tenant_id = NEW.tenant_id
     AND s.ended_at IS NULL
     AND pl.metric = v_metric;

  -- No subscription, no limit row, or a deliberate NULL cap: nothing to say.
  -- A school that predates billing is not a school we stop.
  IF v_cap IS NULL THEN RETURN NEW; END IF;

  -- Counted for this tenant directly rather than through app_tenant_usage(),
  -- which reads the transaction's tenant setting — and an import or a platform
  -- path may be inserting for a tenant that is not the current one.
  CASE v_metric
    WHEN 'learners' THEN
      SELECT count(*)::int INTO v_used FROM student
       WHERE tenant_id = NEW.tenant_id AND deleted_at IS NULL
         AND lifecycle_status IN ('enrolled', 'admitted');
    WHEN 'staff' THEN
      SELECT count(*)::int INTO v_used FROM staff
       WHERE tenant_id = NEW.tenant_id AND deleted_at IS NULL;
    WHEN 'campuses' THEN
      SELECT count(*)::int INTO v_used FROM campus
       WHERE tenant_id = NEW.tenant_id AND deleted_at IS NULL;
    ELSE RETURN NEW;
  END CASE;

  IF v_used >= v_cap THEN
    -- The message names the number, because "limit reached" sends somebody to
    -- a support queue to ask which limit and what it is.
    RAISE EXCEPTION 'plan limit reached: % of % % on this plan',
      v_used, v_cap, v_metric
      USING ERRCODE = 'check_violation',
            HINT = 'Existing records are unaffected. Moving to a larger plan lifts this immediately.';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER student_within_plan_cap
  BEFORE INSERT ON student
  FOR EACH ROW EXECUTE FUNCTION enforce_plan_cap('learners');

CREATE TRIGGER staff_within_plan_cap
  BEFORE INSERT ON staff
  FOR EACH ROW EXECUTE FUNCTION enforce_plan_cap('staff');

CREATE TRIGGER campus_within_plan_cap
  BEFORE INSERT ON campus
  FOR EACH ROW EXECUTE FUNCTION enforce_plan_cap('campuses');

REVOKE ALL ON FUNCTION app_tenant_usage(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_tenant_usage(text) TO paathshala_app;

COMMENT ON FUNCTION app_tenant_usage(text) IS
  'Usage counted from the rows themselves. Deliberately not a stored counter: '
  'a counter drifts on any path that does not increment it, and a school '
  'refused at a cap it is not at is worse than a slow query.';
COMMENT ON FUNCTION enforce_plan_cap() IS
  'Refuses NEW records past the hard cap. Never touches existing ones — a '
  'school over its learner cap has children enrolled, and they keep working.';
