-- 0050: onboarding a school.
--
-- Until now there was no way to create one. 0003 says "provisioning a tenant is
-- a platform operation and runs as the owner role", which was true and meant
-- that adding a customer required a DBA with a SQL prompt — the seed and the
-- test fixtures are the only things that have ever done it. That is not a
-- deployment detail; it is the product being unable to take its first customer.
--
-- The difficulty is doing this without inventing a god mode. Everything in this
-- system rests on there being no role that can see across tenants, and the
-- obvious implementation of an admin console is exactly such a role.
--
-- So the platform role can CREATE a school and can LIST its customers, and can
-- read nothing inside one. It has no grant on person, student, invoice,
-- attendance or messaging — not a policy that filters them, no grant at all, so
-- the failure is "permission denied for table student" rather than an empty
-- result that someone might mistake for a working query. Support access to
-- tenant data remains what 0008 made it: a time-boxed, two-person, audited
-- impersonation session, and nothing else.
--
-- It can create the first owner's login and never read one back: INSERT on
-- password_hash, no SELECT. Writing a credential is inherent to provisioning;
-- reading one is not.

-- ---------------------------------------------------------------------------
-- Who is platform staff
-- ---------------------------------------------------------------------------

-- Deliberately not a role in role_grant. Every role there is scoped to a
-- tenant, and a platform administrator is the one principal in the system who
-- is not — folding them in would mean every tenant-scoped policy had to grow a
-- special case, which is how a special case becomes a bypass.
CREATE TABLE platform_admin (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_account_id uuid NOT NULL REFERENCES user_account (id),

  -- What they may do. Provisioning and support are separate on purpose: the
  -- person who onboards schools does not thereby gain the ability to request
  -- access to one's records.
  capability      text NOT NULL CHECK (capability IN ('provision', 'support', 'billing')),

  granted_by      uuid REFERENCES user_account (id),
  granted_at      timestamptz NOT NULL DEFAULT now(),
  revoked_at      timestamptz,
  revoked_by      uuid REFERENCES user_account (id),
  note            text,

  CONSTRAINT platform_admin_once
    UNIQUE (user_account_id, capability),
  CONSTRAINT platform_admin_revoked_has_actor
    CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
);

CREATE INDEX platform_admin_live_idx
  ON platform_admin (user_account_id, capability) WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- The provisioning record
-- ---------------------------------------------------------------------------

CREATE TABLE tenant_provisioning (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid REFERENCES organization (id),

  -- Supplied by the caller and unique. Onboarding is the one operation nobody
  -- retries carefully: a sales engineer refreshes the page, and a second school
  -- appears with the same name and no learners. This makes the retry return the
  -- first result instead.
  request_key     text NOT NULL,

  legal_name      text NOT NULL,
  display_name    text NOT NULL,
  owner_email     text NOT NULL,
  status          text NOT NULL DEFAULT 'provisioned'
                    CHECK (status IN ('provisioned', 'failed')),
  failure_reason  text,

  provisioned_by  uuid NOT NULL REFERENCES user_account (id),
  created_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT tenant_provisioning_key_unique UNIQUE (request_key),
  CONSTRAINT tenant_provisioning_failed_has_reason
    CHECK ((status = 'failed') = (failure_reason IS NOT NULL)),
  CONSTRAINT tenant_provisioning_success_has_tenant
    CHECK ((status = 'provisioned') = (tenant_id IS NOT NULL))
);

-- ---------------------------------------------------------------------------
-- The platform role
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'paathshala_platform') THEN
    RAISE EXCEPTION
      'Role paathshala_platform does not exist. Run db:bootstrap before db:migrate.'
      USING ERRCODE = 'invalid_authorization_specification';
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO paathshala_platform;

-- The structural tables a new school needs, and nothing that lives inside one.
GRANT SELECT, INSERT, UPDATE ON organization TO paathshala_platform;
GRANT SELECT, INSERT ON campus, academic_unit TO paathshala_platform;
GRANT SELECT, INSERT, UPDATE ON platform_admin TO paathshala_platform;
GRANT SELECT, INSERT ON tenant_provisioning TO paathshala_platform;
GRANT SELECT, INSERT ON role_grant TO paathshala_platform;

-- A credential can be written and never read. `password_hash` is absent from
-- the SELECT list on purpose: provisioning has to create the owner's login, and
-- has no reason to ever look at one.
GRANT SELECT (id, login_email, status, created_at) ON user_account TO paathshala_platform;
GRANT INSERT (login_email, password_hash, status) ON user_account TO paathshala_platform;

-- No RLS on these two: they are platform-level, not tenant-level, and a policy
-- keyed on app_current_tenant_id() would be meaningless. Their protection is
-- that only one role holds a grant, and only one guard reaches that role.
ALTER TABLE platform_admin      ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_admin      FORCE  ROW LEVEL SECURITY;
ALTER TABLE tenant_provisioning ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_provisioning FORCE  ROW LEVEL SECURITY;

CREATE POLICY platform_only ON platform_admin
  FOR ALL TO paathshala_platform USING (true) WITH CHECK (true);
CREATE POLICY platform_only ON tenant_provisioning
  FOR ALL TO paathshala_platform USING (true) WITH CHECK (true);

-- The platform role sees every organization — that is what a customer list is —
-- but the policy is written out rather than inherited, so it is visible in
-- `pg_policies` next to the tenant one and nobody has to infer it.
CREATE POLICY platform_all_tenants ON organization
  FOR ALL TO paathshala_platform USING (true) WITH CHECK (true);
CREATE POLICY platform_all_tenants ON campus
  FOR ALL TO paathshala_platform USING (true) WITH CHECK (true);
CREATE POLICY platform_all_tenants ON academic_unit
  FOR ALL TO paathshala_platform USING (true) WITH CHECK (true);
CREATE POLICY platform_all_tenants ON role_grant
  FOR ALL TO paathshala_platform USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- Is the caller platform staff
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION platform_admin_has(p_user uuid, p_capability text)
RETURNS boolean
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM platform_admin
     WHERE user_account_id = p_user
       AND capability = p_capability
       AND revoked_at IS NULL)
$$;

REVOKE ALL ON FUNCTION platform_admin_has(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_admin_has(uuid, text)
  TO paathshala_platform, paathshala_auth;

COMMENT ON FUNCTION platform_admin_has(uuid, text) IS
  'Whether this account holds a live platform capability. Called by the auth '
  'role during login, which is why it is SECURITY DEFINER — that role has no '
  'grant on platform_admin and should not gain one.';
