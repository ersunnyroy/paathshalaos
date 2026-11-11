-- 0020: tenant isolation for admissions, enrollment and files.
--
-- Staff-only throughout, with one exception: a learner and their linked
-- guardians may read that learner's own enrollment, because the guardian app
-- shows "Aarav, Class XI-A, roll 14". Applications and leads are staff-only
-- even for the applicant — an applicant is not yet a principal in the tenant,
-- and the admissions pipeline carries internal notes and scores.

GRANT SELECT, INSERT, UPDATE, DELETE ON
  file, form_definition, form_submission, lead, enquiry, application,
  application_document, admission_decision, enrollment, enrollment_event, subject_election
  TO paathshala_app;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['file','form_definition','form_submission','lead','enquiry',
                           'application','application_document','admission_decision',
                           'enrollment_event','subject_election']
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

ALTER TABLE enrollment ENABLE ROW LEVEL SECURITY;
ALTER TABLE enrollment FORCE  ROW LEVEL SECURITY;

-- Readable by staff, by the learner, and by a linked guardian. Mirrors the
-- `student` policy from 0012 and stays out of the recursion the same way: it
-- reads `student` and `guardian_link`, whose policies read `tenant_principal`
-- and never `enrollment`.
CREATE POLICY enrollment_read ON enrollment
  FOR SELECT TO paathshala_app
  USING (
    tenant_id = app_current_tenant_id()
    AND (
      app_actor_has_staff_scope()
      OR EXISTS (
        SELECT 1 FROM student s
         WHERE s.id = enrollment.student_id
           AND s.person_id = app_current_person_id()
      )
      OR EXISTS (
        SELECT 1 FROM guardian_link gl
         WHERE gl.student_id = enrollment.student_id
           AND gl.guardian_person_id = app_current_person_id()
           AND gl.effective_to IS NULL
      )
    )
  );

CREATE POLICY enrollment_staff_insert ON enrollment
  FOR INSERT TO paathshala_app
  WITH CHECK (tenant_id = app_current_tenant_id() AND app_actor_has_staff_scope());

CREATE POLICY enrollment_staff_update ON enrollment
  FOR UPDATE TO paathshala_app
  USING (tenant_id = app_current_tenant_id() AND app_actor_has_staff_scope())
  WITH CHECK (tenant_id = app_current_tenant_id() AND app_actor_has_staff_scope());

CREATE POLICY enrollment_staff_delete ON enrollment
  FOR DELETE TO paathshala_app
  USING (tenant_id = app_current_tenant_id() AND app_actor_has_staff_scope());
