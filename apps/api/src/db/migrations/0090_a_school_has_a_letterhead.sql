-- 0090: what a school prints at the top of its paper (M47.4).
--
-- A receipt and a certificate are documents a family carries to a bank, a
-- passport office or another school. Both printed the school's name and
-- nothing else, because nothing else was stored: no address, no telephone
-- number, no affiliation number. A bonafide certificate without the school's
-- address and affiliation number is routinely sent back.
--
-- ## Why its own table and not columns on `organization`
--
-- `organization` is also read and written by the platform console
-- (`paathshala_platform` holds SELECT, INSERT, UPDATE on it). What a school
-- prints on its paper is the school's to say and nobody else's to edit, so it
-- sits in a table the platform role is not granted at all.
--
-- ## Who may read and write
--
-- Everybody in the school may read it: a parent printing a receipt needs the
-- same header the office gets. Writing follows the one rule that already
-- exists for school-wide settings — `app_actor_may_change_school_settings()`
-- (0079) — and is not restated here.
--
-- ## What the checks are for
--
-- A PIN code is six digits and a UDISE+ code is eleven. Both are typed by
-- hand from a letter, both get printed on documents other institutions read,
-- and a wrong digit count is the mistake that can be caught for free. Nothing
-- else is validated: an affiliation number's shape differs by board.

CREATE TABLE school_letterhead (
  tenant_id         uuid PRIMARY KEY REFERENCES organization (id),

  address_line1     text,
  address_line2     text,
  city              text,
  state             text,
  pincode           text CHECK (pincode IS NULL OR pincode ~ '^[1-9][0-9]{5}$'),

  phone             text,
  email             text,
  website           text,

  -- "CBSE", "ICSE", a state board. Free text: the list is long and local.
  affiliation_body  text,
  affiliation_no    text,
  school_code       text,
  udise_code        text CHECK (udise_code IS NULL OR udise_code ~ '^[0-9]{11}$'),

  -- Whose name goes under the signature line.
  signatory_name    text,
  signatory_title   text,

  updated_by        uuid REFERENCES user_account (id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER school_letterhead_set_updated_at
  BEFORE UPDATE ON school_letterhead
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE school_letterhead ENABLE ROW LEVEL SECURITY;
ALTER TABLE school_letterhead FORCE  ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE ON school_letterhead TO paathshala_app;

CREATE POLICY letterhead_read ON school_letterhead
  FOR SELECT TO paathshala_app
  USING (tenant_id = app_current_tenant_id());

CREATE POLICY letterhead_insert ON school_letterhead
  FOR INSERT TO paathshala_app
  WITH CHECK (tenant_id = app_current_tenant_id()
              AND app_actor_may_change_school_settings());

CREATE POLICY letterhead_update ON school_letterhead
  FOR UPDATE TO paathshala_app
  USING (tenant_id = app_current_tenant_id()
         AND app_actor_may_change_school_settings())
  WITH CHECK (tenant_id = app_current_tenant_id()
              AND app_actor_may_change_school_settings());
