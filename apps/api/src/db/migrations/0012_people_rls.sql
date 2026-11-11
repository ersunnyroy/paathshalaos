-- 0012: AC-4. A guardian sees only their linked learners, enforced by the
-- database rather than by the query the developer remembered to write.
--
-- The design constraint that shapes everything below: a policy expression may
-- not read the table it protects, or any table whose policy reads back. Postgres
-- raises "infinite recursion detected in policy for relation". So the actor's
-- person id cannot be resolved by selecting from `person` inside `person`'s own
-- policy, and `guardian_link`'s policy cannot join `student` while `student`'s
-- policy reads `guardian_link`.
--
-- Two things make it work:
--
--   tenant_principal   a trigger-maintained projection of (tenant, login) ->
--                      person, so the actor's person id is one non-recursive
--                      lookup away.
--   staff scope        derived from role_grant, NOT from a flag the caller
--                      sets. A caller-supplied "I am a guardian" flag would
--                      fail OPEN when a code path forgot to set it; deriving
--                      the positive staff capability from stored grants means
--                      an unknown actor gets nothing.

CREATE TABLE tenant_principal (
  tenant_id        uuid NOT NULL REFERENCES organization (id),
  user_account_id  uuid NOT NULL REFERENCES user_account (id) ON DELETE CASCADE,
  person_id        uuid NOT NULL REFERENCES person (id) ON DELETE CASCADE,
  PRIMARY KEY (tenant_id, user_account_id)
);

CREATE INDEX tenant_principal_person_idx ON tenant_principal (tenant_id, person_id);

-- Kept in step by a trigger rather than by application code, so a person
-- created by an import, a migration or a future module cannot drift out of sync.
CREATE OR REPLACE FUNCTION sync_tenant_principal() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM tenant_principal
     WHERE tenant_id = OLD.tenant_id AND person_id = OLD.id;
    RETURN OLD;
  END IF;

  IF OLD IS NOT NULL AND OLD.user_account_id IS NOT NULL
     AND (NEW.user_account_id IS NULL OR NEW.user_account_id <> OLD.user_account_id) THEN
    DELETE FROM tenant_principal
     WHERE tenant_id = OLD.tenant_id AND user_account_id = OLD.user_account_id;
  END IF;

  IF NEW.user_account_id IS NOT NULL AND NEW.deleted_at IS NULL THEN
    INSERT INTO tenant_principal (tenant_id, user_account_id, person_id)
    VALUES (NEW.tenant_id, NEW.user_account_id, NEW.id)
    ON CONFLICT (tenant_id, user_account_id) DO UPDATE SET person_id = EXCLUDED.person_id;
  ELSIF NEW.deleted_at IS NOT NULL THEN
    DELETE FROM tenant_principal
     WHERE tenant_id = NEW.tenant_id AND person_id = NEW.id;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER person_syncs_principal
  AFTER INSERT OR UPDATE OR DELETE ON person
  FOR EACH ROW EXECUTE FUNCTION sync_tenant_principal();

-- Who is acting, as a person in this tenant. NULL when the actor has no person
-- row here, which denies everything downstream.
CREATE OR REPLACE FUNCTION app_current_person_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT person_id FROM tenant_principal
   WHERE tenant_id = app_current_tenant_id()
     AND user_account_id = app_current_actor_id()
$$;

-- True when the actor holds a role that legitimately sees the whole tenant or a
-- campus within it. Derived from grants, so revoking the grant removes the
-- visibility on the next statement.
CREATE OR REPLACE FUNCTION app_actor_has_staff_scope() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM role_grant g
     WHERE g.tenant_id = app_current_tenant_id()
       AND g.user_account_id = app_current_actor_id()
       AND g.revoked_at IS NULL
       AND (g.expires_at IS NULL OR g.expires_at > now())
       AND g.role IN ('ORG_OWNER', 'CAMPUS_ADMIN', 'ADMISSIONS', 'ACCOUNTANT',
                      'TEACHER', 'TRANSPORT', 'SUPPORT_AGENT')
  )
$$;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON person, contact_method, address, staff, student, guardian_link TO paathshala_app;
GRANT SELECT ON tenant_principal TO paathshala_app;

ALTER TABLE person           ENABLE ROW LEVEL SECURITY;
ALTER TABLE person           FORCE  ROW LEVEL SECURITY;
ALTER TABLE contact_method   ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact_method   FORCE  ROW LEVEL SECURITY;
ALTER TABLE address          ENABLE ROW LEVEL SECURITY;
ALTER TABLE address          FORCE  ROW LEVEL SECURITY;
ALTER TABLE staff            ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff            FORCE  ROW LEVEL SECURITY;
ALTER TABLE student          ENABLE ROW LEVEL SECURITY;
ALTER TABLE student          FORCE  ROW LEVEL SECURITY;
ALTER TABLE guardian_link    ENABLE ROW LEVEL SECURITY;
ALTER TABLE guardian_link    FORCE  ROW LEVEL SECURITY;
ALTER TABLE tenant_principal ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_principal FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON tenant_principal
  FOR ALL TO paathshala_app
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

CREATE POLICY tenant_isolation ON staff
  FOR ALL TO paathshala_app
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

CREATE POLICY tenant_isolation ON address
  FOR ALL TO paathshala_app
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

CREATE POLICY tenant_isolation ON contact_method
  FOR ALL TO paathshala_app
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

-- A guardian sees themselves and the guardians of nobody else. This policy
-- deliberately does NOT join `student`, because `student`'s policy reads
-- `guardian_link` and the pair would recurse.
CREATE POLICY guardian_scope ON guardian_link
  FOR ALL TO paathshala_app
  USING (
    tenant_id = app_current_tenant_id()
    AND (app_actor_has_staff_scope() OR guardian_person_id = app_current_person_id())
  )
  WITH CHECK (
    tenant_id = app_current_tenant_id()
    -- Only staff may create or alter a guardian link. A guardian adding their
    -- own link to a learner would be a child-safety hole, so it is refused by
    -- the database and not merely absent from the app.
    AND app_actor_has_staff_scope()
  );

-- The core of AC-4.
CREATE POLICY guardian_scope ON student
  FOR ALL TO paathshala_app
  USING (
    tenant_id = app_current_tenant_id()
    AND (
      app_actor_has_staff_scope()
      -- A learner reads their own record.
      OR person_id = app_current_person_id()
      -- A guardian reads a learner they hold a live link to.
      OR EXISTS (
        SELECT 1 FROM guardian_link gl
         WHERE gl.student_id = student.id
           AND gl.guardian_person_id = app_current_person_id()
           AND gl.effective_to IS NULL
           AND gl.effective_from <= CURRENT_DATE
      )
    )
  )
  WITH CHECK (tenant_id = app_current_tenant_id() AND app_actor_has_staff_scope());

CREATE POLICY guardian_scope ON person
  FOR ALL TO paathshala_app
  USING (
    tenant_id = app_current_tenant_id()
    AND (
      app_actor_has_staff_scope()
      OR id = app_current_person_id()
      -- The person behind a linked learner. Reads `student` and
      -- `guardian_link`, whose own policies read `tenant_principal` and never
      -- `person`, so the chain terminates.
      OR EXISTS (
        SELECT 1
          FROM guardian_link gl
          JOIN student s ON s.id = gl.student_id
         WHERE s.person_id = person.id
           AND gl.guardian_person_id = app_current_person_id()
           AND gl.effective_to IS NULL
      )
    )
  )
  WITH CHECK (tenant_id = app_current_tenant_id() AND app_actor_has_staff_scope());
