-- 0013: consent (M3.6).
--
-- DPDP-shaped, and the shape matters more than the field list:
--
--   A notice is immutable once published, and a consent stores WHICH VERSION it
--   was given against. "We updated our privacy policy" must not retroactively
--   rewrite what someone agreed to.
--
--   Consent for a minor is given by a verified guardian, and the record says who
--   gave it. Most learners here are minors, so this is the normal path, not an
--   edge case.
--
--   Withdrawal never deletes the record. Proof of consent has to outlive the
--   consent itself — otherwise there is no way to answer "on what basis did you
--   process this in March".
--
-- NOTE FOR COUNSEL REVIEW: the purpose list, the age threshold, and what counts
-- as verifiable parental consent are exactly the questions that need an Indian
-- data-protection opinion before launch. The schema records decisions; it does
-- not make them.

CREATE TABLE notice_version (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Platform-wide notices have no tenant; an institute may publish its own.
  tenant_id    uuid REFERENCES organization (id),
  code         text NOT NULL,
  version      integer NOT NULL,
  locale       text NOT NULL DEFAULT 'en-IN',
  title        text NOT NULL,
  body         text NOT NULL,
  published_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX notice_version_key
  ON notice_version (COALESCE(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid), code, version, locale);

-- Published notices are frozen. An edit would silently change what every
-- existing consent refers to.
CREATE OR REPLACE FUNCTION notice_version_is_immutable_once_published() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.published_at IS NOT NULL
     AND (NEW.body <> OLD.body OR NEW.title <> OLD.title OR NEW.code <> OLD.code
          OR NEW.version <> OLD.version OR NEW.locale <> OLD.locale) THEN
    RAISE EXCEPTION 'notice version % is published and cannot be edited; publish a new version', OLD.version
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER notice_version_frozen
  BEFORE UPDATE ON notice_version
  FOR EACH ROW EXECUTE FUNCTION notice_version_is_immutable_once_published();

CREATE TABLE consent_record (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES organization (id),

  -- Whose data the consent is about.
  person_id           uuid NOT NULL REFERENCES person (id) ON DELETE CASCADE,
  -- Who actually gave it. Differs from person_id whenever the data subject is a
  -- minor and a guardian consented on their behalf.
  given_by_person_id  uuid NOT NULL REFERENCES person (id),
  guardian_link_id    uuid REFERENCES guardian_link (id),

  purpose             text NOT NULL CHECK (purpose IN (
                        'core_education_service',   -- necessary for the contract
                        'attendance_notifications',
                        'fee_notifications',
                        'photo_publication',
                        'transport_tracking',
                        'third_party_assessment',
                        'marketing')),
  -- Processing necessary for the educational contract is not consent-dependent,
  -- and the distinction has to be in the data: withdrawing consent for optional
  -- processing must not break the core service.
  basis               text NOT NULL DEFAULT 'consent'
                        CHECK (basis IN ('consent', 'contract', 'legal_obligation')),

  notice_version_id   uuid NOT NULL REFERENCES notice_version (id),
  channel             text NOT NULL CHECK (channel IN ('app', 'web', 'paper', 'in_person')),
  evidence_ref        text,

  given_at            timestamptz NOT NULL DEFAULT now(),
  withdrawn_at        timestamptz,
  withdrawn_reason    text,

  created_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT consent_withdrawn_after_given
    CHECK (withdrawn_at IS NULL OR withdrawn_at >= given_at),
  CONSTRAINT consent_contract_basis_not_withdrawable
    CHECK (basis <> 'contract' OR withdrawn_at IS NULL)
);

CREATE UNIQUE INDEX consent_one_live_per_purpose
  ON consent_record (tenant_id, person_id, purpose) WHERE withdrawn_at IS NULL;
CREATE INDEX consent_person_idx ON consent_record (tenant_id, person_id);

-- Append-and-withdraw only. A consent record is evidence, so it is never
-- deleted and never has its history rewritten.
CREATE OR REPLACE FUNCTION consent_record_is_evidence() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'consent records are evidence and cannot be deleted'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.person_id <> OLD.person_id OR NEW.purpose <> OLD.purpose
     OR NEW.notice_version_id <> OLD.notice_version_id OR NEW.given_at <> OLD.given_at
     OR NEW.given_by_person_id <> OLD.given_by_person_id THEN
    RAISE EXCEPTION 'a consent record may only be withdrawn, not rewritten'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER consent_record_append_only
  BEFORE UPDATE OR DELETE ON consent_record
  FOR EACH ROW EXECUTE FUNCTION consent_record_is_evidence();

GRANT SELECT ON notice_version TO paathshala_app;
GRANT SELECT, INSERT, UPDATE ON consent_record TO paathshala_app;

ALTER TABLE notice_version  ENABLE ROW LEVEL SECURITY;
ALTER TABLE notice_version  FORCE  ROW LEVEL SECURITY;
ALTER TABLE consent_record  ENABLE ROW LEVEL SECURITY;
ALTER TABLE consent_record  FORCE  ROW LEVEL SECURITY;

-- Platform notices are readable by everyone; a tenant's own notice only by them.
CREATE POLICY notice_visibility ON notice_version
  FOR SELECT TO paathshala_app
  USING (tenant_id IS NULL OR tenant_id = app_current_tenant_id());

-- A guardian sees and manages consent for themselves and their linked learners.
CREATE POLICY consent_scope ON consent_record
  FOR ALL TO paathshala_app
  USING (
    tenant_id = app_current_tenant_id()
    AND (
      app_actor_has_staff_scope()
      OR person_id = app_current_person_id()
      OR given_by_person_id = app_current_person_id()
      OR EXISTS (
        SELECT 1
          FROM guardian_link gl
          JOIN student s ON s.id = gl.student_id
         WHERE s.person_id = consent_record.person_id
           AND gl.guardian_person_id = app_current_person_id()
           AND gl.effective_to IS NULL
      )
    )
  )
  WITH CHECK (
    tenant_id = app_current_tenant_id()
    AND (app_actor_has_staff_scope() OR given_by_person_id = app_current_person_id())
  );
