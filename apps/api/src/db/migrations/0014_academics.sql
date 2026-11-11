-- 0014: the academic structure.
--
-- The hierarchy from the plan, in full, with no level collapsed:
--
--   organization → campus → academic_unit → programme
--                                         → academic_year → term
--   programme + academic_year → class_group → section
--   subject + class_group + term → course_offering → schedule_slot
--
-- A single-branch coaching institute has exactly one organization, one campus
-- and one academic unit — but the rows exist. That is what makes a college, a
-- multi-campus trust or a corporate training provider additive later rather
-- than a migration.
--
-- Every structure row is scoped to an academic year. This is the AC-3 decision:
-- 2026-27 gets NEW class_group rows rather than reusing 2025-26's, so a class
-- renamed next year cannot reach backwards into last year's records.

CREATE TABLE programme (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES organization (id),
  academic_unit_id  uuid NOT NULL REFERENCES academic_unit (id),
  code              text NOT NULL,
  name              text NOT NULL,
  duration_terms    integer,
  credential_type   text CHECK (credential_type IS NULL OR credential_type IN
                      ('none', 'certificate', 'diploma', 'degree', 'board_examination')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz,
  CONSTRAINT programme_duration_positive CHECK (duration_terms IS NULL OR duration_terms > 0)
);

CREATE UNIQUE INDEX programme_tenant_unit_code_key
  ON programme (tenant_id, academic_unit_id, code) WHERE deleted_at IS NULL;

CREATE TABLE term (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES organization (id),
  academic_year_id  uuid NOT NULL REFERENCES academic_year (id),
  label             text NOT NULL,
  sequence          integer NOT NULL,
  starts_on         date NOT NULL,
  ends_on           date NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz,
  CONSTRAINT term_dates_ordered CHECK (ends_on > starts_on),
  CONSTRAINT term_sequence_positive CHECK (sequence > 0)
);

CREATE UNIQUE INDEX term_year_sequence_key
  ON term (tenant_id, academic_year_id, sequence) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX term_year_label_key
  ON term (tenant_id, academic_year_id, label) WHERE deleted_at IS NULL;

-- Terms within one year may not overlap. Two open terms means an assessment
-- cannot be attributed to a period, and every later report is ambiguous.
ALTER TABLE term ADD CONSTRAINT term_no_overlap_within_year
  EXCLUDE USING gist (
    academic_year_id WITH =,
    daterange(starts_on, ends_on, '[]') WITH &&
  ) WHERE (deleted_at IS NULL);

CREATE TABLE subject (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES organization (id),
  academic_unit_id  uuid NOT NULL REFERENCES academic_unit (id),
  code              text NOT NULL,
  name              text NOT NULL,
  subject_type      text NOT NULL DEFAULT 'core'
                      CHECK (subject_type IN ('core', 'elective', 'co_scholastic', 'language')),
  default_credits   numeric(5,2),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz
);

CREATE UNIQUE INDEX subject_tenant_unit_code_key
  ON subject (tenant_id, academic_unit_id, code) WHERE deleted_at IS NULL;

CREATE TABLE room (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES organization (id),
  campus_id   uuid NOT NULL REFERENCES campus (id),
  code        text NOT NULL,
  name        text NOT NULL,
  capacity    integer,
  room_type   text NOT NULL DEFAULT 'classroom'
                CHECK (room_type IN ('classroom', 'laboratory', 'hall', 'library', 'ground', 'other')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz,
  CONSTRAINT room_capacity_positive CHECK (capacity IS NULL OR capacity > 0)
);

CREATE UNIQUE INDEX room_tenant_campus_code_key
  ON room (tenant_id, campus_id, code) WHERE deleted_at IS NULL;

-- A class or batch, in one specific academic year.
CREATE TABLE class_group (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES organization (id),
  programme_id      uuid NOT NULL REFERENCES programme (id),
  academic_year_id  uuid NOT NULL REFERENCES academic_year (id),
  name              text NOT NULL,
  group_kind        text NOT NULL DEFAULT 'class'
                      CHECK (group_kind IN ('class', 'cohort', 'batch')),
  capacity          integer,
  -- Ordering for reports and promotion, e.g. Class IX = 9. Distinct from `name`
  -- precisely so that renaming "Class X" to "Grade 10" does not reorder history.
  level_sequence    integer,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz,
  CONSTRAINT class_group_capacity_positive CHECK (capacity IS NULL OR capacity > 0)
);

CREATE UNIQUE INDEX class_group_year_programme_name_key
  ON class_group (tenant_id, academic_year_id, programme_id, name) WHERE deleted_at IS NULL;
CREATE INDEX class_group_year_idx ON class_group (tenant_id, academic_year_id);

CREATE TABLE section (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL REFERENCES organization (id),
  class_group_id         uuid NOT NULL REFERENCES class_group (id),
  name                   text NOT NULL,
  capacity               integer,
  class_teacher_staff_id uuid REFERENCES staff (id),
  room_id                uuid REFERENCES room (id),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  deleted_at             timestamptz,
  CONSTRAINT section_capacity_positive CHECK (capacity IS NULL OR capacity > 0)
);

CREATE UNIQUE INDEX section_class_group_name_key
  ON section (tenant_id, class_group_id, name) WHERE deleted_at IS NULL;
CREATE INDEX section_class_teacher_idx ON section (tenant_id, class_teacher_staff_id);

-- A subject taught to a group, in a term, by a teacher.
CREATE TABLE course_offering (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                 uuid NOT NULL REFERENCES organization (id),
  class_group_id            uuid NOT NULL REFERENCES class_group (id),
  -- NULL means the whole class takes it together rather than per section.
  section_id                uuid REFERENCES section (id),
  subject_id                uuid NOT NULL REFERENCES subject (id),
  term_id                   uuid NOT NULL REFERENCES term (id),
  primary_teacher_staff_id  uuid REFERENCES staff (id),
  credits                   numeric(5,2),
  is_elective               boolean NOT NULL DEFAULT false,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  deleted_at                timestamptz
);

-- COALESCE on section_id because NULL is a real, distinct case here — "the whole
-- class" — and a plain unique index would let it be inserted twice.
CREATE UNIQUE INDEX course_offering_unique
  ON course_offering (
    tenant_id, class_group_id,
    COALESCE(section_id, '00000000-0000-0000-0000-000000000000'::uuid),
    subject_id, term_id
  ) WHERE deleted_at IS NULL;
CREATE INDEX course_offering_teacher_term_idx
  ON course_offering (tenant_id, primary_teacher_staff_id, term_id);
CREATE INDEX course_offering_group_idx ON course_offering (tenant_id, class_group_id);

-- One recurring meeting of an offering.
CREATE TABLE schedule_slot (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES organization (id),
  course_offering_id uuid NOT NULL REFERENCES course_offering (id) ON DELETE CASCADE,
  section_id         uuid REFERENCES section (id),
  room_id            uuid REFERENCES room (id),
  staff_id           uuid REFERENCES staff (id),

  -- ISO-8601: Monday = 1.
  day_of_week        smallint NOT NULL CHECK (day_of_week BETWEEN 1 AND 7),
  period_no          smallint,
  starts_at          time NOT NULL,
  ends_at            time NOT NULL,

  -- Denormalized from course_offering -> term -> academic_year, and set by a
  -- trigger so the application never supplies it and it cannot drift.
  --
  -- It exists because a timetable belongs to an academic year. Without it, a
  -- slot left open-ended in 2025-26 overlaps 2026-27 forever, and rolling the
  -- timetable over trips the room constraint against last year's own lessons.
  -- Scoping the constraints by year is both more correct and cheaper than
  -- retroactively closing every prior-year range.
  academic_year_id   uuid REFERENCES academic_year (id),

  effective_from     date NOT NULL DEFAULT CURRENT_DATE,
  effective_to       date,

  -- Minutes since midnight, derived rather than stored twice. Exclusion
  -- constraints need a range type with GiST support, and there is no built-in
  -- range over `time`.
  minutes            int4range GENERATED ALWAYS AS (
                       int4range(
                         EXTRACT(HOUR FROM starts_at)::int * 60 + EXTRACT(MINUTE FROM starts_at)::int,
                         EXTRACT(HOUR FROM ends_at)::int   * 60 + EXTRACT(MINUTE FROM ends_at)::int
                       )
                     ) STORED,

  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz,

  CONSTRAINT schedule_slot_times_ordered CHECK (ends_at > starts_at),
  CONSTRAINT schedule_slot_dates_ordered CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

CREATE INDEX schedule_slot_offering_idx ON schedule_slot (tenant_id, course_offering_id);
CREATE INDEX schedule_slot_staff_day_idx ON schedule_slot (tenant_id, staff_id, day_of_week);

-- The three constraints that make a timetable clash impossible rather than
-- merely detected.
--
-- An application-level check cannot do this: two admins editing the timetable in
-- parallel both read "free", both write, and the clash exists. A GiST exclusion
-- constraint is evaluated by the index under the same lock as the insert, so the
-- second write fails no matter how the reads interleaved.
--
-- Each constraint matches on four dimensions at once — the resource, the weekday,
-- overlapping minutes, and overlapping effective date ranges — so a slot that
-- ends in March and one that starts in April do not conflict.

ALTER TABLE schedule_slot ADD CONSTRAINT schedule_slot_room_not_double_booked
  EXCLUDE USING gist (
    academic_year_id WITH =,
    room_id WITH =,
    day_of_week WITH =,
    minutes WITH &&,
    daterange(effective_from, effective_to, '[]') WITH &&
  ) WHERE (deleted_at IS NULL AND room_id IS NOT NULL);

ALTER TABLE schedule_slot ADD CONSTRAINT schedule_slot_teacher_not_double_booked
  EXCLUDE USING gist (
    academic_year_id WITH =,
    staff_id WITH =,
    day_of_week WITH =,
    minutes WITH &&,
    daterange(effective_from, effective_to, '[]') WITH &&
  ) WHERE (deleted_at IS NULL AND staff_id IS NOT NULL);

-- A section cannot be in two lessons at once either, which is the clash learners
-- actually notice.
ALTER TABLE schedule_slot ADD CONSTRAINT schedule_slot_section_not_double_booked
  EXCLUDE USING gist (
    academic_year_id WITH =,
    section_id WITH =,
    day_of_week WITH =,
    minutes WITH &&,
    daterange(effective_from, effective_to, '[]') WITH &&
  ) WHERE (deleted_at IS NULL AND section_id IS NOT NULL);

-- Derives the academic year from the offering. BEFORE, so the value is present
-- when the exclusion constraints are checked.
CREATE OR REPLACE FUNCTION set_schedule_slot_academic_year() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  SELECT ay.id INTO NEW.academic_year_id
    FROM course_offering co
    JOIN term t ON t.id = co.term_id
    JOIN academic_year ay ON ay.id = t.academic_year_id
   WHERE co.id = NEW.course_offering_id;

  IF NEW.academic_year_id IS NULL THEN
    RAISE EXCEPTION 'course offering % does not resolve to an academic year',
      NEW.course_offering_id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER schedule_slot_derives_academic_year
  BEFORE INSERT OR UPDATE OF course_offering_id ON schedule_slot
  FOR EACH ROW EXECUTE FUNCTION set_schedule_slot_academic_year();

CREATE INDEX schedule_slot_year_idx ON schedule_slot (tenant_id, academic_year_id);

CREATE TRIGGER programme_set_updated_at       BEFORE UPDATE ON programme       FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER term_set_updated_at            BEFORE UPDATE ON term            FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER subject_set_updated_at         BEFORE UPDATE ON subject         FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER room_set_updated_at            BEFORE UPDATE ON room            FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER class_group_set_updated_at     BEFORE UPDATE ON class_group     FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER section_set_updated_at         BEFORE UPDATE ON section         FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER course_offering_set_updated_at BEFORE UPDATE ON course_offering FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER schedule_slot_set_updated_at   BEFORE UPDATE ON schedule_slot   FOR EACH ROW EXECUTE FUNCTION set_updated_at();
