-- 0007: the audit log.
--
-- Two properties matter more than the schema:
--
--   Sensitive READS are recorded, not only writes. In the PowerSchool breach the
--   forensics could not establish what had been taken because the logs did not
--   reach back far enough. Reads are the expensive thing to add later and the
--   only thing that answers "what did they see".
--
--   The application cannot rewrite history. UPDATE and DELETE are revoked from
--   every role and blocked by a trigger, so tampering requires a superuser and a
--   deliberate act rather than a stray ORM call.

CREATE TABLE audit_log (
  id                  uuid NOT NULL DEFAULT gen_random_uuid(),
  occurred_at         timestamptz NOT NULL DEFAULT now(),
  tenant_id           uuid NOT NULL,

  actor_user_id       uuid,
  actor_role          text,
  -- Set when a platform staff member is acting inside an approved impersonation
  -- session. Both identities are always recorded; neither replaces the other.
  on_behalf_of_user_id uuid,
  impersonation_id    uuid,

  action              text NOT NULL,
  resource_type       text NOT NULL,
  resource_id         uuid,
  classification      text NOT NULL DEFAULT 'INTERNAL'
                        CHECK (classification IN ('PUBLIC', 'INTERNAL', 'SENSITIVE', 'RESTRICTED')),

  before              jsonb,
  after               jsonb,

  request_id          text,
  ip                  inet,
  user_agent          text,
  api_client_id       uuid,
  -- Required for the operations where "why" is the whole point: impersonation,
  -- bulk export, fee adjustment, result correction.
  reason              text,

  PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);

CREATE INDEX audit_log_tenant_time_idx    ON audit_log (tenant_id, occurred_at DESC);
CREATE INDEX audit_log_resource_idx       ON audit_log (tenant_id, resource_type, resource_id);
CREATE INDEX audit_log_actor_idx          ON audit_log (tenant_id, actor_user_id, occurred_at DESC);

-- Creates the partition covering a given month if it is not already there.
-- Called by a scheduled job; also called defensively on insert failure so a
-- missed job degrades into a slow write rather than a lost audit record.
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
    EXECUTE format('GRANT INSERT, SELECT ON %I TO paathshala_app, paathshala_auth', part_name);
    EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON %I FROM PUBLIC, paathshala_app, paathshala_auth', part_name);
  END IF;
  RETURN part_name;
END;
$$;

SELECT ensure_audit_partition(CURRENT_DATE);
SELECT ensure_audit_partition((CURRENT_DATE + interval '1 month')::date);
SELECT ensure_audit_partition((CURRENT_DATE + interval '2 months')::date);

-- Defence in depth. The revokes below stop the application roles; this stops
-- the owner and anything else that inherits table ownership.
CREATE OR REPLACE FUNCTION audit_log_is_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_is_append_only();
CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_is_append_only();

GRANT INSERT, SELECT ON audit_log TO paathshala_app, paathshala_auth;
REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM PUBLIC, paathshala_app, paathshala_auth;

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON audit_log
  FOR ALL TO paathshala_app
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

-- The auth role writes login and session events before any tenant scope exists,
-- and must never be able to read a tenant's audit trail back.
CREATE POLICY auth_role_appends ON audit_log
  FOR INSERT TO paathshala_auth
  WITH CHECK (true);

-- Tamper-evidence without serialising every insert.
--
-- A per-row hash chain would make the audit table a global write bottleneck,
-- since every insert would have to read the previous row under a lock. Instead a
-- scheduled job seals each closed period: the digest covers that period's rows
-- in a deterministic order plus the previous checkpoint's digest, so altering
-- any sealed row breaks every checkpoint after it.
CREATE TABLE audit_checkpoint (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  period_start  timestamptz NOT NULL,
  period_end    timestamptz NOT NULL,
  row_count     bigint NOT NULL,
  prev_digest   text,
  digest        text NOT NULL,
  sealed_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, period_start)
);

CREATE OR REPLACE FUNCTION seal_audit_period(p_tenant uuid, p_start timestamptz, p_end timestamptz)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  v_prev    text;
  v_digest  text;
  v_count   bigint;
BEGIN
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

GRANT SELECT ON audit_checkpoint TO paathshala_app;
