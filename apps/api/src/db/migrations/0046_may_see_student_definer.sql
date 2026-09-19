-- 0046 — app_may_see_student() recursed through enrollment.
--
-- Found immediately by the M12 tests: "stack depth limit exceeded" on any read
-- of `student` as a teacher.
--
-- The loop, which is only visible once both policies exist:
--
--   student's policy calls app_may_see_student()
--     → which reads enrollment
--       → whose policy allows "the learner themselves", which reads student
--         → whose policy calls app_may_see_student()
--           → ...
--
-- Neither policy is wrong on its own. This is the same recursion limit that
-- shaped the guardian scoping in M3, arriving from a new direction: any two
-- tables whose policies read each other will do it, and the read does not have
-- to be obvious — here it is a branch that exists so a student can see their
-- own enrollment.
--
-- The fix is the one M3 settled on: a helper that does the cross-table lookup
-- runs as its owner, so its internal read is a plain query rather than a policy
-- evaluation. It stays safe because it filters by tenant itself and answers
-- only about the CURRENT actor — it cannot be asked "what can somebody else
-- see".
CREATE OR REPLACE FUNCTION app_may_see_student(p_student_id uuid) RETURNS boolean
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT app_actor_has_whole_school_scope()
      OR EXISTS (
        SELECT 1 FROM enrollment e
         WHERE e.student_id = p_student_id
           AND e.tenant_id = app_current_tenant_id()
           AND e.section_id = ANY (app_actor_section_ids()))
$$;

REVOKE ALL ON FUNCTION app_may_see_student(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_may_see_student(uuid) TO paathshala_app;

COMMENT ON FUNCTION app_may_see_student(uuid) IS
  'Whether the CURRENT actor may see this learner. SECURITY DEFINER to break '
  'the student/enrollment policy cycle; filters by tenant itself and answers '
  'only about the caller.';
