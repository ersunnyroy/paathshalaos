-- 0027: tenant isolation for money.
--
-- Accountants and owners write. Teachers cannot see finance at all — a teacher
-- knowing which families are behind on fees changes how they treat a child, and
-- the permission table in authz.service.ts says so too.
--
-- Learners and linked guardians read their OWN invoices, payments and receipts,
-- because paying fees is the guardian app's second-most-used screen after
-- attendance.

GRANT SELECT, INSERT, UPDATE, DELETE ON
  fee_plan, fee_component, fee_assignment, concession, installment,
  invoice, invoice_line, payment, payment_attempt, payment_allocation,
  receipt, refund, waiver, mandate, settlement_batch, settlement_line,
  payment_webhook_event
  TO paathshala_app;

-- The ledger is INSERT and SELECT only. No UPDATE or DELETE privilege exists to
-- be misused, whatever the application code does.
GRANT SELECT, INSERT ON ledger_entry TO paathshala_app;
REVOKE UPDATE, DELETE, TRUNCATE ON ledger_entry FROM PUBLIC, paathshala_app;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['fee_plan','fee_component','fee_assignment','concession',
                           'installment','invoice_line','payment_attempt','payment_allocation',
                           'refund','waiver','mandate','settlement_batch','settlement_line',
                           'payment_webhook_event','ledger_entry']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($f$
      CREATE POLICY staff_only ON %I
        FOR ALL TO paathshala_app
        USING (tenant_id = app_current_tenant_id() AND app_actor_has_staff_scope())
        WITH CHECK (tenant_id = app_current_tenant_id() AND app_actor_has_staff_scope())
    $f$, t);
  END LOOP;
END;
$$;

ALTER TABLE invoice ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice FORCE  ROW LEVEL SECURITY;
ALTER TABLE payment ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment FORCE  ROW LEVEL SECURITY;
ALTER TABLE receipt ENABLE ROW LEVEL SECURITY;
ALTER TABLE receipt FORCE  ROW LEVEL SECURITY;

-- A guardian sees an invoice for a learner they are linked to AND hold
-- can_view_finance for. The capability flag is enforced at the query, exactly as
-- it is for academics in 0012.
CREATE POLICY invoice_read ON invoice
  FOR SELECT TO paathshala_app
  USING (
    tenant_id = app_current_tenant_id()
    AND (
      app_actor_has_staff_scope()
      OR EXISTS (
        SELECT 1 FROM enrollment e JOIN student s ON s.id = e.student_id
         WHERE e.id = invoice.enrollment_id AND s.person_id = app_current_person_id()
      )
      OR EXISTS (
        SELECT 1 FROM enrollment e JOIN guardian_link gl ON gl.student_id = e.student_id
         WHERE e.id = invoice.enrollment_id
           AND gl.guardian_person_id = app_current_person_id()
           AND gl.effective_to IS NULL
           AND gl.can_view_finance
      )
    )
  );
CREATE POLICY invoice_staff_write ON invoice
  FOR ALL TO paathshala_app
  USING (tenant_id = app_current_tenant_id() AND app_actor_has_staff_scope())
  WITH CHECK (tenant_id = app_current_tenant_id() AND app_actor_has_staff_scope());

CREATE POLICY payment_read ON payment
  FOR SELECT TO paathshala_app
  USING (
    tenant_id = app_current_tenant_id()
    AND (
      app_actor_has_staff_scope()
      OR payer_person_id = app_current_person_id()
    )
  );
CREATE POLICY payment_staff_write ON payment
  FOR ALL TO paathshala_app
  USING (tenant_id = app_current_tenant_id() AND app_actor_has_staff_scope())
  WITH CHECK (tenant_id = app_current_tenant_id() AND app_actor_has_staff_scope());

CREATE POLICY receipt_read ON receipt
  FOR SELECT TO paathshala_app
  USING (
    tenant_id = app_current_tenant_id()
    AND (
      app_actor_has_staff_scope()
      OR EXISTS (
        SELECT 1 FROM payment p
         WHERE p.id = receipt.payment_id AND p.payer_person_id = app_current_person_id()
      )
    )
  );
CREATE POLICY receipt_staff_write ON receipt
  FOR ALL TO paathshala_app
  USING (tenant_id = app_current_tenant_id() AND app_actor_has_staff_scope())
  WITH CHECK (tenant_id = app_current_tenant_id() AND app_actor_has_staff_scope());
