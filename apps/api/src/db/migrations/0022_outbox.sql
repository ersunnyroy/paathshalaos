-- 0022: the transactional outbox.
--
-- Domain events are written in the SAME COMMIT as the change they describe, so
-- an event can never describe a state that was rolled back — and conversely, a
-- change can never happen without its event. Publishing from application code
-- after the commit loses events whenever the process dies in between, which is
-- exactly when you most want the notification to go out.
--
-- A relay reads unpublished rows and pushes them onward. Delivery is
-- at-least-once; every consumer dedupes on `id`.

CREATE TABLE outbox_event (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,
  event_type      text NOT NULL,
  aggregate_type  text NOT NULL,
  aggregate_id    uuid,
  schema_version  text NOT NULL DEFAULT '1.0',
  payload         jsonb NOT NULL,
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  published_at    timestamptz,
  attempts        integer NOT NULL DEFAULT 0,
  last_error      text,
  CONSTRAINT outbox_event_payload_is_object CHECK (jsonb_typeof(payload) = 'object')
);

-- The relay's only query. Partial, so it stays small however large the table
-- grows: published rows leave the index entirely.
CREATE INDEX outbox_event_unpublished_idx
  ON outbox_event (occurred_at) WHERE published_at IS NULL;
CREATE INDEX outbox_event_tenant_type_idx ON outbox_event (tenant_id, event_type, occurred_at DESC);

GRANT SELECT, INSERT, UPDATE ON outbox_event TO paathshala_app;

ALTER TABLE outbox_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox_event FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON outbox_event
  FOR ALL TO paathshala_app
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());
