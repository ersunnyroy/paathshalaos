-- 0018: admissions, from an unqualified contact to an issued offer.
--
--   lead      → somebody's phone number and where it came from
--   enquiry   → qualified interest in a specific programme and year
--   application → a submitted form plus documents
--   admission_decision → immutable once issued

CREATE TABLE lead (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES organization (id),
  campus_id       uuid NOT NULL REFERENCES campus (id),
  source          text NOT NULL CHECK (source IN
                    ('walk_in', 'phone', 'website', 'referral', 'event', 'advertisement', 'import', 'other')),
  name            text NOT NULL,
  phone           text,
  email           citext,
  utm             jsonb,
  score           integer,
  owner_staff_id  uuid REFERENCES staff (id),
  status          text NOT NULL DEFAULT 'new'
                    CHECK (status IN ('new', 'contacted', 'qualified', 'converted', 'lost', 'duplicate')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  CONSTRAINT lead_has_a_contact CHECK (phone IS NOT NULL OR email IS NOT NULL),
  CONSTRAINT lead_score_range CHECK (score IS NULL OR score BETWEEN 0 AND 100)
);

CREATE INDEX lead_campus_status_idx ON lead (tenant_id, campus_id, status) WHERE deleted_at IS NULL;
CREATE INDEX lead_phone_idx ON lead (tenant_id, phone);
CREATE INDEX lead_owner_idx ON lead (tenant_id, owner_staff_id) WHERE deleted_at IS NULL;

CREATE TABLE enquiry (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES organization (id),
  lead_id            uuid NOT NULL REFERENCES lead (id) ON DELETE CASCADE,
  programme_id       uuid NOT NULL REFERENCES programme (id),
  academic_year_id   uuid NOT NULL REFERENCES academic_year (id),
  stage              text NOT NULL DEFAULT 'enquired'
                       CHECK (stage IN ('enquired', 'counselled', 'visit_scheduled', 'visited',
                                        'form_issued', 'form_submitted', 'closed_won', 'closed_lost')),
  next_action_at     timestamptz,
  next_action_note   text,
  lost_reason        text,
  form_submission_id uuid REFERENCES form_submission (id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz,
  -- A lost enquiry without a reason teaches the institute nothing about why it
  -- lost, which is the only reason to record the stage at all.
  CONSTRAINT enquiry_lost_has_reason
    CHECK (stage <> 'closed_lost' OR lost_reason IS NOT NULL)
);

CREATE UNIQUE INDEX enquiry_lead_programme_year_key
  ON enquiry (tenant_id, lead_id, programme_id, academic_year_id) WHERE deleted_at IS NULL;
-- The admissions desk's working list: what needs chasing, oldest first.
CREATE INDEX enquiry_pipeline_idx
  ON enquiry (tenant_id, stage, next_action_at) WHERE deleted_at IS NULL;
CREATE INDEX enquiry_year_idx ON enquiry (tenant_id, academic_year_id, stage);

CREATE TABLE application (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES organization (id),
  enquiry_id          uuid REFERENCES enquiry (id),
  applicant_person_id uuid NOT NULL REFERENCES person (id),
  programme_id        uuid NOT NULL REFERENCES programme (id),
  academic_year_id    uuid NOT NULL REFERENCES academic_year (id),
  application_no      text NOT NULL,
  form_submission_id  uuid REFERENCES form_submission (id),
  status              text NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft', 'submitted', 'under_review', 'documents_pending',
                                          'decided', 'withdrawn', 'expired')),
  submitted_at        timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz,
  CONSTRAINT application_submitted_has_timestamp
    CHECK ((status = 'draft') = (submitted_at IS NULL)),
  -- A submitted application must carry the answers it was submitted with.
  CONSTRAINT application_submitted_has_form
    CHECK (status = 'draft' OR form_submission_id IS NOT NULL)
);

CREATE UNIQUE INDEX application_no_key
  ON application (tenant_id, application_no) WHERE deleted_at IS NULL;
-- One live application per person per programme per year. Re-applying after a
-- withdrawal is allowed; applying twice in parallel is not.
CREATE UNIQUE INDEX application_one_live_per_person_programme_year
  ON application (tenant_id, applicant_person_id, programme_id, academic_year_id)
  WHERE deleted_at IS NULL AND status NOT IN ('withdrawn', 'expired');
CREATE INDEX application_review_queue_idx
  ON application (tenant_id, academic_year_id, status) WHERE deleted_at IS NULL;

CREATE TABLE application_document (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES organization (id),
  application_id    uuid NOT NULL REFERENCES application (id) ON DELETE CASCADE,
  document_type     text NOT NULL,
  file_id           uuid REFERENCES file (id),
  is_required       boolean NOT NULL DEFAULT true,
  status            text NOT NULL DEFAULT 'awaited'
                      CHECK (status IN ('awaited', 'uploaded', 'verified', 'rejected')),
  verified_by       uuid REFERENCES staff (id),
  verified_at       timestamptz,
  rejection_reason  text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT application_document_uploaded_has_file
    CHECK (status = 'awaited' OR file_id IS NOT NULL),
  CONSTRAINT application_document_rejected_has_reason
    CHECK (status <> 'rejected' OR rejection_reason IS NOT NULL),
  CONSTRAINT application_document_verified_has_verifier
    CHECK (status <> 'verified' OR (verified_by IS NOT NULL AND verified_at IS NOT NULL))
);

CREATE UNIQUE INDEX application_document_type_key
  ON application_document (tenant_id, application_id, document_type);
CREATE INDEX application_document_status_idx ON application_document (tenant_id, status);

CREATE TABLE admission_decision (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES organization (id),
  application_id     uuid NOT NULL REFERENCES application (id),
  outcome            text NOT NULL CHECK (outcome IN ('offered', 'waitlisted', 'rejected')),
  decided_by         uuid NOT NULL REFERENCES staff (id),
  decided_at         timestamptz NOT NULL DEFAULT now(),
  offered_section_id uuid REFERENCES section (id),
  offer_expires_at   timestamptz,
  conditions         text,
  reason             text,
  -- Set when the applicant accepts. Separate from the decision itself, which
  -- never changes.
  accepted_at        timestamptz,
  declined_at        timestamptz,
  superseded_at      timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT admission_decision_offer_has_expiry
    CHECK (outcome <> 'offered' OR offer_expires_at IS NOT NULL),
  CONSTRAINT admission_decision_offer_has_section
    CHECK (outcome <> 'offered' OR offered_section_id IS NOT NULL),
  CONSTRAINT admission_decision_rejection_has_reason
    CHECK (outcome <> 'rejected' OR reason IS NOT NULL),
  CONSTRAINT admission_decision_not_both_accepted_and_declined
    CHECK (accepted_at IS NULL OR declined_at IS NULL)
);

-- One live decision per application. A revised decision supersedes the old one
-- rather than overwriting it, so the sequence of what the institute told the
-- family stays on the record.
CREATE UNIQUE INDEX admission_decision_one_live
  ON admission_decision (tenant_id, application_id) WHERE superseded_at IS NULL;
CREATE INDEX admission_decision_expiry_idx
  ON admission_decision (tenant_id, offer_expires_at)
  WHERE superseded_at IS NULL AND accepted_at IS NULL AND declined_at IS NULL;

-- Immutable except for the three fields that legitimately change after issue:
-- acceptance, decline, and being superseded.
CREATE OR REPLACE FUNCTION admission_decision_is_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'an admission decision cannot be deleted; supersede it instead'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.outcome <> OLD.outcome
     OR NEW.application_id <> OLD.application_id
     OR NEW.decided_by <> OLD.decided_by
     OR NEW.decided_at <> OLD.decided_at
     OR COALESCE(NEW.offered_section_id::text, '') <> COALESCE(OLD.offered_section_id::text, '')
     OR COALESCE(NEW.conditions, '') <> COALESCE(OLD.conditions, '') THEN
    RAISE EXCEPTION 'an issued admission decision cannot be altered; supersede it instead'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER admission_decision_frozen
  BEFORE UPDATE OR DELETE ON admission_decision
  FOR EACH ROW EXECUTE FUNCTION admission_decision_is_immutable();

CREATE TRIGGER lead_set_updated_at                 BEFORE UPDATE ON lead                 FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER enquiry_set_updated_at              BEFORE UPDATE ON enquiry              FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER application_set_updated_at          BEFORE UPDATE ON application          FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER application_document_set_updated_at BEFORE UPDATE ON application_document FOR EACH ROW EXECUTE FUNCTION set_updated_at();
