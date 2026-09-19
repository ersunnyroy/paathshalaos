-- 0011: people. One human, one record per tenant, whatever roles they hold.
--
-- The shape that matters: `person` is tenant-scoped, `user_account` (migration
-- 0005) is global. A guardian with children at two institutes has ONE login and
-- TWO person rows. Modelling it the other way — a person row shared across
-- tenants — would leak the fact that a family attends a competitor's school, and
-- modelling the login per tenant would force them to hold two passwords.

CREATE TABLE person (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES organization (id),

  -- Most people have no login: a class of 40 learners has 40 person rows and
  -- perhaps 3 accounts.
  user_account_id  uuid REFERENCES user_account (id) ON DELETE SET NULL,

  given_name       text NOT NULL,
  middle_name      text,
  family_name      text,
  preferred_name   text,
  date_of_birth    date,
  gender           text,

  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz,

  CONSTRAINT person_dob_is_plausible
    CHECK (date_of_birth IS NULL OR (date_of_birth > '1900-01-01' AND date_of_birth <= CURRENT_DATE))
);

-- One person row per login per tenant. Without this, a second sign-up with the
-- same email quietly creates a duplicate family.
CREATE UNIQUE INDEX person_tenant_user_account_key
  ON person (tenant_id, user_account_id)
  WHERE user_account_id IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX person_tenant_family_name_idx ON person (tenant_id, family_name);
CREATE INDEX person_tenant_name_trgm_idx
  ON person USING gin ((coalesce(given_name,'') || ' ' || coalesce(family_name,'')) gin_trgm_ops);

CREATE TABLE contact_method (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES organization (id),
  person_id    uuid NOT NULL REFERENCES person (id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('phone', 'email', 'whatsapp')),
  value        text NOT NULL,
  is_primary   boolean NOT NULL DEFAULT false,
  verified_at  timestamptz,
  -- Consent to be contacted lives here per channel; the notification dispatcher
  -- reads it at send time rather than trusting a cached audience list.
  opt_in_state text NOT NULL DEFAULT 'unknown'
                 CHECK (opt_in_state IN ('unknown', 'opted_in', 'opted_out')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz
);

CREATE UNIQUE INDEX contact_method_unique
  ON contact_method (tenant_id, person_id, kind, value) WHERE deleted_at IS NULL;
-- One primary per kind per person, enforced rather than hoped for.
CREATE UNIQUE INDEX contact_method_one_primary_per_kind
  ON contact_method (tenant_id, person_id, kind)
  WHERE is_primary AND deleted_at IS NULL;
CREATE INDEX contact_method_value_idx ON contact_method (tenant_id, value);

CREATE TABLE address (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES organization (id),
  person_id   uuid NOT NULL REFERENCES person (id) ON DELETE CASCADE,
  label       text NOT NULL DEFAULT 'home' CHECK (label IN ('home', 'work', 'correspondence', 'other')),
  line1       text NOT NULL,
  line2       text,
  city        text NOT NULL,
  state       text NOT NULL,
  pincode     text NOT NULL,
  country     char(2) NOT NULL DEFAULT 'IN',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz,
  CONSTRAINT address_pincode_shape CHECK (country <> 'IN' OR pincode ~ '^[1-9][0-9]{5}$')
);

CREATE INDEX address_person_idx ON address (tenant_id, person_id);

CREATE TABLE staff (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES organization (id),
  person_id      uuid NOT NULL REFERENCES person (id),
  campus_id      uuid NOT NULL REFERENCES campus (id),
  employee_code  text NOT NULL,
  designation    text,
  department     text,
  joined_on      date NOT NULL,
  left_on        date,
  status         text NOT NULL DEFAULT 'active'
                   CHECK (status IN ('active', 'on_leave', 'exited')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz,
  CONSTRAINT staff_exit_after_join CHECK (left_on IS NULL OR left_on >= joined_on),
  CONSTRAINT staff_exited_has_date CHECK (status <> 'exited' OR left_on IS NOT NULL)
);

CREATE UNIQUE INDEX staff_tenant_code_key ON staff (tenant_id, employee_code) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX staff_one_active_per_person
  ON staff (tenant_id, person_id) WHERE status <> 'exited' AND deleted_at IS NULL;
CREATE INDEX staff_campus_status_idx ON staff (tenant_id, campus_id, status);

CREATE TABLE student (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES organization (id),
  person_id          uuid NOT NULL REFERENCES person (id),
  admission_no       text NOT NULL,

  lifecycle_status   text NOT NULL DEFAULT 'enquiry'
                       CHECK (lifecycle_status IN
                         ('enquiry', 'applicant', 'enrolled', 'on_leave',
                          'transferred_out', 'withdrawn', 'completed', 'alumni')),
  first_admitted_on  date,

  -- Health and accessibility data. Classified RESTRICTED: readable only with an
  -- explicit field grant, and every read is audited (migration 0013).
  blood_group        text CHECK (blood_group IS NULL OR blood_group ~ '^(A|B|AB|O)[+-]$'),
  medical_note       text,
  accommodations     text,
  emergency_contact_name  text,
  emergency_contact_phone text,

  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz
);

CREATE UNIQUE INDEX student_tenant_admission_no_key
  ON student (tenant_id, admission_no) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX student_one_per_person
  ON student (tenant_id, person_id) WHERE deleted_at IS NULL;
CREATE INDEX student_lifecycle_idx ON student (tenant_id, lifecycle_status);

-- The relationship, and its rights.
--
-- The capability flags are the point. A guardian without can_view_academics
-- cannot see marks — not hidden in the UI, but invisible to the query (see
-- migration 0012). Custody arrangements are real, common, and the thing every
-- incumbent gets wrong by treating "parent" as a single boolean.
CREATE TABLE guardian_link (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES organization (id),
  student_id           uuid NOT NULL REFERENCES student (id) ON DELETE CASCADE,
  guardian_person_id   uuid NOT NULL REFERENCES person (id) ON DELETE CASCADE,

  relationship         text NOT NULL CHECK (relationship IN
                         ('mother', 'father', 'grandparent', 'sibling', 'uncle_aunt',
                          'legal_guardian', 'foster_parent', 'other')),
  is_primary           boolean NOT NULL DEFAULT false,

  can_view_academics        boolean NOT NULL DEFAULT true,
  can_view_finance          boolean NOT NULL DEFAULT true,
  can_pay                   boolean NOT NULL DEFAULT true,
  can_authorise_pickup      boolean NOT NULL DEFAULT true,
  can_receive_notifications boolean NOT NULL DEFAULT true,

  -- What order or agreement the institute is acting on. Exists so a custody
  -- decision is recorded rather than remembered by whoever was at the desk.
  legal_custody_note   text,

  effective_from       date NOT NULL DEFAULT CURRENT_DATE,
  effective_to         date,

  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT guardian_link_dates_ordered
    CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CONSTRAINT guardian_link_not_self
    CHECK (guardian_person_id <> student_id)
);

CREATE UNIQUE INDEX guardian_link_active_unique
  ON guardian_link (tenant_id, student_id, guardian_person_id) WHERE effective_to IS NULL;
CREATE UNIQUE INDEX guardian_link_one_primary
  ON guardian_link (tenant_id, student_id) WHERE is_primary AND effective_to IS NULL;
-- The index that makes the guardian's own app fast: every screen they open
-- starts from "which learners am I linked to".
CREATE INDEX guardian_link_by_guardian_idx
  ON guardian_link (tenant_id, guardian_person_id) WHERE effective_to IS NULL;

CREATE TRIGGER person_set_updated_at         BEFORE UPDATE ON person         FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER contact_method_set_updated_at BEFORE UPDATE ON contact_method FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER address_set_updated_at        BEFORE UPDATE ON address        FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER staff_set_updated_at          BEFORE UPDATE ON staff          FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER student_set_updated_at        BEFORE UPDATE ON student        FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER guardian_link_set_updated_at  BEFORE UPDATE ON guardian_link  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
