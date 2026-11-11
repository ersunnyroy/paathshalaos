-- 0005: identity. Users, devices, sessions, refresh tokens, role grants.

CREATE EXTENSION IF NOT EXISTS citext;
--
-- A person may have no login at all (most students), exactly one (staff), or a
-- login that spans several tenants (a guardian with children at two institutes).
-- That last case is why login credentials are NOT tenant-scoped: the identity is
-- global, and access to a tenant comes from a grant. Modelling it the other way
-- forces a guardian to hold a separate password per institute, which is the
-- multi-institute failure incumbents ship.

CREATE TABLE user_account (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  login_email     citext,
  login_phone     text,
  password_hash   text,
  mfa_secret_ref  text,
  status          text NOT NULL DEFAULT 'active'
                    CHECK (status IN ('invited', 'active', 'suspended', 'disabled')),

  -- Bumped whenever any grant for this user changes. The access token carries
  -- the value it was minted with; a mismatch means the token's authority is
  -- stale. This is what makes a revoked role take effect on the very next
  -- request instead of whenever the token happens to expire (AC-11).
  grants_version  integer NOT NULL DEFAULT 1,

  failed_attempts integer NOT NULL DEFAULT 0,
  locked_until    timestamptz,
  last_login_at   timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,

  CONSTRAINT user_account_has_an_identifier
    CHECK (login_email IS NOT NULL OR login_phone IS NOT NULL),
  -- A staff account authenticates with a password; a guardian authenticates
  -- with an OTP to a verified phone and legitimately has no password.
  CONSTRAINT user_account_password_needs_email
    CHECK (password_hash IS NULL OR login_email IS NOT NULL)
);

CREATE UNIQUE INDEX user_account_email_key ON user_account (login_email) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX user_account_phone_key ON user_account (login_phone) WHERE deleted_at IS NULL;

CREATE TABLE device (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_account_id  uuid NOT NULL REFERENCES user_account (id) ON DELETE CASCADE,
  platform         text NOT NULL CHECK (platform IN ('ios', 'android', 'web')),
  app_version      text,
  push_token       text,
  fingerprint      text NOT NULL,
  trusted_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX device_user_fingerprint_key ON device (user_account_id, fingerprint);

CREATE TABLE session (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_account_id     uuid NOT NULL REFERENCES user_account (id) ON DELETE CASCADE,
  device_id           uuid REFERENCES device (id) ON DELETE SET NULL,

  -- All refresh tokens descended from one login share a family id. Detecting a
  -- replayed token revokes the family, not just the one token, because a replay
  -- means either the token leaked or the client is broken; in both cases every
  -- descendant is suspect.
  family_id           uuid NOT NULL DEFAULT gen_random_uuid(),
  refresh_token_hash  text NOT NULL,
  parent_session_id   uuid REFERENCES session (id) ON DELETE SET NULL,

  ip                  inet,
  city                text,
  user_agent          text,
  issued_at           timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz NOT NULL,
  last_seen_at        timestamptz NOT NULL DEFAULT now(),
  rotated_at          timestamptz,
  revoked_at          timestamptz,
  revoked_reason      text
);

CREATE UNIQUE INDEX session_refresh_hash_key ON session (refresh_token_hash);
CREATE INDEX session_user_active_idx ON session (user_account_id) WHERE revoked_at IS NULL;
CREATE INDEX session_family_idx ON session (family_id);

CREATE TABLE role_grant (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES organization (id),
  user_account_id  uuid NOT NULL REFERENCES user_account (id) ON DELETE CASCADE,
  role             text NOT NULL CHECK (role IN (
                     'ORG_OWNER', 'CAMPUS_ADMIN', 'ADMISSIONS', 'ACCOUNTANT',
                     'TEACHER', 'STUDENT', 'GUARDIAN', 'TRANSPORT', 'SUPPORT_AGENT')),
  scope_type       text NOT NULL CHECK (scope_type IN (
                     'organization', 'campus', 'academic_unit', 'class_group', 'section', 'self')),
  scope_id         uuid,
  granted_by       uuid REFERENCES user_account (id) ON DELETE SET NULL,
  granted_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz,
  revoked_at       timestamptz,

  -- An organization-scoped grant needs no id; every narrower scope must name one.
  CONSTRAINT role_grant_scope_id_required
    CHECK ((scope_type = 'organization' AND scope_id IS NULL) OR
           (scope_type <> 'organization' AND scope_id IS NOT NULL))
);

CREATE UNIQUE INDEX role_grant_unique
  ON role_grant (tenant_id, user_account_id, role, scope_type, COALESCE(scope_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE revoked_at IS NULL;
CREATE INDEX role_grant_user_idx ON role_grant (user_account_id) WHERE revoked_at IS NULL;
CREATE INDEX role_grant_tenant_user_idx ON role_grant (tenant_id, user_account_id);

-- Any change to a grant bumps the user's grants_version. Doing this in a trigger
-- rather than in application code means it cannot be forgotten by a future code
-- path that writes role_grant directly.
CREATE OR REPLACE FUNCTION bump_grants_version() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE user_account
     SET grants_version = grants_version + 1
   WHERE id = COALESCE(NEW.user_account_id, OLD.user_account_id);
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER role_grant_bumps_version
  AFTER INSERT OR UPDATE OR DELETE ON role_grant
  FOR EACH ROW EXECUTE FUNCTION bump_grants_version();

CREATE TRIGGER user_account_set_updated_at BEFORE UPDATE ON user_account FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER device_set_updated_at       BEFORE UPDATE ON device       FOR EACH ROW EXECUTE FUNCTION set_updated_at();
