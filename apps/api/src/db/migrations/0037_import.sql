-- 0037: the import pipeline (M9.4, AC-9).
--
-- Every institute arrives with a spreadsheet. It is the first thing they do and
-- the thing that decides whether they stay, and it is almost always partly
-- wrong: duplicate admission numbers, dates as `12/03/14`, a phone number
-- Excel has helpfully turned into 9.8765E+09, a guardian row with no learner.
--
-- Three properties, and each exists because of a specific way imports go wrong:
--
--   1. **Validation writes nothing.** Not one domain row. The half-applied
--      import — 3,000 learners in, one bad row, and now nobody knows what state
--      the school is in — is the failure that loses a customer on day one.
--   2. **The preview IS the apply.** Not a similar computation. The preview
--      records a plan and a digest of the inputs it was computed from; apply
--      re-derives the digest and refuses if anything moved. "It said it would
--      create 4,988 and it created 4,991" must be impossible rather than rare.
--   3. **It can be reversed.** Every row the apply creates is recorded with its
--      table and id, so an import applied in error can be taken back out —
--      and, where a created row has since been referenced by something else,
--      the reversal REFUSES rather than cascading. Undo must not become a
--      second disaster.
--
-- The staging tables are ordinary tenant tables, not temp tables: an import that
-- takes twenty minutes must survive a connection drop, and the office needs to
-- see the errors on a screen rather than in a log.

CREATE TABLE import_batch (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES organization (id),
  campus_id           uuid REFERENCES campus (id),

  -- What is being imported. Deliberately a small closed set: a generic
  -- "import anything" pipeline is how a typo writes to the ledger.
  entity              text NOT NULL CHECK (entity IN ('learner_roster', 'staff_roster',
                                                      'guardian_link', 'fee_assignment')),
  file_id             uuid REFERENCES file (id),
  original_filename   text,
  source_sha256       text,

  status              text NOT NULL DEFAULT 'uploaded'
                        CHECK (status IN ('uploaded', 'mapped', 'validated', 'previewed',
                                          'applying', 'applied', 'reversed', 'failed',
                                          'cancelled')),

  -- Set at preview. The apply recomputes it and refuses on a mismatch, which is
  -- the mechanism behind "the preview matches the apply exactly".
  plan_digest         text,
  -- Counts as the preview reported them, kept so the apply's own counts can be
  -- compared against what a human was shown.
  preview_counts      jsonb,
  applied_counts      jsonb,

  uploaded_by         uuid REFERENCES staff (id),
  applied_by          uuid REFERENCES staff (id),
  reversed_by         uuid REFERENCES staff (id),
  reverse_reason      text,

  created_at          timestamptz NOT NULL DEFAULT now(),
  validated_at        timestamptz,
  previewed_at        timestamptz,
  applied_at          timestamptz,
  reversed_at         timestamptz,

  CONSTRAINT import_batch_applied_has_timestamp
    CHECK ((status = 'applied') = (applied_at IS NOT NULL) OR status = 'reversed'),
  CONSTRAINT import_batch_reversed_has_reason
    CHECK (status <> 'reversed' OR (reverse_reason IS NOT NULL AND reversed_at IS NOT NULL))
);

CREATE INDEX import_batch_status_idx ON import_batch (tenant_id, status, created_at DESC);

-- How the spreadsheet's columns map onto fields. Stored rather than inferred
-- each time, because the office will re-upload a corrected file and expect the
-- mapping they already did to still be there.
CREATE TABLE import_mapping (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES organization (id),
  import_batch_id  uuid NOT NULL REFERENCES import_batch (id) ON DELETE CASCADE,

  source_column    text NOT NULL,
  target_field     text NOT NULL,
  -- A named, closed set of transforms. Not an expression: an import mapping is
  -- user input, and an expression evaluator over user input inside the database
  -- is a remote code execution waiting to be written.
  transform        text CHECK (transform IN ('trim', 'upper', 'lower', 'date_dmy',
                                             'date_ymd', 'phone_in', 'digits_only')),
  is_required      boolean NOT NULL DEFAULT false,
  default_value    text,

  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX import_mapping_target_key
  ON import_mapping (import_batch_id, target_field);
CREATE UNIQUE INDEX import_mapping_source_key
  ON import_mapping (import_batch_id, source_column);

-- One row per spreadsheet row. `raw` is exactly what was in the file, kept
-- untouched: when somebody asks why a learner's name is wrong, the answer has
-- to start from what they actually uploaded.
CREATE TABLE import_row (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES organization (id),
  import_batch_id  uuid NOT NULL REFERENCES import_batch (id) ON DELETE CASCADE,

  row_no           integer NOT NULL,
  raw              jsonb NOT NULL,
  normalised       jsonb,

  status           text NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'valid', 'invalid', 'duplicate',
                                       'applied', 'skipped')),
  -- [{ field, code, message }]. Plural because a row with three problems should
  -- be fixed once, not uploaded three times.
  errors           jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- What the preview says this row will do: 'create', 'update' or 'skip'.
  planned_action   text CHECK (planned_action IN ('create', 'update', 'skip')),
  -- For an update, the existing row it matched.
  matched_id       uuid,

  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT import_row_invalid_has_errors
    CHECK (status <> 'invalid' OR jsonb_array_length(errors) > 0)
);

CREATE UNIQUE INDEX import_row_no_key ON import_row (import_batch_id, row_no);
CREATE INDEX import_row_status_idx ON import_row (import_batch_id, status);

-- What the apply actually created, so it can be taken back out.
--
-- No foreign key to the created row: the target is a different table per entry,
-- and a FK per possible table would make this a maintenance burden that silently
-- stops covering new tables. The reversal resolves and checks instead.
CREATE TABLE import_applied_row (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES organization (id),
  import_batch_id  uuid NOT NULL REFERENCES import_batch (id) ON DELETE CASCADE,
  import_row_id    uuid REFERENCES import_row (id) ON DELETE CASCADE,

  target_table     text NOT NULL,
  target_id        uuid NOT NULL,
  action           text NOT NULL CHECK (action IN ('create', 'update')),
  -- For an update, what the fields were before, so reversal can restore them.
  before_values    jsonb,
  -- The order to undo in. Reversal walks this descending, so a child created
  -- after its parent is removed first.
  sequence_no      integer NOT NULL,

  reversed_at      timestamptz,

  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX import_applied_row_seq_key
  ON import_applied_row (import_batch_id, sequence_no);
CREATE INDEX import_applied_row_target_idx
  ON import_applied_row (tenant_id, target_table, target_id);

-- An import batch that has been applied is part of the record. Its rows and its
-- counts are what the office will be shown when they ask what happened, and an
-- UPDATE that tidied them would make the question unanswerable.
CREATE OR REPLACE FUNCTION import_batch_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status IN ('applied', 'reversed') THEN
      RAISE EXCEPTION 'an applied import cannot be deleted; reverse it instead'
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status = 'applied' AND NEW.status NOT IN ('applied', 'reversed') THEN
    RAISE EXCEPTION 'an applied import can only be reversed'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status = 'reversed' AND NEW.status <> 'reversed' THEN
    RAISE EXCEPTION 'a reversed import is final'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status IN ('applied', 'reversed')
     AND (NEW.plan_digest IS DISTINCT FROM OLD.plan_digest
          OR NEW.preview_counts IS DISTINCT FROM OLD.preview_counts
          OR NEW.applied_counts IS DISTINCT FROM OLD.applied_counts) THEN
    RAISE EXCEPTION 'the record of what an applied import did cannot be edited'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER import_batch_guarded
  BEFORE UPDATE OR DELETE ON import_batch
  FOR EACH ROW EXECUTE FUNCTION import_batch_guard();

CREATE OR REPLACE FUNCTION import_applied_row_is_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'the record of an applied row cannot be deleted'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.target_table <> OLD.target_table
     OR NEW.target_id <> OLD.target_id
     OR NEW.action <> OLD.action
     OR NEW.sequence_no <> OLD.sequence_no THEN
    RAISE EXCEPTION 'an applied-row record may only be marked reversed'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER import_applied_row_append_only
  BEFORE UPDATE OR DELETE ON import_applied_row
  FOR EACH ROW EXECUTE FUNCTION import_applied_row_is_append_only();

-- ---------------------------------------------------------------------------
-- Isolation
-- ---------------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE, DELETE ON
  import_batch, import_mapping, import_row, import_applied_row
  TO paathshala_app;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['import_batch','import_mapping','import_row','import_applied_row']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    -- Staff only, all of it. An import is a bulk write to the whole school's
    -- records; there is no version of it a guardian should be able to see, let
    -- alone start.
    EXECUTE format($f$
      CREATE POLICY staff_only ON %I
        FOR ALL TO paathshala_app
        USING (tenant_id = app_current_tenant_id() AND app_actor_has_staff_scope())
        WITH CHECK (tenant_id = app_current_tenant_id() AND app_actor_has_staff_scope())
    $f$, t);
  END LOOP;
END;
$$;
