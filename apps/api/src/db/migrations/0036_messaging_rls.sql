-- 0036: tenant isolation for messaging.
--
-- Templates are policy documents, readable across the tenant. Everything that
-- records an actual message is staff-only, with ONE exception: a person may see
-- the messages addressed to them. "Why did I get this" and "did you ever tell
-- me" are both questions the recipient is entitled to answer for themselves,
-- and a support call that starts with the parent already knowing what was sent
-- is a much shorter call.
--
-- `communication_preference` is the other exception, and it is a write one: a
-- guardian changes their own preferences. Consent is managed under 0013's
-- policy; this is only the how, not the whether.

GRANT SELECT, INSERT, UPDATE, DELETE ON
  message_template, message_template_version, communication_preference,
  message_request, message_recipient, message_attempt, delivery_receipt,
  whatsapp_session
  TO paathshala_app;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['message_template','message_template_version',
                           'communication_preference','message_request',
                           'message_recipient','message_attempt','delivery_receipt',
                           'whatsapp_session']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END;
$$;

-- Templates: read across the tenant, write by staff.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['message_template','message_template_version']
  LOOP
    EXECUTE format($f$
      CREATE POLICY template_read ON %I
        FOR SELECT TO paathshala_app
        USING (tenant_id = app_current_tenant_id())
    $f$, t);
    EXECUTE format($f$
      CREATE POLICY template_staff_write ON %I
        FOR ALL TO paathshala_app
        USING (tenant_id = app_current_tenant_id() AND app_actor_has_staff_scope())
        WITH CHECK (tenant_id = app_current_tenant_id() AND app_actor_has_staff_scope())
    $f$, t);
  END LOOP;
END;
$$;

-- Dispatch bookkeeping: staff only.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['message_request','message_attempt','delivery_receipt',
                           'whatsapp_session']
  LOOP
    EXECUTE format($f$
      CREATE POLICY staff_only ON %I
        FOR ALL TO paathshala_app
        USING (tenant_id = app_current_tenant_id() AND app_actor_has_staff_scope())
        WITH CHECK (tenant_id = app_current_tenant_id() AND app_actor_has_staff_scope())
    $f$, t);
  END LOOP;
END;
$$;

-- A person reads what was addressed to them — including a SUPPRESSED row, which
-- is the record of a message deliberately not sent and the evidence that
-- withdrawing consent worked.
CREATE POLICY recipient_read ON message_recipient
  FOR SELECT TO paathshala_app
  USING (
    tenant_id = app_current_tenant_id()
    AND (app_actor_has_staff_scope() OR person_id = app_current_person_id())
  );
CREATE POLICY recipient_staff_write ON message_recipient
  FOR ALL TO paathshala_app
  USING (tenant_id = app_current_tenant_id() AND app_actor_has_staff_scope())
  WITH CHECK (tenant_id = app_current_tenant_id() AND app_actor_has_staff_scope());

-- Preferences are the person's own to set.
CREATE POLICY preference_own ON communication_preference
  FOR ALL TO paathshala_app
  USING (
    tenant_id = app_current_tenant_id()
    AND (app_actor_has_staff_scope() OR person_id = app_current_person_id())
  )
  WITH CHECK (
    tenant_id = app_current_tenant_id()
    AND (app_actor_has_staff_scope() OR person_id = app_current_person_id())
  );
