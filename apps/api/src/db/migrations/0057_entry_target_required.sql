-- 0057: correct the constraint 0054 added.
--
-- 0054 required every session to name a person or a role. That broke the older
-- support path, which has always allowed a session with neither: an approved
-- agent looking at a tenant's records as themselves, under a ticket. Ten tests
-- said so immediately, which is the system working — but the constraint should
-- never have been written across both paths.
--
-- The real rule is narrower and belongs only to the platform path: entering a
-- school means becoming one of its people. "Enter as a teacher" is not a thing
-- the database can express, because every policy here decides by actor id and
-- there is no generic teacher — only Mrs Nair, whose name is what the school
-- needs in its access log. `assumed_role` records which of her roles was being
-- exercised; it never stands in for her.

ALTER TABLE impersonation_session
  DROP CONSTRAINT impersonation_assumes_person_or_role;

ALTER TABLE impersonation_session
  ADD CONSTRAINT impersonation_platform_entry_names_a_person
    CHECK (entry_path <> 'platform' OR target_user_id IS NOT NULL);

COMMENT ON COLUMN impersonation_session.assumed_role IS
  'Which of the target''s roles was being exercised, when they hold more than '
  'one. Narrows what the entry token carries; never widens it, and never '
  'substitutes for naming the person.';
