-- 0029 — finance is not "staff".
--
-- 0027's header said "Teachers cannot see finance at all". Its policies said
-- app_actor_has_staff_scope(), which includes TEACHER, TRANSPORT and
-- SUPPORT_AGENT. A test that logged in as a teacher and listed invoices got 7
-- rows. The comment was the intent; this migration is the enforcement.
--
-- Why it matters beyond tidiness: a teacher who knows which families are behind
-- on fees treats those children differently, and the class teacher is exactly
-- the person a parent's arrears should never reach.

CREATE OR REPLACE FUNCTION app_actor_has_finance_scope() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM role_grant g
     WHERE g.tenant_id = app_current_tenant_id()
       AND g.user_account_id = app_current_actor_id()
       AND g.revoked_at IS NULL
       AND (g.expires_at IS NULL OR g.expires_at > now())
       AND g.role IN ('ORG_OWNER', 'CAMPUS_ADMIN', 'ACCOUNTANT')
  )
$$;

COMMENT ON FUNCTION app_actor_has_finance_scope() IS
  'True for roles that may see money. Deliberately narrower than '
  'app_actor_has_staff_scope(): TEACHER, ADMISSIONS, TRANSPORT and '
  'SUPPORT_AGENT are staff but are not finance.';

-- The staff-only tables: swap the predicate in place.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['fee_plan','fee_component','fee_assignment','concession',
                           'installment','invoice_line','payment_attempt','payment_allocation',
                           'refund','waiver','mandate','settlement_batch','settlement_line',
                           'payment_webhook_event','ledger_entry']
  LOOP
    EXECUTE format('DROP POLICY staff_only ON %I', t);
    EXECUTE format($f$
      CREATE POLICY finance_only ON %I
        FOR ALL TO paathshala_app
        USING (tenant_id = app_current_tenant_id() AND app_actor_has_finance_scope())
        WITH CHECK (tenant_id = app_current_tenant_id() AND app_actor_has_finance_scope())
    $f$, t);
  END LOOP;
END;
$$;

-- The three tables a payer also reads: only the staff branch narrows; the
-- learner and guardian branches are untouched.
DROP POLICY invoice_read ON invoice;
CREATE POLICY invoice_read ON invoice
  FOR SELECT TO paathshala_app
  USING (
    tenant_id = app_current_tenant_id()
    AND (
      app_actor_has_finance_scope()
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

DROP POLICY invoice_staff_write ON invoice;
CREATE POLICY invoice_finance_write ON invoice
  FOR ALL TO paathshala_app
  USING (tenant_id = app_current_tenant_id() AND app_actor_has_finance_scope())
  WITH CHECK (tenant_id = app_current_tenant_id() AND app_actor_has_finance_scope());

DROP POLICY payment_read ON payment;
CREATE POLICY payment_read ON payment
  FOR SELECT TO paathshala_app
  USING (
    tenant_id = app_current_tenant_id()
    AND (
      app_actor_has_finance_scope()
      OR payer_person_id = app_current_person_id()
    )
  );

DROP POLICY payment_staff_write ON payment;
CREATE POLICY payment_finance_write ON payment
  FOR ALL TO paathshala_app
  USING (tenant_id = app_current_tenant_id() AND app_actor_has_finance_scope())
  WITH CHECK (tenant_id = app_current_tenant_id() AND app_actor_has_finance_scope());

DROP POLICY receipt_read ON receipt;
CREATE POLICY receipt_read ON receipt
  FOR SELECT TO paathshala_app
  USING (
    tenant_id = app_current_tenant_id()
    AND (
      app_actor_has_finance_scope()
      OR EXISTS (
        SELECT 1 FROM payment p
         WHERE p.id = receipt.payment_id AND p.payer_person_id = app_current_person_id()
      )
    )
  );

DROP POLICY receipt_staff_write ON receipt;
CREATE POLICY receipt_finance_write ON receipt
  FOR ALL TO paathshala_app
  USING (tenant_id = app_current_tenant_id() AND app_actor_has_finance_scope())
  WITH CHECK (tenant_id = app_current_tenant_id() AND app_actor_has_finance_scope());
