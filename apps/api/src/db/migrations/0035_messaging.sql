-- 0035: messaging — templates, dispatch, delivery.
--
-- Three things make this schema look different from a generic notification
-- table, and each of them is a real-world constraint rather than a preference:
--
--   1. **DLT.** Commercial SMS in India must be sent against a template
--      registered on a DLT platform under a registered entity and header. An
--      unregistered template is not "less deliverable"; it is rejected by the
--      operator. So the registration ids are columns with a NOT NULL rule at
--      send time, not metadata someone fills in later.
--   2. **WhatsApp's session window.** Outside 24 hours since the user's last
--      inbound message, only an approved template may be sent. A free-form
--      message outside the window is refused by Meta and, repeated, costs the
--      number its quality rating.
--   3. **Consent is read at SEND TIME, per recipient, per purpose.** Not from an
--      audience list computed an hour ago. AC-8 is exactly this: a guardian who
--      withdrew consent this morning is not messaged this afternoon, whatever a
--      queued job believes.
--
-- And the shape that AC-8's second half depends on: a recipient row is per
-- (person, SUBJECT), not per person. A guardian of three children gets three
-- messages about three children. Deduplicating on the phone number — the
-- obvious optimisation — silently tells that parent about one child and drops
-- the other two.

-- ---------------------------------------------------------------------------
-- Templates
-- ---------------------------------------------------------------------------

CREATE TABLE message_template (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES organization (id),

  code              text NOT NULL,
  name              text NOT NULL,
  -- Which consent purpose this template's content falls under. The dispatcher
  -- checks consent for THIS purpose; a template with the wrong purpose is how a
  -- marketing message goes out under an attendance consent.
  purpose           text NOT NULL CHECK (purpose IN (
                      'core_education_service', 'attendance_notifications',
                      'fee_notifications', 'photo_publication',
                      'transport_tracking', 'third_party_assessment', 'marketing')),

  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz
);

CREATE UNIQUE INDEX message_template_code_key
  ON message_template (tenant_id, code) WHERE deleted_at IS NULL;

-- A version per channel per locale. Versioned because a template someone has
-- already sent against is part of the record — and because DLT approval attaches
-- to a specific body, so editing the body invalidates the registration.
CREATE TABLE message_template_version (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES organization (id),
  message_template_id   uuid NOT NULL REFERENCES message_template (id) ON DELETE CASCADE,

  channel               text NOT NULL CHECK (channel IN ('sms', 'whatsapp', 'email', 'push', 'in_app')),
  locale                text NOT NULL DEFAULT 'en-IN',
  version               integer NOT NULL,

  -- `{{learner_name}}` style. The variable list is stored explicitly so a
  -- render with a missing variable is caught before it reaches an operator as
  -- the literal text "{{learner_name}}" in a parent's inbox.
  body                  text NOT NULL,
  variables             text[] NOT NULL DEFAULT '{}',

  -- DLT, for SMS. Required at send time for the sms channel.
  dlt_entity_id         text,
  dlt_template_id       text,
  sender_header         text,

  -- WhatsApp, where the template is approved by Meta rather than by an Indian
  -- registrar, and has its own name and language.
  wa_template_name      text,
  wa_language           text,

  approval_status       text NOT NULL DEFAULT 'draft'
                          CHECK (approval_status IN ('draft', 'submitted', 'approved', 'rejected')),
  approved_at           timestamptz,
  rejection_reason      text,

  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT template_version_positive CHECK (version > 0),
  CONSTRAINT template_version_approved_has_timestamp
    CHECK ((approval_status = 'approved') = (approved_at IS NOT NULL)),
  CONSTRAINT template_version_rejected_has_reason
    CHECK (approval_status <> 'rejected' OR rejection_reason IS NOT NULL),
  -- An approved SMS template without its DLT ids cannot legally be sent, so it
  -- may not reach 'approved' without them.
  CONSTRAINT template_version_sms_needs_dlt
    CHECK (channel <> 'sms' OR approval_status <> 'approved'
           OR (dlt_entity_id IS NOT NULL AND dlt_template_id IS NOT NULL
               AND sender_header IS NOT NULL)),
  CONSTRAINT template_version_whatsapp_needs_name
    CHECK (channel <> 'whatsapp' OR approval_status <> 'approved'
           OR (wa_template_name IS NOT NULL AND wa_language IS NOT NULL))
);

CREATE UNIQUE INDEX message_template_version_key
  ON message_template_version (message_template_id, channel, locale, version);
CREATE INDEX message_template_version_approved_idx
  ON message_template_version (tenant_id, message_template_id, channel, locale)
  WHERE approval_status = 'approved';

-- An approved version is frozen. The DLT registration and the Meta approval are
-- both against a specific body; editing it means the registration no longer
-- describes what is being sent.
CREATE OR REPLACE FUNCTION message_template_version_freeze() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.approval_status = 'approved' THEN
      RAISE EXCEPTION 'an approved template version cannot be deleted'
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.approval_status = 'approved'
     AND (NEW.body <> OLD.body
          OR NEW.channel <> OLD.channel
          OR NEW.locale <> OLD.locale
          OR NEW.variables IS DISTINCT FROM OLD.variables
          OR NEW.dlt_template_id IS DISTINCT FROM OLD.dlt_template_id) THEN
    RAISE EXCEPTION 'an approved template version is frozen; create a new version'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER message_template_version_frozen
  BEFORE UPDATE OR DELETE ON message_template_version
  FOR EACH ROW EXECUTE FUNCTION message_template_version_freeze();

-- ---------------------------------------------------------------------------
-- Preferences
-- ---------------------------------------------------------------------------

-- Per person, per purpose: which channel they want, and a quiet-hours window.
-- Separate from consent_record on purpose — consent is the LEGAL basis to
-- contact someone, a preference is HOW. Conflating them means "please use
-- WhatsApp instead of SMS" reads as a withdrawal of consent.
CREATE TABLE communication_preference (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES organization (id),
  person_id          uuid NOT NULL REFERENCES person (id) ON DELETE CASCADE,
  purpose            text NOT NULL,

  preferred_channel  text CHECK (preferred_channel IN ('sms', 'whatsapp', 'email', 'push', 'in_app')),
  locale             text,
  -- Local time, institute's timezone. NULL means no restriction.
  quiet_from         time,
  quiet_to           time,
  -- A hard opt-out of THIS purpose's messages, distinct from withdrawing the
  -- consent that permits them at all.
  muted              boolean NOT NULL DEFAULT false,

  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT communication_preference_quiet_pair
    CHECK ((quiet_from IS NULL) = (quiet_to IS NULL))
);

CREATE UNIQUE INDEX communication_preference_key
  ON communication_preference (tenant_id, person_id, purpose);

-- ---------------------------------------------------------------------------
-- Dispatch
-- ---------------------------------------------------------------------------

-- One request is one send: "tell today's absentees' guardians". It fans out to
-- recipients, each of which fans out to attempts.
CREATE TABLE message_request (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES organization (id),
  campus_id           uuid REFERENCES campus (id),

  message_template_id uuid NOT NULL REFERENCES message_template (id),
  purpose             text NOT NULL,

  -- What triggered it, for tracing a parent's "why did I get this".
  source_type         text NOT NULL,
  source_id           uuid,

  -- Caller-supplied and unique per tenant. A retried job is the same request,
  -- not a second one — the difference between a delayed notification and two
  -- notifications.
  idempotency_key     text NOT NULL,

  status              text NOT NULL DEFAULT 'queued'
                        CHECK (status IN ('queued', 'dispatching', 'completed', 'cancelled')),

  requested_by        uuid REFERENCES staff (id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  completed_at        timestamptz
);

CREATE UNIQUE INDEX message_request_idempotency_key
  ON message_request (tenant_id, idempotency_key);
CREATE INDEX message_request_status_idx ON message_request (tenant_id, status, created_at);

-- One row per (person, SUBJECT). The subject is the learner the message is
-- about, and it is part of the key: a guardian of three children gets three
-- rows and three messages. Collapsing on person_id is the bug AC-8 exists to
-- catch.
CREATE TABLE message_recipient (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES organization (id),
  message_request_id   uuid NOT NULL REFERENCES message_request (id) ON DELETE CASCADE,

  person_id            uuid NOT NULL REFERENCES person (id),
  -- The learner this message is about. NULL for a message about the recipient
  -- themselves (a staff notice, say).
  subject_person_id    uuid REFERENCES person (id),

  -- Resolved at dispatch, not at queue time.
  contact_method_id    uuid REFERENCES contact_method (id),
  channel              text CHECK (channel IN ('sms', 'whatsapp', 'email', 'push', 'in_app')),
  locale               text,
  rendered_body        text,

  status               text NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending', 'sent', 'delivered', 'read',
                                           'failed', 'suppressed')),
  -- Why a message was NOT sent. Never NULL for a suppressed row: "we did not
  -- message you because you withdrew consent on the 4th" has to be answerable,
  -- and it is the answer a regulator asks for.
  suppression_reason   text,

  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT message_recipient_suppressed_has_reason
    CHECK ((status = 'suppressed') = (suppression_reason IS NOT NULL))
);

-- One message per person per subject per request. This is the index that makes
-- "three children, three messages" true and "three children, three DUPLICATE
-- messages about one child" impossible.
CREATE UNIQUE INDEX message_recipient_one_per_subject
  ON message_recipient (
    message_request_id, person_id,
    COALESCE(subject_person_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );
CREATE INDEX message_recipient_status_idx
  ON message_recipient (tenant_id, status, created_at);

-- Every attempt, including the ones that failed and the fallbacks. A parent who
-- says "I never got it" is usually right about something, and this is where you
-- look.
CREATE TABLE message_attempt (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES organization (id),
  message_recipient_id  uuid NOT NULL REFERENCES message_recipient (id) ON DELETE CASCADE,

  attempt_no            integer NOT NULL,
  channel               text NOT NULL CHECK (channel IN ('sms', 'whatsapp', 'email', 'push', 'in_app')),
  -- Set when this attempt exists because an earlier channel failed.
  fallback_from         text,

  provider              text,
  provider_message_id   text,
  provider_status       text,
  error_code            text,
  error_detail          text,

  sent_at               timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT message_attempt_no_positive CHECK (attempt_no > 0)
);

CREATE UNIQUE INDEX message_attempt_no_key
  ON message_attempt (message_recipient_id, attempt_no);
CREATE UNIQUE INDEX message_attempt_provider_key
  ON message_attempt (provider, provider_message_id)
  WHERE provider_message_id IS NOT NULL;

-- Provider callbacks. Stored raw and deduped on the provider's own id, exactly
-- as payment webhooks are in 0025: a provider that does not get a 200 will send
-- the same receipt again, often several times at once.
CREATE TABLE delivery_receipt (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES organization (id),

  provider             text NOT NULL,
  provider_message_id  text NOT NULL,
  provider_event_id    text,
  status               text NOT NULL,
  error_code           text,
  raw_body             text NOT NULL,
  signature_valid      boolean,

  received_at          timestamptz NOT NULL DEFAULT now(),
  processed_at         timestamptz
);

CREATE UNIQUE INDEX delivery_receipt_event_key
  ON delivery_receipt (provider, provider_event_id) WHERE provider_event_id IS NOT NULL;
CREATE INDEX delivery_receipt_message_idx
  ON delivery_receipt (provider, provider_message_id);

-- The WhatsApp session window. Updated when a person sends US a message;
-- read to decide whether a free-form body is permitted.
CREATE TABLE whatsapp_session (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES organization (id),
  person_id       uuid NOT NULL REFERENCES person (id) ON DELETE CASCADE,
  last_inbound_at timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX whatsapp_session_key ON whatsapp_session (tenant_id, person_id);

-- ---------------------------------------------------------------------------
-- Consent at send time
-- ---------------------------------------------------------------------------

-- The AC-8 predicate, in the database rather than in a service, so every path
-- that sends anything answers the same question the same way.
--
-- It returns the REASON rather than a boolean: 'ok' or why not. A dispatcher
-- that only knows "no" cannot tell a parent why they were not contacted, and
-- that explanation is the thing a regulator asks for.
CREATE OR REPLACE FUNCTION may_message(
  subject_person uuid,      -- whose data the message concerns
  recipient_person uuid,    -- who would receive it
  msg_purpose text
) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT CASE
    -- Processing necessary for the educational contract is not consent-based,
    -- so it is never suppressed for want of a consent record. A fee receipt is
    -- not marketing.
    WHEN msg_purpose = 'core_education_service' THEN 'ok'
    WHEN EXISTS (
      SELECT 1 FROM communication_preference p
       WHERE p.person_id = recipient_person
         AND p.purpose = msg_purpose
         AND p.muted
    ) THEN 'muted'
    WHEN EXISTS (
      SELECT 1 FROM consent_record c
       WHERE c.person_id = subject_person
         AND c.purpose = msg_purpose
         AND c.withdrawn_at IS NULL
         AND c.basis IN ('consent', 'contract', 'legal_obligation')
    ) THEN 'ok'
    WHEN EXISTS (
      SELECT 1 FROM consent_record c
       WHERE c.person_id = subject_person
         AND c.purpose = msg_purpose
         AND c.withdrawn_at IS NOT NULL
    ) THEN 'consent_withdrawn'
    ELSE 'no_consent'
  END;
$$;

COMMENT ON FUNCTION may_message(uuid, uuid, text) IS
  'AC-8. Returns ''ok'' or the reason a message must not be sent, evaluated '
  'against consent as it stands RIGHT NOW rather than against a cached audience.';
