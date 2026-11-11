-- 0019: enrollment and the learner lifecycle.
--
-- The integrity rule from the plan, stated exactly: ONE ACTIVE ENROLLMENT PER
-- LEARNER PER ACADEMIC YEAR, enforced by a partial unique index rather than by
-- application logic — because the failure mode is a learner appearing twice on a
-- roll and once on a fee ledger, discovered in March.
--
-- Two kinds of transfer, deliberately different:
--
--   within a year, between sections → UPDATE section_id on the SAME row, plus an
--     event. One enrollment, one fee assignment, one attendance history.
--   between campuses or academic units → END one enrollment, OPEN another,
--     linked by related_enrollment_id, in one transaction. Two rows, because the
--     learner genuinely belonged to two places and each has its own roll number,
--     fees and attendance.

CREATE TABLE enrollment (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES organization (id),
  student_id            uuid NOT NULL REFERENCES student (id),
  section_id            uuid NOT NULL REFERENCES section (id),
  academic_year_id      uuid NOT NULL REFERENCES academic_year (id),
  admission_decision_id uuid REFERENCES admission_decision (id),

  status                text NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active', 'transferred', 'withdrawn', 'completed')),
  roll_no               text,
  enrolled_on           date NOT NULL DEFAULT CURRENT_DATE,
  ended_on              date,

  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT enrollment_ended_after_enrolled
    CHECK (ended_on IS NULL OR ended_on >= enrolled_on),
  -- An ended enrollment must say when, and an active one must not.
  CONSTRAINT enrollment_status_matches_ended_on
    CHECK ((status = 'active') = (ended_on IS NULL))
);

-- THE invariant.
CREATE UNIQUE INDEX enrollment_one_active_per_learner_per_year
  ON enrollment (tenant_id, student_id, academic_year_id) WHERE status = 'active';

-- Roll numbers are unique within a section while they are in use. A withdrawn
-- learner's number can be reissued; two active learners cannot share one.
CREATE UNIQUE INDEX enrollment_roll_no_key
  ON enrollment (tenant_id, section_id, roll_no)
  WHERE roll_no IS NOT NULL AND status = 'active';

CREATE INDEX enrollment_year_status_idx ON enrollment (tenant_id, academic_year_id, status);
CREATE INDEX enrollment_section_idx ON enrollment (tenant_id, section_id) WHERE status = 'active';
CREATE INDEX enrollment_student_idx ON enrollment (tenant_id, student_id);

-- Append-only. Every transition the learner's record ever made, including the
-- ones that were later reversed.
CREATE TABLE enrollment_event (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES organization (id),
  enrollment_id         uuid NOT NULL REFERENCES enrollment (id) ON DELETE CASCADE,
  event_type            text NOT NULL CHECK (event_type IN
                          ('enrolled', 'section_changed', 'transferred_in', 'transferred_out',
                           'withdrawn', 'completed', 'alumni', 'reinstated')),
  effective_on          date NOT NULL DEFAULT CURRENT_DATE,
  reason                text,
  -- Deliberately NOT a foreign key, for the same reason audit_log has none.
  --
  -- An append-only table cannot carry a referential action: ON DELETE SET NULL
  -- issues an UPDATE, which the append-only trigger below refuses, so removing
  -- a departed employee's account would fail on a table nobody may modify. ON
  -- DELETE NO ACTION would instead make the account undeletable forever.
  --
  -- A historical record should not hold a live reference to a mutable row. The
  -- id is kept verbatim; if the account is gone, the audit log still says who.
  actor_user_id         uuid,
  -- The other side of a campus transfer.
  related_enrollment_id uuid REFERENCES enrollment (id),
  from_section_id       uuid REFERENCES section (id),
  to_section_id         uuid REFERENCES section (id),
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX enrollment_event_enrollment_idx
  ON enrollment_event (tenant_id, enrollment_id, effective_on);
CREATE INDEX enrollment_event_type_idx ON enrollment_event (tenant_id, event_type, effective_on);

CREATE OR REPLACE FUNCTION enrollment_event_is_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'enrollment_event is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER enrollment_event_no_update BEFORE UPDATE ON enrollment_event
  FOR EACH STATEMENT EXECUTE FUNCTION enrollment_event_is_append_only();
CREATE TRIGGER enrollment_event_no_delete BEFORE DELETE ON enrollment_event
  FOR EACH STATEMENT EXECUTE FUNCTION enrollment_event_is_append_only();

-- Which optional offerings this enrollment takes.
CREATE TABLE subject_election (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES organization (id),
  enrollment_id      uuid NOT NULL REFERENCES enrollment (id) ON DELETE CASCADE,
  course_offering_id uuid NOT NULL REFERENCES course_offering (id),
  elected_on         date NOT NULL DEFAULT CURRENT_DATE,
  dropped_on         date,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT subject_election_dates_ordered
    CHECK (dropped_on IS NULL OR dropped_on >= elected_on)
);

CREATE UNIQUE INDEX subject_election_one_live
  ON subject_election (tenant_id, enrollment_id, course_offering_id) WHERE dropped_on IS NULL;

-- An enrollment's section must belong to the enrollment's academic year.
-- Without this, a section transfer could quietly move a learner into last
-- year's class and every downstream report would disagree with itself.
CREATE OR REPLACE FUNCTION enrollment_section_matches_year() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_year uuid;
BEGIN
  SELECT cg.academic_year_id INTO v_year
    FROM section s JOIN class_group cg ON cg.id = s.class_group_id
   WHERE s.id = NEW.section_id;

  IF v_year IS NULL THEN
    RAISE EXCEPTION 'section % does not exist', NEW.section_id;
  END IF;
  IF v_year <> NEW.academic_year_id THEN
    RAISE EXCEPTION 'section % belongs to academic year %, not %',
      NEW.section_id, v_year, NEW.academic_year_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER enrollment_section_year_matches
  BEFORE INSERT OR UPDATE OF section_id, academic_year_id ON enrollment
  FOR EACH ROW EXECUTE FUNCTION enrollment_section_matches_year();

CREATE TRIGGER enrollment_set_updated_at
  BEFORE UPDATE ON enrollment FOR EACH ROW EXECUTE FUNCTION set_updated_at();
