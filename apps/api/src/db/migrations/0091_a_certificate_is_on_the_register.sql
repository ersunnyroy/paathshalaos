-- 0091: a certificate the school issues is numbered and kept (M47.6).
--
-- M47.3 could print a bonafide certificate and deliberately gave it no number:
-- a number recorded nowhere is worse than none, because the day somebody rings
-- to ask "did your school issue certificate 0412?" nobody can answer.
--
-- This is the register. A row is what was issued: to whom, which kind, by
-- whom, when, under what number, and the exact words — stored, not
-- regenerated, because a learner's class and guardian change and a
-- certificate has to say next year what it said on the day.
--
-- ## Immutable, like a receipt
--
-- The application role gets SELECT and INSERT and nothing else. There is no
-- UPDATE to misuse: a certificate that was wrong is answered by issuing
-- another, and the first stays on the register as what was handed over.
-- (Marking one as withdrawn is a later migration; it will be a new row that
-- points at the old one, the way a cancelling receipt does.)
--
-- ## The number
--
-- `serial_no` runs per school, per kind, per year label, from 1. The unique
-- index is the guarantee; the service takes max + 1 inside its transaction and
-- a collision is a retry, the same way receipt numbers are allocated.
--
-- ## Who may issue
--
-- The office: owner, administrator, admissions. Not every member of staff — a
-- certificate carries the school's authority to a bank or a passport office.
-- One function, so the policy and the service ask the same question.
--
-- Everybody on the staff side who can see the learner can read the register
-- for that learner (`app_student_visible`), and so can the family: a parent
-- should be able to see what has been issued in their child's name.

CREATE OR REPLACE FUNCTION app_actor_may_issue_certificates() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM role_grant g
     WHERE g.tenant_id = app_current_tenant_id()
       AND g.user_account_id = app_current_actor_id()
       AND g.revoked_at IS NULL
       AND (g.expires_at IS NULL OR g.expires_at > now())
       AND g.role IN ('ORG_OWNER', 'CAMPUS_ADMIN', 'ADMISSIONS')
  )
$$;

COMMENT ON FUNCTION app_actor_may_issue_certificates() IS
  'True for the roles that issue documents in the school''s name. Narrower '
  'than app_actor_has_staff_scope(): a teacher is staff and does not issue.';

CREATE TABLE certificate_issue (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES organization (id),
  student_id      uuid NOT NULL REFERENCES student (id),

  kind            text NOT NULL CHECK (kind IN ('bonafide', 'study', 'dob')),
  -- "2026-27", or the calendar year when the learner is in no academic year.
  year_label      text NOT NULL,
  serial_no       integer NOT NULL CHECK (serial_no > 0),
  certificate_no  text NOT NULL,

  issued_on       date NOT NULL,
  purpose         text,
  -- The words as handed over.
  title           text NOT NULL,
  paragraphs      jsonb NOT NULL
                    CHECK (jsonb_typeof(paragraphs) = 'array' AND jsonb_array_length(paragraphs) > 0),

  issued_by       uuid REFERENCES staff (id),
  issued_by_user  uuid REFERENCES user_account (id),
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX certificate_issue_serial_key
  ON certificate_issue (tenant_id, kind, year_label, serial_no);
CREATE UNIQUE INDEX certificate_issue_no_key
  ON certificate_issue (tenant_id, certificate_no);
CREATE INDEX certificate_issue_student_idx
  ON certificate_issue (tenant_id, student_id, created_at DESC);

ALTER TABLE certificate_issue ENABLE ROW LEVEL SECURITY;
ALTER TABLE certificate_issue FORCE  ROW LEVEL SECURITY;

GRANT SELECT, INSERT ON certificate_issue TO paathshala_app;
REVOKE UPDATE, DELETE, TRUNCATE ON certificate_issue FROM PUBLIC, paathshala_app;

-- Whoever may see the learner may see what was issued in their name. Read
-- through `student`, whose own policy is the rule: nothing is restated.
CREATE POLICY certificate_read ON certificate_issue
  FOR SELECT TO paathshala_app
  USING (
    tenant_id = app_current_tenant_id()
    AND EXISTS (SELECT 1 FROM student s WHERE s.id = certificate_issue.student_id)
  );

CREATE POLICY certificate_issue_by_office ON certificate_issue
  FOR INSERT TO paathshala_app
  WITH CHECK (
    tenant_id = app_current_tenant_id()
    AND app_actor_may_issue_certificates()
    AND EXISTS (SELECT 1 FROM student s WHERE s.id = certificate_issue.student_id)
  );
