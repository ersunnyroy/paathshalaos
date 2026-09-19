-- 0028 — a payment remembers WHICH invoice it was raised for.
--
-- Found by a test that only failed when the whole file ran: allocation was
-- purely oldest-first across the campus, so a counter receipt written against
-- invoice B landed on invoice A because A happened to be due earlier. In
-- isolation there was no A and the test passed. The family is told "this pays
-- your March bill" and the books say otherwise — an accounting lie, not a
-- rounding one.
--
-- Nullable on purpose: a general deposit or an advance has no target and still
-- allocates oldest-first. The column records intent, not a constraint; a
-- payment larger than its target still spills over to the other dues.
ALTER TABLE payment
  ADD COLUMN target_invoice_id uuid REFERENCES invoice (id);

CREATE INDEX payment_target_invoice_idx ON payment (tenant_id, target_invoice_id)
  WHERE target_invoice_id IS NOT NULL;

COMMENT ON COLUMN payment.target_invoice_id IS
  'The invoice this payment was raised against, if any. Allocation settles this '
  'invoice first and only then spills over to other outstanding dues, so a '
  'receipt matches what the payer was asked to pay.';

-- Re-pointing a settled payment at a different invoice would rewrite history
-- without leaving a trace, so the target is frozen with the amount.
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
     OR NEW.received_on <> OLD.received_on
     OR NEW.target_invoice_id IS DISTINCT FROM OLD.target_invoice_id THEN
    RAISE EXCEPTION 'a payment cannot be altered; reverse it and record a new one'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
