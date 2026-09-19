-- 0002: the tenancy spine. Organization is the tenant; campus is a scope inside
-- it, never a tenant of its own.

CREATE TABLE organization (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_name    text NOT NULL,
  display_name  text NOT NULL,
  gstin         text,
  pan           text,
  country       char(2) NOT NULL DEFAULT 'IN',
  timezone      text NOT NULL DEFAULT 'Asia/Kolkata',
  locale        text NOT NULL DEFAULT 'en-IN',
  status        text NOT NULL DEFAULT 'active'
                  CHECK (status IN ('trial', 'active', 'suspended', 'terminated')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz
);

CREATE UNIQUE INDEX organization_gstin_key
  ON organization (gstin) WHERE gstin IS NOT NULL AND deleted_at IS NULL;

CREATE TABLE campus (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES organization (id),
  code        text NOT NULL,
  name        text NOT NULL,
  is_primary  boolean NOT NULL DEFAULT false,
  status      text NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'inactive')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz
);

-- Tenant-scoped, and partial so a code can be reused after a soft delete.
CREATE UNIQUE INDEX campus_tenant_code_key
  ON campus (tenant_id, code) WHERE deleted_at IS NULL;
CREATE INDEX campus_tenant_status_idx ON campus (tenant_id, status);

CREATE TABLE academic_unit (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES organization (id),
  campus_id             uuid NOT NULL REFERENCES campus (id),
  code                  text NOT NULL,
  name                  text NOT NULL,
  unit_type             text NOT NULL
                          CHECK (unit_type IN ('school', 'college', 'centre', 'academy', 'corporate')),
  board_or_affiliation  text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  deleted_at            timestamptz
);

CREATE UNIQUE INDEX academic_unit_tenant_campus_code_key
  ON academic_unit (tenant_id, campus_id, code) WHERE deleted_at IS NULL;
CREATE INDEX academic_unit_tenant_campus_idx ON academic_unit (tenant_id, campus_id);

CREATE TABLE academic_year (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES organization (id),
  academic_unit_id  uuid NOT NULL REFERENCES academic_unit (id),
  label             text NOT NULL,
  starts_on         date NOT NULL,
  ends_on           date NOT NULL,
  status            text NOT NULL DEFAULT 'planning'
                      CHECK (status IN ('planning', 'active', 'closed', 'archived')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz,
  CONSTRAINT academic_year_dates_ordered CHECK (ends_on > starts_on)
);

CREATE UNIQUE INDEX academic_year_tenant_unit_label_key
  ON academic_year (tenant_id, academic_unit_id, label) WHERE deleted_at IS NULL;
CREATE INDEX academic_year_tenant_status_idx ON academic_year (tenant_id, status);

-- Two *active* years may not overlap within one academic unit. Planning and
-- archived years may, because a school plans next year while this one runs.
ALTER TABLE academic_year ADD CONSTRAINT academic_year_no_overlapping_active
  EXCLUDE USING gist (
    academic_unit_id WITH =,
    daterange(starts_on, ends_on, '[]') WITH &&
  ) WHERE (status = 'active' AND deleted_at IS NULL);

CREATE TRIGGER organization_set_updated_at   BEFORE UPDATE ON organization   FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER campus_set_updated_at         BEFORE UPDATE ON campus         FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER academic_unit_set_updated_at  BEFORE UPDATE ON academic_unit  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER academic_year_set_updated_at  BEFORE UPDATE ON academic_year  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
