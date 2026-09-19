-- 0049 — two policies expressing the same intent had already diverged.
--
-- 0045 put "who may see this learner" on `student` for the app role, and 0045
-- put a narrower version on `student` for the health role. Within three
-- migrations they disagreed: a guardian reading their own child's medical note
-- got nothing, because the health policy asked for staff scope and a parent is
-- not staff.
--
-- That is not a typo, it is the predictable result of writing one rule twice.
-- So it becomes a function, used by both policies, and the two cannot drift
-- again without someone editing the thing they share.
--
-- SECURITY DEFINER for the same reason as its neighbours: it reads `enrollment`
-- and `guardian_link`, whose own policies would otherwise evaluate inside a
-- policy on `student` — nested evaluation on the hot path, and the cycle that
-- 0046 already had to break once.
CREATE OR REPLACE FUNCTION app_student_visible(
  p_student_id uuid, p_student_person_id uuid
) RETURNS boolean
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT
    -- The office, and every role whose job is the whole institute.
    app_actor_has_whole_school_scope()
    -- A teacher, for the sections they actually teach.
    OR EXISTS (
      SELECT 1 FROM enrollment e
       WHERE e.student_id = p_student_id
         AND e.tenant_id = app_current_tenant_id()
         AND e.section_id = ANY (app_actor_section_ids()))
    -- The learner themselves.
    OR p_student_person_id = app_current_person_id()
    -- A guardian with a link that is in force today.
    OR EXISTS (
      SELECT 1 FROM guardian_link gl
       WHERE gl.student_id = p_student_id
         AND gl.tenant_id = app_current_tenant_id()
         AND gl.guardian_person_id = app_current_person_id()
         AND gl.effective_to IS NULL
         AND gl.effective_from <= CURRENT_DATE)
$$;

REVOKE ALL ON FUNCTION app_student_visible(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_student_visible(uuid, uuid)
  TO paathshala_app, paathshala_health;

COMMENT ON FUNCTION app_student_visible(uuid, uuid) IS
  'The single rule for who may see a learner. Both the app role''s policy and '
  'the health role''s policy call it, so the two cannot diverge — which they '
  'did, within three migrations of being written separately.';

DROP POLICY section_or_guardian ON student;
CREATE POLICY section_or_guardian ON student
  FOR ALL TO paathshala_app
  USING (tenant_id = app_current_tenant_id() AND app_student_visible(id, person_id))
  WITH CHECK (tenant_id = app_current_tenant_id() AND app_actor_has_whole_school_scope());

DROP POLICY health_scope ON student;
CREATE POLICY health_scope ON student
  FOR ALL TO paathshala_health
  USING (tenant_id = app_current_tenant_id() AND app_student_visible(id, person_id))
  -- Writing a medical note is a narrower act than reading one: the office and
  -- the nurse record it, a parent does not edit it in place.
  WITH CHECK (tenant_id = app_current_tenant_id() AND app_actor_has_whole_school_scope());

-- app_may_see_student() is now only the teacher half of the rule, which is all
-- `enrollment` needs. Kept rather than folded in, because enrollment asks the
-- question about a SECTION and student asks it about a ROW.
COMMENT ON FUNCTION app_may_see_student(uuid) IS
  'Whole-school scope, or a section the actor teaches. The guardian and '
  'self branches live in app_student_visible(), which is what policies on '
  'student use.';
