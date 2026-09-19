-- 0054: a platform administrator enters a school.
--
-- 0008 built impersonation for SUPPORT: a request, a second person's approval,
-- a ticket reference, sixty minutes. That is the right shape when the person
-- asking is a support agent handling one complaint, and it is the wrong shape
-- when the person is running the platform and needs to look at a school right
-- now — a queue of one-click approvals between two colleagues becomes a rubber
-- stamp, and a rubber stamp is worse than no control because it looks like one.
--
-- So this adds a second entry path rather than weakening the first:
--
--   support     request → approve → active. Unchanged. Still two people, still
--               a ticket, still read-only by default.
--   platform    a holder of the `impersonate` capability opens a session
--               directly. No approver, no ticket, no wait.
--
-- What both paths share, and what this migration is really about: a session ROW
-- exists either way. It carries both identities into every audit entry, it
-- expires on a clock the database enforces, the school sees it in their own
-- trail, and the institute's owner can end it. The platform path removes the
-- friction; it does not remove the record.
--
-- The alternative — a standing cross-tenant grant so the console can query any
-- school directly — is one line of SQL and removes the record entirely. Under
-- the DPDP Act the school is the Data Fiduciary and we are the Processor; a
-- Processor that cannot say who read a child's file is the finding that ends an
-- enterprise sale.

ALTER TABLE impersonation_session
  ADD COLUMN entry_path text NOT NULL DEFAULT 'support'
    CHECK (entry_path IN ('support', 'platform'));

-- Which role the actor is assuming, when they are not assuming a specific
-- person. "Show me what a teacher sees" is the common request and there may be
-- no single teacher who represents it.
ALTER TABLE impersonation_session
  ADD COLUMN assumed_role text;

ALTER TABLE impersonation_session
  ADD CONSTRAINT impersonation_assumes_person_or_role
    CHECK (target_user_id IS NOT NULL OR assumed_role IS NOT NULL);

-- A platform session needs no approver; a support session still does. Both
-- still need the window, which the existing trigger enforces.
--
-- Written as one constraint rather than relaxing the trigger, so the two paths
-- are visibly different in the schema and nobody has to read a service to know
-- which rules apply to which.
ALTER TABLE impersonation_session
  ADD CONSTRAINT impersonation_support_needs_approval
    CHECK (entry_path = 'platform' OR status <> 'active' OR approved_by IS NOT NULL);

-- The ticket reference is a support artefact. A platform entry has no ticket,
-- and demanding one would just teach people to type 'n/a'.
ALTER TABLE impersonation_session ALTER COLUMN ticket_ref DROP NOT NULL;
ALTER TABLE impersonation_session
  ADD CONSTRAINT impersonation_support_has_ticket
    CHECK (entry_path = 'platform' OR ticket_ref IS NOT NULL);

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
    -- The clock applies to both paths. A platform administrator who needs
    -- longer opens another session, which leaves another row — that is the
    -- point, and it costs them one click an hour.
    IF NEW.entry_path = 'support' AND NEW.approved_by IS NULL THEN
      RAISE EXCEPTION 'a support impersonation cannot become active without an approver';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE INDEX impersonation_actor_idx
  ON impersonation_session (actor_user_id, requested_at DESC);

-- The platform role reads and writes these rows: opening a session is a
-- platform action, and the console lists what its own people have been doing.
GRANT SELECT, INSERT, UPDATE ON impersonation_session TO paathshala_platform;

CREATE POLICY platform_sessions ON impersonation_session
  FOR ALL TO paathshala_platform USING (true) WITH CHECK (true);

COMMENT ON COLUMN impersonation_session.entry_path IS
  'support: requested and approved by a second person, with a ticket. '
  'platform: opened directly by a capability holder. Both leave a row, both '
  'expire on the same clock, both appear in the school''s own audit trail.';
