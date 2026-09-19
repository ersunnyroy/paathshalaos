-- 0048 — the health role could not evaluate the query it exists for.
--
-- Two misses, both the same shape: a column privilege covers every column the
-- query MENTIONS, not only the ones it returns.
--
--   `deleted_at` appears in the WHERE clause of the sensitive read. It is not
--   in the result, so it was not in the grant, and the whole statement was
--   refused.
--
--   `guardian_link` is read by the visibility rule — staff, or a guardian whose
--   link carries can_view_academics. Without SELECT on it the rule cannot be
--   evaluated at all.
--
-- The grant stays column-scoped rather than becoming a table grant. A guardian
-- link carries relationship and custody notes that the health role has no
-- business reading; it needs to know that a link exists and what it permits.
GRANT SELECT (deleted_at) ON student TO paathshala_health;

GRANT SELECT (id, tenant_id, student_id, guardian_person_id,
              effective_from, effective_to,
              can_view_academics, can_view_finance)
  ON guardian_link TO paathshala_health;

CREATE POLICY health_scope ON guardian_link
  FOR SELECT TO paathshala_health
  USING (tenant_id = app_current_tenant_id());

GRANT EXECUTE ON FUNCTION app_current_person_id() TO paathshala_health;
GRANT EXECUTE ON FUNCTION app_actor_has_staff_scope() TO paathshala_health;
GRANT EXECUTE ON FUNCTION app_actor_has_whole_school_scope() TO paathshala_health;
