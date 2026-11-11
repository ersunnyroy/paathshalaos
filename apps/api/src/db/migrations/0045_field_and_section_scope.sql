-- 0045 — M3.7 and the teacher's roll, both carried since M3.
--
-- Two boundaries that were written down as intentions and never enforced. They
-- survived ten milestones because neither is a cross-tenant leak: the isolation
-- suite was green throughout, and stays green now. Most real exposure inside a
-- school product is internal.
--
-- ---------------------------------------------------------------------------
-- 1. RESTRICTED columns need their own role
-- ---------------------------------------------------------------------------
--
-- 0011 says of blood_group, medical_note, accommodations and the emergency
-- contacts: "Classified RESTRICTED: readable only with an explicit field
-- grant". Nothing enforced it. Any staff role could read a child's inhaler
-- because any staff role could read the row.
--
-- The enforcement is a column-level grant. The application role keeps every
-- ordinary column and loses these five, so `SELECT *` on `student` — the way
-- this would actually leak, through a debug log or a generic serialiser —
-- raises permission denied instead of writing a medical note into a log
-- aggregator.
--
-- A third role reads them. It is deliberately narrow: it can see those columns
-- and the identity needed to know whose they are, and nothing else. A role that
-- could also read fees would be a worse boundary than none, because it would
-- get used for convenience and quietly become a second application role.

-- The role itself is created by db:bootstrap, not here. Roles are cluster-level
-- objects rather than schema objects, so a CREATE ROLE in a versioned migration
-- fails the moment a second database is created in the same cluster — which is
-- exactly how the packaging test found this, on a scratch database beside the
-- real one. The migration owns what the role may TOUCH; bootstrap owns that it
-- exists and how it authenticates.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'paathshala_health') THEN
    RAISE EXCEPTION
      'Role paathshala_health does not exist. Run db:bootstrap before db:migrate.'
      USING ERRCODE = 'invalid_authorization_specification';
  END IF;
END $$;

-- Revoke first, then grant back everything except the five. Revoking the table
-- and re-granting by column is the only way to express this: a column grant
-- does not override a table-wide one.
REVOKE SELECT ON student FROM paathshala_app;
GRANT SELECT (
  id, tenant_id, person_id, admission_no, lifecycle_status, first_admitted_on,
  created_at, updated_at, deleted_at
) ON student TO paathshala_app;

-- UPDATE is granted per column for the same reason: the office edits an
-- emergency contact through a path that is audited, not by a general update.
REVOKE UPDATE ON student FROM paathshala_app;
GRANT UPDATE (admission_no, lifecycle_status, first_admitted_on, deleted_at)
  ON student TO paathshala_app;

-- The health role. Reads the restricted five plus the keys that identify the
-- learner, and writes them, because somebody has to record the inhaler.
GRANT SELECT (id, tenant_id, person_id, admission_no,
              blood_group, medical_note, accommodations,
              emergency_contact_name, emergency_contact_phone)
  ON student TO paathshala_health;
GRANT UPDATE (blood_group, medical_note, accommodations,
              emergency_contact_name, emergency_contact_phone)
  ON student TO paathshala_health;
-- Enough to resolve a name, and nothing further.
GRANT SELECT (id, tenant_id, given_name, family_name, user_account_id)
  ON person TO paathshala_health;
GRANT SELECT ON role_grant, tenant_principal TO paathshala_health;

-- RLS applies to the health role exactly as it does to the app role: a field
-- grant widens which COLUMNS are visible, never which rows.
CREATE POLICY health_scope ON student
  FOR ALL TO paathshala_health
  USING (tenant_id = app_current_tenant_id() AND app_actor_has_staff_scope())
  WITH CHECK (tenant_id = app_current_tenant_id() AND app_actor_has_staff_scope());

CREATE POLICY health_scope ON person
  FOR SELECT TO paathshala_health
  USING (tenant_id = app_current_tenant_id());

CREATE POLICY health_scope ON role_grant
  FOR SELECT TO paathshala_health
  USING (tenant_id = app_current_tenant_id());

CREATE POLICY health_scope ON tenant_principal
  FOR SELECT TO paathshala_health
  USING (tenant_id = app_current_tenant_id());

COMMENT ON ROLE paathshala_health IS
  'Reads and writes the RESTRICTED columns on student. Holds no privilege on '
  'money, attendance, results or messaging — a role that could reach those '
  'would be used for convenience and stop being a boundary.';

-- ---------------------------------------------------------------------------
-- 2. A teacher's roll is their sections
-- ---------------------------------------------------------------------------
--
-- `app_actor_has_staff_scope()` is true for TEACHER, so every class teacher
-- could list every learner in the school. That is not what a school means by
-- "the teacher can see their class", and it is the kind of access nobody
-- notices until a parent asks why a teacher two years above knows their child's
-- circumstances.
--
-- The office still sees everyone: admitting, billing and reporting are
-- whole-school jobs. So the split is by ROLE, not by a new flag.

-- True for the roles whose work is the whole institute.
CREATE OR REPLACE FUNCTION app_actor_has_whole_school_scope() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN app_current_api_client_id() IS NOT NULL
      THEN cardinality(app_api_client_scopes()) > 0
    ELSE EXISTS (
      SELECT 1 FROM role_grant g
       WHERE g.tenant_id = app_current_tenant_id()
         AND g.user_account_id = app_current_actor_id()
         AND g.revoked_at IS NULL
         AND (g.expires_at IS NULL OR g.expires_at > now())
         AND g.role IN ('ORG_OWNER', 'CAMPUS_ADMIN', 'ADMISSIONS', 'ACCOUNTANT',
                        'SUPPORT_AGENT'))
  END
$$;

COMMENT ON FUNCTION app_actor_has_whole_school_scope() IS
  'Roles whose job is the whole institute. TEACHER and TRANSPORT are staff but '
  'are not whole-school: their reach is computed from what they actually teach '
  'or drive.';

-- The sections a staff member is responsible for: class teacher of the section,
-- named teacher on an offering for its class group, or timetabled into it.
--
-- SECURITY DEFINER because it reads `section`, `course_offering` and
-- `schedule_slot`, whose own policies would otherwise be evaluated inside a
-- policy on `student` — nested evaluation on the hot path, and a recursion risk
-- the moment one of those tables is scoped by section too.
CREATE OR REPLACE FUNCTION app_actor_section_ids() RETURNS uuid[]
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(array_agg(DISTINCT s.id), ARRAY[]::uuid[])
    FROM section s
    LEFT JOIN class_group cg ON cg.id = s.class_group_id
   WHERE s.tenant_id = app_current_tenant_id()
     AND EXISTS (
       SELECT 1 FROM staff st
        WHERE st.tenant_id = s.tenant_id
          AND st.deleted_at IS NULL
          AND st.person_id = app_current_person_id()
          AND (
            s.class_teacher_staff_id = st.id
            OR EXISTS (SELECT 1 FROM course_offering co
                        WHERE co.class_group_id = cg.id
                          AND co.primary_teacher_staff_id = st.id)
            OR EXISTS (SELECT 1 FROM schedule_slot sl
                        WHERE sl.section_id = s.id AND sl.staff_id = st.id)))
$$;

REVOKE ALL ON FUNCTION app_actor_section_ids() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_actor_section_ids() TO paathshala_app;

COMMENT ON FUNCTION app_actor_section_ids() IS
  'Sections this staff member teaches, is class teacher of, or is timetabled '
  'into. Empty for somebody who teaches nothing — closed by default.';

-- True when the actor may see this learner: whole-school role, a section they
-- teach, or their own guardian link.
CREATE OR REPLACE FUNCTION app_may_see_student(p_student_id uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT app_actor_has_whole_school_scope()
      OR EXISTS (
        SELECT 1 FROM enrollment e
         WHERE e.student_id = p_student_id
           AND e.tenant_id = app_current_tenant_id()
           AND e.section_id = ANY (app_actor_section_ids()))
$$;

-- Swap the read policies. Three branches survive untouched — the learner
-- themselves, their guardians, and the office — and only the staff branch
-- narrows. `effective_to IS NULL` is how a guardian link records that it is
-- still in force; there is no revoked_at on that table.
DROP POLICY guardian_scope ON student;

CREATE POLICY section_or_guardian ON student
  FOR ALL TO paathshala_app
  USING (
    tenant_id = app_current_tenant_id()
    AND (app_may_see_student(id)
         OR person_id = app_current_person_id()
         OR EXISTS (SELECT 1 FROM guardian_link gl
                     WHERE gl.student_id = student.id
                       AND gl.guardian_person_id = app_current_person_id()
                       AND gl.effective_to IS NULL
                       AND gl.effective_from <= CURRENT_DATE)))
  WITH CHECK (
    tenant_id = app_current_tenant_id()
    -- Creating or editing a learner record is an office job. A teacher marking
    -- a register has no reason to write one, and an accidental grant here would
    -- be the widest of the three.
    AND app_actor_has_whole_school_scope());

-- And the same on enrollment, because a policy on `student` alone is walked
-- around by reading enrollment and joining back — which is what every report
-- query does.
DROP POLICY enrollment_read ON enrollment;

CREATE POLICY enrollment_read ON enrollment
  FOR SELECT TO paathshala_app
  USING (
    tenant_id = app_current_tenant_id()
    AND (app_actor_has_whole_school_scope()
         OR section_id = ANY (app_actor_section_ids())
         OR EXISTS (SELECT 1 FROM student s
                     WHERE s.id = enrollment.student_id
                       AND s.person_id = app_current_person_id())
         OR EXISTS (SELECT 1 FROM guardian_link gl
                     WHERE gl.student_id = enrollment.student_id
                       AND gl.guardian_person_id = app_current_person_id()
                       AND gl.effective_to IS NULL)));

-- Enrolling, transferring and withdrawing are office work too. These policies
-- previously accepted any staff scope, so a class teacher could have moved a
-- learner between sections.
DO $$
DECLARE p record;
BEGIN
  FOR p IN SELECT policyname, cmd FROM pg_policies
            WHERE tablename = 'enrollment'
              AND policyname IN ('enrollment_staff_insert', 'enrollment_staff_update',
                                 'enrollment_staff_delete')
  LOOP
    EXECUTE format('DROP POLICY %I ON enrollment', p.policyname);
  END LOOP;
END $$;

CREATE POLICY enrollment_office_insert ON enrollment
  FOR INSERT TO paathshala_app
  WITH CHECK (tenant_id = app_current_tenant_id() AND app_actor_has_whole_school_scope());
CREATE POLICY enrollment_office_update ON enrollment
  FOR UPDATE TO paathshala_app
  USING (tenant_id = app_current_tenant_id() AND app_actor_has_whole_school_scope())
  WITH CHECK (tenant_id = app_current_tenant_id() AND app_actor_has_whole_school_scope());
CREATE POLICY enrollment_office_delete ON enrollment
  FOR DELETE TO paathshala_app
  USING (tenant_id = app_current_tenant_id() AND app_actor_has_whole_school_scope());
