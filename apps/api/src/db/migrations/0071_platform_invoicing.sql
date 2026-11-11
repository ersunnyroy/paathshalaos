-- 0071 — invoicing a school (M25).
--
-- Distinct from `invoice`, which is a school billing a parent. This is us
-- billing the school, and conflating the two would put our revenue inside a
-- tenant's row-level security — readable by the school, and scoped away from
-- the platform role that actually needs it.
--
-- Three things here are India-specific and are the reason this is not a
-- generic "charge the customer" table:
--
--   1. **Place of supply decides the tax split.** Intra-state supply is CGST
--      plus SGST, each half the rate; inter-state is IGST at the full rate.
--      Never both, and the wrong one is not a rounding difference — it is a
--      return filed against the wrong state.
--   2. **Numbers must be consecutive, per financial year, with no gaps.** Not
--      "unique". A gap is a question from an auditor about a missing invoice.
--   3. **An issued invoice is frozen.** A correction is a credit note, not an
--      edit. The same rule `invoice_frozen` already applies to a parent's bill.
--
-- NOT VERIFIED BY AN ACCOUNTANT. The mechanics below — the split, the
-- rounding, the numbering, the immutability — are implemented precisely and
-- tested. The rate (18%) and the SAC code are configuration rather than
-- constants for exactly that reason: they are the parts a professional has to
-- confirm, and hard-coding them would hide that they were guessed. M31 has the
-- review.

-- ---------------------------------------------------------------------------
-- A correction to 0059, which cannot be edited
-- ---------------------------------------------------------------------------
--
-- `plan_version.price_monthly` is commented "Paise, as every other amount in
-- this system". It is a numeric(14,2), and every other money column in this
-- schema — `invoice.total`, `payment.amount` — holds rupees and paise in
-- exactly that shape. The comment is wrong, and wrong in the one place where
-- believing it means multiplying by a hundred.
COMMENT ON COLUMN plan_version.price_monthly IS
  'Rupees and paise, like every other numeric(14,2) money column here. The '
  'original comment said paise; it was wrong. numeric(14,2) holding paise '
  'would mean fractional paise.';
COMMENT ON COLUMN plan_version.price_annual IS
  'Rupees and paise. See price_monthly.';

-- ---------------------------------------------------------------------------
-- Who is supplying, and to whom
-- ---------------------------------------------------------------------------

-- Our own identity on the invoice. A table rather than configuration because
-- it appears on a legal document: when it changes, invoices issued before the
-- change must keep showing what was true then, and a value read from an
-- environment variable at render time cannot do that. The invoice copies it.
CREATE TABLE platform_tax_identity (
  id            boolean PRIMARY KEY DEFAULT true CHECK (id),
  legal_name    text NOT NULL,
  gstin         text NOT NULL CHECK (gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]{3}$'),
  -- The first two characters of a GSTIN are the state code, so this is
  -- derivable — and stored anyway, because a derived value in a tax
  -- calculation is a value somebody changes the derivation of.
  state_code    character(2) NOT NULL CHECK (state_code ~ '^[0-9]{2}$'),
  address       text NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE platform_tax_identity IS
  'One row, enforced by the primary key. Our supplier details as they appear '
  'on an invoice.';

-- Where the school is, for tax purposes.
--
-- Separate from `organization` because a school's billing contact and place of
-- supply are not its identity, and because a school WITHOUT a GSTIN still has
-- a state — an unregistered customer is an ordinary case, not an error.
CREATE TABLE tenant_billing_profile (
  tenant_id     uuid PRIMARY KEY REFERENCES organization (id),
  billing_name  text NOT NULL,
  -- NULL means unregistered. Still billed, still taxed; simply cannot claim
  -- input credit. Treating a missing GSTIN as a failure would refuse to
  -- invoice the smaller half of the market.
  gstin         text CHECK (gstin IS NULL
                  OR gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]{3}$'),
  state_code    character(2) NOT NULL CHECK (state_code ~ '^[0-9]{2}$'),
  billing_email text NOT NULL CHECK (billing_email ~ '^[^@[:space:]]+@[^@[:space:]]+$'),
  address       text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  -- A registered school's GSTIN must agree with the state we are billing. The
  -- first two characters ARE the state code, so a mismatch means one of them
  -- was typed wrong, and the wrong one sends the tax to the wrong government.
  CONSTRAINT tenant_billing_gstin_matches_state
    CHECK (gstin IS NULL OR substring(gstin from 1 for 2) = state_code)
);

-- ---------------------------------------------------------------------------
-- The invoice
-- ---------------------------------------------------------------------------

CREATE TABLE platform_invoice (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES organization (id),
  subscription_id   uuid NOT NULL REFERENCES subscription (id),

  -- "PS/2627/000001". Sixteen characters is the statutory maximum and this is
  -- fourteen, leaving room for a prefix change without a migration.
  invoice_no        text NOT NULL,
  -- "2026-27". The series restarts each year, which is why the uniqueness
  -- constraint is on the pair.
  financial_year    text NOT NULL CHECK (financial_year ~ '^[0-9]{4}-[0-9]{2}$'),
  -- The position in the series, so a gap is detectable by arithmetic rather
  -- than by parsing the number.
  serial            integer NOT NULL CHECK (serial > 0),

  issued_on         date NOT NULL DEFAULT CURRENT_DATE,
  due_on            date NOT NULL,
  period_start      date NOT NULL,
  period_end        date NOT NULL,

  -- Copied, not joined. An invoice is a statement about what was true when it
  -- was issued; a school that changes its registered address next year must
  -- not retroactively change last year's document.
  supplier_gstin    text NOT NULL,
  supplier_state    character(2) NOT NULL,
  customer_gstin    text,
  customer_state    character(2) NOT NULL,
  customer_name     text NOT NULL,
  customer_address  text NOT NULL,

  -- Intra-state is CGST + SGST; inter-state is IGST. Stored rather than
  -- recomputed so the document says which it was.
  supply_type       text NOT NULL CHECK (supply_type IN ('intra_state', 'inter_state')),

  taxable_value     numeric(14,2) NOT NULL CHECK (taxable_value >= 0),
  cgst              numeric(14,2) NOT NULL DEFAULT 0 CHECK (cgst >= 0),
  sgst              numeric(14,2) NOT NULL DEFAULT 0 CHECK (sgst >= 0),
  igst              numeric(14,2) NOT NULL DEFAULT 0 CHECK (igst >= 0),
  total             numeric(14,2) NOT NULL CHECK (total >= 0),

  status            text NOT NULL DEFAULT 'issued'
                      CHECK (status IN ('issued', 'paid', 'cancelled')),
  paid_at           timestamptz,
  cancelled_at      timestamptz,
  cancel_reason     text,

  created_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT platform_invoice_no_unique UNIQUE (invoice_no),
  CONSTRAINT platform_invoice_serial_unique UNIQUE (financial_year, serial),

  -- One or the other, never both. An invoice carrying CGST and IGST is a
  -- return filed twice.
  CONSTRAINT platform_invoice_one_tax_regime CHECK (
    (supply_type = 'intra_state' AND igst = 0)
    OR (supply_type = 'inter_state' AND cgst = 0 AND sgst = 0)),

  -- The central and state halves of an intra-state supply are equal by law.
  CONSTRAINT platform_invoice_halves_match CHECK (cgst = sgst),

  -- The arithmetic on the face of the document has to hold. This is the
  -- constraint that makes a rounding bug a failed insert rather than a
  -- disagreement discovered at audit.
  CONSTRAINT platform_invoice_adds_up
    CHECK (total = taxable_value + cgst + sgst + igst),

  CONSTRAINT platform_invoice_period_ordered CHECK (period_end >= period_start),
  CONSTRAINT platform_invoice_paid_has_timestamp
    CHECK ((status = 'paid') = (paid_at IS NOT NULL)),
  CONSTRAINT platform_invoice_cancelled_has_reason
    CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL AND cancel_reason IS NOT NULL))
);

CREATE INDEX platform_invoice_tenant_idx
  ON platform_invoice (tenant_id, issued_on DESC);
CREATE INDEX platform_invoice_unpaid_idx
  ON platform_invoice (due_on) WHERE status = 'issued';

CREATE TABLE platform_invoice_line (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  platform_invoice_id uuid NOT NULL REFERENCES platform_invoice (id) ON DELETE CASCADE,
  line_no            integer NOT NULL CHECK (line_no > 0),
  description        text NOT NULL,
  -- The service accounting code. Configuration, not a constant: see the note
  -- at the top about what has and has not been checked by a professional.
  sac_code           text NOT NULL CHECK (sac_code ~ '^[0-9]{6}$'),
  quantity           numeric(10,2) NOT NULL CHECK (quantity > 0),
  unit_price         numeric(14,2) NOT NULL CHECK (unit_price >= 0),
  taxable_value      numeric(14,2) NOT NULL CHECK (taxable_value >= 0),
  -- Per cent, not a fraction. 18.00 means eighteen per cent.
  tax_rate           numeric(5,2) NOT NULL CHECK (tax_rate >= 0 AND tax_rate <= 100),

  CONSTRAINT platform_invoice_line_once UNIQUE (platform_invoice_id, line_no)
);

-- ---------------------------------------------------------------------------
-- A correction is a document, not an edit
-- ---------------------------------------------------------------------------

CREATE TABLE platform_credit_note (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES organization (id),
  platform_invoice_id uuid NOT NULL REFERENCES platform_invoice (id),
  note_no             text NOT NULL,
  financial_year      text NOT NULL CHECK (financial_year ~ '^[0-9]{4}-[0-9]{2}$'),
  serial              integer NOT NULL CHECK (serial > 0),
  issued_on           date NOT NULL DEFAULT CURRENT_DATE,
  reason              text NOT NULL CHECK (length(trim(reason)) >= 10),

  taxable_value       numeric(14,2) NOT NULL CHECK (taxable_value >= 0),
  cgst                numeric(14,2) NOT NULL DEFAULT 0 CHECK (cgst >= 0),
  sgst                numeric(14,2) NOT NULL DEFAULT 0 CHECK (sgst >= 0),
  igst                numeric(14,2) NOT NULL DEFAULT 0 CHECK (igst >= 0),
  total               numeric(14,2) NOT NULL CHECK (total >= 0),

  created_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT platform_credit_note_no_unique UNIQUE (note_no),
  CONSTRAINT platform_credit_note_serial_unique UNIQUE (financial_year, serial),
  CONSTRAINT platform_credit_note_halves_match CHECK (cgst = sgst),
  CONSTRAINT platform_credit_note_adds_up
    CHECK (total = taxable_value + cgst + sgst + igst)
);

CREATE INDEX platform_credit_note_invoice_idx
  ON platform_credit_note (platform_invoice_id);

-- A credit note cannot exceed what is left of the invoice it corrects.
--
-- A trigger rather than a constraint because the rule spans rows: the sum of
-- every note against an invoice, compared to that invoice's total. Checked on
-- INSERT only; these are append-only by the trigger below.
CREATE OR REPLACE FUNCTION credit_note_within_invoice() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  invoice_total numeric(14,2);
  credited      numeric(14,2);
BEGIN
  SELECT total INTO invoice_total FROM platform_invoice
   WHERE id = NEW.platform_invoice_id;
  SELECT COALESCE(sum(total), 0) INTO credited FROM platform_credit_note
   WHERE platform_invoice_id = NEW.platform_invoice_id;

  IF credited + NEW.total > invoice_total THEN
    RAISE EXCEPTION
      'Credit notes against this invoice would total %, which is more than the invoice''s %',
      credited + NEW.total, invoice_total
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER credit_note_within_invoice
  BEFORE INSERT ON platform_credit_note
  FOR EACH ROW EXECUTE FUNCTION credit_note_within_invoice();

-- ---------------------------------------------------------------------------
-- Frozen once issued
-- ---------------------------------------------------------------------------
--
-- Everything except the payment and cancellation fields, which are the only
-- things that legitimately change after issue. An amount, a number, a party or
-- a date changing on an issued tax invoice is not a correction; it is a
-- different document wearing the same number.

CREATE OR REPLACE FUNCTION platform_invoice_is_frozen() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.invoice_no IS DISTINCT FROM OLD.invoice_no
     OR NEW.financial_year IS DISTINCT FROM OLD.financial_year
     OR NEW.serial IS DISTINCT FROM OLD.serial
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.issued_on IS DISTINCT FROM OLD.issued_on
     OR NEW.period_start IS DISTINCT FROM OLD.period_start
     OR NEW.period_end IS DISTINCT FROM OLD.period_end
     OR NEW.supplier_gstin IS DISTINCT FROM OLD.supplier_gstin
     OR NEW.supplier_state IS DISTINCT FROM OLD.supplier_state
     OR NEW.customer_gstin IS DISTINCT FROM OLD.customer_gstin
     OR NEW.customer_state IS DISTINCT FROM OLD.customer_state
     OR NEW.customer_name IS DISTINCT FROM OLD.customer_name
     OR NEW.customer_address IS DISTINCT FROM OLD.customer_address
     OR NEW.supply_type IS DISTINCT FROM OLD.supply_type
     OR NEW.taxable_value IS DISTINCT FROM OLD.taxable_value
     OR NEW.cgst IS DISTINCT FROM OLD.cgst
     OR NEW.sgst IS DISTINCT FROM OLD.sgst
     OR NEW.igst IS DISTINCT FROM OLD.igst
     OR NEW.total IS DISTINCT FROM OLD.total
  THEN
    RAISE EXCEPTION
      'An issued tax invoice cannot be changed. Raise a credit note instead.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER platform_invoice_frozen
  BEFORE UPDATE ON platform_invoice
  FOR EACH ROW EXECUTE FUNCTION platform_invoice_is_frozen();

CREATE OR REPLACE FUNCTION platform_document_no_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Tax documents are not deleted. Cancel or credit them.'
    USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER platform_invoice_no_delete
  BEFORE DELETE ON platform_invoice
  FOR EACH ROW EXECUTE FUNCTION platform_document_no_delete();
CREATE TRIGGER platform_credit_note_no_delete
  BEFORE DELETE ON platform_credit_note
  FOR EACH ROW EXECUTE FUNCTION platform_document_no_delete();
CREATE TRIGGER platform_credit_note_no_update
  BEFORE UPDATE ON platform_credit_note
  FOR EACH ROW EXECUTE FUNCTION platform_document_no_delete();

-- ---------------------------------------------------------------------------
-- Numbers without gaps
-- ---------------------------------------------------------------------------
--
-- A sequence is the obvious choice and the wrong one: a sequence does not roll
-- back, so a failed insert consumes a number and leaves a hole. A hole is a
-- question from an auditor about an invoice that does not exist.
--
-- A counter row, locked FOR UPDATE and incremented inside the same transaction
-- as the insert, rolls back with it. That serialises invoice creation within a
-- financial year, which is the correct trade: a handful of invoices a month
-- per school, against a gap-free series that is a statutory requirement.

CREATE TABLE platform_document_series (
  kind            text NOT NULL CHECK (kind IN ('invoice', 'credit_note')),
  financial_year  text NOT NULL CHECK (financial_year ~ '^[0-9]{4}-[0-9]{2}$'),
  last_serial     integer NOT NULL DEFAULT 0 CHECK (last_serial >= 0),
  PRIMARY KEY (kind, financial_year)
);

COMMENT ON TABLE platform_document_series IS
  'A counter, not a sequence. A sequence does not roll back, so a failed '
  'insert leaves a gap — and a gap in a tax invoice series is a question from '
  'an auditor about a document that does not exist.';

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
--
-- The platform role, and NOT the application role. Our revenue is not the
-- school's data: a school reading its own invoice is a screen we will build
-- against a narrow view, not a grant on the table. The assertion in
-- platform-pool.ts stays true because none of these are tenant tables in the
-- row-level-security sense — they have a tenant_id and no policy, so the app
-- role simply cannot see them at all.

GRANT SELECT, INSERT, UPDATE ON platform_tax_identity TO paathshala_platform;
GRANT SELECT, INSERT, UPDATE ON tenant_billing_profile TO paathshala_platform;
GRANT SELECT, INSERT, UPDATE ON platform_invoice TO paathshala_platform;
GRANT SELECT, INSERT ON platform_invoice_line TO paathshala_platform;
GRANT SELECT, INSERT ON platform_credit_note TO paathshala_platform;
GRANT SELECT, INSERT, UPDATE ON platform_document_series TO paathshala_platform;
