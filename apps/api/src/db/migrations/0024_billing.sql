-- 0024: fee structures.
--
-- A published plan is frozen. Invoices reference the plan they were raised
-- under, and editing it afterwards would silently change what a family was
-- billed for a term that has already been paid.

CREATE TABLE fee_plan (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES organization (id),
  academic_unit_id  uuid NOT NULL REFERENCES academic_unit (id),
  programme_id      uuid REFERENCES programme (id),
  academic_year_id  uuid NOT NULL REFERENCES academic_year (id),
  name              text NOT NULL,
  version           integer NOT NULL DEFAULT 1,
  status            text NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft', 'published', 'closed')),
  currency          char(3) NOT NULL DEFAULT 'INR',
  published_at      timestamptz,
  published_by      uuid REFERENCES staff (id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz,
  CONSTRAINT fee_plan_published_has_timestamp
    CHECK ((status = 'draft') = (published_at IS NULL))
);

CREATE UNIQUE INDEX fee_plan_key
  ON fee_plan (tenant_id, academic_year_id,
               COALESCE(programme_id, '00000000-0000-0000-0000-000000000000'::uuid),
               name, version)
  WHERE deleted_at IS NULL;
CREATE INDEX fee_plan_status_idx ON fee_plan (tenant_id, academic_year_id, status);

CREATE TABLE fee_component (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES organization (id),
  fee_plan_id   uuid NOT NULL REFERENCES fee_plan (id) ON DELETE CASCADE,
  code          text NOT NULL,
  name          text NOT NULL,
  amount        numeric(14,2) NOT NULL,
  frequency     text NOT NULL
                  CHECK (frequency IN ('one_time', 'monthly', 'term', 'annual')),
  is_refundable boolean NOT NULL DEFAULT false,
  is_optional   boolean NOT NULL DEFAULT false,
  tax_rate      numeric(5,2) NOT NULL DEFAULT 0,
  gl_code       text,
  sort_order    integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fee_component_amount_not_negative CHECK (amount >= 0),
  CONSTRAINT fee_component_tax_rate_sane CHECK (tax_rate >= 0 AND tax_rate <= 100)
);

CREATE UNIQUE INDEX fee_component_key ON fee_component (tenant_id, fee_plan_id, code);

-- A published plan and its components are immutable together. Freezing the plan
-- row alone would leave the amounts editable, which is the part that matters.
CREATE OR REPLACE FUNCTION fee_plan_frozen_once_published() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'draft' AND NEW.status <> 'closed' AND
     (NEW.name <> OLD.name OR NEW.version <> OLD.version
      OR NEW.academic_year_id <> OLD.academic_year_id OR NEW.currency <> OLD.currency) THEN
    RAISE EXCEPTION 'fee plan % is published; create a new version instead', OLD.name
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER fee_plan_is_frozen
  BEFORE UPDATE ON fee_plan FOR EACH ROW EXECUTE FUNCTION fee_plan_frozen_once_published();

CREATE OR REPLACE FUNCTION fee_component_frozen_once_published() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_status text;
BEGIN
  SELECT status INTO v_status FROM fee_plan
   WHERE id = COALESCE(NEW.fee_plan_id, OLD.fee_plan_id);
  IF v_status <> 'draft' THEN
    RAISE EXCEPTION 'the fee plan is published; its components cannot be % ', TG_OP
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER fee_component_follows_plan
  BEFORE INSERT OR UPDATE OR DELETE ON fee_component
  FOR EACH ROW EXECUTE FUNCTION fee_component_frozen_once_published();

-- The plan applied to one enrollment.
CREATE TABLE fee_assignment (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES organization (id),
  enrollment_id   uuid NOT NULL REFERENCES enrollment (id),
  fee_plan_id     uuid NOT NULL REFERENCES fee_plan (id),
  effective_from  date NOT NULL DEFAULT CURRENT_DATE,
  effective_to    date,
  override_reason text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fee_assignment_dates_ordered
    CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

-- One live assignment per enrollment: two would double-bill the family.
CREATE UNIQUE INDEX fee_assignment_one_live
  ON fee_assignment (tenant_id, enrollment_id) WHERE effective_to IS NULL;
CREATE INDEX fee_assignment_plan_idx ON fee_assignment (tenant_id, fee_plan_id);

-- A discount, with who approved it.
--
-- Concessions are where fee leakage happens: granted verbally at a counter,
-- never recorded, impossible to reconcile. Every one here carries an approver
-- and a reason, and RTE and staff concessions are typed rather than free text
-- so they can be reported on.
CREATE TABLE concession (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES organization (id),
  fee_assignment_id uuid NOT NULL REFERENCES fee_assignment (id) ON DELETE CASCADE,
  fee_component_id  uuid REFERENCES fee_component (id),
  concession_type   text NOT NULL CHECK (concession_type IN
                      ('sibling', 'staff_ward', 'rte', 'merit', 'need_based', 'early_payment', 'custom')),
  mode              text NOT NULL CHECK (mode IN ('percent', 'amount')),
  value             numeric(14,2) NOT NULL,
  reason            text NOT NULL,
  requested_by      uuid REFERENCES staff (id),
  approved_by       uuid REFERENCES staff (id),
  approved_at       timestamptz,
  revoked_at        timestamptz,
  revoked_reason    text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT concession_value_positive CHECK (value > 0),
  CONSTRAINT concession_percent_range
    CHECK (mode <> 'percent' OR value <= 100),
  -- An unapproved concession must not reduce anything.
  CONSTRAINT concession_approved_has_approver
    CHECK ((approved_by IS NULL) = (approved_at IS NULL))
);

CREATE INDEX concession_assignment_idx ON concession (tenant_id, fee_assignment_id)
  WHERE revoked_at IS NULL;
CREATE INDEX concession_approved_idx ON concession (tenant_id, approved_at);

CREATE TABLE installment (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES organization (id),
  fee_assignment_id  uuid NOT NULL REFERENCES fee_assignment (id) ON DELETE CASCADE,
  sequence           integer NOT NULL,
  due_on             date NOT NULL,
  gross_amount       numeric(14,2) NOT NULL,
  concession_amount  numeric(14,2) NOT NULL DEFAULT 0,
  net_amount         numeric(14,2) NOT NULL,
  status             text NOT NULL DEFAULT 'scheduled'
                       CHECK (status IN ('scheduled', 'invoiced', 'paid', 'waived', 'cancelled')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT installment_amounts_not_negative
    CHECK (gross_amount >= 0 AND concession_amount >= 0 AND net_amount >= 0),
  -- The arithmetic is checked by the database, not trusted from the caller.
  CONSTRAINT installment_net_is_gross_less_concession
    CHECK (net_amount = gross_amount - concession_amount),
  CONSTRAINT installment_sequence_positive CHECK (sequence > 0)
);

CREATE UNIQUE INDEX installment_key ON installment (tenant_id, fee_assignment_id, sequence);
CREATE INDEX installment_due_idx ON installment (tenant_id, due_on, status);

CREATE TRIGGER fee_plan_set_updated_at
  BEFORE UPDATE ON fee_plan FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER fee_assignment_set_updated_at
  BEFORE UPDATE ON fee_assignment FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER installment_set_updated_at
  BEFORE UPDATE ON installment FOR EACH ROW EXECUTE FUNCTION set_updated_at();
