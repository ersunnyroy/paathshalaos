-- 0008: platform support access (AC-12).
--
-- There is no standing platform access to tenant data anywhere in this system.
-- A support agent who needs to see a tenant's records asks, a second platform
-- person approves, the window is short, and everything done inside it carries
-- both identities. The institute owner watches it happen and can end it.

CREATE TABLE impersonation_session (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES organization (id),

  actor_user_id     uuid NOT NULL REFERENCES user_account (id),
  target_user_id    uuid REFERENCES user_account (id),

  reason            text NOT NULL CHECK (length(trim(reason)) >= 10),
  ticket_ref        text NOT NULL,

  status            text NOT NULL DEFAULT 'requested'
                      CHECK (status IN ('requested', 'approved', 'denied', 'active', 'expired', 'revoked')),

  -- Write access is a separate elevation with its own approval, so the default
  -- and overwhelmingly common case is a read-only window.
  write_enabled     boolean NOT NULL DEFAULT false,

  requested_at      timestamptz NOT NULL DEFAULT now(),
  approved_by       uuid REFERENCES user_account (id),
  approved_at       timestamptz,
  denied_by         uuid REFERENCES user_account (id),
  denied_at         timestamptz,
  started_at        timestamptz,
  expires_at        timestamptz,
  revoked_at        timestamptz,
  revoked_by        uuid REFERENCES user_account (id),
  revoked_reason    text,

  -- Self-approval would make the two-person rule decorative.
  CONSTRAINT impersonation_needs_a_second_person
    CHECK (approved_by IS NULL OR approved_by <> actor_user_id),
  CONSTRAINT impersonation_approved_has_timestamp
    CHECK ((approved_by IS NULL) = (approved_at IS NULL))
);

CREATE INDEX impersonation_tenant_idx ON impersonation_session (tenant_id, requested_at DESC);
CREATE INDEX impersonation_active_idx ON impersonation_session (status) WHERE status = 'active';

-- The 60-minute cap lives in the database, not only in the service that creates
-- the row, so a second code path cannot quietly grant itself a longer window.
CREATE OR REPLACE FUNCTION enforce_impersonation_window() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'active' THEN
    IF NEW.started_at IS NULL OR NEW.expires_at IS NULL THEN
      RAISE EXCEPTION 'an active impersonation session must have started_at and expires_at';
    END IF;
    IF NEW.expires_at > NEW.started_at + interval '60 minutes' THEN
      RAISE EXCEPTION 'impersonation window may not exceed 60 minutes';
    END IF;
    IF NEW.approved_by IS NULL THEN
      RAISE EXCEPTION 'impersonation cannot become active without an approver';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER impersonation_window_is_bounded
  BEFORE INSERT OR UPDATE ON impersonation_session
  FOR EACH ROW EXECUTE FUNCTION enforce_impersonation_window();

GRANT SELECT, INSERT, UPDATE ON impersonation_session TO paathshala_app;

ALTER TABLE impersonation_session ENABLE ROW LEVEL SECURITY;
ALTER TABLE impersonation_session FORCE  ROW LEVEL SECURITY;

-- Scoped to the tenant like everything else, which is what lets the institute
-- owner see and revoke a session against their own data while it is running.
CREATE POLICY tenant_isolation ON impersonation_session
  FOR ALL TO paathshala_app
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());
