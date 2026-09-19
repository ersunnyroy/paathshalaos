-- 0025: invoices, payments, receipts, refunds and the money that actually moves.
--
-- The governing rule: an invoice and a payment are IMMUTABLE once issued. A
-- correction is a credit note or a refund, each with its own approval and its
-- own ledger entries. Editing a paid invoice is how a fee ledger stops being
-- auditable, and the first time anyone notices is when the numbers disagree
-- with the bank.

CREATE TABLE invoice (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES organization (id),
  campus_id       uuid NOT NULL REFERENCES campus (id),
  installment_id  uuid REFERENCES installment (id),
  enrollment_id   uuid NOT NULL REFERENCES enrollment (id),

  invoice_no      text NOT NULL,
  financial_year  text NOT NULL,

  issued_on       date NOT NULL DEFAULT CURRENT_DATE,
  due_on          date NOT NULL,

  subtotal        numeric(14,2) NOT NULL,
  discount_total  numeric(14,2) NOT NULL DEFAULT 0,
  tax_total       numeric(14,2) NOT NULL DEFAULT 0,
  total           numeric(14,2) NOT NULL,
  amount_paid     numeric(14,2) NOT NULL DEFAULT 0,

  status          text NOT NULL DEFAULT 'issued'
                    CHECK (status IN ('issued', 'part_paid', 'paid', 'void')),
  voided_by       uuid REFERENCES staff (id),
  voided_at       timestamptz,
  void_reason     text,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT invoice_amounts_not_negative
    CHECK (subtotal >= 0 AND discount_total >= 0 AND tax_total >= 0
           AND total >= 0 AND amount_paid >= 0),
  CONSTRAINT invoice_total_is_consistent
    CHECK (total = subtotal - discount_total + tax_total),
  -- The invariant an accountant would check first: you cannot receive more
  -- against an invoice than the invoice is for.
  CONSTRAINT invoice_not_overpaid CHECK (amount_paid <= total),
  CONSTRAINT invoice_void_has_reason
    CHECK (status <> 'void' OR (void_reason IS NOT NULL AND voided_at IS NOT NULL))
);

-- Gapless per campus per financial year. A gap reads as a lost invoice to an
-- auditor and will be asked about.
CREATE UNIQUE INDEX invoice_no_key ON invoice (tenant_id, campus_id, financial_year, invoice_no);
CREATE INDEX invoice_due_idx ON invoice (tenant_id, status, due_on);
CREATE INDEX invoice_enrollment_idx ON invoice (tenant_id, enrollment_id);

CREATE TABLE invoice_line (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES organization (id),
  invoice_id        uuid NOT NULL REFERENCES invoice (id) ON DELETE CASCADE,
  fee_component_id  uuid REFERENCES fee_component (id),
  description       text NOT NULL,
  quantity          numeric(10,2) NOT NULL DEFAULT 1,
  unit_amount       numeric(14,2) NOT NULL,
  discount_amount   numeric(14,2) NOT NULL DEFAULT 0,
  tax_rate          numeric(5,2) NOT NULL DEFAULT 0,
  tax_amount        numeric(14,2) NOT NULL DEFAULT 0,
  line_total        numeric(14,2) NOT NULL,
  gl_code           text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT invoice_line_total_is_consistent
    CHECK (line_total = (quantity * unit_amount) - discount_amount + tax_amount)
);

CREATE INDEX invoice_line_invoice_idx ON invoice_line (tenant_id, invoice_id);

-- A UPI AutoPay or e-NACH authorisation.
CREATE TABLE mandate (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES organization (id),
  payer_person_id      uuid NOT NULL REFERENCES person (id),
  provider             text NOT NULL,
  provider_mandate_id  text NOT NULL,
  max_amount           numeric(14,2) NOT NULL,
  frequency            text NOT NULL
                         CHECK (frequency IN ('monthly', 'quarterly', 'half_yearly', 'annual', 'as_presented')),
  valid_from           date NOT NULL,
  valid_to             date,
  -- Every state the lifecycle can be in. A silent mandate failure is a
  -- collection failure the accountant must see, so 'failed' is a state rather
  -- than an absence.
  status               text NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending', 'authorised', 'paused', 'failed', 'revoked', 'expired')),
  authorised_at        timestamptz,
  revoked_at           timestamptz,
  failure_reason       text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mandate_max_amount_positive CHECK (max_amount > 0),
  CONSTRAINT mandate_authorised_has_timestamp
    CHECK (status <> 'authorised' OR authorised_at IS NOT NULL)
);

CREATE UNIQUE INDEX mandate_provider_key ON mandate (provider, provider_mandate_id);
CREATE INDEX mandate_payer_idx ON mandate (tenant_id, payer_person_id, status);

CREATE TABLE payment (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES organization (id),
  campus_id            uuid NOT NULL REFERENCES campus (id),
  payer_person_id      uuid REFERENCES person (id),

  method               text NOT NULL CHECK (method IN
                         ('upi', 'card', 'netbanking', 'wallet', 'cash', 'cheque', 'dd', 'neft', 'mandate')),
  amount               numeric(14,2) NOT NULL,
  currency             char(3) NOT NULL DEFAULT 'INR',
  received_on          date NOT NULL DEFAULT CURRENT_DATE,

  -- 'pending' until a SIGNED PROVIDER WEBHOOK says otherwise. A client-side
  -- success callback never moves this, which is the whole of AC-6.
  status               text NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending', 'succeeded', 'failed', 'reversed')),

  provider             text,
  provider_order_id    text,
  provider_payment_id  text,
  mandate_id           uuid REFERENCES mandate (id),

  -- Caller-supplied, unique per tenant. A retried request is the same payment.
  idempotency_key      text NOT NULL,

  -- Never the PAN. Last four and network only, which keeps us out of PCI scope.
  instrument_last4     char(4),
  instrument_network   text,

  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT payment_amount_positive CHECK (amount > 0),
  CONSTRAINT payment_succeeded_has_provider_ref
    CHECK (status <> 'succeeded' OR method IN ('cash', 'cheque', 'dd', 'neft')
           OR provider_payment_id IS NOT NULL)
);

CREATE UNIQUE INDEX payment_idempotency_key ON payment (tenant_id, idempotency_key);
CREATE UNIQUE INDEX payment_provider_key
  ON payment (provider, provider_payment_id) WHERE provider_payment_id IS NOT NULL;
CREATE INDEX payment_received_idx ON payment (tenant_id, received_on);
CREATE INDEX payment_status_idx ON payment (tenant_id, status);

-- Every attempt, including the ones that failed. A parent who says "it took the
-- money" is usually right about something, and this is where you look.
CREATE TABLE payment_attempt (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES organization (id),
  payment_id         uuid NOT NULL REFERENCES payment (id) ON DELETE CASCADE,
  provider_order_id  text,
  provider_status    text,
  error_code         text,
  error_message      text,
  raw_response_ref   text,
  attempted_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX payment_attempt_payment_idx ON payment_attempt (tenant_id, payment_id, attempted_at);

-- Inbound provider webhooks, deduplicated. Persisted raw BEFORE parsing so a
-- malformed or hostile body is still available for forensics.
CREATE TABLE payment_webhook_event (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES organization (id),
  provider           text NOT NULL,
  provider_event_id  text NOT NULL,
  event_type         text NOT NULL,
  raw_body           text NOT NULL,
  signature_valid    boolean NOT NULL,
  processed_at       timestamptz,
  received_at        timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX payment_webhook_dedupe ON payment_webhook_event (provider, provider_event_id);
CREATE INDEX payment_webhook_unprocessed_idx
  ON payment_webhook_event (received_at) WHERE processed_at IS NULL;

CREATE TABLE payment_allocation (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES organization (id),
  payment_id    uuid NOT NULL REFERENCES payment (id) ON DELETE CASCADE,
  invoice_id    uuid NOT NULL REFERENCES invoice (id),
  amount        numeric(14,2) NOT NULL,
  allocated_at  timestamptz NOT NULL DEFAULT now(),
  allocated_by  uuid REFERENCES staff (id),
  CONSTRAINT payment_allocation_amount_positive CHECK (amount > 0)
);

CREATE UNIQUE INDEX payment_allocation_key ON payment_allocation (tenant_id, payment_id, invoice_id);
CREATE INDEX payment_allocation_invoice_idx ON payment_allocation (tenant_id, invoice_id);

CREATE TABLE receipt (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES organization (id),
  campus_id             uuid NOT NULL REFERENCES campus (id),
  payment_id            uuid NOT NULL REFERENCES payment (id),
  receipt_no            text NOT NULL,
  financial_year        text NOT NULL,
  issued_on             date NOT NULL DEFAULT CURRENT_DATE,
  amount                numeric(14,2) NOT NULL,
  file_id               uuid REFERENCES file (id),
  checksum              text,
  cancelled_by_receipt_id uuid REFERENCES receipt (id),
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX receipt_no_key ON receipt (tenant_id, campus_id, financial_year, receipt_no);
CREATE UNIQUE INDEX receipt_payment_key ON receipt (tenant_id, payment_id)
  WHERE cancelled_by_receipt_id IS NULL;

CREATE TABLE refund (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES organization (id),
  payment_id          uuid NOT NULL REFERENCES payment (id),
  amount              numeric(14,2) NOT NULL,
  reason              text NOT NULL,
  -- Two people, because refund fraud is the insider risk in a fee system.
  requested_by        uuid NOT NULL REFERENCES staff (id),
  approved_by         uuid REFERENCES staff (id),
  approved_at         timestamptz,
  rejected_by         uuid REFERENCES staff (id),
  rejected_at         timestamptz,
  provider_refund_id  text,
  status              text NOT NULL DEFAULT 'requested'
                        CHECK (status IN ('requested', 'approved', 'rejected', 'processing', 'settled', 'failed')),
  settled_on          date,
  idempotency_key     text NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT refund_amount_positive CHECK (amount > 0),
  CONSTRAINT refund_needs_a_second_person
    CHECK (approved_by IS NULL OR approved_by <> requested_by),
  CONSTRAINT refund_approved_has_timestamp
    CHECK ((approved_by IS NULL) = (approved_at IS NULL))
);

CREATE UNIQUE INDEX refund_idempotency_key ON refund (tenant_id, idempotency_key);
CREATE UNIQUE INDEX refund_provider_key
  ON refund (provider_refund_id) WHERE provider_refund_id IS NOT NULL;
CREATE INDEX refund_status_idx ON refund (tenant_id, status);

CREATE TABLE waiver (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES organization (id),
  invoice_id   uuid NOT NULL REFERENCES invoice (id),
  amount       numeric(14,2) NOT NULL,
  reason       text NOT NULL,
  approved_by  uuid NOT NULL REFERENCES staff (id),
  approved_at  timestamptz NOT NULL DEFAULT now(),
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT waiver_amount_positive CHECK (amount > 0)
);

CREATE INDEX waiver_invoice_idx ON waiver (tenant_id, invoice_id);

-- Immutability. `amount_paid` and `status` legitimately change as money
-- arrives; everything that defines WHAT was billed does not.
CREATE OR REPLACE FUNCTION invoice_is_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'an invoice cannot be deleted; void it instead'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.invoice_no <> OLD.invoice_no
     OR NEW.total <> OLD.total
     OR NEW.subtotal <> OLD.subtotal
     OR NEW.tax_total <> OLD.tax_total
     OR NEW.discount_total <> OLD.discount_total
     OR NEW.enrollment_id <> OLD.enrollment_id
     OR NEW.issued_on <> OLD.issued_on THEN
    RAISE EXCEPTION 'an issued invoice cannot be altered; raise a credit note or void it'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER invoice_frozen
  BEFORE UPDATE OR DELETE ON invoice
  FOR EACH ROW EXECUTE FUNCTION invoice_is_immutable();

CREATE OR REPLACE FUNCTION payment_is_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a payment cannot be deleted; reverse it instead'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.amount <> OLD.amount
     OR NEW.method <> OLD.method
     OR NEW.idempotency_key <> OLD.idempotency_key
     OR NEW.received_on <> OLD.received_on THEN
    RAISE EXCEPTION 'a payment cannot be altered; reverse it and record a new one'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER payment_frozen
  BEFORE UPDATE OR DELETE ON payment
  FOR EACH ROW EXECUTE FUNCTION payment_is_immutable();

CREATE OR REPLACE FUNCTION receipt_is_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a receipt cannot be deleted; cancel it with a replacement'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.receipt_no <> OLD.receipt_no OR NEW.amount <> OLD.amount
     OR NEW.payment_id <> OLD.payment_id OR NEW.issued_on <> OLD.issued_on THEN
    RAISE EXCEPTION 'a receipt cannot be altered'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER receipt_frozen
  BEFORE UPDATE OR DELETE ON receipt
  FOR EACH ROW EXECUTE FUNCTION receipt_is_immutable();

CREATE TRIGGER invoice_set_updated_at BEFORE UPDATE ON invoice FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER payment_set_updated_at BEFORE UPDATE ON payment FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER refund_set_updated_at  BEFORE UPDATE ON refund  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER mandate_set_updated_at BEFORE UPDATE ON mandate FOR EACH ROW EXECUTE FUNCTION set_updated_at();
