-- 0040 — an API client is a principal, and the policies have to know it.
--
-- 0039 left a gap that only shows up when you actually call the public API: the
-- guard sets a tenant but no actor, because a machine integration deliberately
-- does not borrow the identity of whoever created its key. Every existing policy
-- keys on `app_actor_has_staff_scope()`, which reads role_grant for the current
-- ACTOR. With no actor that is false, and the API returns an empty list.
--
-- An empty list is the worst possible outcome here. It is not an error anyone
-- notices; it looks exactly like "this school has no students yet", and an
-- integrator would spend a day on it before asking us.
--
-- Two ways to close it. Give every client a shadow user_account and a role
-- grant — which makes a machine indistinguishable from a person in the audit
-- log, and leaves a login-shaped row nobody can log in as. Or teach the two
-- scope helpers about clients directly, which is what this does.
--
-- The extension is DISJOINT, and that is the property worth defending: when no
-- API client is in scope, both functions evaluate exactly the expression they
-- did before. A human session cannot reach the new branch, and a machine
-- session cannot reach the old one.

CREATE OR REPLACE FUNCTION app_current_api_client_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.api_client_id', true), '')::uuid
$$;

-- The scopes of the client making this request, or an empty array. Checks
-- tenant and status here so that a suspended client's scopes evaporate on the
-- next statement rather than at the next login it never makes.
CREATE OR REPLACE FUNCTION app_api_client_scopes() RETURNS text[]
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    (SELECT c.scopes FROM api_client c
      WHERE c.id = app_current_api_client_id()
        AND c.tenant_id = app_current_tenant_id()
        AND c.status = 'active'),
    ARRAY[]::text[])
$$;

CREATE OR REPLACE FUNCTION app_actor_has_staff_scope() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN app_current_api_client_id() IS NOT NULL
      THEN cardinality(app_api_client_scopes()) > 0
    ELSE EXISTS (
      SELECT 1 FROM role_grant g
       WHERE g.tenant_id = app_current_tenant_id()
         AND g.user_account_id = app_current_actor_id()
         AND g.revoked_at IS NULL
         AND (g.expires_at IS NULL OR g.expires_at > now())
         AND g.role IN ('ORG_OWNER', 'CAMPUS_ADMIN', 'ADMISSIONS', 'ACCOUNTANT',
                        'TEACHER', 'TRANSPORT', 'SUPPORT_AGENT'))
  END
$$;

-- Money stays narrow for machines too. A client with students:read alone must
-- not see a fee position, for the same reason a teacher must not.
CREATE OR REPLACE FUNCTION app_actor_has_finance_scope() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN app_current_api_client_id() IS NOT NULL
      THEN app_api_client_scopes() && ARRAY['invoices:read', 'payments:read']::text[]
    ELSE EXISTS (
      SELECT 1 FROM role_grant g
       WHERE g.tenant_id = app_current_tenant_id()
         AND g.user_account_id = app_current_actor_id()
         AND g.revoked_at IS NULL
         AND (g.expires_at IS NULL OR g.expires_at > now())
         AND g.role IN ('ORG_OWNER', 'CAMPUS_ADMIN', 'ACCOUNTANT'))
  END
$$;

-- Integration scope gets NO machine branch, deliberately.
--
-- A key that could mint another key, or add a webhook endpoint, is a key that
-- can escalate itself and exfiltrate every future event to an address of its
-- choosing. Managing integrations stays a thing a named human does while signed
-- in. So the scope below is a READ of the delivery log — which is what an
-- integrator actually needs, to reconcile what they received — and nothing more.
CREATE OR REPLACE FUNCTION app_actor_has_integration_scope() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT app_current_api_client_id() IS NULL
     AND EXISTS (
       SELECT 1 FROM role_grant g
        WHERE g.tenant_id = app_current_tenant_id()
          AND g.user_account_id = app_current_actor_id()
          AND g.revoked_at IS NULL
          AND (g.expires_at IS NULL OR g.expires_at > now())
          AND g.role = 'ORG_OWNER')
$$;

-- Renamed from webhooks:manage, which promised something it does not grant.
ALTER TABLE api_client DROP CONSTRAINT api_client_scopes_known;
ALTER TABLE api_client ADD CONSTRAINT api_client_scopes_known CHECK (
  scopes <@ ARRAY['students:read', 'attendance:read', 'attendance:write',
                  'invoices:read', 'payments:read', 'results:read',
                  'webhooks:read']::text[]
);

COMMENT ON FUNCTION app_actor_has_integration_scope() IS
  'ORG_OWNER, signed in as a person. Never an API client: a credential that can '
  'issue credentials or redirect the event stream can escalate itself.';
