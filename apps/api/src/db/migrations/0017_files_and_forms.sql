-- 0017: file metadata, and configurable forms.
--
-- `file` is the metadata record only. Bytes live in object storage; this row
-- carries the key, the hash and the classification. It arrives now because
-- admissions cannot work without document upload, and it is deliberately
-- minimal — signatures, verification workflow and export artefacts come later.

CREATE TABLE file (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES organization (id),
  bucket            text NOT NULL,
  object_key        text NOT NULL,
  mime_type         text NOT NULL,
  size_bytes        bigint NOT NULL,
  sha256            text NOT NULL,
  classification    text NOT NULL DEFAULT 'INTERNAL'
                      CHECK (classification IN ('PUBLIC', 'INTERNAL', 'SENSITIVE', 'RESTRICTED')),
  -- Attribution, not accountability: audit_log holds the durable record and
  -- has no FK. A departed employee's account must not pin every file they ever
  -- uploaded, so this degrades to NULL rather than blocking the delete.
  uploaded_by       uuid REFERENCES user_account (id) ON DELETE SET NULL,
  -- Nothing may be served until a scan has cleared it. Default 'pending', not
  -- 'clean': a file that skipped the scanner must not be downloadable because
  -- somebody forgot to set a flag.
  virus_scan_state  text NOT NULL DEFAULT 'pending'
                      CHECK (virus_scan_state IN ('pending', 'clean', 'infected', 'failed')),
  -- Suspends every deletion and retention job for this row.
  legal_hold        boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz,
  CONSTRAINT file_size_positive CHECK (size_bytes > 0),
  CONSTRAINT file_sha256_shape CHECK (sha256 ~ '^[0-9a-f]{64}$')
);

-- Content-addressed per tenant: the same document uploaded twice is one row.
CREATE UNIQUE INDEX file_tenant_sha256_key ON file (tenant_id, sha256) WHERE deleted_at IS NULL;
CREATE INDEX file_tenant_classification_idx ON file (tenant_id, classification);
CREATE INDEX file_scan_pending_idx ON file (tenant_id) WHERE virus_scan_state = 'pending';

-- Configurable forms.
--
-- Core records stay strongly typed columns. This is for what genuinely varies
-- between institutes: which questions an admission form asks. The definition is
-- a JSON Schema, versioned, and frozen on publish; a submission stores the
-- version id that validated it, so an answer set is reproducible years later
-- even after the form has changed five times.

CREATE TABLE form_definition (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES organization (id),
  code          text NOT NULL,
  version       integer NOT NULL,
  title         text NOT NULL,
  purpose       text NOT NULL CHECK (purpose IN ('enquiry', 'application', 'feedback', 'custom')),
  json_schema   jsonb NOT NULL,
  ui_schema     jsonb,
  published_at  timestamptz,
  created_by    uuid REFERENCES user_account (id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT form_definition_version_positive CHECK (version > 0),
  CONSTRAINT form_definition_schema_is_object CHECK (jsonb_typeof(json_schema) = 'object')
);

CREATE UNIQUE INDEX form_definition_key ON form_definition (tenant_id, code, version);
CREATE UNIQUE INDEX form_definition_one_published_per_code
  ON form_definition (tenant_id, code, version) WHERE published_at IS NOT NULL;
CREATE INDEX form_definition_code_idx ON form_definition (tenant_id, code, version DESC);

-- Same reasoning as notice_version in 0013: editing a published schema would
-- silently change what every existing submission claims to have satisfied.
CREATE OR REPLACE FUNCTION form_definition_frozen_once_published() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.published_at IS NOT NULL
     AND (NEW.json_schema <> OLD.json_schema OR NEW.code <> OLD.code
          OR NEW.version <> OLD.version OR NEW.purpose <> OLD.purpose) THEN
    RAISE EXCEPTION 'form % version % is published; publish a new version instead',
      OLD.code, OLD.version USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER form_definition_is_frozen
  BEFORE UPDATE ON form_definition
  FOR EACH ROW EXECUTE FUNCTION form_definition_frozen_once_published();

CREATE TABLE form_submission (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL REFERENCES organization (id),
  -- The exact version that validated this payload, not the current one.
  form_definition_id     uuid NOT NULL REFERENCES form_definition (id),
  payload                jsonb NOT NULL,
  submitted_by           uuid REFERENCES user_account (id) ON DELETE SET NULL,
  submitted_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT form_submission_payload_is_object CHECK (jsonb_typeof(payload) = 'object')
);

CREATE INDEX form_submission_definition_idx ON form_submission (tenant_id, form_definition_id);
-- Queries over the answers themselves, e.g. "applicants whose previous board was CBSE".
CREATE INDEX form_submission_payload_idx ON form_submission USING gin (payload jsonb_path_ops);

CREATE TRIGGER form_definition_set_updated_at
  BEFORE UPDATE ON form_definition FOR EACH ROW EXECUTE FUNCTION set_updated_at();
