-- 0044 — next_ticket_reference() could never run.
--
-- `SELECT MAX(...) ... FOR UPDATE` is rejected by Postgres: row locking and
-- aggregation are incompatible, because there is no row to lock once the rows
-- have been folded into one value. So every attempt to raise a ticket failed.
--
-- The intent behind the FOR UPDATE was right — two people raising a ticket in
-- the same millisecond must not both read the same maximum — so it is replaced
-- rather than dropped. An advisory lock keyed on (tenant, year) serialises
-- exactly the numbering, holds only until the transaction ends, and blocks
-- nobody in another tenant.
--
-- The alternative, catching the unique violation and retrying, also works. It
-- was not chosen because it turns an ordinary concurrent case into an error path
-- that runs perhaps twice a year and is therefore never exercised.
CREATE OR REPLACE FUNCTION next_ticket_reference() RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_tenant uuid := app_current_tenant_id();
  v_year   text := to_char(now(), 'YYYY');
  v_next   integer;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'next_ticket_reference called outside a tenant scope'
      USING ERRCODE = 'raise_exception';
  END IF;

  -- Two 32-bit keys rather than one hashed string, so a collision would need
  -- two tenants whose uuids hash alike AND the same year.
  PERFORM pg_advisory_xact_lock(hashtext(v_tenant::text), hashtext(v_year));

  SELECT COALESCE(MAX(split_part(reference, '-', 3)::integer), 0) + 1
    INTO v_next
    FROM support_ticket
   WHERE tenant_id = v_tenant AND reference LIKE 'TKT-' || v_year || '-%';

  RETURN 'TKT-' || v_year || '-' || lpad(v_next::text, 5, '0');
END;
$$;

REVOKE ALL ON FUNCTION next_ticket_reference() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION next_ticket_reference() TO paathshala_app;
