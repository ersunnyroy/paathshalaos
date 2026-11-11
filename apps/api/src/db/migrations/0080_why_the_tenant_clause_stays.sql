-- 0080: a comment, shipped as a migration because 0079 has been applied.
--
-- The checksum guard refuses an edit to a migration that has run, and it is
-- right to: a file whose bytes no longer match what any database was built
-- from is a file nobody can reason about. So a correction — including one that
-- is only a comment — ships as a new migration. This one costs six lines and
-- keeps that rule intact.
--
-- What it records: `app_actor_may_change_school_settings()` filters on
-- `g.tenant_id = app_current_tenant_id()`, and for the application role that
-- predicate can never exclude a row — `role_grant` carries its own tenant
-- policy from 0006, so the function only ever sees this tenant's grants. A
-- mutation pass established that removing the clause fails no test, and that
-- no test could be written that it would fail.
--
-- It stays anyway, for two reasons worth writing down rather than rediscovering:
-- the function is read beside `app_actor_has_staff_scope()`, which carries the
-- same clause, and a function whose correctness depends on its caller's policy
-- is one `SECURITY DEFINER` away from being wrong.

COMMENT ON FUNCTION app_actor_may_change_school_settings() IS
  'True when the actor holds an organisation-wide ORG_OWNER or CAMPUS_ADMIN '
  'grant. Used by the organization write policy; deliberately narrower than '
  'app_actor_has_staff_scope(), which a teacher satisfies. The tenant_id '
  'predicate inside it is redundant for paathshala_app — role_grant has its '
  'own tenant policy — and is kept for symmetry and against a future '
  'SECURITY DEFINER. See migration 0080.';
