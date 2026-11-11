-- 0067 — corrects a visibility hole introduced by 0066.
--
-- What 0066 shipped:
--
--     SELECT app_student_visible(p_student_id, app_current_person_id())
--
-- The second parameter of app_student_visible is the STUDENT's person_id. It
-- exists so the function's "or the learner themselves" branch can compare it to
-- the caller:
--
--     OR p_student_person_id = app_current_person_id()      -- 0049, line 34
--
-- Passing the CALLER's person id makes that branch read
-- `app_current_person_id() = app_current_person_id()`, which is true for every
-- caller who has a person row at all. So app_may_see_transport returned true
-- unconditionally, and every policy built on it — the manifest, the boarding
-- record — was open to any guardian, any teacher, any former driver, for any
-- child in the school.
--
-- The tests caught it on their first run, which is the only good part of this
-- story. It is written up here rather than quietly patched because the shape of
-- the mistake matters more than the mistake: a two-argument predicate whose
-- second argument is derivable from the first is a trap, and it was always going
-- to be sprung by whoever called it next.
--
-- So the correction is not only "pass the right id". It removes the trap:
-- app_student_visible(uuid) resolves the learner's person itself, and nothing
-- new is ever asked to supply it. The two-argument form stays, because the
-- policies on `student` in 0049 already hold the row and passing the column they
-- have beats a sub-select per row on the hot path.

CREATE OR REPLACE FUNCTION app_student_visible(p_student_id uuid)
RETURNS boolean
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT app_student_visible(
    p_student_id,
    (SELECT s.person_id FROM student s
      WHERE s.id = p_student_id
        AND s.tenant_id = app_current_tenant_id()))
$$;

REVOKE ALL ON FUNCTION app_student_visible(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_student_visible(uuid) TO paathshala_app, paathshala_health;

COMMENT ON FUNCTION app_student_visible(uuid) IS
  'Prefer this over the two-argument form everywhere except the policies on '
  'student itself, which already hold person_id. 0066 passed the caller''s '
  'person id where the learner''s was expected and opened every transport row '
  'in the school; this form makes that mistake unavailable.';

CREATE OR REPLACE FUNCTION app_may_see_transport(p_student_id uuid)
RETURNS boolean
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT app_student_visible(p_student_id)
      OR EXISTS (
        SELECT 1 FROM transport_enrolment te
         WHERE te.student_id = p_student_id
           AND te.tenant_id = app_current_tenant_id()
           AND te.effective_to IS NULL
           AND app_drives_route(te.route_id))
$$;

-- ---------------------------------------------------------------------------
-- The other half: a driver has to be able to READ the children they carry.
-- ---------------------------------------------------------------------------
--
-- The manifest joins transport_enrolment to student, person and contact_method.
-- A driver passes the policy on transport_enrolment and fails the policies on
-- all three of those, so the corrected rule above would hand the driver of the
-- route an empty list — the one person the document exists for.
--
-- The tempting fix is to add a driver branch to the policies on student, person
-- and contact_method. That is the wrong trade: it would give a driver a general
-- read over learner records — date of birth, medical note, address, fee status —
-- because row-level security grants rows, not fields, and the manifest needs
-- five columns.
--
-- So the manifest is a document, not a query. This function returns exactly the
-- fields a run needs, checks the caller's authority once at the top, and never
-- widens anybody's reach over the underlying tables.
CREATE OR REPLACE FUNCTION app_route_manifest(
  p_route_id uuid, p_direction text, p_on date DEFAULT NULL)
RETURNS TABLE (
  student_id uuid, admission_no text, given_name text, family_name text,
  stop_id uuid, stop_name text, sequence_no integer,
  pickup_time text, drop_time text, guardian_phone text, boarded_today text)
LANGUAGE plpgsql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- One check, at the door. Everything below runs as the definer, so this line
  -- is the whole authorisation — which is why it is a hard failure rather than
  -- a filter: an empty list would be indistinguishable from an empty bus.
  IF NOT (app_drives_route(p_route_id) OR app_actor_has_whole_school_scope()) THEN
    RAISE EXCEPTION 'not permitted to read this manifest'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN QUERY
  SELECT s.id, s.admission_no, p.given_name, p.family_name,
         rs.id, rs.name, rs.sequence_no,
         rs.pickup_time::text, rs.drop_time::text,
         -- One number, the primary guardian's. A manifest is not a contact
         -- directory: the driver needs somebody to ring in the next thirty
         -- seconds, and a list of six numbers is not that.
         (SELECT cm.value FROM contact_method cm
            JOIN guardian_link gl ON gl.guardian_person_id = cm.person_id
           WHERE gl.student_id = s.id
             AND gl.tenant_id = te.tenant_id
             AND gl.effective_to IS NULL
             AND gl.effective_from <= CURRENT_DATE
             AND gl.can_receive_notifications
             AND cm.kind = 'phone'
             AND cm.deleted_at IS NULL
           ORDER BY gl.is_primary DESC, cm.is_primary DESC, cm.created_at
           LIMIT 1),
         (SELECT be.kind FROM boarding_event be
           WHERE be.student_id = s.id AND be.route_id = te.route_id
             AND be.on_date = COALESCE(p_on, CURRENT_DATE)
             AND be.direction = p_direction
           ORDER BY be.recorded_at DESC LIMIT 1)
    FROM transport_enrolment te
    JOIN student s ON s.id = te.student_id AND s.deleted_at IS NULL
    JOIN person p ON p.id = s.person_id
    JOIN route_stop rs ON rs.id = te.stop_id
   WHERE te.route_id = p_route_id
     AND te.tenant_id = app_current_tenant_id()
     AND te.effective_from <= COALESCE(p_on, CURRENT_DATE)
     AND (te.effective_to IS NULL OR te.effective_to >= COALESCE(p_on, CURRENT_DATE))
     AND te.direction IN (p_direction, 'both')
     AND s.lifecycle_status IN ('enrolled', 'on_leave')
   ORDER BY rs.sequence_no, p.given_name;
END;
$$;

REVOKE ALL ON FUNCTION app_route_manifest(uuid, text, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_route_manifest(uuid, text, date) TO paathshala_app;

COMMENT ON FUNCTION app_route_manifest(uuid, text, date) IS
  'The manifest as a document with a fixed column list, not a query over the '
  'learner tables. A driver gets the five fields a run needs and gains no read '
  'over student, person or contact_method — which row-level security could not '
  'have given them, because it grants rows and the problem here is columns.';
