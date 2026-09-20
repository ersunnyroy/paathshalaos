-- 0084: narrow 0083's tenant guard to the role it was written for (M33.2).
--
-- 0083 made `seal_audit_period` SECURITY DEFINER and added a guard: a period may
-- only be sealed by the tenant it belongs to. Necessary — as SECURITY DEFINER
-- the function reads `audit_log` with row-level security bypassed, so without a
-- guard any principal could ask for a digest over another school's audit rows.
--
-- The guard was too broad. It compared against `app_current_tenant_id()`
-- unconditionally, which also refuses the OWNER connection, where there is no
-- tenant scope to compare against. That breaks the operator: verifying a
-- restore, or re-deriving a digest to check a claim of tampering, both happen
-- at a psql prompt with no `app.tenant_id` set. The audit suite found it
-- immediately, which is the test doing its job.
--
-- Narrowed to `paathshala_app` — the pattern 0076 already uses for the
-- submission write guard, and for the same reason. The application role is the
-- one that can be pointed at an arbitrary tenant id by a request; the owner is
-- a superuser who bypasses every policy in the database anyway, so a guard
-- against it protects nothing and costs the one legitimate use.
--
-- Shipped as a new migration rather than an edit to 0083, which is the rule.
-- The correction is a paragraph of reasoning, and a paragraph of reasoning is
-- exactly what is lost when a file is quietly rewritten.

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
  IF current_user = 'paathshala_app'
     AND p_tenant IS DISTINCT FROM app_current_tenant_id() THEN
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

COMMENT ON FUNCTION seal_audit_period(uuid, timestamptz, timestamptz) IS
  'Seals a period of the audit log into the digest chain. SECURITY DEFINER so '
  'the scheduled job can insert into audit_checkpoint, on which the application '
  'role holds only SELECT; the tenant guard inside it is what stops that '
  'privilege being pointed at another school. See migrations 0083 and 0084.';
