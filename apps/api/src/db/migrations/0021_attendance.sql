-- 0021: attendance.
--
-- A NOTE ON PARTITIONING, because the plan calls for it and this does not do it.
--
-- attendance_record is the highest-volume table in the product and will want
-- monthly partitioning. It is deliberately NOT partitioned yet, because a
-- partitioned table's unique constraints must include the partition key — so
-- `UNIQUE (tenant_id, client_event_id)` would become
-- `UNIQUE (tenant_id, session_date, client_event_id)`, and the offline
-- idempotency guarantee would hold only within a date rather than absolutely.
-- Correctness first; partitioning is a scaling migration with a known shape, and
-- when it happens the lesson from 0009 applies: a policy on a partitioned parent
-- is not applied to a query naming a partition directly.

CREATE TABLE attendance_session (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES organization (id),
  section_id          uuid NOT NULL REFERENCES section (id),
  -- NULL for day-level attendance, set for subject-wise.
  course_offering_id  uuid REFERENCES course_offering (id),
  academic_year_id    uuid NOT NULL REFERENCES academic_year (id),

  session_date        date NOT NULL,
  period_no           smallint,
  mode                text NOT NULL DEFAULT 'subject'
                        CHECK (mode IN ('day', 'subject', 'device')),

  status              text NOT NULL DEFAULT 'open'
                        CHECK (status IN ('open', 'submitted', 'locked')),
  marked_by_staff_id  uuid REFERENCES staff (id),
  submitted_at        timestamptz,
  locked_at           timestamptz,
  locked_by_staff_id  uuid REFERENCES staff (id),

  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT attendance_session_submitted_has_timestamp
    CHECK ((status = 'open') = (submitted_at IS NULL)),
  CONSTRAINT attendance_session_locked_has_timestamp
    CHECK ((status = 'locked') = (locked_at IS NOT NULL)),
  CONSTRAINT attendance_session_day_mode_has_no_offering
    CHECK (mode <> 'day' OR course_offering_id IS NULL),
  CONSTRAINT attendance_session_subject_mode_has_offering
    CHECK (mode <> 'subject' OR course_offering_id IS NOT NULL)
);

-- One session per section per date per period per offering. COALESCE because a
-- NULL offering (day attendance) is a real, distinct case.
CREATE UNIQUE INDEX attendance_session_unique
  ON attendance_session (
    tenant_id, section_id, session_date,
    COALESCE(period_no, -1),
    COALESCE(course_offering_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );
CREATE INDEX attendance_session_date_idx ON attendance_session (tenant_id, session_date);
CREATE INDEX attendance_session_open_idx
  ON attendance_session (tenant_id, section_id, session_date) WHERE status = 'open';

CREATE TABLE attendance_record (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL REFERENCES organization (id),
  attendance_session_id  uuid NOT NULL REFERENCES attendance_session (id) ON DELETE CASCADE,

  -- References the ENROLLMENT, not the student. A learner who transferred
  -- mid-year has two enrollments, and the day they were absent belongs to
  -- whichever one was active on that date. Keying on student_id would attach
  -- history to whichever section they happen to sit in now.
  enrollment_id          uuid NOT NULL REFERENCES enrollment (id),

  state                  text NOT NULL
                           CHECK (state IN ('present', 'absent', 'late', 'excused', 'half_day')),
  minutes_late           integer,

  source                 text NOT NULL DEFAULT 'app'
                           CHECK (source IN ('app', 'web', 'device', 'import')),

  -- Generated on the device before the record could possibly reach a server.
  -- This is what makes a replay a no-op instead of a duplicate.
  client_event_id        uuid,
  -- What the device believed the time was. Kept for forensics; never trusted.
  device_recorded_at     timestamptz,
  -- Server time, always authoritative.
  recorded_at            timestamptz NOT NULL DEFAULT now(),
  recorded_by_staff_id   uuid REFERENCES staff (id),

  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT attendance_record_late_has_minutes
    CHECK (state <> 'late' OR minutes_late IS NOT NULL),
  CONSTRAINT attendance_record_minutes_sane
    CHECK (minutes_late IS NULL OR (minutes_late >= 0 AND minutes_late <= 600))
);

-- One state per learner per session.
CREATE UNIQUE INDEX attendance_record_one_per_enrollment
  ON attendance_record (tenant_id, attendance_session_id, enrollment_id);
-- Offline idempotency. A replayed batch collides here and does nothing.
CREATE UNIQUE INDEX attendance_record_client_event_key
  ON attendance_record (tenant_id, client_event_id) WHERE client_event_id IS NOT NULL;
CREATE INDEX attendance_record_enrollment_idx
  ON attendance_record (tenant_id, enrollment_id, recorded_at DESC);

-- An amendment, never an overwrite.
--
-- The original record keeps its original state until a correction is approved,
-- and even then the correction row preserves what it used to be. "It always said
-- absent" is a thing families dispute, and the system should be able to answer.
CREATE TABLE attendance_correction (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES organization (id),
  attendance_record_id  uuid REFERENCES attendance_record (id) ON DELETE CASCADE,

  -- Set when a correction is requested for a session that has no record yet —
  -- a late offline sync into a locked session.
  attendance_session_id uuid REFERENCES attendance_session (id) ON DELETE CASCADE,
  enrollment_id         uuid REFERENCES enrollment (id),

  from_state            text,
  to_state              text NOT NULL
                          CHECK (to_state IN ('present', 'absent', 'late', 'excused', 'half_day')),
  reason                text NOT NULL,
  origin                text NOT NULL DEFAULT 'manual'
                          CHECK (origin IN ('manual', 'late_offline_sync', 'device_import')),

  status                text NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending', 'approved', 'rejected')),
  requested_by          uuid REFERENCES staff (id),
  requested_at          timestamptz NOT NULL DEFAULT now(),
  approved_by           uuid REFERENCES staff (id),
  approved_at           timestamptz,
  rejection_reason      text,

  created_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT attendance_correction_targets_something
    CHECK (attendance_record_id IS NOT NULL
           OR (attendance_session_id IS NOT NULL AND enrollment_id IS NOT NULL)),
  CONSTRAINT attendance_correction_approved_has_approver
    CHECK (status <> 'approved' OR (approved_by IS NOT NULL AND approved_at IS NOT NULL)),
  CONSTRAINT attendance_correction_rejected_has_reason
    CHECK (status <> 'rejected' OR rejection_reason IS NOT NULL)
);

CREATE INDEX attendance_correction_pending_idx
  ON attendance_correction (tenant_id, status, requested_at) WHERE status = 'pending';
CREATE INDEX attendance_correction_record_idx
  ON attendance_correction (tenant_id, attendance_record_id);

-- A correction row is evidence of what was changed and why.
CREATE OR REPLACE FUNCTION attendance_correction_is_evidence() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'an attendance correction cannot be deleted'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.from_state IS DISTINCT FROM OLD.from_state
     OR NEW.to_state <> OLD.to_state
     OR NEW.attendance_record_id IS DISTINCT FROM OLD.attendance_record_id
     OR NEW.requested_at <> OLD.requested_at THEN
    RAISE EXCEPTION 'an attendance correction may only be approved or rejected, not rewritten'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER attendance_correction_append_only
  BEFORE UPDATE OR DELETE ON attendance_correction
  FOR EACH ROW EXECUTE FUNCTION attendance_correction_is_evidence();

CREATE TABLE leave_request (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES organization (id),
  subject_type      text NOT NULL CHECK (subject_type IN ('student', 'staff')),
  -- Polymorphic by design: student_id or staff_id. Enforced by the two partial
  -- FK-shaped checks below rather than a real FK, because a single column cannot
  -- reference two tables.
  student_id        uuid REFERENCES student (id),
  staff_id          uuid REFERENCES staff (id),
  from_date         date NOT NULL,
  to_date           date NOT NULL,
  leave_type        text NOT NULL CHECK (leave_type IN
                      ('sick', 'casual', 'planned', 'medical', 'bereavement', 'other')),
  reason            text NOT NULL,
  attachment_file_id uuid REFERENCES file (id),
  status            text NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  requested_by      uuid REFERENCES user_account (id) ON DELETE SET NULL,
  decided_by        uuid REFERENCES staff (id),
  decided_at        timestamptz,
  decision_note     text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT leave_request_dates_ordered CHECK (to_date >= from_date),
  CONSTRAINT leave_request_subject_matches
    CHECK ((subject_type = 'student' AND student_id IS NOT NULL AND staff_id IS NULL)
        OR (subject_type = 'staff'   AND staff_id   IS NOT NULL AND student_id IS NULL)),
  CONSTRAINT leave_request_decided_has_decider
    CHECK (status IN ('pending', 'cancelled') OR (decided_by IS NOT NULL AND decided_at IS NOT NULL))
);

CREATE INDEX leave_request_student_idx ON leave_request (tenant_id, student_id, from_date);
CREATE INDEX leave_request_staff_idx ON leave_request (tenant_id, staff_id, from_date);
CREATE INDEX leave_request_pending_idx ON leave_request (tenant_id, status) WHERE status = 'pending';

CREATE TRIGGER attendance_session_set_updated_at
  BEFORE UPDATE ON attendance_session FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER attendance_record_set_updated_at
  BEFORE UPDATE ON attendance_record FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER leave_request_set_updated_at
  BEFORE UPDATE ON leave_request FOR EACH ROW EXECUTE FUNCTION set_updated_at();
