-- 0068 — a family can see the result run their child's marks belong to.
--
-- `result_line_read` already lets a guardian read their own child's marks, and
-- only from a run whose status is 'published'. But `result_run` itself is
-- staff-only, so the row that says WHICH TERM those marks are for, and when the
-- school published them, is unreadable to the person the marks are about.
--
-- The effect is a parent app that can show a column of percentages with no
-- heading. That is not a safer product; it is the same information with the
-- context removed, which is how a parent misreads last term's marks as this
-- term's.
--
-- So the run becomes readable — a published one, to a family that has a child
-- in it, and no other. Everything that makes a run sensitive is on
-- `result_line`, which is already scoped child by child: what is added here is
-- a term, a section and a date.
--
-- FOR SELECT deliberately. The existing `result_run_staff` policy stays exactly
-- as it is and remains the only way anybody writes one; permissive policies are
-- OR'd for reads, and a family that can read a run must not thereby be able to
-- publish one.

CREATE POLICY result_run_family_read ON result_run
  FOR SELECT TO paathshala_app
  USING (
    tenant_id = app_current_tenant_id()
    AND status = 'published'
    AND EXISTS (
      SELECT 1
        FROM result_line l
        JOIN enrollment e ON e.id = l.enrollment_id
       WHERE l.result_run_id = result_run.id
         AND l.tenant_id = result_run.tenant_id
         AND (
           -- The learner themselves.
           EXISTS (SELECT 1 FROM student s
                    WHERE s.id = e.student_id
                      AND s.person_id = app_current_person_id())
           -- Or a guardian the school has allowed to see academics. The same
           -- flag result_line_read checks, because a family that may not see
           -- the marks has no business seeing that a run exists for them.
           OR EXISTS (SELECT 1 FROM guardian_link gl
                       WHERE gl.student_id = e.student_id
                         AND gl.guardian_person_id = app_current_person_id()
                         AND gl.effective_to IS NULL
                         AND gl.can_view_academics))));

COMMENT ON POLICY result_run_family_read ON result_run IS
  'Published runs only, and only where this family has a child with a line in '
  'them. Mirrors result_line_read exactly, including can_view_academics: a '
  'family that may not read the marks must not learn that a run exists.';
