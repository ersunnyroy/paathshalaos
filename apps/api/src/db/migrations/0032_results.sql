-- 0032: results, report cards, and publication.
--
-- Three properties this schema is built to guarantee:
--
--   1. **Deterministic and re-runnable.** A result run stores a digest of every
--      input it consumed. Re-running over unchanged inputs must produce the same
--      digest; a different digest means something moved, and the run says so
--      rather than quietly producing different numbers.
--   2. **Reviewed before published.** Computing is not publishing. A run sits in
--      `computed` until a human who is NOT the person who ran it marks it
--      reviewed. Results reach families only from a published run.
--   3. **A correction supersedes, never overwrites.** A report card that has
--      gone home is immutable. A correction is a new version that points back at
--      the one it replaces, and the old artefact is retained — because "what did
--      the card actually say in March" is the question that gets asked.

-- ---------------------------------------------------------------------------
-- Result runs
-- ---------------------------------------------------------------------------

CREATE TABLE result_run (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES organization (id),
  academic_year_id    uuid NOT NULL REFERENCES academic_year (id),
  term_id             uuid NOT NULL REFERENCES term (id),
  -- The cohort the run covers. A run is per section so a class teacher can be
  -- the reviewer; a whole-school run is many runs, which is also how a partial
  -- re-run stays possible.
  section_id          uuid NOT NULL REFERENCES section (id),

  -- Hash of everything the computation read: assessment ids, weights, max
  -- marks, every mark, and the grading scale bands. Two runs with the same
  -- digest MUST have the same lines.
  inputs_digest       text NOT NULL,
  -- The rules in force for this run, copied in rather than referenced, so a
  -- later scale edit cannot retro-change what was published.
  grading_scale_id    uuid REFERENCES grading_scale (id),
  policy              jsonb NOT NULL DEFAULT '{}'::jsonb,

  status              text NOT NULL DEFAULT 'computed'
                        CHECK (status IN ('computed', 'reviewed', 'published',
                                          'superseded', 'discarded')),

  computed_at         timestamptz NOT NULL DEFAULT now(),
  computed_by         uuid REFERENCES staff (id),
  reviewed_at         timestamptz,
  reviewed_by         uuid REFERENCES staff (id),
  published_at        timestamptz,
  published_by        uuid REFERENCES staff (id),

  -- Set on the OLD run when a new one replaces it.
  superseded_by       uuid REFERENCES result_run (id),
  supersede_reason    text,

  created_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT result_run_reviewed_has_timestamp
    CHECK ((reviewed_by IS NULL) = (reviewed_at IS NULL)),
  -- The person who ran the computation cannot be the person who signs it off.
  -- A single-handed publish is how a wrong subject weighting reaches 300
  -- families before anybody reads a number.
  CONSTRAINT result_run_review_needs_two_people
    CHECK (reviewed_by IS NULL OR computed_by IS NULL OR reviewed_by <> computed_by),
  CONSTRAINT result_run_published_was_reviewed
    CHECK (status <> 'published' OR (reviewed_at IS NOT NULL AND published_at IS NOT NULL)),
  CONSTRAINT result_run_superseded_has_successor
    CHECK ((status = 'superseded') = (superseded_by IS NOT NULL))
);

CREATE INDEX result_run_scope_idx
  ON result_run (tenant_id, section_id, term_id, status);

-- At most ONE published run per section per term. Two published runs is two
-- truths, and the family has one of them on paper.
CREATE UNIQUE INDEX result_run_one_published
  ON result_run (tenant_id, section_id, term_id) WHERE status = 'published';

CREATE TABLE result_line (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES organization (id),
  result_run_id    uuid NOT NULL REFERENCES result_run (id) ON DELETE CASCADE,
  enrollment_id    uuid NOT NULL REFERENCES enrollment (id),
  -- NULL for the learner's overall line; set for a per-subject line.
  course_offering_id uuid REFERENCES course_offering (id),

  -- Weighted marks, to two places. Kept alongside the percentage because a
  -- report card shows both and recomputing one from the other rounds twice.
  obtained         numeric(8,2),
  maximum          numeric(8,2),
  percentage       numeric(6,3),

  grade_label      text,
  grade_point      numeric(4,2),
  is_pass          boolean,

  -- Set when the learner could not be graded at all, with the reason. A blank
  -- cell on a report card is never acceptable; "absent from both papers" is.
  not_graded_reason text,

  created_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT result_line_percentage_sane
    CHECK (percentage IS NULL OR (percentage >= 0 AND percentage <= 100)),
  CONSTRAINT result_line_graded_or_explained
    CHECK (percentage IS NOT NULL OR not_graded_reason IS NOT NULL)
);

CREATE UNIQUE INDEX result_line_unique
  ON result_line (
    result_run_id, enrollment_id,
    COALESCE(course_offering_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );
CREATE INDEX result_line_enrollment_idx ON result_line (tenant_id, enrollment_id);

-- A result line is a computed artefact: it is written once by the run that
-- produced it and never edited. Changing a number means a new run.
CREATE OR REPLACE FUNCTION result_line_is_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- Discarding an unpublished run is legitimate; cascade passes through here
    -- with the run already gone, so only a published run's lines are protected.
    IF EXISTS (SELECT 1 FROM result_run r
                WHERE r.id = OLD.result_run_id AND r.status IN ('published', 'superseded')) THEN
      RAISE EXCEPTION 'the lines of a published run cannot be deleted'
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'a result line cannot be edited; compute a new run'
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER result_line_frozen
  BEFORE UPDATE OR DELETE ON result_line
  FOR EACH ROW EXECUTE FUNCTION result_line_is_immutable();

-- A published run is frozen except for being superseded.
CREATE OR REPLACE FUNCTION result_run_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status IN ('published', 'superseded') THEN
      RAISE EXCEPTION 'a published result run cannot be deleted'
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status = 'published' AND NEW.status NOT IN ('published', 'superseded') THEN
    RAISE EXCEPTION 'a published run can only be superseded, not unpublished'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status = 'superseded' AND NEW.status <> 'superseded' THEN
    RAISE EXCEPTION 'a superseded run is final'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status IN ('published', 'superseded')
     AND (NEW.inputs_digest <> OLD.inputs_digest
          OR NEW.term_id <> OLD.term_id
          OR NEW.section_id <> OLD.section_id) THEN
    RAISE EXCEPTION 'the substance of a published run cannot be altered'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER result_run_guarded
  BEFORE UPDATE OR DELETE ON result_run
  FOR EACH ROW EXECUTE FUNCTION result_run_guard();

-- ---------------------------------------------------------------------------
-- Report cards
-- ---------------------------------------------------------------------------

CREATE TABLE report_card_template (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES organization (id),
  academic_unit_id  uuid NOT NULL REFERENCES academic_unit (id),

  name              text NOT NULL,
  -- The board this layout follows. Named explicitly because "the CBSE one" is
  -- how every conversation about report cards starts, and because a template
  -- validated against last year's real cards is validated for ONE board.
  board             text,
  -- Sections, columns, which aggregates appear. Structure, not markup.
  layout            jsonb NOT NULL,
  version           integer NOT NULL DEFAULT 1,

  is_published      boolean NOT NULL DEFAULT false,
  published_at      timestamptz,

  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz,

  CONSTRAINT report_card_template_published_has_timestamp
    CHECK (is_published = (published_at IS NOT NULL)),
  CONSTRAINT report_card_template_version_positive CHECK (version > 0)
);

CREATE UNIQUE INDEX report_card_template_version_key
  ON report_card_template (tenant_id, academic_unit_id, name, version)
  WHERE deleted_at IS NULL;

CREATE TABLE report_card (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES organization (id),
  enrollment_id       uuid NOT NULL REFERENCES enrollment (id),
  term_id             uuid NOT NULL REFERENCES term (id),
  result_run_id       uuid NOT NULL REFERENCES result_run (id),
  template_id         uuid REFERENCES report_card_template (id),

  version             integer NOT NULL DEFAULT 1,
  status              text NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft', 'published', 'superseded')),

  -- The rendered artefact, retained. Not a path that can be overwritten in
  -- place: the whole point is that the March card still reads as it did.
  artefact_file_id    uuid,
  artefact_sha256     text,

  -- The data the card was rendered FROM, frozen at publication. A template
  -- change must not alter a card already sent.
  snapshot            jsonb,

  published_at        timestamptz,
  published_by        uuid REFERENCES staff (id),
  superseded_by       uuid REFERENCES report_card (id),
  supersede_reason    text,

  created_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT report_card_version_positive CHECK (version > 0),
  CONSTRAINT report_card_published_has_timestamp
    CHECK ((status = 'published') = (published_at IS NOT NULL) OR status = 'superseded'),
  CONSTRAINT report_card_superseded_has_successor
    CHECK ((status = 'superseded') = (superseded_by IS NOT NULL)),
  -- A published card without its snapshot cannot be reproduced, which defeats
  -- retention.
  CONSTRAINT report_card_published_has_snapshot
    CHECK (status = 'draft' OR snapshot IS NOT NULL)
);

CREATE UNIQUE INDEX report_card_version_key
  ON report_card (tenant_id, enrollment_id, term_id, version);
-- One LIVE card per learner per term. Older versions stay as 'superseded'.
CREATE UNIQUE INDEX report_card_one_live
  ON report_card (tenant_id, enrollment_id, term_id) WHERE status = 'published';

CREATE OR REPLACE FUNCTION report_card_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'a report card that has been published cannot be deleted'
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status = 'published' THEN
    IF NEW.status NOT IN ('published', 'superseded') THEN
      RAISE EXCEPTION 'a published report card can only be superseded'
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW.snapshot IS DISTINCT FROM OLD.snapshot
       OR NEW.artefact_sha256 IS DISTINCT FROM OLD.artefact_sha256
       OR NEW.result_run_id <> OLD.result_run_id
       OR NEW.version <> OLD.version THEN
      -- This is the guarantee. The card that went home is the card on file.
      RAISE EXCEPTION 'a published report card is immutable; issue a new version'
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  IF OLD.status = 'superseded' AND NEW.status <> 'superseded' THEN
    RAISE EXCEPTION 'a superseded report card is final'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER report_card_guarded
  BEFORE UPDATE OR DELETE ON report_card
  FOR EACH ROW EXECUTE FUNCTION report_card_guard();
