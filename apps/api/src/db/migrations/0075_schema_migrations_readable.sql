-- 0075 — the boot check can read which migrations are applied.
--
-- `assert_schema_matches_code` compares the migrations a build ships with the
-- ones the database has. It runs on the platform pool, which has no grant on
-- `schema_migration` — the same wall 0070 hit for the backlog counts, and for
-- the same good reason: that role's grants are a short list and every addition
-- to it is reviewed.
--
-- So the same answer. A function returning what the check needs, rather than
-- the table. What it returns is schema metadata — file names and hashes of
-- text that is in the repository — so it discloses nothing about any school;
-- the restriction exists to keep the role's grant list short, not because the
-- rows are secret.
--
-- The first version of the check queried the table directly and carried a
-- comment saying it went through a function "so the application role still
-- needs no grant". The comment was describing this migration, which did not
-- exist yet. Writing the comment first and the code second is how a file ends
-- up documenting an intention rather than a behaviour.

CREATE OR REPLACE FUNCTION app_schema_migrations()
RETURNS TABLE (name text, checksum text)
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT name, checksum FROM schema_migration ORDER BY name
$$;

REVOKE ALL ON FUNCTION app_schema_migrations() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_schema_migrations() TO paathshala_platform;

COMMENT ON FUNCTION app_schema_migrations() IS
  'For the boot check that refuses to serve traffic against a schema this '
  'build does not understand. File names and hashes of text that is in the '
  'repository — no school''s data passes through here.';
