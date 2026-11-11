-- 0043: support and onboarding — tickets, knowledge base, guided setup.
--
-- Three design decisions here are load-bearing.
--
--   **A ticket is raised BY a person, and that person can be a parent.** So the
--   policy is not "staff see everything": a guardian sees the tickets they
--   raised and nothing else, in a product where the other tickets are about
--   other people's children. Getting this wrong is not a privacy nicety — the
--   subject line of a support ticket is often the most sensitive free text an
--   institute holds.
--
--   **The conversation is append-only.** A support thread is the record of what
--   was promised, and a system where the last reply can be edited after the fact
--   cannot settle a disagreement about what was promised. Edits are new messages.
--
--   **Guided setup stores no progress.** There is no checklist table with
--   booleans someone ticks. Progress is DERIVED from whether the thing actually
--   exists — a campus, a year, a fee plan, a learner — because a stored tick
--   that says "fees configured" while no fee plan exists is worse than no
--   checklist at all. The cost is a handful of counting queries; the benefit is
--   that the checklist cannot lie.

-- ---------------------------------------------------------------------------
-- Tickets
-- ---------------------------------------------------------------------------

CREATE TABLE support_ticket (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES organization (id),

  -- Human-facing, per tenant, gapless-ish. People quote this number on the
  -- phone; a uuid is not something anyone reads aloud.
  reference     text NOT NULL,

  -- The person who raised it, which is how a guardian's own tickets are found.
  -- NOT the user account: a guardian and a staff member are both people here,
  -- and the policies below already key on person.
  raised_by_person_id uuid NOT NULL REFERENCES person (id),

  subject       text NOT NULL,
  category      text NOT NULL CHECK (category IN (
                  'fees_and_payments', 'attendance', 'results', 'admissions',
                  'app_or_login', 'data_correction', 'other')),
  priority      text NOT NULL DEFAULT 'normal'
                  CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  status        text NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open', 'waiting_on_requester', 'resolved', 'closed')),

  assigned_to_staff_id uuid REFERENCES staff (id),

  -- Two clocks, set at creation from the priority. Stored rather than computed
  -- on read so that changing the SLA table later does not silently rewrite
  -- whether last month's tickets were met.
  first_response_due_at timestamptz NOT NULL,
  resolution_due_at     timestamptz NOT NULL,
  first_responded_at    timestamptz,
  resolved_at           timestamptz,
  closed_at             timestamptz,

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT support_ticket_reference_unique UNIQUE (tenant_id, reference),
  CONSTRAINT support_ticket_subject_not_blank CHECK (length(btrim(subject)) > 0),
  -- A resolved ticket says when. A ticket that is not resolved must not.
  CONSTRAINT support_ticket_resolved_has_time CHECK (
    (status IN ('resolved', 'closed')) = (resolved_at IS NOT NULL)),
  CONSTRAINT support_ticket_closed_has_time CHECK (
    (status = 'closed') = (closed_at IS NOT NULL)),
  CONSTRAINT support_ticket_resolution_after_response CHECK (
    resolution_due_at >= first_response_due_at)
);

CREATE INDEX support_ticket_queue_idx
  ON support_ticket (tenant_id, status, priority, created_at);
CREATE INDEX support_ticket_requester_idx
  ON support_ticket (tenant_id, raised_by_person_id, created_at DESC);
-- The breach query, partial so it stays small: only tickets still owed a reply.
CREATE INDEX support_ticket_response_due_idx
  ON support_ticket (first_response_due_at)
  WHERE first_responded_at IS NULL AND status <> 'closed';

CREATE TRIGGER support_ticket_touch BEFORE UPDATE ON support_ticket
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE ticket_message (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES organization (id),
  ticket_id     uuid NOT NULL REFERENCES support_ticket (id) ON DELETE CASCADE,

  author_person_id uuid NOT NULL REFERENCES person (id),
  body          text NOT NULL,

  -- An internal note is staff-only and never rendered to the requester. It is a
  -- column rather than a separate table so that the thread reads in one query
  -- in order — and it is filtered by the policy below, not by the application,
  -- because a note leaked to a parent cannot be unsent.
  is_internal   boolean NOT NULL DEFAULT false,

  created_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ticket_message_body_not_blank CHECK (length(btrim(body)) > 0)
);

CREATE INDEX ticket_message_thread_idx ON ticket_message (ticket_id, created_at);

CREATE OR REPLACE FUNCTION ticket_message_is_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ticket_message is append-only (attempted %); reply instead of editing',
    TG_OP USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER ticket_message_frozen
  BEFORE UPDATE OR DELETE ON ticket_message
  FOR EACH ROW EXECUTE FUNCTION ticket_message_is_append_only();

-- Status changes, assignments, priority bumps. Separate from messages so the
-- thread a parent reads is a conversation, not a system log.
CREATE TABLE ticket_event (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES organization (id),
  ticket_id   uuid NOT NULL REFERENCES support_ticket (id) ON DELETE CASCADE,
  actor_person_id uuid REFERENCES person (id),
  kind        text NOT NULL CHECK (kind IN (
                'created', 'status_changed', 'assigned', 'priority_changed',
                'first_response', 'reopened')),
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ticket_event_detail_is_object CHECK (jsonb_typeof(detail) = 'object')
);

CREATE INDEX ticket_event_thread_idx ON ticket_event (ticket_id, occurred_at);

CREATE TRIGGER ticket_event_frozen
  BEFORE UPDATE OR DELETE ON ticket_event
  FOR EACH ROW EXECUTE FUNCTION ticket_message_is_append_only();

-- ---------------------------------------------------------------------------
-- Knowledge base
-- ---------------------------------------------------------------------------

CREATE TABLE kb_article (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES organization (id),

  slug        text NOT NULL,
  title       text NOT NULL,
  -- Who this is written for. A parent must not be shown the article about
  -- voiding an invoice, and a teacher does not need the one about resetting a
  -- parent's password.
  audience    text NOT NULL DEFAULT 'everyone'
                CHECK (audience IN ('everyone', 'staff', 'guardians')),
  category    text,

  status      text NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft', 'published', 'archived')),
  -- Points at the version readers actually get. Draft edits do not change what
  -- is published until this moves, so an article can be rewritten in the open.
  published_version integer,

  created_by  uuid REFERENCES user_account (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT kb_article_slug_unique UNIQUE (tenant_id, slug),
  CONSTRAINT kb_article_slug_shape CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  CONSTRAINT kb_article_published_has_version CHECK (
    status <> 'published' OR published_version IS NOT NULL)
);

CREATE TRIGGER kb_article_touch BEFORE UPDATE ON kb_article
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE kb_article_version (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES organization (id),
  kb_article_id uuid NOT NULL REFERENCES kb_article (id) ON DELETE CASCADE,

  version     integer NOT NULL CHECK (version > 0),
  title       text NOT NULL,
  body        text NOT NULL,
  written_by  uuid REFERENCES user_account (id),
  created_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT kb_article_version_unique UNIQUE (kb_article_id, version),
  CONSTRAINT kb_article_version_body_not_blank CHECK (length(btrim(body)) > 0)
);

CREATE TRIGGER kb_article_version_frozen
  BEFORE UPDATE OR DELETE ON kb_article_version
  FOR EACH ROW EXECUTE FUNCTION ticket_message_is_append_only();

-- Trigram search over titles. Not full-text: an institute's help articles are
-- written in a mix of English and transliterated Hindi, and a stemmer for one
-- makes the other worse. Trigrams do not care which language a word is in, and
-- they match a misspelling, which is what somebody searching help has.
CREATE INDEX kb_article_version_title_trgm
  ON kb_article_version USING gin (title gin_trgm_ops);
CREATE INDEX kb_article_version_body_trgm
  ON kb_article_version USING gin (body gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- Grants and row-level security
-- ---------------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE ON support_ticket TO paathshala_app;
GRANT SELECT, INSERT ON ticket_message TO paathshala_app;
GRANT SELECT, INSERT ON ticket_event TO paathshala_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON kb_article TO paathshala_app;
GRANT SELECT, INSERT ON kb_article_version TO paathshala_app;

ALTER TABLE support_ticket     ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_ticket     FORCE  ROW LEVEL SECURITY;
ALTER TABLE ticket_message     ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_message     FORCE  ROW LEVEL SECURITY;
ALTER TABLE ticket_event       ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_event       FORCE  ROW LEVEL SECURITY;
ALTER TABLE kb_article         ENABLE ROW LEVEL SECURITY;
ALTER TABLE kb_article         FORCE  ROW LEVEL SECURITY;
ALTER TABLE kb_article_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE kb_article_version FORCE  ROW LEVEL SECURITY;

-- A guardian sees the tickets they raised. Staff see the tenant's queue.
--
-- Note what this does NOT do: it does not let a guardian see a ticket raised
-- ABOUT their child by a teacher. That is deliberate — "Riya's mother called
-- again about the arrears" is a staff conversation, and a parent discovering
-- it reads as surveillance however carefully it was worded.
CREATE POLICY requester_or_staff ON support_ticket
  FOR ALL TO paathshala_app
  USING (
    tenant_id = app_current_tenant_id()
    AND (app_actor_has_staff_scope() OR raised_by_person_id = app_current_person_id()))
  WITH CHECK (
    tenant_id = app_current_tenant_id()
    AND (app_actor_has_staff_scope() OR raised_by_person_id = app_current_person_id()));

-- The thread. Internal notes are filtered HERE rather than in a query, because
-- the failure mode of filtering in application code is a note rendered to a
-- parent — and there is no way to recall that.
CREATE POLICY thread_visibility ON ticket_message
  FOR ALL TO paathshala_app
  USING (
    tenant_id = app_current_tenant_id()
    AND (NOT is_internal OR app_actor_has_staff_scope())
    AND EXISTS (
      SELECT 1 FROM support_ticket t
       WHERE t.id = ticket_message.ticket_id
         AND (app_actor_has_staff_scope()
              OR t.raised_by_person_id = app_current_person_id())))
  WITH CHECK (
    tenant_id = app_current_tenant_id()
    -- Only staff may write an internal note, and only staff may write as
    -- somebody else: a requester's message must be their own.
    AND (NOT is_internal OR app_actor_has_staff_scope())
    AND (app_actor_has_staff_scope() OR author_person_id = app_current_person_id())
    AND EXISTS (
      SELECT 1 FROM support_ticket t
       WHERE t.id = ticket_message.ticket_id
         AND (app_actor_has_staff_scope()
              OR t.raised_by_person_id = app_current_person_id())));

CREATE POLICY thread_visibility ON ticket_event
  FOR ALL TO paathshala_app
  USING (
    tenant_id = app_current_tenant_id()
    AND EXISTS (
      SELECT 1 FROM support_ticket t
       WHERE t.id = ticket_event.ticket_id
         AND (app_actor_has_staff_scope()
              OR t.raised_by_person_id = app_current_person_id())))
  WITH CHECK (
    tenant_id = app_current_tenant_id()
    AND EXISTS (
      SELECT 1 FROM support_ticket t
       WHERE t.id = ticket_event.ticket_id
         AND (app_actor_has_staff_scope()
              OR t.raised_by_person_id = app_current_person_id())));

-- Reading help: published articles for your audience. Writing them: staff.
--
-- The audience check is in USING, so a guardian's search cannot return the
-- article about voiding invoices however it is phrased — and a draft is
-- invisible to everyone but staff, so an article can be written in the product
-- rather than in a document somewhere else.
CREATE POLICY read_published_write_staff ON kb_article
  FOR ALL TO paathshala_app
  USING (
    tenant_id = app_current_tenant_id()
    AND (app_actor_has_staff_scope()
         OR (status = 'published' AND audience IN ('everyone', 'guardians'))))
  WITH CHECK (
    tenant_id = app_current_tenant_id() AND app_actor_has_staff_scope());

CREATE POLICY read_published_write_staff ON kb_article_version
  FOR ALL TO paathshala_app
  USING (
    tenant_id = app_current_tenant_id()
    AND EXISTS (
      SELECT 1 FROM kb_article a
       WHERE a.id = kb_article_version.kb_article_id
         AND (app_actor_has_staff_scope()
              OR (a.status = 'published'
                  AND a.published_version = kb_article_version.version
                  AND a.audience IN ('everyone', 'guardians')))))
  WITH CHECK (
    tenant_id = app_current_tenant_id() AND app_actor_has_staff_scope());

-- ---------------------------------------------------------------------------
-- Ticket references
-- ---------------------------------------------------------------------------

-- Per tenant, per year, sequential. Allocated by a function rather than a
-- sequence because a sequence is global and would leak how many tickets every
-- other school on the platform has raised — the same reason invoice numbers are
-- per campus rather than per database.
CREATE OR REPLACE FUNCTION next_ticket_reference() RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_tenant uuid := app_current_tenant_id();
  v_year   text := to_char(now(), 'YYYY');
  v_next   integer;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'next_ticket_reference called outside a tenant scope'
      USING ERRCODE = 'raise_exception';
  END IF;

  -- Locks the tenant's existing rows for the year, so two people raising a
  -- ticket in the same millisecond cannot both read the same maximum. The
  -- alternative — catch the unique violation and retry — works too, but turns a
  -- normal concurrent case into an error path nobody exercises.
  SELECT COALESCE(MAX(split_part(reference, '-', 3)::integer), 0) + 1
    INTO v_next
    FROM support_ticket
   WHERE tenant_id = v_tenant AND reference LIKE 'TKT-' || v_year || '-%'
     FOR UPDATE;

  RETURN 'TKT-' || v_year || '-' || lpad(v_next::text, 5, '0');
END;
$$;

REVOKE ALL ON FUNCTION next_ticket_reference() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION next_ticket_reference() TO paathshala_app;

CREATE POLICY definer_bookkeeping ON support_ticket
  FOR ALL TO paathshala_owner USING (true) WITH CHECK (true);
