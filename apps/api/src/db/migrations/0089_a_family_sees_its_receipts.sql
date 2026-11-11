-- 0089: a family can see the receipts for its own child's fees (M47.2).
--
-- A guardian who may see a child's fees can already read the invoice and how
-- much of it has been paid (`invoice_read`, 0029). What they could not read is
-- the proof: `payment_read` and `receipt_read` only open for the person
-- recorded as the payer, and cash taken at the school counter has no payer on
-- record. So the commonest payment a school takes produced a receipt the
-- family could not see, and an invoice that said "₹2,500 paid" beside an empty
-- list of receipts. The lines of the invoice were closed to them as well.
--
-- ## One rule, read through rather than rewritten
--
-- "May this person see this family's fees" is decided in exactly one place:
-- the `invoice_read` policy. Nothing here restates it. Each policy below asks
-- only whether the row hangs off an invoice the caller can see, and lets
-- row-level security on `invoice` answer:
--
--   invoice_line        → its invoice
--   payment_allocation  → its invoice
--   payment             → an allocation the caller can see
--   receipt             → a payment the caller can see
--
-- So a guardian whose `can_view_finance` is switched off, or whose link has
-- ended, loses the receipts in the same statement that loses them the
-- invoice — there is no second list of conditions to keep in step.
--
-- The chain runs one way (receipt → payment → allocation → invoice →
-- enrollment / student / guardian_link). `invoice_read` reads nothing in
-- billing, so there is no cycle of the kind 0069 had to break.
--
-- ## What this deliberately widens, said out loud
--
-- * A second guardian with finance access now sees a payment the first
--   guardian made, including the columns on `payment` that describe the
--   instrument. The API reads only the method; a column-level split is the
--   follow-up if a query ever needs more.
-- * A payment allocated across invoices of two different families (one cheque
--   for two cousins) is visible to both, whole. The receipt page shows each
--   family only the share allocated to its own invoice.
--
-- Staff are untouched: the finance policies from 0029 are separate permissive
-- policies and still apply. A teacher is staff and not finance, sees no
-- invoice, and therefore sees none of these either.

CREATE POLICY invoice_line_family_read ON invoice_line
  FOR SELECT TO paathshala_app
  USING (
    tenant_id = app_current_tenant_id()
    AND EXISTS (SELECT 1 FROM invoice i WHERE i.id = invoice_line.invoice_id)
  );

CREATE POLICY payment_allocation_family_read ON payment_allocation
  FOR SELECT TO paathshala_app
  USING (
    tenant_id = app_current_tenant_id()
    AND EXISTS (SELECT 1 FROM invoice i WHERE i.id = payment_allocation.invoice_id)
  );

DROP POLICY payment_read ON payment;
CREATE POLICY payment_read ON payment
  FOR SELECT TO paathshala_app
  USING (
    tenant_id = app_current_tenant_id()
    AND (
      app_actor_has_finance_scope()
      OR payer_person_id = app_current_person_id()
      OR EXISTS (
        SELECT 1 FROM payment_allocation pa WHERE pa.payment_id = payment.id
      )
    )
  );

DROP POLICY receipt_read ON receipt;
CREATE POLICY receipt_read ON receipt
  FOR SELECT TO paathshala_app
  USING (
    tenant_id = app_current_tenant_id()
    AND (
      app_actor_has_finance_scope()
      -- Was "a payment I made". Now "a payment I can see", which is that and
      -- the payments against my child's invoices.
      OR EXISTS (SELECT 1 FROM payment p WHERE p.id = receipt.payment_id)
    )
  );
