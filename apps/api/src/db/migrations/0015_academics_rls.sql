-- 0015: tenant isolation for the academic structure.
--
-- Plain tenant scoping, with one addition: the structure is readable by anyone
-- with a foothold in the tenant — a guardian needs to see their child's class
-- name and timetable — but writable only by staff. A guardian who could rename
-- a class or move a lesson would be a strange kind of vandal, and the database
-- should not depend on the UI to stop them.

GRANT SELECT, INSERT, UPDATE, DELETE ON
  programme, term, subject, room, class_group, section, course_offering, schedule_slot
  TO paathshala_app;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['programme','term','subject','room','class_group','section',
                           'course_offering','schedule_slot']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);

    -- Readable within the tenant by any principal who belongs to it.
    EXECUTE format($f$
      CREATE POLICY tenant_read ON %I
        FOR SELECT TO paathshala_app
        USING (tenant_id = app_current_tenant_id())
    $f$, t);

    -- Written only by staff. Separate policies per command, so the read rule and
    -- the write rule are independently reviewable and neither is implicit.
    EXECUTE format($f$
      CREATE POLICY staff_insert ON %I
        FOR INSERT TO paathshala_app
        WITH CHECK (tenant_id = app_current_tenant_id() AND app_actor_has_staff_scope())
    $f$, t);

    EXECUTE format($f$
      CREATE POLICY staff_update ON %I
        FOR UPDATE TO paathshala_app
        USING (tenant_id = app_current_tenant_id() AND app_actor_has_staff_scope())
        WITH CHECK (tenant_id = app_current_tenant_id() AND app_actor_has_staff_scope())
    $f$, t);

    EXECUTE format($f$
      CREATE POLICY staff_delete ON %I
        FOR DELETE TO paathshala_app
        USING (tenant_id = app_current_tenant_id() AND app_actor_has_staff_scope())
    $f$, t);
  END LOOP;
END;
$$;
