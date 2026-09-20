-- 0069 — corrects 0068, which made result_run unreadable to everyone.
--
-- 0068 gave `result_run` a family read policy that asks "is there a
-- `result_line` in this run belonging to my child". `result_line`'s own policy
-- asks "is the `result_run` behind this line published". Each policy needs the
-- other evaluated first, and Postgres answers:
--
--     infinite recursion detected in policy for relation "result_line"
--
-- Not a family-only failure. The recursion is in the policy pair, so it fires
-- for any read of either table that reaches the other — the office's results
-- screen included. A migration that opened one door and jammed every other one.
--
-- The fix is the one this schema has used since 0045: the branch that reads
-- another policied table moves into a SECURITY DEFINER function with a pinned
-- search_path. Inside it, `result_line` is read as the definer, so no policy is
-- evaluated and there is nothing to recurse into. The function is the ONLY
-- place that shortcut exists, it takes a run id and returns a boolean, and it
-- answers exactly the question `result_line_read` answers — deliberately, so
-- the two cannot drift into disagreeing about which family may see what.

CREATE OR REPLACE FUNCTION app_family_in_result_run(p_run_id uuid)
RETURNS boolean
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM result_line l
      JOIN enrollment e ON e.id = l.enrollment_id
     WHERE l.result_run_id = p_run_id
       AND l.tenant_id = app_current_tenant_id()
       AND (
         EXISTS (SELECT 1 FROM student s
                  WHERE s.id = e.student_id
                    AND s.person_id = app_current_person_id())
         OR EXISTS (SELECT 1 FROM guardian_link gl
                     WHERE gl.student_id = e.student_id
                       AND gl.guardian_person_id = app_current_person_id()
                       AND gl.effective_to IS NULL
                       AND gl.can_view_academics)))
$$;

REVOKE ALL ON FUNCTION app_family_in_result_run(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_family_in_result_run(uuid) TO paathshala_app;

COMMENT ON FUNCTION app_family_in_result_run(uuid) IS
  'Reads result_line as the definer so result_run''s family policy does not '
  'recurse into result_line''s policy, which reads result_run. Asks exactly '
  'what result_line_read asks, so the two cannot drift.';

DROP POLICY result_run_family_read ON result_run;
CREATE POLICY result_run_family_read ON result_run
  FOR SELECT TO paathshala_app
  USING (
    tenant_id = app_current_tenant_id()
    AND status = 'published'
    AND app_family_in_result_run(id));

COMMENT ON POLICY result_run_family_read ON result_run IS
  'Published runs only, and only where this family has a child with a line in '
  'them. The membership test is a SECURITY DEFINER function because the direct '
  'form recursed with result_line''s own policy — see 0069.';
