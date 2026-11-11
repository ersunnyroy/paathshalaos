-- 0076: lessons, assignments and submissions (M28).
--
-- The last of the three flags M16 sold with nothing behind it. `transport` was
-- paid off in 0066, `hr` in 0073, and this is `lms`.
--
-- ONE DESIGN DECISION SHAPES EVERY TABLE HERE: an assignment that carries marks
-- IS an assessment. There is no score column on a submission, anywhere, on
-- purpose. The obvious schema gives `submission` a `marks_obtained` and a
-- `graded_at`, and it is wrong in a way that only shows up in March: those
-- marks are then invisible to M8's weighting, to the result run, and to the
-- report card, so a term of homework the teacher graded every week contributes
-- nothing to the learner's result and nobody notices until the results are
-- computed. A second scoring system beside the first is not a feature.
--
-- So an assignment that counts points back to an `assessment` row, and grading
-- a submission means entering a mark against that assessment through the
-- machinery M8 already has — the same lock, the same corrections, the same
-- absent/exempt rule, the same idempotency. `submission` carries what the
-- assessment module has no place for: the work itself, when it arrived,
-- whether it was late, and what the teacher wrote back.
--
-- An assignment with no assessment is practice. That is a real thing teachers
-- set and it should not be forced to pollute the gradebook, so `assessment_id`
-- is nullable — but a submission on an assignment that HAS one cannot be
-- marked returned until a mark exists. That is a trigger, below, because "the
-- service remembers to write the mark too" is exactly the kind of promise that
-- holds until the second caller.

-- ---------------------------------------------------------------------------
-- Who may see and who may set
-- ---------------------------------------------------------------------------
--
-- Two questions, deliberately not one. 0049 established that a learner has a
-- single visibility rule; this is the same discipline for a course offering,
-- and the reason it splits in two is that reading and writing have genuinely
-- different answers here.
--
-- A class teacher of 5A can see the work set in 5A — they are asked about it
-- at the gate every afternoon. They cannot EDIT the maths teacher's
-- assignment. Collapsing the two would have been one shorter function and a
-- teacher quietly rewriting a colleague's homework.

CREATE OR REPLACE FUNCTION app_is_own_learner(p_student_id uuid) RETURNS boolean
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM student s
     WHERE s.id = p_student_id
       AND s.tenant_id = app_current_tenant_id()
       AND s.deleted_at IS NULL
       AND (s.person_id = app_current_person_id()
            OR EXISTS (SELECT 1 FROM guardian_link gl
                        WHERE gl.student_id = s.id
                          AND gl.tenant_id = s.tenant_id
                          AND gl.guardian_person_id = app_current_person_id()
                          AND gl.effective_to IS NULL
                          AND gl.effective_from <= CURRENT_DATE)))
$$;

REVOKE ALL ON FUNCTION app_is_own_learner(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_is_own_learner(uuid) TO paathshala_app;

COMMENT ON FUNCTION app_is_own_learner(uuid) IS
  'The learner themselves, or a guardian whose link is in force today. '
  'Narrower than app_student_visible, which also admits their teachers and '
  'the office — this is the rule for acts only the family may perform, such '
  'as submitting a piece of work.';

-- The write rule: the teacher who owns the offering, or is timetabled into it.
CREATE OR REPLACE FUNCTION app_may_set_work(p_course_offering_id uuid) RETURNS boolean
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM course_offering co
     WHERE co.id = p_course_offering_id
       AND co.tenant_id = app_current_tenant_id()
       AND co.deleted_at IS NULL
       AND (app_actor_has_whole_school_scope()
            OR (app_current_staff_id() IS NOT NULL
                AND (co.primary_teacher_staff_id = app_current_staff_id()
                     OR EXISTS (SELECT 1 FROM schedule_slot sl
                                 WHERE sl.course_offering_id = co.id
                                   AND sl.staff_id = app_current_staff_id())))))
$$;

REVOKE ALL ON FUNCTION app_may_set_work(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_may_set_work(uuid) TO paathshala_app;

COMMENT ON FUNCTION app_may_set_work(uuid) IS
  'Who may create or change the work on a course offering. Deliberately '
  'narrower than app_may_see_offering: a class teacher reads every subject '
  'taught to their section and edits none of them.';

-- The read rule.
CREATE OR REPLACE FUNCTION app_may_see_offering(p_course_offering_id uuid) RETURNS boolean
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM course_offering co
     WHERE co.id = p_course_offering_id
       AND co.tenant_id = app_current_tenant_id()
       AND co.deleted_at IS NULL
       AND (
         app_may_set_work(co.id)
         -- Section scope: the class teacher, and anyone timetabled into a
         -- section this offering is taught to.
         OR (co.section_id IS NOT NULL AND co.section_id = ANY (app_actor_section_ids()))
         OR (co.section_id IS NULL AND EXISTS (
               SELECT 1 FROM section s
                WHERE s.tenant_id = co.tenant_id
                  AND s.class_group_id = co.class_group_id
                  AND s.id = ANY (app_actor_section_ids())))
         -- The family: an active enrollment in a section this offering covers.
         OR EXISTS (
           SELECT 1 FROM enrollment e
            JOIN section s ON s.id = e.section_id
            WHERE e.tenant_id = co.tenant_id
              AND e.status = 'active'
              AND s.class_group_id = co.class_group_id
              AND (co.section_id IS NULL OR co.section_id = e.section_id)
              AND app_is_own_learner(e.student_id))))
$$;

REVOKE ALL ON FUNCTION app_may_see_offering(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_may_see_offering(uuid) TO paathshala_app;

COMMENT ON FUNCTION app_may_see_offering(uuid) IS
  'Who may read the teaching of a course offering. A NULL section_id on the '
  'offering means the whole class group takes it together, which is why every '
  'branch here has two halves rather than one.';

-- ---------------------------------------------------------------------------
-- Lessons
-- ---------------------------------------------------------------------------

CREATE TABLE lesson (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES organization (id),
  course_offering_id  uuid NOT NULL REFERENCES course_offering (id) ON DELETE CASCADE,

  -- Derived from the offering's term, by trigger, exactly as 0014 and 0030 do
  -- it. A lesson belongs to an academic year and no caller should have to say
  -- so twice.
  academic_year_id    uuid NOT NULL REFERENCES academic_year (id),

  title               text NOT NULL CHECK (length(btrim(title)) > 0),
  summary             text,
  -- Where it sits in the sequence the teacher is working through. Sparse on
  -- purpose: inserting a lesson between 3 and 4 should not renumber the term.
  sequence_no         integer,
  taught_on           date,

  status              text NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft', 'published', 'archived')),
  published_at        timestamptz,

  created_by_staff_id uuid REFERENCES staff (id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT lesson_published_has_timestamp
    CHECK ((status = 'published') = (published_at IS NOT NULL))
);

CREATE INDEX lesson_offering_idx ON lesson (tenant_id, course_offering_id, sequence_no);
CREATE INDEX lesson_published_idx ON lesson (tenant_id, course_offering_id)
  WHERE status = 'published';

-- Teaching material. The bytes are in object storage; 0017's `file` row is the
-- metadata, and it already carries the virus-scan state that decides whether
-- anything may be served.
CREATE TABLE lesson_resource (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES organization (id),
  lesson_id   uuid NOT NULL REFERENCES lesson (id) ON DELETE CASCADE,
  file_id     uuid NOT NULL REFERENCES file (id),
  label       text,
  sort_order  integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX lesson_resource_unique ON lesson_resource (tenant_id, lesson_id, file_id);

-- ---------------------------------------------------------------------------
-- Assignments
-- ---------------------------------------------------------------------------

CREATE TABLE assignment (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES organization (id),
  course_offering_id  uuid NOT NULL REFERENCES course_offering (id) ON DELETE CASCADE,
  academic_year_id    uuid NOT NULL REFERENCES academic_year (id),
  -- Optional: homework set off the back of a particular lesson.
  lesson_id           uuid REFERENCES lesson (id) ON DELETE SET NULL,

  -- The whole design, in one nullable column.
  --
  -- Set: this assignment carries marks, and they live in `mark` against this
  -- assessment, where the result run can see them. NULL: practice, no marks,
  -- nothing to reconcile. There is deliberately no third state.
  assessment_id       uuid REFERENCES assessment (id),

  title               text NOT NULL CHECK (length(btrim(title)) > 0),
  instructions        text,

  due_at              timestamptz,
  -- A teacher who will not take late work has to say so. The default is the
  -- forgiving one because the cost of the two mistakes is not symmetrical: a
  -- child locked out of submitting at 23:01 has no recourse, and a teacher who
  -- wanted a hard deadline can set one.
  accepts_late        boolean NOT NULL DEFAULT true,

  submission_kind     text NOT NULL DEFAULT 'either'
                        CHECK (submission_kind IN ('text', 'file', 'either', 'offline')),

  status              text NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft', 'published', 'closed')),
  published_at        timestamptz,

  created_by_staff_id uuid REFERENCES staff (id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT assignment_published_has_timestamp
    CHECK ((status IN ('published', 'closed')) = (published_at IS NOT NULL)),
  -- 'offline' means the work is handed in on paper. There is nothing to upload
  -- and nothing to type, so a due date is all the row carries — but it can
  -- still be graded, which is why it is a submission_kind and not a flag.
  CONSTRAINT assignment_late_needs_a_deadline
    CHECK (accepts_late OR due_at IS NOT NULL)
);

-- One assignment per assessment. Two assignments pointing at one assessment
-- would make "which piece of work is this mark for" unanswerable.
CREATE UNIQUE INDEX assignment_assessment_key ON assignment (assessment_id)
  WHERE assessment_id IS NOT NULL;
CREATE INDEX assignment_offering_idx ON assignment (tenant_id, course_offering_id, due_at);
CREATE INDEX assignment_due_idx ON assignment (tenant_id, due_at) WHERE status = 'published';

-- ---------------------------------------------------------------------------
-- Submissions
-- ---------------------------------------------------------------------------

CREATE TABLE submission (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES organization (id),
  assignment_id       uuid NOT NULL REFERENCES assignment (id) ON DELETE CASCADE,

  -- The enrollment, not the student — the same reason attendance and marks use
  -- it. A learner who changed section in November did this homework in the
  -- section they were in at the time.
  enrollment_id       uuid NOT NULL REFERENCES enrollment (id),
  -- Derived from the enrollment by trigger. It exists so the row-level policy
  -- can ask "is this my child" without joining, and because a policy that
  -- joins enrollment is a policy that depends on enrollment's own policy.
  student_id          uuid NOT NULL REFERENCES student (id),
  -- Likewise derived: the write policy asks who may set work on this offering,
  -- and should not have to walk back through assignment to find out.
  course_offering_id  uuid NOT NULL REFERENCES course_offering (id),

  body_text           text,
  submitted_at        timestamptz NOT NULL DEFAULT now(),
  -- Computed by trigger from the assignment's due_at. Never accepted from a
  -- caller: two clients with two clocks would disagree about whether the same
  -- row was late.
  is_late             boolean NOT NULL DEFAULT false,

  status              text NOT NULL DEFAULT 'submitted'
                        CHECK (status IN ('submitted', 'returned')),
  feedback            text,
  returned_at         timestamptz,
  returned_by_staff_id uuid REFERENCES staff (id),

  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT submission_returned_has_timestamp
    CHECK ((status = 'returned') = (returned_at IS NOT NULL))
);

CREATE UNIQUE INDEX submission_one_per_learner
  ON submission (tenant_id, assignment_id, enrollment_id);
CREATE INDEX submission_assignment_idx ON submission (tenant_id, assignment_id, status);
CREATE INDEX submission_student_idx ON submission (tenant_id, student_id, submitted_at DESC);

CREATE TABLE submission_file (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES organization (id),
  submission_id  uuid NOT NULL REFERENCES submission (id) ON DELETE CASCADE,
  file_id        uuid NOT NULL REFERENCES file (id),
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX submission_file_unique ON submission_file (tenant_id, submission_id, file_id);

-- ---------------------------------------------------------------------------
-- The rules, as triggers
-- ---------------------------------------------------------------------------

-- Both lesson and assignment hang off a course offering, and both need the
-- academic year the offering's term belongs to.
CREATE OR REPLACE FUNCTION learning_derive_year() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  SELECT t.academic_year_id INTO NEW.academic_year_id
    FROM course_offering co JOIN term t ON t.id = co.term_id
   WHERE co.id = NEW.course_offering_id;
  IF NEW.academic_year_id IS NULL THEN
    RAISE EXCEPTION 'course offering % does not exist', NEW.course_offering_id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER lesson_year_derived
  BEFORE INSERT OR UPDATE OF course_offering_id ON lesson
  FOR EACH ROW EXECUTE FUNCTION learning_derive_year();

CREATE TRIGGER assignment_year_derived
  BEFORE INSERT OR UPDATE OF course_offering_id ON assignment
  FOR EACH ROW EXECUTE FUNCTION learning_derive_year();

-- An assignment's assessment cannot be moved once work has come in.
--
-- The same shape as 0030's refusal to rescale max_marks after marks exist:
-- repointing the link does not touch a single `mark` row, and every one of
-- them silently becomes a mark for a different piece of work.
CREATE OR REPLACE FUNCTION assignment_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.assessment_id IS DISTINCT FROM OLD.assessment_id
     AND EXISTS (SELECT 1 FROM submission s WHERE s.assignment_id = OLD.id) THEN
    RAISE EXCEPTION 'the assessment cannot be changed once work has been submitted'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status IN ('published', 'closed') AND NEW.status = 'draft' THEN
    RAISE EXCEPTION 'a published assignment cannot be returned to draft'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER assignment_guarded
  BEFORE UPDATE ON assignment
  FOR EACH ROW EXECUTE FUNCTION assignment_guard();

-- Lateness, the derived columns, and the two refusals that belong here rather
-- than in a service.
CREATE OR REPLACE FUNCTION submission_derive() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_due         timestamptz;
  v_accepts     boolean;
  v_status      text;
  v_offering    uuid;
BEGIN
  SELECT a.due_at, a.accepts_late, a.status, a.course_offering_id
    INTO v_due, v_accepts, v_status, v_offering
    FROM assignment a WHERE a.id = NEW.assignment_id;

  IF v_status IS NULL THEN
    RAISE EXCEPTION 'assignment % does not exist', NEW.assignment_id;
  END IF;

  NEW.course_offering_id := v_offering;

  SELECT e.student_id INTO NEW.student_id
    FROM enrollment e WHERE e.id = NEW.enrollment_id;
  IF NEW.student_id IS NULL THEN
    RAISE EXCEPTION 'enrollment % does not exist', NEW.enrollment_id;
  END IF;

  IF TG_OP = 'INSERT' AND v_status <> 'published' THEN
    RAISE EXCEPTION 'work can only be submitted against a published assignment (this one is %)',
      v_status USING ERRCODE = 'restrict_violation';
  END IF;

  NEW.is_late := (v_due IS NOT NULL AND NEW.submitted_at > v_due);

  IF NEW.is_late AND NOT v_accepts THEN
    RAISE EXCEPTION 'this assignment does not accept late work; it was due %', v_due
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER submission_derived
  BEFORE INSERT OR UPDATE ON submission
  FOR EACH ROW EXECUTE FUNCTION submission_derive();

-- Who may change WHICH half of a submission, and the invariant of this
-- milestone.
--
-- The row-level policy below can say who may write this row; it cannot say
-- which columns. That distinction is the whole safety of the table, because
-- the two principals who may write it want opposite halves of it:
--
--   the family owns the WORK       — body_text, submitted_at
--   the teacher owns the VERDICT   — status, feedback, returned_at, by whom
--
-- With only the policy, a learner passes `app_is_own_learner` and can set their
-- own work to 'returned' with a compliment in the feedback; a teacher passes
-- `app_may_set_work` and can rewrite the homework they are about to mark.
-- Neither is a hypothetical — both are single UPDATE statements against an
-- endpoint that otherwise looks correct.
--
-- And then THE rule this milestone exists for: a graded assignment is returned
-- by entering a mark. Setting the status without one produces a submission the
-- learner sees as marked and a gradebook that has never heard of it, which is
-- exactly the failure this schema is shaped around — so it is checked here as
-- well, rather than trusted to the one service that currently does it right.
CREATE OR REPLACE FUNCTION submission_write_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_assessment uuid;
BEGIN
  -- Anything that is not the application role is a migration, a fixture, a
  -- restore or an operator holding the owner role — all of whom bypass
  -- row-level security outright. Refusing them here would be theatre, and it
  -- would break the one path (teardown) that legitimately rewrites history.
  IF current_user <> 'paathshala_app' THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- INSERT is not the small case. This trigger was written for UPDATE only,
    -- on the assumption that work is handed in and then marked — and the
    -- assumption is not enforced anywhere. A learner who may create their own
    -- submission may create it already carrying a verdict: status 'returned',
    -- a returned_at, and whatever feedback they care to write about
    -- themselves. It is one INSERT, the policy passes it, and the UPDATE
    -- checks below never run.
    IF (NEW.status <> 'submitted'
        OR NEW.feedback IS NOT NULL
        OR NEW.returned_at IS NOT NULL
        OR NEW.returned_by_staff_id IS NOT NULL)
       AND NOT app_may_set_work(NEW.course_offering_id) THEN
      RAISE EXCEPTION 'only the teacher who set this work can return it'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSE
    IF (NEW.status, NEW.feedback, NEW.returned_at, NEW.returned_by_staff_id)
       IS DISTINCT FROM
       (OLD.status, OLD.feedback, OLD.returned_at, OLD.returned_by_staff_id)
       AND NOT app_may_set_work(NEW.course_offering_id) THEN
      RAISE EXCEPTION 'only the teacher who set this work can return it'
        USING ERRCODE = 'insufficient_privilege';
    END IF;

    IF (NEW.body_text, NEW.submitted_at) IS DISTINCT FROM (OLD.body_text, OLD.submitted_at)
       AND NOT app_is_own_learner(NEW.student_id) THEN
      RAISE EXCEPTION 'a teacher marks work; they do not edit it'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;

  -- The mark requirement applies to both paths, for the same reason: a
  -- submission showing as returned with nothing in `mark` behind it is the
  -- failure this milestone exists to prevent, and it does not care which
  -- statement produced it.
  IF NEW.status = 'returned'
     AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'returned') THEN
    SELECT a.assessment_id INTO v_assessment
      FROM assignment a WHERE a.id = NEW.assignment_id;

    IF v_assessment IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM mark m
                        WHERE m.assessment_id = v_assessment
                          AND m.enrollment_id = NEW.enrollment_id) THEN
      RAISE EXCEPTION
        'this assignment carries marks; enter the mark before returning the work'
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- AFTER the derive trigger, which is why the name sorts later: Postgres fires
-- BEFORE row triggers in name order, and this one reads course_offering_id and
-- student_id, which `submission_derived` is what fills in.
CREATE TRIGGER submission_write_guarded
  BEFORE INSERT OR UPDATE ON submission
  FOR EACH ROW EXECUTE FUNCTION submission_write_guard();

-- ---------------------------------------------------------------------------
-- Privileges and row-level security
-- ---------------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE ON lesson, lesson_resource, assignment, submission,
  submission_file TO paathshala_app;

ALTER TABLE lesson            ENABLE ROW LEVEL SECURITY;
ALTER TABLE lesson            FORCE  ROW LEVEL SECURITY;
ALTER TABLE lesson_resource   ENABLE ROW LEVEL SECURITY;
ALTER TABLE lesson_resource   FORCE  ROW LEVEL SECURITY;
ALTER TABLE assignment        ENABLE ROW LEVEL SECURITY;
ALTER TABLE assignment        FORCE  ROW LEVEL SECURITY;
ALTER TABLE submission        ENABLE ROW LEVEL SECURITY;
ALTER TABLE submission        FORCE  ROW LEVEL SECURITY;
ALTER TABLE submission_file   ENABLE ROW LEVEL SECURITY;
ALTER TABLE submission_file   FORCE  ROW LEVEL SECURITY;

-- A draft is the teacher's notebook. The family branch of every read policy
-- below requires 'published', which is the same rule 0068 established for a
-- result run and for the same reason: work in progress shown to a parent is a
-- phone call about a mark that was never awarded.
CREATE POLICY teaching_visibility ON lesson
  FOR ALL TO paathshala_app
  USING (tenant_id = app_current_tenant_id()
         AND app_may_see_offering(course_offering_id)
         AND (status = 'published' OR app_may_set_work(course_offering_id)))
  WITH CHECK (tenant_id = app_current_tenant_id()
              AND app_may_set_work(course_offering_id));

CREATE POLICY resource_follows_lesson ON lesson_resource
  FOR ALL TO paathshala_app
  USING (tenant_id = app_current_tenant_id()
         AND EXISTS (SELECT 1 FROM lesson l WHERE l.id = lesson_id))
  -- Reading the lesson through its own policy is enough to find it; writing
  -- needs the narrower question asked directly, because a row being visible
  -- has never implied it is yours to change.
  WITH CHECK (tenant_id = app_current_tenant_id()
              AND EXISTS (SELECT 1 FROM lesson l
                           WHERE l.id = lesson_id
                             AND app_may_set_work(l.course_offering_id)));

CREATE POLICY assignment_visibility ON assignment
  FOR ALL TO paathshala_app
  USING (tenant_id = app_current_tenant_id()
         AND app_may_see_offering(course_offering_id)
         AND (status <> 'draft' OR app_may_set_work(course_offering_id)))
  WITH CHECK (tenant_id = app_current_tenant_id()
              AND app_may_set_work(course_offering_id));

-- Reading a submission is the learner rule, unchanged since 0049: the office,
-- the teachers of that learner's sections, the learner, and their guardians.
--
-- Writing is narrower on both sides. A family may submit their own child's
-- work and nobody else's; a teacher may write feedback on work set in an
-- offering they own. Neither can do the other's half, and a parent of another
-- child in the same class can do neither.
CREATE POLICY submission_visibility ON submission
  FOR ALL TO paathshala_app
  USING (tenant_id = app_current_tenant_id() AND app_student_visible(student_id))
  WITH CHECK (tenant_id = app_current_tenant_id()
              AND (app_is_own_learner(student_id)
                   OR app_may_set_work(course_offering_id)));

CREATE POLICY submission_file_follows ON submission_file
  FOR ALL TO paathshala_app
  USING (tenant_id = app_current_tenant_id()
         AND EXISTS (SELECT 1 FROM submission s WHERE s.id = submission_id))
  WITH CHECK (tenant_id = app_current_tenant_id()
              AND EXISTS (SELECT 1 FROM submission s
                           WHERE s.id = submission_id
                             AND (app_is_own_learner(s.student_id)
                                  OR app_may_set_work(s.course_offering_id))));

-- NOT BUILT, and named here rather than left implicit: 0017 says nothing may
-- be served until a scan has cleared it, and that gate belongs on the endpoint
-- that hands out a download URL for a lesson resource or a submitted file.
-- There is no such endpoint yet — the bytes are uploaded and referenced, never
-- served — so there is nothing to gate. The first download route added here
-- must check `file.virus_scan_state = 'clean'` before signing anything.

COMMENT ON TABLE submission IS
  'A piece of work handed in. Carries no score: an assignment that awards '
  'marks points at an assessment, and the marks live in `mark` where the '
  'result run can see them.';
