-- 0083: the two audit functions no role in this product could execute (M33.2).
--
-- Found while giving the jobs of 0082 a caller: both of the audit maintenance
-- functions from 0007 are plain `SECURITY INVOKER`, and neither application
-- role has the privileges they need. They have been unrunnable by anything that
-- exists since the day they were written.
--
-- ## `ensure_audit_partition` — and the outage it has a date on
--
-- The function does CREATE TABLE, GRANT and REVOKE. `paathshala_app` and
-- `paathshala_auth` can do none of those. 0007 pre-created three months of
-- partitions and said a scheduled job would create more; there was no scheduled
-- job, so every database this product has ever built runs out of audit
-- partitions three months after it was migrated.
--
-- The comment beside the inline call in `audit.service.ts` says the miss
-- "degrades into a slow write, never a lost record". It does not. That call
-- runs on the auth pool, hits `permission denied`, and the record is lost with
-- a log line — the one failure mode an audit log is not allowed to have.
--
-- ## `seal_audit_period` — the tamper-evidence nothing could apply
--
-- It INSERTs into `audit_checkpoint`, on which the application role holds
-- SELECT and nothing else. So the digest chain that makes the audit trail
-- defensible could only ever have been built by a superuser at a psql prompt.
--
-- ## Why SECURITY DEFINER is safe here, stated rather than assumed
--
-- Both take a `search_path` pinned to `public, pg_temp`, which is the rule 0069
-- established after the recursion incident. Neither takes a string from a
-- caller: the partition name is built with `to_char` from a date, so there is
-- no identifier a caller controls anywhere in the DDL.
--
-- `seal_audit_period` gains something `ensure_audit_partition` does not need: a
-- tenant guard. As SECURITY DEFINER it reads `audit_log` with row-level
-- security bypassed, so without the guard any principal could ask for a digest
-- over another school's audit rows — not a dump, but an oracle, and an oracle
-- over an audit log is a thing nobody should be handed. The function now
-- refuses any tenant but the caller's own.

CREATE OR REPLACE FUNCTION ensure_audit_partition(for_month date) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  start_date date := date_trunc('month', for_month)::date;
  end_date   date := (date_trunc('month', for_month) + interval '1 month')::date;
  part_name  text := 'audit_log_' || to_char(start_date, 'YYYY_MM');
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = part_name) THEN
    EXECUTE format(
      'CREATE TABLE %I PARTITION OF audit_log FOR VALUES FROM (%L) TO (%L)',
      part_name, start_date, end_date);
    EXECUTE format('GRANT INSERT, SELECT ON %I TO paathshala_app, paathshala_auth', part_name);
    EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON %I FROM PUBLIC, paathshala_app, paathshala_auth', part_name);
  END IF;
  RETURN part_name;
EXCEPTION
  -- Two writers arriving in the first millisecond of a month, or the scheduled
  -- job racing the defensive inline call. The loser wants the partition to
  -- exist, and it does.
  WHEN duplicate_table THEN RETURN part_name;
END;
$$;

REVOKE ALL ON FUNCTION ensure_audit_partition(date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ensure_audit_partition(date)
  TO paathshala_app, paathshala_auth;

CREATE OR REPLACE FUNCTION seal_audit_period(p_tenant uuid, p_start timestamptz, p_end timestamptz)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_prev    text;
  v_digest  text;
  v_count   bigint;
BEGIN
  -- Row-level security is bypassed below, so the boundary has to be here.
  IF p_tenant IS DISTINCT FROM app_current_tenant_id() THEN
    RAISE EXCEPTION 'a period may only be sealed by the tenant it belongs to'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT digest INTO v_prev
    FROM audit_checkpoint
   WHERE tenant_id = p_tenant AND period_start < p_start
   ORDER BY period_start DESC LIMIT 1;

  SELECT count(*),
         encode(sha256(convert_to(COALESCE(v_prev, '') || COALESCE(string_agg(
           id::text || occurred_at::text || action || resource_type ||
           COALESCE(resource_id::text, '') || COALESCE(actor_user_id::text, '') ||
           COALESCE(before::text, '') || COALESCE(after::text, ''),
           '|' ORDER BY occurred_at, id), ''), 'UTF8')), 'hex')
    INTO v_count, v_digest
    FROM audit_log
   WHERE tenant_id = p_tenant AND occurred_at >= p_start AND occurred_at < p_end;

  INSERT INTO audit_checkpoint (tenant_id, period_start, period_end, row_count, prev_digest, digest)
  VALUES (p_tenant, p_start, p_end, v_count, v_prev, v_digest)
  ON CONFLICT (tenant_id, period_start) DO NOTHING;

  RETURN v_digest;
END;
$$;

REVOKE ALL ON FUNCTION seal_audit_period(uuid, timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION seal_audit_period(uuid, timestamptz, timestamptz) TO paathshala_app;

-- The three months 0007 created are long gone in any database old enough to
-- matter. Top up to a year ahead here, so that a deployment which somehow never
-- runs the scheduler still has twelve months rather than three.
DO $$
DECLARE d date;
BEGIN
  FOR d IN SELECT generate_series(date_trunc('month', CURRENT_DATE),
                                  date_trunc('month', CURRENT_DATE + interval '12 months'),
                                  interval '1 month')::date
  LOOP PERFORM ensure_audit_partition(d); END LOOP;
END $$;

COMMENT ON FUNCTION ensure_audit_partition(date) IS
  'Creates the audit_log partition for a month. SECURITY DEFINER because the '
  'application roles have no DDL rights and the defensive call in '
  'audit.service.ts runs as one of them — without this it fails with '
  'permission denied and the audit record is lost. See migration 0083.';
