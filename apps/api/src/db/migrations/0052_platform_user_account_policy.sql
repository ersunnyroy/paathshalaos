-- 0052 — the platform role had the grant but no policy.
--
-- `user_account` has row-level security with policies for the app role and the
-- auth role, and none for the platform role, so its INSERT was refused by the
-- policy even though the column grants allowed it. Two different mechanisms
-- both have to say yes, which is the point of having both — and the failure
-- landed on the INSERT rather than silently widening anything.
--
-- The policy is written narrowly. Reading is already restricted to the columns
-- in 0050 (no password_hash), and creating an account is what provisioning is.
-- Deleting or updating one is not: a platform administrator who could edit an
-- account could change the email on a school owner's login and take it over,
-- so no UPDATE or DELETE policy exists here and no grant backs one.
CREATE POLICY platform_creates_owners ON user_account
  FOR INSERT TO paathshala_platform
  WITH CHECK (true);

CREATE POLICY platform_reads_accounts ON user_account
  FOR SELECT TO paathshala_platform
  USING (true);

COMMENT ON POLICY platform_creates_owners ON user_account IS
  'Provisioning creates the first owner login. There is deliberately no UPDATE '
  'or DELETE policy for this role: changing the email on an existing login is '
  'how an account gets taken over.';
