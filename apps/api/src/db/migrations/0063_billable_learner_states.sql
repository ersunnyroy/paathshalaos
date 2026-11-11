-- 0063: count the learners a school actually has.
--
-- 0062 counted `lifecycle_status IN ('enrolled', 'admitted')`. There is no
-- 'admitted' state — the column's CHECK lists enquiry, applicant, enrolled,
-- on_leave, transferred_out, withdrawn, completed, alumni — so the filter was
-- one real value and one that can never match. It counted correctly by
-- accident, and a mutation removing the whole filter changed nothing, which is
-- how it surfaced: every learner in the tests is enrolled.
--
-- The right set is enrolled and on_leave. A child on leave still holds a seat,
-- still appears on the register, still has fees raised — billing a school less
-- because a learner is off sick would be wrong in the school's favour, and the
-- reconciliation later would be worse than the discount.
--
-- The four terminal states are history. A school should not pay for children
-- who left, and being billed for alumni is the kind of thing that turns a
-- renewal into an argument about whether anything else is being counted wrong.

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
    WHEN 'learners' THEN
      SELECT count(*)::int INTO n FROM student
       WHERE tenant_id = t AND deleted_at IS NULL
         AND lifecycle_status IN ('enrolled', 'on_leave');
    WHEN 'staff' THEN
      SELECT count(*)::int INTO n FROM staff
       WHERE tenant_id = t AND deleted_at IS NULL;
    WHEN 'campuses' THEN
      SELECT count(*)::int INTO n FROM campus
       WHERE tenant_id = t AND deleted_at IS NULL;
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

  IF v_cap IS NULL THEN RETURN NEW; END IF;

  -- NEW.tenant_id, not the transaction's tenant: an import or a platform path
  -- may be inserting for a tenant that is not the current one, and a cap that
  -- reads the wrong tenant refuses the wrong school.
  CASE v_metric
    WHEN 'learners' THEN
      SELECT count(*)::int INTO v_used FROM student
       WHERE tenant_id = NEW.tenant_id AND deleted_at IS NULL
         AND lifecycle_status IN ('enrolled', 'on_leave');
    WHEN 'staff' THEN
      SELECT count(*)::int INTO v_used FROM staff
       WHERE tenant_id = NEW.tenant_id AND deleted_at IS NULL;
    WHEN 'campuses' THEN
      SELECT count(*)::int INTO v_used FROM campus
       WHERE tenant_id = NEW.tenant_id AND deleted_at IS NULL;
    ELSE RETURN NEW;
  END CASE;

  IF v_used >= v_cap THEN
    RAISE EXCEPTION 'plan limit reached: % of % % on this plan',
      v_used, v_cap, v_metric
      USING ERRCODE = 'check_violation',
            HINT = 'Existing records are unaffected. Moving to a larger plan lifts this immediately.';
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION app_tenant_usage(text) IS
  'Usage counted from the rows themselves. Learners are those enrolled or on '
  'leave: a child on leave holds a seat, a child who left does not.';
