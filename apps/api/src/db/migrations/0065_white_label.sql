-- 0065: whose product is this, and how do you reach it (M19).
--
-- Two problems that look separate and are the same one.
--
--   **White-labelling.** A school subscribing to this should be able to put
--   their own name and mark on it. That is not a cosmetic setting: it changes
--   what appears on the SIGN-IN screen, which is the one screen shown before
--   anybody has authenticated — so the branding has to be resolvable without a
--   token, which means something in the request has to identify the school.
--
--   **Addressing.** Today the web app carries its tenant in a build-time
--   variable and the mobile app in a config file, which is one build per
--   school and is the opposite of white-labelling.
--
-- The host solves both. `stjosephs.paathshala.app` or `portal.stjosephs.edu.in`
-- identifies the school before login, which is exactly what the sign-in screen
-- needs in order to show that school's mark — and it removes the baked-in
-- tenant id entirely.
--
-- **One host per school, not one per role.** A subdomain per role would leak
-- the school's role structure to anyone who could guess a hostname, and would
-- give a person who is both a teacher and a parent two different URLs for the
-- same account. The host says WHICH SCHOOL; the signed-in user's grants decide
-- what they see, exactly as they do now.

-- ---------------------------------------------------------------------------
-- Addressing
-- ---------------------------------------------------------------------------

CREATE TABLE tenant_domain (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES organization (id),

  -- Stored lowercased and without a port. Hosts are case-insensitive and a
  -- lookup that is not would fail for anybody who typed a capital letter.
  host          text NOT NULL CHECK (host = lower(host) AND host !~ ':'),

  -- managed — a subdomain of ours, created at provisioning and ours to trust.
  -- custom  — a domain the school owns, and therefore one we must not route
  --           until they have proved they own it.
  kind          text NOT NULL CHECK (kind IN ('managed', 'custom')),

  -- A custom domain is inert until verified. The token goes in a DNS TXT
  -- record; until we have read it back, this host resolves to nothing.
  --
  -- Without this, anybody could claim any hostname and quietly capture the
  -- branding — and later the traffic — of a domain they do not own.
  verified_at   timestamptz,
  verify_token  text NOT NULL DEFAULT encode(gen_random_bytes(16), 'hex'),

  -- Exactly one host per school is the canonical one, for links in email and
  -- for redirecting the others.
  is_primary    boolean NOT NULL DEFAULT false,

  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid REFERENCES user_account (id) ON DELETE SET NULL,

  CONSTRAINT tenant_domain_host_unique UNIQUE (host),
  -- A managed subdomain is ours; there is nothing to verify and pretending
  -- otherwise would leave every new school unreachable until somebody ticked
  -- a box.
  CONSTRAINT tenant_domain_managed_is_verified
    CHECK (kind = 'custom' OR verified_at IS NOT NULL)
);

CREATE UNIQUE INDEX tenant_domain_one_primary
  ON tenant_domain (tenant_id) WHERE is_primary;

CREATE INDEX tenant_domain_tenant_idx ON tenant_domain (tenant_id);

-- ---------------------------------------------------------------------------
-- Branding
-- ---------------------------------------------------------------------------
--
-- Deliberately a short, closed list of fields rather than a stylesheet.
--
-- "Let them supply CSS" is the flexible answer and it is wrong twice: it is an
-- injection surface on a page we serve, and it turns every future layout change
-- into somebody's broken portal. Colours are validated as hex because they end
-- up in a CSS custom property, and a colour value is a place to smuggle one.

CREATE TABLE tenant_branding (
  tenant_id       uuid PRIMARY KEY REFERENCES organization (id),

  -- What the school calls itself in the interface. Falls back to
  -- organization.display_name, so this is only for when they differ.
  app_name        text CHECK (app_name IS NULL OR length(trim(app_name)) BETWEEN 1 AND 60),

  -- Uploaded images, held in object storage like every other file. NOT inline
  -- SVG: an SVG is a script host, and this one would be served on the sign-in
  -- page of a school's own domain.
  logo_file_id    uuid REFERENCES file (id),
  logo_dark_file_id uuid REFERENCES file (id),

  -- #RGB or #RRGGBB, and nothing else. These are interpolated into a CSS
  -- custom property; `#fff; background: url(…)` is the reason for the anchors.
  primary_colour  text CHECK (primary_colour ~ '^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$'),
  ink_colour      text CHECK (ink_colour ~ '^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$'),

  -- Shown under the sign-in form. Plain text, rendered as text.
  support_email   text CHECK (support_email IS NULL OR support_email ~ '^[^@[:space:]]+@[^@[:space:]]+$'),
  support_phone   text CHECK (support_phone IS NULL OR length(support_phone) <= 20),

  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid REFERENCES user_account (id) ON DELETE SET NULL
);

-- ---------------------------------------------------------------------------
-- Resolving a host, before anybody has signed in
-- ---------------------------------------------------------------------------
--
-- SECURITY DEFINER and readable by the app role without a tenant scope, because
-- this runs before there IS a tenant scope — it is what establishes one.
--
-- What it returns is deliberately only what a sign-in screen needs: the school's
-- name, its mark, its colours. No counts, no addresses, no indication of whether
-- a school is large or small or behind on payment. A host is public knowledge;
-- everything behind it is not.
CREATE OR REPLACE FUNCTION app_brand_for_host(p_host text)
RETURNS TABLE (
  tenant_id uuid, display_name text, app_name text,
  logo_object_key text, logo_dark_object_key text,
  primary_colour text, ink_colour text,
  support_email text, support_phone text,
  host_kind text, is_primary boolean
)
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT o.id, o.display_name, b.app_name,
         f.object_key, fd.object_key,
         b.primary_colour, b.ink_colour, b.support_email, b.support_phone,
         d.kind, d.is_primary
    FROM tenant_domain d
    JOIN organization o ON o.id = d.tenant_id
    LEFT JOIN tenant_branding b ON b.tenant_id = o.id
    LEFT JOIN file f  ON f.id = b.logo_file_id
    LEFT JOIN file fd ON fd.id = b.logo_dark_file_id
   -- Lowercased here as well as on insert: the caller passes a Host header,
   -- and a Host header is whatever the browser sent.
   WHERE d.host = lower(p_host)
     -- An unverified custom domain resolves to nothing at all. This is the
     -- line that stops somebody claiming a hostname they do not own.
     AND d.verified_at IS NOT NULL
     -- A school we have terminated does not get to keep serving its portal.
     AND o.deleted_at IS NULL
     AND o.status <> 'terminated'
$$;

REVOKE ALL ON FUNCTION app_brand_for_host(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_brand_for_host(text)
  TO paathshala_app, paathshala_auth, paathshala_platform;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------

-- The console creates and verifies domains, and sets branding on a school's
-- behalf during onboarding.
GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_domain TO paathshala_platform;
GRANT SELECT, INSERT, UPDATE ON tenant_branding TO paathshala_platform;

-- The school reads and edits its own branding, and reads its own domains.
-- It may NOT insert a domain: claiming a hostname is a routing decision with
-- effects outside that school, so it goes through the console.
GRANT SELECT ON tenant_domain TO paathshala_app;
GRANT SELECT, INSERT, UPDATE ON tenant_branding TO paathshala_app;

ALTER TABLE tenant_domain ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_domain FORCE  ROW LEVEL SECURITY;
ALTER TABLE tenant_branding ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_branding FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON tenant_domain
  FOR ALL TO paathshala_app
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (false);

CREATE POLICY tenant_isolation ON tenant_branding
  FOR ALL TO paathshala_app
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

CREATE POLICY platform_all ON tenant_domain
  FOR ALL TO paathshala_platform USING (true) WITH CHECK (true);
CREATE POLICY platform_all ON tenant_branding
  FOR ALL TO paathshala_platform USING (true) WITH CHECK (true);

COMMENT ON FUNCTION app_brand_for_host(text) IS
  'Host to school, for the sign-in screen, before any token exists. Returns '
  'only what a sign-in screen needs; an unverified custom domain returns '
  'nothing, which is what stops hostname claim-jumping.';
COMMENT ON TABLE tenant_domain IS
  'One host per school, not one per role: a role-per-subdomain scheme leaks the '
  'school''s structure and gives a teacher who is also a parent two URLs.';
