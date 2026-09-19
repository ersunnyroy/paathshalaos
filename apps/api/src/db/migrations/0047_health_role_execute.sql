-- 0047 — the health role could not evaluate its own policy.
--
-- `health_scope` on `student` calls app_actor_has_staff_scope(), which since
-- 0040 calls app_api_client_scopes(), whose EXECUTE was granted to
-- paathshala_app alone. So the policy raised "permission denied for function"
-- and the role could read nothing at all.
--
-- Worth noticing how this failed: not as a leak but as a refusal. A role that
-- cannot evaluate its policy reads nothing, which is the right direction for a
-- privilege bug to fall — the same reason app_current_person_id() and friends
-- are written to return NULL rather than to guess.
GRANT EXECUTE ON FUNCTION app_api_client_scopes() TO paathshala_health;
GRANT EXECUTE ON FUNCTION app_actor_section_ids() TO paathshala_health;
GRANT EXECUTE ON FUNCTION app_may_see_student(uuid) TO paathshala_health;
