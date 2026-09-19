-- 0039: the public API and outbound webhooks.
--
-- AC-10 is three claims, and each one is a structure here rather than a
-- convention in application code:
--
--   1. **Retries are idempotent.** Two things retry in this system and both are
--      made safe by a unique index rather than by care. A client retrying a
--      POST reuses its Idempotency-Key, and `idempotency_key` replays the
--      stored response instead of performing the work twice. A webhook retrying
--      a delivery re-sends a FROZEN payload under the same delivery id, because
--      `webhook_delivery` is one row per (endpoint, event) and its body is
--      immutable — so a receiver that dedupes on the id is correct, and one
--      that does not still sees identical bytes.
--
--   2. **Signatures are verified.** The signing secret never leaves the
--      database. `webhook_sign()` is SECURITY DEFINER and returns signatures;
--      the column grants below mean the application role cannot read the secret
--      at all, so a `SELECT *` on the endpoint table fails loudly rather than
--      putting a signing key in a log line or an API response.
--
--   3. **Deliveries are visible to the tenant.** Every table here carries the
--      tenant policy, so the delivery log an institute sees is their own rows
--      and the question "did you actually send it" has an answer they can check
--      without asking us.
--
-- The asymmetry worth naming: an API KEY is a credential, so its secret lives
-- where the application role cannot reach it, exactly like a password hash. Its
-- metadata — prefix, last four, expiry — is ordinary tenant data, because the
-- institute must be able to see which keys exist and revoke them.

-- ---------------------------------------------------------------------------
-- Who may manage integrations
-- ---------------------------------------------------------------------------

-- Narrower than finance scope, and deliberately so: an API key is authority
-- over the WHOLE organisation regardless of who minted it, so a campus admin
-- issuing one would be granting themselves the campuses they do not have.
CREATE OR REPLACE FUNCTION app_actor_has_integration_scope() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM role_grant g
     WHERE g.tenant_id = app_current_tenant_id()
       AND g.user_account_id = app_current_actor_id()
       AND g.revoked_at IS NULL
       AND (g.expires_at IS NULL OR g.expires_at > now())
       AND g.role = 'ORG_OWNER'
  )
$$;

COMMENT ON FUNCTION app_actor_has_integration_scope() IS
  'ORG_OWNER only. An API key spans the whole organisation, so anyone who can '
  'mint one can exceed their own campus scope through it.';

-- ---------------------------------------------------------------------------
-- API clients and keys
-- ---------------------------------------------------------------------------

CREATE TABLE api_client (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES organization (id),
  name         text NOT NULL,
  description  text,
  -- What this client may do, checked per request. Stored as a sorted array so
  -- two clients with the same authority compare equal.
  scopes       text[] NOT NULL,
  status       text NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active', 'suspended')),
  -- A per-minute ceiling, per client, so one integration's runaway loop cannot
  -- consume the tenant's whole budget.
  rate_per_min integer NOT NULL DEFAULT 120 CHECK (rate_per_min BETWEEN 1 AND 6000),
  created_by   uuid REFERENCES user_account (id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT api_client_name_unique UNIQUE (tenant_id, name),
  CONSTRAINT api_client_scopes_not_empty CHECK (cardinality(scopes) > 0),
  -- A closed set. An unknown scope string in this column is authority nobody
  -- can reason about, and it would pass a naive `scopes @> ARRAY[...]` check
  -- against whatever a future endpoint decides to require.
  CONSTRAINT api_client_scopes_known CHECK (
    scopes <@ ARRAY['students:read', 'attendance:read', 'attendance:write',
                    'invoices:read', 'payments:read', 'results:read',
                    'webhooks:manage']::text[]
  )
);

CREATE TRIGGER api_client_touch BEFORE UPDATE ON api_client
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Key METADATA. The institute sees this; it is how they audit and revoke.
CREATE TABLE api_key (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES organization (id),
  api_client_id uuid NOT NULL REFERENCES api_client (id) ON DELETE CASCADE,

  -- The public half of the key, carried in the credential itself so a lookup is
  -- an index hit rather than a scan over every hash in the table.
  prefix        text NOT NULL,
  -- For "which key is this?" in a support conversation, without the key.
  last_four     text NOT NULL,
  label         text,

  created_by    uuid REFERENCES user_account (id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz,
  revoked_at    timestamptz,
  revoked_by    uuid REFERENCES user_account (id),
  last_used_at  timestamptz,

  CONSTRAINT api_key_prefix_unique UNIQUE (prefix),
  CONSTRAINT api_key_prefix_shape CHECK (prefix ~ '^pk_(live|test)_[0-9a-f]{16}$'),
  CONSTRAINT api_key_last_four_shape CHECK (last_four ~ '^[0-9a-f]{4}$'),
  CONSTRAINT api_key_expiry_after_creation CHECK (expires_at IS NULL OR expires_at > created_at)
);

CREATE INDEX api_key_client_idx ON api_key (tenant_id, api_client_id, created_at DESC);

-- The credential itself. Separate table, separate role, no grant to the
-- application role — the same split that keeps password hashes out of reach of
-- the role that serves tenant data. A SQL injection in a reporting endpoint
-- cannot read this table because the connection it runs on has no rights to it.
--
-- SHA-256 rather than Argon2id, which is the opposite of the choice made for
-- passwords, and for a reason: an API key is 256 bits from a CSPRNG, not a
-- human's guess. There is no dictionary to run against it, so a slow KDF buys
-- nothing and costs a hash on every single request.
CREATE TABLE api_key_secret (
  api_key_id  uuid PRIMARY KEY,
  tenant_id   uuid NOT NULL,
  secret_hash text NOT NULL,
  CONSTRAINT api_key_secret_hash_shape CHECK (secret_hash ~ '^[0-9a-f]{64}$')
);

-- ---------------------------------------------------------------------------
-- Idempotent replay
-- ---------------------------------------------------------------------------

CREATE TABLE idempotency_key (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES organization (id),
  api_client_id uuid NOT NULL REFERENCES api_client (id) ON DELETE CASCADE,

  idem_key      text NOT NULL,
  -- The request this key was first used for. A client that reuses a key with a
  -- DIFFERENT body has a bug — most often a loop variable that did not advance
  -- — and replaying the first response would silently drop the second request.
  -- So that case is an error, not a replay.
  request_digest text NOT NULL,
  endpoint       text NOT NULL,

  -- in_flight is claimed BEFORE the work runs. Two concurrent duplicates race
  -- for this row; the loser is told to retry rather than performing the work a
  -- second time.
  state          text NOT NULL DEFAULT 'in_flight'
                   CHECK (state IN ('in_flight', 'completed')),
  status_code    integer,
  response_body  jsonb,

  created_at     timestamptz NOT NULL DEFAULT now(),
  completed_at   timestamptz,
  -- Keys are kept for 24 hours, which is the window a retry realistically
  -- happens in. Keeping them forever turns this into an unbounded log of every
  -- write the API has ever served.
  expires_at     timestamptz NOT NULL DEFAULT now() + interval '24 hours',

  CONSTRAINT idempotency_key_unique UNIQUE (tenant_id, api_client_id, idem_key),
  CONSTRAINT idempotency_key_completed_has_response CHECK (
    (state = 'in_flight' AND status_code IS NULL AND response_body IS NULL
       AND completed_at IS NULL)
    OR
    (state = 'completed' AND status_code IS NOT NULL AND response_body IS NOT NULL
       AND completed_at IS NOT NULL)
  ),
  CONSTRAINT idempotency_key_digest_shape CHECK (request_digest ~ '^[0-9a-f]{64}$')
);

CREATE INDEX idempotency_key_expiry_idx ON idempotency_key (expires_at);

-- ---------------------------------------------------------------------------
-- Webhook endpoints
-- ---------------------------------------------------------------------------

CREATE TABLE webhook_endpoint (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES organization (id),

  url            text NOT NULL,
  description    text,
  -- Which event types this endpoint wants. Empty is not "all": an endpoint
  -- subscribed to nothing is almost always a half-finished setup, and sending
  -- it everything is the wrong guess.
  event_types    text[] NOT NULL,
  status         text NOT NULL DEFAULT 'active'
                   CHECK (status IN ('active', 'paused', 'disabled')),

  -- The signing secrets. NOT readable by the application role — see the grants
  -- below. `previous_secret` exists so a rotation does not break a receiver
  -- mid-flight: during the overlap both signatures are sent, the receiver
  -- accepts either, and the old one stops being sent when the window closes.
  signing_secret     text NOT NULL,
  previous_secret    text,
  secret_rotated_at  timestamptz,

  -- Set when repeated failures take the endpoint out of rotation, so the reason
  -- is on the record the tenant can see rather than only in a log.
  disabled_reason text,
  created_by     uuid REFERENCES user_account (id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),

  -- https only. A webhook carries a child's name and a family's fee position;
  -- over http that is readable by every hop in between, and the signature
  -- proves origin, not confidentiality.
  CONSTRAINT webhook_endpoint_https CHECK (url ~ '^https://'),
  CONSTRAINT webhook_endpoint_events_not_empty CHECK (cardinality(event_types) > 0),
  CONSTRAINT webhook_endpoint_url_unique UNIQUE (tenant_id, url),
  CONSTRAINT webhook_endpoint_disabled_has_reason CHECK (
    status <> 'disabled' OR disabled_reason IS NOT NULL)
);

CREATE TRIGGER webhook_endpoint_touch BEFORE UPDATE ON webhook_endpoint
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Deliveries and attempts
-- ---------------------------------------------------------------------------

CREATE TABLE webhook_delivery (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES organization (id),
  webhook_endpoint_id uuid NOT NULL REFERENCES webhook_endpoint (id) ON DELETE CASCADE,
  outbox_event_id     uuid NOT NULL REFERENCES outbox_event (id),

  event_type          text NOT NULL,
  -- Frozen at fan-out. This is what makes a retry identical rather than merely
  -- similar: re-reading the aggregate at retry time would send the state as of
  -- NOW under an event that describes THEN, and a receiver replaying its inbox
  -- would build a different history than one that succeeded first time.
  payload             jsonb NOT NULL,

  status              text NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'succeeded', 'failed', 'dead')),
  attempt_count       integer NOT NULL DEFAULT 0,
  next_attempt_at     timestamptz NOT NULL DEFAULT now(),
  last_error          text,
  succeeded_at        timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),

  -- The index that makes the fan-out idempotent. Running the relay twice over
  -- the same event inserts nothing the second time, so "did we already queue
  -- this?" is answered by the database rather than by a check-then-insert that
  -- two workers can both pass.
  CONSTRAINT webhook_delivery_once UNIQUE (webhook_endpoint_id, outbox_event_id),
  CONSTRAINT webhook_delivery_payload_is_object CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT webhook_delivery_succeeded_has_time CHECK (
    (status = 'succeeded') = (succeeded_at IS NOT NULL))
);

CREATE INDEX webhook_delivery_due_idx
  ON webhook_delivery (next_attempt_at)
  WHERE status = 'pending';
CREATE INDEX webhook_delivery_tenant_idx
  ON webhook_delivery (tenant_id, created_at DESC);

-- Append-only. The delivery row says where things stand; this says what
-- happened, and a support conversation about "we never got it" is settled by
-- the response code we actually received rather than by recollection.
CREATE TABLE webhook_attempt (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES organization (id),
  webhook_delivery_id uuid NOT NULL REFERENCES webhook_delivery (id) ON DELETE CASCADE,

  attempt_no          integer NOT NULL CHECK (attempt_no > 0),
  attempted_at        timestamptz NOT NULL DEFAULT now(),
  duration_ms         integer CHECK (duration_ms >= 0),
  response_status     integer,
  -- Truncated on the way in. A receiver that returns its whole HTML error page
  -- would otherwise put a megabyte per attempt into this table.
  response_excerpt    text CHECK (response_excerpt IS NULL OR length(response_excerpt) <= 2048),
  error               text,

  CONSTRAINT webhook_attempt_no_unique UNIQUE (webhook_delivery_id, attempt_no),
  CONSTRAINT webhook_attempt_has_an_outcome CHECK (
    response_status IS NOT NULL OR error IS NOT NULL)
);

CREATE OR REPLACE FUNCTION webhook_attempt_is_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'webhook_attempt is append-only (attempted %)', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER webhook_attempt_no_update
  BEFORE UPDATE OR DELETE ON webhook_attempt
  FOR EACH ROW EXECUTE FUNCTION webhook_attempt_is_append_only();

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE ON api_client TO paathshala_app;
GRANT SELECT, UPDATE (label, revoked_at, revoked_by, last_used_at) ON api_key TO paathshala_app;
-- No grant at all on api_key_secret for the application role. That is the
-- point: the role that serves tenant data cannot read a credential, so no
-- endpoint, query or injection on that connection can return one.
GRANT SELECT ON api_key_secret TO paathshala_auth;
GRANT SELECT, INSERT, UPDATE, DELETE ON idempotency_key TO paathshala_app;

-- Column-level, so the secrets are not merely "not selected" by convention.
-- A `SELECT *` on this table from the application role raises permission denied
-- rather than quietly handing a signing key to whatever serialises the row.
GRANT SELECT (id, tenant_id, url, description, event_types, status,
              secret_rotated_at, disabled_reason, created_by, created_at, updated_at)
  ON webhook_endpoint TO paathshala_app;
GRANT UPDATE (url, description, event_types, status, disabled_reason)
  ON webhook_endpoint TO paathshala_app;
-- Deliberately no INSERT: an endpoint cannot exist without a signing secret,
-- and the application role cannot write one. Creation goes through
-- webhook_endpoint_create() below.
GRANT DELETE ON webhook_endpoint TO paathshala_app;

GRANT SELECT, INSERT, UPDATE ON webhook_delivery TO paathshala_app;
GRANT SELECT, INSERT ON webhook_attempt TO paathshala_app;

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

ALTER TABLE api_client        ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_client        FORCE  ROW LEVEL SECURITY;
ALTER TABLE api_key           ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_key           FORCE  ROW LEVEL SECURITY;
ALTER TABLE api_key_secret    ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_key_secret    FORCE  ROW LEVEL SECURITY;
ALTER TABLE idempotency_key   ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_key   FORCE  ROW LEVEL SECURITY;
ALTER TABLE webhook_endpoint  ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_endpoint  FORCE  ROW LEVEL SECURITY;
ALTER TABLE webhook_delivery  ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_delivery  FORCE  ROW LEVEL SECURITY;
ALTER TABLE webhook_attempt   ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_attempt   FORCE  ROW LEVEL SECURITY;

-- Managing integrations is ORG_OWNER work. Reading the delivery log is not:
-- "did the fee receipt reach our accounting system" is a question the office
-- asks, and making them raise a ticket to see it is how a support queue fills
-- up with questions the tenant could have answered themselves.
CREATE POLICY integration_scope ON api_client
  FOR ALL TO paathshala_app
  USING (tenant_id = app_current_tenant_id() AND app_actor_has_integration_scope())
  WITH CHECK (tenant_id = app_current_tenant_id() AND app_actor_has_integration_scope());

CREATE POLICY integration_scope ON api_key
  FOR ALL TO paathshala_app
  USING (tenant_id = app_current_tenant_id() AND app_actor_has_integration_scope())
  WITH CHECK (tenant_id = app_current_tenant_id() AND app_actor_has_integration_scope());

CREATE POLICY integration_scope ON webhook_endpoint
  FOR ALL TO paathshala_app
  USING (tenant_id = app_current_tenant_id() AND app_actor_has_integration_scope())
  WITH CHECK (tenant_id = app_current_tenant_id() AND app_actor_has_integration_scope());

CREATE POLICY staff_read ON webhook_delivery
  FOR ALL TO paathshala_app
  USING (tenant_id = app_current_tenant_id() AND app_actor_has_staff_scope())
  WITH CHECK (tenant_id = app_current_tenant_id() AND app_actor_has_staff_scope());

CREATE POLICY staff_read ON webhook_attempt
  FOR ALL TO paathshala_app
  USING (tenant_id = app_current_tenant_id() AND app_actor_has_staff_scope())
  WITH CHECK (tenant_id = app_current_tenant_id() AND app_actor_has_staff_scope());

-- Scoped to the tenant but NOT to the actor: the request that replays a key is
-- made by the API client, and the human who first used it is irrelevant to
-- whether the replay is the same request.
CREATE POLICY tenant_isolation ON idempotency_key
  FOR ALL TO paathshala_app
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

-- The auth role authenticates keys and does so before any tenant is known, so
-- its policy cannot key on app_current_tenant_id(). It is confined instead by
-- having SELECT on this one table and nothing else in the tenant schema.
CREATE POLICY auth_lookup ON api_key_secret
  FOR SELECT TO paathshala_auth
  USING (true);

-- The definer functions below run as the owner. FORCE ROW LEVEL SECURITY applies
-- to the owner too, so without this they would be filtered to nothing on any
-- deployment where the owner is not a superuser — which is every deployment we
-- would want. The functions filter by app_current_tenant_id() themselves; this
-- policy exists so that filtering is the only thing standing between them and
-- the wrong tenant, rather than an accident of role configuration.
CREATE POLICY definer_bookkeeping ON api_client       FOR ALL TO paathshala_owner USING (true) WITH CHECK (true);
CREATE POLICY definer_bookkeeping ON api_key          FOR ALL TO paathshala_owner USING (true) WITH CHECK (true);
CREATE POLICY definer_bookkeeping ON api_key_secret   FOR ALL TO paathshala_owner USING (true) WITH CHECK (true);
CREATE POLICY definer_bookkeeping ON webhook_endpoint FOR ALL TO paathshala_owner USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- Issuing credentials
-- ---------------------------------------------------------------------------

-- One transaction across two tables the caller cannot both reach. Splitting
-- this into two application-level writes on two pools would leave, on a partial
-- failure, either a key metadata row that can never authenticate or a secret
-- with no owner — and the second of those is a live credential nobody can see
-- to revoke.
CREATE OR REPLACE FUNCTION api_key_issue(
  p_client_id  uuid,
  p_label      text DEFAULT NULL,
  p_expires_at timestamptz DEFAULT NULL,
  p_live       boolean DEFAULT true
) RETURNS TABLE (api_key_id uuid, prefix text, secret text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_tenant uuid := app_current_tenant_id();
  v_prefix text;
  v_secret text;
  v_id     uuid;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'api_key_issue called outside a tenant scope'
      USING ERRCODE = 'raise_exception';
  END IF;
  IF NOT app_actor_has_integration_scope() THEN
    RAISE EXCEPTION 'Only an organisation owner may issue an API key'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Checked here rather than trusted from the caller: this function runs with
  -- the owner's rights, so a client id from another tenant would otherwise be
  -- perfectly writable.
  PERFORM 1 FROM api_client
   WHERE id = p_client_id AND tenant_id = v_tenant AND status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No active API client % in this organisation', p_client_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  v_prefix := 'pk_' || CASE WHEN p_live THEN 'live' ELSE 'test' END
              || '_' || encode(gen_random_bytes(8), 'hex');
  -- 32 bytes from the CSPRNG. The secret is returned exactly once, here; after
  -- this transaction only its SHA-256 exists anywhere in the system.
  v_secret := encode(gen_random_bytes(32), 'hex');

  INSERT INTO api_key (tenant_id, api_client_id, prefix, last_four, label,
                       created_by, expires_at)
  VALUES (v_tenant, p_client_id, v_prefix, right(v_secret, 4), p_label,
          app_current_actor_id(), p_expires_at)
  RETURNING id INTO v_id;

  INSERT INTO api_key_secret (api_key_id, tenant_id, secret_hash)
  VALUES (v_id, v_tenant, encode(digest(v_secret, 'sha256'), 'hex'));

  RETURN QUERY SELECT v_id, v_prefix, v_secret;
END;
$$;

REVOKE ALL ON FUNCTION api_key_issue(uuid, text, timestamptz, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api_key_issue(uuid, text, timestamptz, boolean) TO paathshala_app;

-- Authentication runs before any tenant is known — the key is what names the
-- tenant — so this is the one place a lookup crosses the tenant boundary. It
-- returns a REASON rather than a bare null: "expired" and "revoked" are
-- different support conversations, and collapsing them into "invalid" means
-- every one of them starts with us guessing.
CREATE OR REPLACE FUNCTION api_key_authenticate(p_prefix text, p_secret text)
RETURNS TABLE (
  ok boolean, reason text, api_key_id uuid, tenant_id uuid,
  api_client_id uuid, scopes text[], rate_per_min integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE k record;
BEGIN
  SELECT ak.id, ak.tenant_id, ak.api_client_id, ak.expires_at, ak.revoked_at,
         ac.status AS client_status, ac.scopes, ac.rate_per_min,
         aks.secret_hash
    INTO k
    FROM api_key ak
    JOIN api_client ac ON ac.id = ak.api_client_id
    JOIN api_key_secret aks ON aks.api_key_id = ak.id
   WHERE ak.prefix = p_prefix;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 'unknown_key', NULL::uuid, NULL::uuid, NULL::uuid,
                        NULL::text[], NULL::integer;
    RETURN;
  END IF;

  IF k.secret_hash <> encode(digest(p_secret, 'sha256'), 'hex') THEN
    RETURN QUERY SELECT false, 'bad_secret', NULL::uuid, NULL::uuid, NULL::uuid,
                        NULL::text[], NULL::integer;
    RETURN;
  END IF;
  IF k.revoked_at IS NOT NULL THEN
    RETURN QUERY SELECT false, 'revoked', NULL::uuid, NULL::uuid, NULL::uuid,
                        NULL::text[], NULL::integer;
    RETURN;
  END IF;
  IF k.expires_at IS NOT NULL AND k.expires_at <= now() THEN
    RETURN QUERY SELECT false, 'expired', NULL::uuid, NULL::uuid, NULL::uuid,
                        NULL::text[], NULL::integer;
    RETURN;
  END IF;
  IF k.client_status <> 'active' THEN
    RETURN QUERY SELECT false, 'client_suspended', NULL::uuid, NULL::uuid, NULL::uuid,
                        NULL::text[], NULL::integer;
    RETURN;
  END IF;

  -- Recorded on success only, and to the minute rather than the microsecond: the
  -- question this answers is "is this key still in use, can we retire it", and a
  -- write per request on a hot key is a cost with no matching benefit.
  UPDATE api_key SET last_used_at = now()
   WHERE id = k.id
     AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute');

  RETURN QUERY SELECT true, 'ok', k.id, k.tenant_id, k.api_client_id,
                      k.scopes, k.rate_per_min;
END;
$$;

REVOKE ALL ON FUNCTION api_key_authenticate(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api_key_authenticate(text, text) TO paathshala_auth;

-- ---------------------------------------------------------------------------
-- Webhook secrets and signing
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION webhook_endpoint_create(
  p_url         text,
  p_event_types text[],
  p_description text DEFAULT NULL
) RETURNS TABLE (endpoint_id uuid, secret text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_tenant uuid := app_current_tenant_id();
  v_secret text;
  v_id     uuid;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'webhook_endpoint_create called outside a tenant scope'
      USING ERRCODE = 'raise_exception';
  END IF;
  IF NOT app_actor_has_integration_scope() THEN
    RAISE EXCEPTION 'Only an organisation owner may add a webhook endpoint'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  v_secret := 'whsec_' || encode(gen_random_bytes(32), 'hex');

  INSERT INTO webhook_endpoint (tenant_id, url, event_types, description,
                                signing_secret, created_by)
  VALUES (v_tenant, p_url, p_event_types, p_description, v_secret,
          app_current_actor_id())
  RETURNING id INTO v_id;

  -- Returned once, at creation. There is no endpoint that reads it back: a
  -- secret an API can re-read is a secret in every log that ever captured that
  -- response.
  RETURN QUERY SELECT v_id, v_secret;
END;
$$;

REVOKE ALL ON FUNCTION webhook_endpoint_create(text, text[], text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION webhook_endpoint_create(text, text[], text) TO paathshala_app;

-- Rotation with an overlap, because the alternative is a flag day. The old
-- secret keeps signing alongside the new one for the window, the receiver
-- accepts either, and nothing has to be deployed on both sides at the same
-- minute.
CREATE OR REPLACE FUNCTION webhook_endpoint_rotate_secret(p_endpoint_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_tenant uuid := app_current_tenant_id();
  v_secret text;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'webhook_endpoint_rotate_secret called outside a tenant scope'
      USING ERRCODE = 'raise_exception';
  END IF;
  IF NOT app_actor_has_integration_scope() THEN
    RAISE EXCEPTION 'Only an organisation owner may rotate a signing secret'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  v_secret := 'whsec_' || encode(gen_random_bytes(32), 'hex');

  UPDATE webhook_endpoint
     SET previous_secret   = signing_secret,
         signing_secret    = v_secret,
         secret_rotated_at = now()
   WHERE id = p_endpoint_id AND tenant_id = v_tenant;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No webhook endpoint % in this organisation', p_endpoint_id
      USING ERRCODE = 'no_data_found';
  END IF;

  RETURN v_secret;
END;
$$;

REVOKE ALL ON FUNCTION webhook_endpoint_rotate_secret(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION webhook_endpoint_rotate_secret(uuid) TO paathshala_app;

-- How long a rotated-out secret keeps signing. Long enough that a receiver can
-- be updated in business hours; short enough that a secret believed rotated
-- actually stops working the same day.
CREATE OR REPLACE FUNCTION webhook_secret_overlap() RETURNS interval
LANGUAGE sql IMMUTABLE AS $$ SELECT interval '24 hours' $$;

-- The dispatcher asks the database to sign; it never holds the key. Returns one
-- signature normally and two during the overlap, current first.
CREATE OR REPLACE FUNCTION webhook_sign(p_endpoint_id uuid, p_signed_payload text)
RETURNS text[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_tenant uuid := app_current_tenant_id();
  e record;
  sigs text[];
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'webhook_sign called outside a tenant scope'
      USING ERRCODE = 'raise_exception';
  END IF;

  SELECT signing_secret, previous_secret, secret_rotated_at INTO e
    FROM webhook_endpoint
   WHERE id = p_endpoint_id AND tenant_id = v_tenant;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No webhook endpoint % in this organisation', p_endpoint_id
      USING ERRCODE = 'no_data_found';
  END IF;

  sigs := ARRAY[encode(hmac(p_signed_payload, e.signing_secret, 'sha256'), 'hex')];

  IF e.previous_secret IS NOT NULL
     AND e.secret_rotated_at IS NOT NULL
     AND e.secret_rotated_at > now() - webhook_secret_overlap() THEN
    sigs := sigs || encode(hmac(p_signed_payload, e.previous_secret, 'sha256'), 'hex');
  END IF;

  RETURN sigs;
END;
$$;

REVOKE ALL ON FUNCTION webhook_sign(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION webhook_sign(uuid, text) TO paathshala_app;

COMMENT ON FUNCTION webhook_sign(uuid, text) IS
  'Signs on behalf of an endpoint without disclosing its secret. The application '
  'role has no column privilege on signing_secret, so this is the only path — '
  'which is what keeps a signing key out of logs and API responses.';
