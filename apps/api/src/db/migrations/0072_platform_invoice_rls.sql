-- 0072 — row-level security on the invoicing tables, which 0071 left off.
--
-- The isolation suite caught this on the first run after 0071: `rls_coverage`
-- names every table with a `tenant_id` and no forced policy, and three of the
-- new ones were on the list.
--
-- The tempting answer was to exempt them. They are platform tables, the
-- application role has no grant on them, and a school therefore cannot read
-- its own invoice no matter what — so the check looked like a false positive.
--
-- It is not. "The app role has no grant" is a fact about today's GRANT
-- statements, and the next migration that adds a reporting view or a support
-- screen changes it in one line, silently. The invariant is worth more than
-- the exemption: a table carrying `tenant_id` says its rows belong to
-- different customers, and that is exactly the table where the second line of
-- defence has to exist before it is needed rather than after.
--
-- So the tables get RLS, forced, with a policy for the role that actually uses
-- them. If somebody grants the application role SELECT tomorrow, it still sees
-- nothing.

ALTER TABLE tenant_billing_profile ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_billing_profile FORCE ROW LEVEL SECURITY;
ALTER TABLE platform_invoice ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_invoice FORCE ROW LEVEL SECURITY;
ALTER TABLE platform_credit_note ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_credit_note FORCE ROW LEVEL SECURITY;

-- The platform role works across every school by design — provisioning and
-- billing are not per-tenant questions — so its policy is unrestricted. The
-- restriction that matters is that the policy names this role and no other:
-- `paathshala_app` matches no policy on these tables and is refused by
-- row-level security even if it is granted the table.
CREATE POLICY platform_billing_access ON tenant_billing_profile
  FOR ALL TO paathshala_platform
  USING (true) WITH CHECK (true);
CREATE POLICY platform_billing_access ON platform_invoice
  FOR ALL TO paathshala_platform
  USING (true) WITH CHECK (true);
CREATE POLICY platform_billing_access ON platform_credit_note
  FOR ALL TO paathshala_platform
  USING (true) WITH CHECK (true);

COMMENT ON POLICY platform_billing_access ON platform_invoice IS
  'Unrestricted for the platform role, which bills across every school, and '
  'absent for every other role — so the application role is refused by RLS '
  'even if a future migration grants it the table.';
