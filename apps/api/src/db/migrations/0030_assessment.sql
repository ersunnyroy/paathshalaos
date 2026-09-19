-- 0030: assessment — grading scales, assessments and marks.
--
-- The two mistakes this schema exists to make impossible:
--
--   1. **An absence is not a zero.** A learner who did not sit the paper has no
--      mark. Storing it as 0 drags the aggregate down, fails them on a paper
--      they never took, and cannot be told apart from a genuine zero afterwards.
--      `mark` therefore carries exactly one of a number, an absence or an
--      exemption, enforced by a CHECK rather than a convention.
--   2. **A published mark is not editable.** Once a report card has gone home,
--      the honest correction is a superseding row, not an UPDATE. Marks freeze
--      when the assessment locks, and the only way past that is an approved
--      correction that records what the mark used to be.
--
-- Grading scales are DATA. Every board and half the private schools grade
-- differently, and a percentage-to-letter mapping in application code is a
-- release for every customer who joins.

-- ---------------------------------------------------------------------------
-- Grading scales
-- ---------------------------------------------------------------------------

CREATE TABLE grading_scale (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES organization (id),
  academic_unit_id  uuid NOT NULL REFERENCES academic_unit (id),

  name              text NOT NULL,
  -- 'percentage' reports the number; 'letter' reports the band label; 'gpa'
  -- reports the band's grade point. The kind decides what a report card shows,
  -- so it is a stored fact rather than a rendering choice.
  kind              text NOT NULL CHECK (kind IN ('percentage', 'letter', 'gpa')),

  -- Published scales are frozen, exactly as published fee plans are. Changing
  -- the boundary between B and B+ after results are out silently rewrites
  -- history for everyone already graded on it.
  is_published      boolean NOT NULL DEFAULT false,
  published_at      timestamptz,
  published_by      uuid REFERENCES staff (id),

  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz,

  CONSTRAINT grading_scale_published_has_timestamp
    CHECK (is_published = (published_at IS NOT NULL))
);

CREATE UNIQUE INDEX grading_scale_name_key
  ON grading_scale (tenant_id, academic_unit_id, name) WHERE deleted_at IS NULL;

CREATE TABLE grade_band (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES organization (id),
  grading_scale_id  uuid NOT NULL REFERENCES grading_scale (id) ON DELETE CASCADE,

  label             text NOT NULL,
  -- Half-open [lower, upper): 90 belongs to the band that starts at 90, and to
  -- exactly one band. Closed ranges are how a mark of exactly 90 ends up as
  -- both an A and an A+ depending on which row the planner reached first.
  span              numrange NOT NULL,
  grade_point       numeric(4,2),
  is_pass           boolean NOT NULL DEFAULT true,
  description       text,

  created_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT grade_band_span_bounds
    CHECK (lower(span) >= 0 AND upper(span) <= 100.0001
           AND lower_inc(span) AND NOT upper_inc(span)),
  CONSTRAINT grade_band_grade_point_sane
    CHECK (grade_point IS NULL OR (grade_point >= 0 AND grade_point <= 10))
);

-- Two bands of one scale may not overlap. This is the constraint that makes
-- "which grade is 90?" a question with one answer.
ALTER TABLE grade_band
  ADD CONSTRAINT grade_band_no_overlap
  EXCLUDE USING gist (grading_scale_id WITH =, span WITH &&);

CREATE UNIQUE INDEX grade_band_label_key ON grade_band (grading_scale_id, label);

-- Overlap is only half of it: a scale with a HOLE in it silently produces
-- ungraded learners, which surfaces as a blank cell on a report card the day it
-- goes home. A scale may not be published until its bands cover 0 to 100
-- without a gap. Checked at publish, because a scale is built up band by band
-- and would be incomplete for most of its construction.
CREATE OR REPLACE FUNCTION grading_scale_is_covered(scale uuid) RETURNS boolean
LANGUAGE plpgsql STABLE AS $$
DECLARE
  covered numrange;
BEGIN
  SELECT range_agg(span)::text::numrange INTO covered
    FROM grade_band WHERE grading_scale_id = scale;
  -- range_agg over a gapped set yields a multirange with more than one member,
  -- which cannot cast back to a single range. That cast failing IS the answer.
  RETURN covered IS NOT NULL
     AND lower(covered) <= 0
     AND upper(covered) >= 100;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION grading_scale_freeze() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'grading_scale' THEN
    IF OLD.is_published AND NOT (NEW.is_published IS DISTINCT FROM OLD.is_published
                                 AND NEW.is_published = false) THEN
      IF NEW.name <> OLD.name OR NEW.kind <> OLD.kind THEN
        RAISE EXCEPTION 'grading scale % is published; create a new version', OLD.id
          USING ERRCODE = 'restrict_violation';
      END IF;
    END IF;
    IF OLD.is_published AND NOT NEW.is_published THEN
      RAISE EXCEPTION 'a published grading scale cannot be unpublished'
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- grade_band: no change of any kind once the parent scale is published.
  IF EXISTS (SELECT 1 FROM grading_scale s
              WHERE s.id = COALESCE(NEW.grading_scale_id, OLD.grading_scale_id)
                AND s.is_published) THEN
    RAISE EXCEPTION 'the grading scale is published; its bands cannot be altered'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER grading_scale_frozen
  BEFORE UPDATE ON grading_scale
  FOR EACH ROW EXECUTE FUNCTION grading_scale_freeze();

CREATE TRIGGER grade_band_frozen
  BEFORE INSERT OR UPDATE OR DELETE ON grade_band
  FOR EACH ROW EXECUTE FUNCTION grading_scale_freeze();

-- ---------------------------------------------------------------------------
-- Assessments
-- ---------------------------------------------------------------------------

CREATE TABLE assessment (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES organization (id),
  course_offering_id   uuid NOT NULL REFERENCES course_offering (id),
  term_id              uuid NOT NULL REFERENCES term (id),
  -- Derived by trigger from the term, so a query never has to join three tables
  -- to answer "which year is this". 0014 established the pattern.
  academic_year_id     uuid NOT NULL REFERENCES academic_year (id),

  name                 text NOT NULL,
  kind                 text NOT NULL
                         CHECK (kind IN ('exam', 'quiz', 'assignment', 'project',
                                         'practical', 'oral', 'internal')),
  max_marks            numeric(6,2) NOT NULL,
  pass_marks           numeric(6,2),
  -- Share of the term's result for this subject. Assessments are created over
  -- weeks, so the weights are NOT required to sum to 100 here — that is checked
  -- when results are computed, where an incomplete set is a real error rather
  -- than an unfinished afternoon.
  weight_percent       numeric(5,2) NOT NULL DEFAULT 0,
  grading_scale_id     uuid REFERENCES grading_scale (id),

  scheduled_on         date,

  status               text NOT NULL DEFAULT 'draft'
                         CHECK (status IN ('draft', 'open', 'locked', 'cancelled')),
  locked_at            timestamptz,
  locked_by_staff_id   uuid REFERENCES staff (id),

  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT assessment_max_marks_positive CHECK (max_marks > 0),
  CONSTRAINT assessment_pass_marks_within
    CHECK (pass_marks IS NULL OR (pass_marks >= 0 AND pass_marks <= max_marks)),
  CONSTRAINT assessment_weight_sane
    CHECK (weight_percent >= 0 AND weight_percent <= 100),
  CONSTRAINT assessment_locked_has_timestamp
    CHECK ((status = 'locked') = (locked_at IS NOT NULL))
);

CREATE UNIQUE INDEX assessment_name_key
  ON assessment (tenant_id, course_offering_id, term_id, name);
CREATE INDEX assessment_term_idx ON assessment (tenant_id, term_id, status);

CREATE OR REPLACE FUNCTION assessment_derive_year() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  SELECT t.academic_year_id INTO NEW.academic_year_id
    FROM term t WHERE t.id = NEW.term_id;
  IF NEW.academic_year_id IS NULL THEN
    RAISE EXCEPTION 'term % does not exist', NEW.term_id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER assessment_year_derived
  BEFORE INSERT OR UPDATE OF term_id ON assessment
  FOR EACH ROW EXECUTE FUNCTION assessment_derive_year();

-- Changing max_marks after marks exist rescales every learner's percentage
-- without touching a single mark row. It is refused outright.
CREATE OR REPLACE FUNCTION assessment_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.max_marks <> OLD.max_marks
     AND EXISTS (SELECT 1 FROM mark m WHERE m.assessment_id = OLD.id) THEN
    RAISE EXCEPTION 'max_marks cannot change once marks have been entered'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status = 'locked' AND NEW.status IN ('draft', 'open') THEN
    -- Unlocking silently re-opens a graded paper. Corrections are the path.
    RAISE EXCEPTION 'a locked assessment cannot be reopened; correct the marks instead'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- Marks
-- ---------------------------------------------------------------------------

CREATE TABLE mark (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES organization (id),
  assessment_id        uuid NOT NULL REFERENCES assessment (id) ON DELETE CASCADE,

  -- The enrollment, not the student — same reason as attendance. A learner who
  -- moved section mid-year sat the paper in the section they were in.
  enrollment_id        uuid NOT NULL REFERENCES enrollment (id),

  marks_obtained       numeric(6,2),
  is_absent            boolean NOT NULL DEFAULT false,
  is_exempt            boolean NOT NULL DEFAULT false,
  remarks              text,

  source               text NOT NULL DEFAULT 'web'
                         CHECK (source IN ('web', 'app', 'import', 'device')),
  -- Offline idempotency, exactly as in 0021: a replayed batch collides and does
  -- nothing rather than double-entering a class.
  client_event_id      uuid,

  entered_by_staff_id  uuid REFERENCES staff (id),
  entered_at           timestamptz NOT NULL DEFAULT now(),

  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),

  -- The rule this table exists for. Exactly one of: a number, an absence, an
  -- exemption. An absent learner has NO mark, not a zero.
  CONSTRAINT mark_is_exactly_one_thing
    CHECK (
      (marks_obtained IS NOT NULL AND NOT is_absent AND NOT is_exempt)
      OR (marks_obtained IS NULL AND is_absent AND NOT is_exempt)
      OR (marks_obtained IS NULL AND NOT is_absent AND is_exempt)
    ),
  CONSTRAINT mark_not_negative CHECK (marks_obtained IS NULL OR marks_obtained >= 0)
);

CREATE UNIQUE INDEX mark_one_per_enrollment
  ON mark (tenant_id, assessment_id, enrollment_id);
CREATE UNIQUE INDEX mark_client_event_key
  ON mark (tenant_id, client_event_id) WHERE client_event_id IS NOT NULL;
CREATE INDEX mark_enrollment_idx ON mark (tenant_id, enrollment_id);

-- max_marks lives on the parent, so the ceiling cannot be a CHECK. A trigger is
-- the only place it can be enforced in the database, and it has to be enforced
-- in the database: a 105-out-of-100 typed at 9pm is otherwise a published grade.
CREATE OR REPLACE FUNCTION mark_within_bounds() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  a record;
BEGIN
  SELECT max_marks, status INTO a FROM assessment WHERE id = NEW.assessment_id;
  IF a IS NULL THEN
    RAISE EXCEPTION 'assessment % does not exist', NEW.assessment_id;
  END IF;
  IF NEW.marks_obtained IS NOT NULL AND NEW.marks_obtained > a.max_marks THEN
    RAISE EXCEPTION 'mark % exceeds the maximum of % for this assessment',
      NEW.marks_obtained, a.max_marks
      USING ERRCODE = 'check_violation';
  END IF;
  IF a.status = 'draft' THEN
    RAISE EXCEPTION 'marks cannot be entered against a draft assessment'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF a.status = 'cancelled' THEN
    RAISE EXCEPTION 'this assessment was cancelled'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF a.status = 'locked' THEN
    RAISE EXCEPTION 'this assessment is locked; record a correction instead'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER mark_bounds_checked
  BEFORE INSERT OR UPDATE ON mark
  FOR EACH ROW EXECUTE FUNCTION mark_within_bounds();

CREATE TRIGGER assessment_guarded
  BEFORE UPDATE ON assessment
  FOR EACH ROW EXECUTE FUNCTION assessment_guard();

-- ---------------------------------------------------------------------------
-- Corrections
-- ---------------------------------------------------------------------------

-- An amendment, never an overwrite — the same shape as attendance_correction,
-- because the dispute is the same shape: "it always said 34" is a thing a parent
-- says, and the system should be able to answer.
CREATE TABLE mark_correction (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES organization (id),
  mark_id           uuid REFERENCES mark (id) ON DELETE CASCADE,

  -- Set when the correction is for a learner who has no mark row at all — a
  -- paper found after the assessment was locked.
  assessment_id     uuid REFERENCES assessment (id) ON DELETE CASCADE,
  enrollment_id     uuid REFERENCES enrollment (id),

  from_marks        numeric(6,2),
  from_absent       boolean,
  to_marks          numeric(6,2),
  to_absent         boolean NOT NULL DEFAULT false,
  to_exempt         boolean NOT NULL DEFAULT false,

  reason            text NOT NULL,
  status            text NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'approved', 'rejected')),

  requested_by      uuid REFERENCES staff (id),
  requested_at      timestamptz NOT NULL DEFAULT now(),
  approved_by       uuid REFERENCES staff (id),
  approved_at       timestamptz,
  rejection_reason  text,

  created_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT mark_correction_targets_something
    CHECK (mark_id IS NOT NULL OR (assessment_id IS NOT NULL AND enrollment_id IS NOT NULL)),
  CONSTRAINT mark_correction_to_is_one_thing
    CHECK (
      (to_marks IS NOT NULL AND NOT to_absent AND NOT to_exempt)
      OR (to_marks IS NULL AND to_absent AND NOT to_exempt)
      OR (to_marks IS NULL AND NOT to_absent AND to_exempt)
    ),
  -- The person who entered the wrong mark is exactly the person most motivated
  -- to correct it quietly.
  CONSTRAINT mark_correction_needs_two_people
    CHECK (approved_by IS NULL OR approved_by <> requested_by),
  CONSTRAINT mark_correction_approved_has_approver
    CHECK ((status = 'approved') = (approved_at IS NOT NULL)),
  CONSTRAINT mark_correction_rejected_has_reason
    CHECK (status <> 'rejected' OR rejection_reason IS NOT NULL)
);

CREATE INDEX mark_correction_pending_idx
  ON mark_correction (tenant_id, status) WHERE status = 'pending';

CREATE OR REPLACE FUNCTION mark_correction_is_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a mark correction cannot be deleted'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'a % correction is settled and cannot be altered', OLD.status
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.from_marks IS DISTINCT FROM OLD.from_marks
     OR NEW.to_marks IS DISTINCT FROM OLD.to_marks
     OR NEW.to_absent <> OLD.to_absent
     OR NEW.mark_id IS DISTINCT FROM OLD.mark_id
     OR NEW.requested_by IS DISTINCT FROM OLD.requested_by THEN
    RAISE EXCEPTION 'the substance of a correction cannot be edited; raise another'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER mark_correction_append_only
  BEFORE UPDATE OR DELETE ON mark_correction
  FOR EACH ROW EXECUTE FUNCTION mark_correction_is_append_only();
