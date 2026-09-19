-- 0055: the capabilities a platform administrator can hold (M15).
--
-- 0050 named three: provision, support, billing. Entering a school is a fourth
-- thing, and changing records inside one is a fifth, and neither belongs to any
-- of the original three. Folding "enter a school" into `support` would mean the
-- person who answers tickets silently acquires the ability to act as a
-- principal, which is the elevation this whole module exists to make visible.
--
-- The list is a CHECK rather than a lookup table because it is a closed set the
-- code branches on. A new capability is a code change; it should also be a
-- migration somebody reads.

ALTER TABLE platform_admin DROP CONSTRAINT platform_admin_capability_check;

ALTER TABLE platform_admin ADD CONSTRAINT platform_admin_capability_check
  CHECK (capability IN (
    -- Creates schools. Sees the school's name and plan, nothing inside it.
    'provision',
    -- Works tickets. Reads the support queue, not the school's records.
    'support',
    -- Plans, subscriptions, entitlements (M16).
    'billing',
    -- Enters a school as one of its people, read-only, on the record.
    'impersonate',
    -- Makes changes while inside. Deliberately separate from 'impersonate':
    -- almost every support question is answered by looking, and a console where
    -- looking and changing are one act produces changes nobody meant to make.
    'impersonate_write',
    -- Grants and revokes the capabilities above. Not a superset of them: an
    -- account holding only this can hand out access but cannot use it, so the
    -- audit log always names somebody who did the work.
    'superadmin'
  ));

COMMENT ON COLUMN platform_admin.capability IS
  'A closed set; see the CHECK constraint. superadmin grants capabilities but '
  'does not confer them, so no single account both authorises and acts.';
