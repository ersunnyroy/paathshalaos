-- 0033: tenant isolation for assessment and results.
--
-- The asymmetry that matters here: a learner and their guardian may read a
-- PUBLISHED result and nothing else. An unpublished run is a draft full of
-- numbers that are still being checked, and a parent who sees one — through an
-- API, an export, or a stray query — has seen a grade the school has not yet
-- stood behind. That is not a privacy nicety; it is the difference between a
-- reviewed result and a rumour.
--
-- Same recursion-avoidance as 0012, 0020 and 0023: these policies read
-- `enrollment`, `student` and `guardian_link`, whose own policies read
-- `tenant_principal` and never read back into assessment.

GRANT SELECT, INSERT, UPDATE, DELETE ON
  grading_scale, grade_band, assessment, mark, mark_correction,
  result_run, result_line, report_card_template, report_card
  TO paathshala_app;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['grading_scale','grade_band','assessment','mark',
                           'mark_correction','result_run','result_line',
                           'report_card_template','report_card']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END;
$$;

-- ---------------------------------------------------------------------------
-- Structure: readable across the tenant, written by staff.
-- ---------------------------------------------------------------------------
-- Grading scales and templates are policy documents, not personal data. A
-- guardian being able to read the scale their child is graded on is a feature:
-- "what does a B+ mean here" should not require a phone call.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['grading_scale','grade_band','assessment',
                           'report_card_template']
  LOOP
    EXECUTE format($f$
      CREATE POLICY structure_read ON %I
        FOR SELECT TO paathshala_app
        USING (tenant_id = app_current_tenant_id())
    $f$, t);
    EXECUTE format($f$
      CREATE POLICY structure_staff_write ON %I
        FOR ALL TO paathshala_app
        USING (tenant_id = app_current_tenant_id() AND app_actor_has_staff_scope())
        WITH CHECK (tenant_id = app_current_tenant_id() AND app_actor_has_staff_scope())
    $f$, t);
  END LOOP;
END;
$$;

-- ---------------------------------------------------------------------------
-- Marks
-- ---------------------------------------------------------------------------
-- A raw mark is staff-only. Families see results, which are reviewed; a mark is
-- a working number that may still be corrected, and showing it live turns every
-- data-entry slip into a complaint before anybody has noticed it.
CREATE POLICY mark_staff_only ON mark
  FOR ALL TO paathshala_app
  USING (tenant_id = app_current_tenant_id() AND app_actor_has_staff_scope())
  WITH CHECK (tenant_id = app_current_tenant_id() AND app_actor_has_staff_scope());

CREATE POLICY mark_correction_staff_only ON mark_correction
  FOR ALL TO paathshala_app
  USING (tenant_id = app_current_tenant_id() AND app_actor_has_staff_scope())
  WITH CHECK (tenant_id = app_current_tenant_id() AND app_actor_has_staff_scope());

-- ---------------------------------------------------------------------------
-- Results
-- ---------------------------------------------------------------------------
CREATE POLICY result_run_staff ON result_run
  FOR ALL TO paathshala_app
  USING (tenant_id = app_current_tenant_id() AND app_actor_has_staff_scope())
  WITH CHECK (tenant_id = app_current_tenant_id() AND app_actor_has_staff_scope());

-- A learner or linked guardian reads a line ONLY from a published run, and a
-- guardian only with can_view_academics on the link — the same capability that
-- gates academics in 0012, so a guardian's view is consistent across the
-- product rather than per-feature.
CREATE POLICY result_line_read ON result_line
  FOR SELECT TO paathshala_app
  USING (
    tenant_id = app_current_tenant_id()
    AND (
      app_actor_has_staff_scope()
      OR (
        EXISTS (SELECT 1 FROM result_run r
                 WHERE r.id = result_line.result_run_id AND r.status = 'published')
        AND (
          EXISTS (
            SELECT 1 FROM enrollment e JOIN student s ON s.id = e.student_id
             WHERE e.id = result_line.enrollment_id
               AND s.person_id = app_current_person_id()
          )
          OR EXISTS (
            SELECT 1 FROM enrollment e JOIN guardian_link gl ON gl.student_id = e.student_id
             WHERE e.id = result_line.enrollment_id
               AND gl.guardian_person_id = app_current_person_id()
               AND gl.effective_to IS NULL
               AND gl.can_view_academics
          )
        )
      )
    )
  );

CREATE POLICY result_line_staff_write ON result_line
  FOR ALL TO paathshala_app
  USING (tenant_id = app_current_tenant_id() AND app_actor_has_staff_scope())
  WITH CHECK (tenant_id = app_current_tenant_id() AND app_actor_has_staff_scope());

-- A report card follows the same rule, plus one more: a SUPERSEDED card stays
-- readable to the family. They were sent it; pretending it never existed is
-- worse than the correction.
CREATE POLICY report_card_read ON report_card
  FOR SELECT TO paathshala_app
  USING (
    tenant_id = app_current_tenant_id()
    AND (
      app_actor_has_staff_scope()
      OR (
        status IN ('published', 'superseded')
        AND (
          EXISTS (
            SELECT 1 FROM enrollment e JOIN student s ON s.id = e.student_id
             WHERE e.id = report_card.enrollment_id
               AND s.person_id = app_current_person_id()
          )
          OR EXISTS (
            SELECT 1 FROM enrollment e JOIN guardian_link gl ON gl.student_id = e.student_id
             WHERE e.id = report_card.enrollment_id
               AND gl.guardian_person_id = app_current_person_id()
               AND gl.effective_to IS NULL
               AND gl.can_view_academics
          )
        )
      )
    )
  );

CREATE POLICY report_card_staff_write ON report_card
  FOR ALL TO paathshala_app
  USING (tenant_id = app_current_tenant_id() AND app_actor_has_staff_scope())
  WITH CHECK (tenant_id = app_current_tenant_id() AND app_actor_has_staff_scope());
