-- 0023: tenant isolation for attendance.
--
-- Staff write. Learners and their linked guardians read their own — the guardian
-- app's most-opened screen is "was my child in school today", and a parent who
-- cannot see it will phone the office instead.
--
-- Same recursion-avoidance as 0012 and 0020: these policies read `enrollment`,
-- `student` and `guardian_link`, whose policies read `tenant_principal` and
-- never read back into attendance.

GRANT SELECT, INSERT, UPDATE, DELETE ON
  attendance_session, attendance_record, attendance_correction, leave_request
  TO paathshala_app;

ALTER TABLE attendance_session    ENABLE ROW LEVEL SECURITY;
ALTER TABLE attendance_session    FORCE  ROW LEVEL SECURITY;
ALTER TABLE attendance_record     ENABLE ROW LEVEL SECURITY;
ALTER TABLE attendance_record     FORCE  ROW LEVEL SECURITY;
ALTER TABLE attendance_correction ENABLE ROW LEVEL SECURITY;
ALTER TABLE attendance_correction FORCE  ROW LEVEL SECURITY;
ALTER TABLE leave_request         ENABLE ROW LEVEL SECURITY;
ALTER TABLE leave_request         FORCE  ROW LEVEL SECURITY;

-- Sessions are structure, readable by anyone in the tenant, written by staff.
CREATE POLICY session_read ON attendance_session
  FOR SELECT TO paathshala_app
  USING (tenant_id = app_current_tenant_id());
CREATE POLICY session_staff_insert ON attendance_session
  FOR INSERT TO paathshala_app
  WITH CHECK (tenant_id = app_current_tenant_id() AND app_actor_has_staff_scope());
CREATE POLICY session_staff_update ON attendance_session
  FOR UPDATE TO paathshala_app
  USING (tenant_id = app_current_tenant_id() AND app_actor_has_staff_scope())
  WITH CHECK (tenant_id = app_current_tenant_id() AND app_actor_has_staff_scope());
CREATE POLICY session_staff_delete ON attendance_session
  FOR DELETE TO paathshala_app
  USING (tenant_id = app_current_tenant_id() AND app_actor_has_staff_scope());

-- A record is visible to staff, to the learner, and to a linked guardian.
CREATE POLICY record_read ON attendance_record
  FOR SELECT TO paathshala_app
  USING (
    tenant_id = app_current_tenant_id()
    AND (
      app_actor_has_staff_scope()
      OR EXISTS (
        SELECT 1 FROM enrollment e JOIN student s ON s.id = e.student_id
         WHERE e.id = attendance_record.enrollment_id
           AND s.person_id = app_current_person_id()
      )
      OR EXISTS (
        SELECT 1 FROM enrollment e JOIN guardian_link gl ON gl.student_id = e.student_id
         WHERE e.id = attendance_record.enrollment_id
           AND gl.guardian_person_id = app_current_person_id()
           AND gl.effective_to IS NULL
      )
    )
  );
CREATE POLICY record_staff_insert ON attendance_record
  FOR INSERT TO paathshala_app
  WITH CHECK (tenant_id = app_current_tenant_id() AND app_actor_has_staff_scope());
CREATE POLICY record_staff_update ON attendance_record
  FOR UPDATE TO paathshala_app
  USING (tenant_id = app_current_tenant_id() AND app_actor_has_staff_scope())
  WITH CHECK (tenant_id = app_current_tenant_id() AND app_actor_has_staff_scope());
CREATE POLICY record_staff_delete ON attendance_record
  FOR DELETE TO paathshala_app
  USING (tenant_id = app_current_tenant_id() AND app_actor_has_staff_scope());

CREATE POLICY correction_staff_only ON attendance_correction
  FOR ALL TO paathshala_app
  USING (tenant_id = app_current_tenant_id() AND app_actor_has_staff_scope())
  WITH CHECK (tenant_id = app_current_tenant_id() AND app_actor_has_staff_scope());

-- A guardian raises leave for a linked learner and reads its outcome, which is
-- the whole point of the feature.
CREATE POLICY leave_read ON leave_request
  FOR SELECT TO paathshala_app
  USING (
    tenant_id = app_current_tenant_id()
    AND (
      app_actor_has_staff_scope()
      OR EXISTS (
        SELECT 1 FROM student s
         WHERE s.id = leave_request.student_id AND s.person_id = app_current_person_id()
      )
      OR EXISTS (
        SELECT 1 FROM guardian_link gl
         WHERE gl.student_id = leave_request.student_id
           AND gl.guardian_person_id = app_current_person_id()
           AND gl.effective_to IS NULL
      )
    )
  );
CREATE POLICY leave_insert ON leave_request
  FOR INSERT TO paathshala_app
  WITH CHECK (
    tenant_id = app_current_tenant_id()
    AND (
      app_actor_has_staff_scope()
      OR EXISTS (
        SELECT 1 FROM guardian_link gl
         WHERE gl.student_id = leave_request.student_id
           AND gl.guardian_person_id = app_current_person_id()
           AND gl.effective_to IS NULL
      )
    )
  );
-- Deciding is staff only: a guardian approving their own request would make the
-- workflow decorative.
CREATE POLICY leave_staff_update ON leave_request
  FOR UPDATE TO paathshala_app
  USING (tenant_id = app_current_tenant_id() AND app_actor_has_staff_scope())
  WITH CHECK (tenant_id = app_current_tenant_id() AND app_actor_has_staff_scope());
