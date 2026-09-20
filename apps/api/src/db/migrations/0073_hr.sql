-- 0073 — HR (M27).
--
-- `hr` has been a plan flag since M16 with nothing behind it. This is the
-- module the flag was selling, and the second of the three modules M16 sold
-- ahead of building.
--
-- The load-bearing part is not contracts or leave balances. It is **relief
-- cover**, which `attendance.spec.ts` has carried as a written-down limitation
-- since M6:
--
--     "Cover assigned on the morning, for a teacher who is in no timetable
--      slot at all, has no representation in this schema. Recorded as a
--      limitation rather than papered over with a policy branch off
--      marked_by_staff_id, which would let whoever marked first keep marking."
--
-- That is a teacher standing in front of a class they cannot mark a register
-- for. The workaround every school uses is that somebody else marks it from
-- the office, which makes the register a second-hand account of who was in a
-- room — and the attendance module's whole argument is that it is not.
--
-- So cover WIDENS somebody's reach, which makes it the most dangerous thing in
-- this migration. Three rules, and they are the same three transport used for
-- a bus manifest:
--
--   1. **Today, not ever.** Cover is dated. A teacher who covered 9B in March
--      has no business in 9B's register in September.
--   2. **A named section, not a blanket.** Cover is granted per section, not
--      "this person is covering today".
--   3. **It is written down.** Who granted it, why, and against which absence.
--      An audit trail is the only thing that distinguishes cover from a
--      quiet permission change.

-- ---------------------------------------------------------------------------
-- Employment
-- ---------------------------------------------------------------------------

CREATE TABLE staff_contract (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES organization (id),
  staff_id      uuid NOT NULL REFERENCES staff (id),

  kind          text NOT NULL
                  CHECK (kind IN ('permanent', 'fixed_term', 'probation',
                                  'visiting', 'contract')),
  -- Hours per week, for a visiting teacher paid by the period. NULL means
  -- full-time as the school defines it, which is deliberately not a number
  -- this schema invents.
  weekly_hours  numeric(5,2) CHECK (weekly_hours IS NULL
                  OR (weekly_hours > 0 AND weekly_hours <= 80)),

  starts_on     date NOT NULL,
  ends_on       date,

  -- Deliberately absent: salary. Pay is the one field that would make this
  -- table need its own access control, its own audit, and its own answer to
  -- "who in the school may read it" — and M27 produces payroll INPUTS rather
  -- than payroll. A salary column would be used within a week and guarded
  -- within a year.

  note          text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid REFERENCES user_account (id),

  CONSTRAINT staff_contract_dates_ordered
    CHECK (ends_on IS NULL OR ends_on >= starts_on),
  CONSTRAINT staff_contract_fixed_term_ends
    CHECK (kind <> 'fixed_term' OR ends_on IS NOT NULL)
);

CREATE INDEX staff_contract_live_idx
  ON staff_contract (tenant_id, staff_id, starts_on DESC);

-- ---------------------------------------------------------------------------
-- Leave
-- ---------------------------------------------------------------------------

-- Defined per school, not by this schema. "Casual leave" and "earned leave"
-- are near-universal in Indian schools and their rules are not: a system that
-- hard-codes an entitlement is a system that argues with every second school.
CREATE TABLE leave_type (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES organization (id),
  code               text NOT NULL CHECK (code ~ '^[A-Z][A-Z0-9_]{1,15}$'),
  name               text NOT NULL,
  -- Whether a day taken counts against pay. The one fact payroll needs.
  is_paid            boolean NOT NULL DEFAULT true,
  -- Days granted per year. NULL means unlimited-by-policy — sick leave at
  -- some schools — which is not the same as zero.
  annual_entitlement numeric(5,1) CHECK (annual_entitlement IS NULL
                       OR annual_entitlement >= 0),
  -- Whether an unused balance survives the year end.
  carries_forward    boolean NOT NULL DEFAULT false,
  deleted_at         timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT leave_type_code_once UNIQUE (tenant_id, code)
);

-- What somebody has left, for a year. A running balance rather than a derived
-- one: an opening balance is a decision the school makes (carry-forward caps,
-- mid-year joiners, a negotiated allowance) and deriving it from the leave
-- taken would quietly overwrite that decision every time a request is filed.
CREATE TABLE leave_balance (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES organization (id),
  staff_id       uuid NOT NULL REFERENCES staff (id),
  leave_type_id  uuid NOT NULL REFERENCES leave_type (id),
  year_label     text NOT NULL CHECK (year_label ~ '^[0-9]{4}-[0-9]{2}$'),
  opening        numeric(5,1) NOT NULL DEFAULT 0 CHECK (opening >= 0),
  -- Maintained by the application when a request is approved, and checked
  -- against the absences that reference it by a report — two numbers that
  -- must agree, rather than one that cannot be wrong and therefore is.
  taken          numeric(5,1) NOT NULL DEFAULT 0 CHECK (taken >= 0),
  updated_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT leave_balance_once UNIQUE (tenant_id, staff_id, leave_type_id, year_label)
);

-- A staff member not at work on a day, whatever the reason.
--
-- Named `staff_absence` rather than `leave_request` because it also covers the
-- cases nobody requested: sick on the morning, bereavement, a training day the
-- school sent them on. A table that only models requests cannot answer "who is
-- not here today", which is the question cover is assigned from.
CREATE TABLE staff_absence (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES organization (id),
  staff_id       uuid NOT NULL REFERENCES staff (id),
  -- NULL for an absence that is not against an entitlement: unpaid, or a
  -- training day the school does not count as leave.
  leave_type_id  uuid REFERENCES leave_type (id),

  starts_on      date NOT NULL,
  ends_on        date NOT NULL,
  -- A half day is the smallest unit any school here actually tracks.
  half_day       boolean NOT NULL DEFAULT false,

  status         text NOT NULL DEFAULT 'requested'
                   CHECK (status IN ('requested', 'approved', 'refused', 'cancelled')),
  reason         text,
  requested_at   timestamptz NOT NULL DEFAULT now(),
  decided_at     timestamptz,
  decided_by     uuid REFERENCES user_account (id),
  decision_note  text,

  CONSTRAINT staff_absence_dates_ordered CHECK (ends_on >= starts_on),
  CONSTRAINT staff_absence_half_day_is_one_day
    CHECK (NOT half_day OR starts_on = ends_on),
  CONSTRAINT staff_absence_decided_has_timestamp
    CHECK ((status IN ('approved', 'refused')) = (decided_at IS NOT NULL)),
  -- A refusal without a note is a decision somebody has to ask about in
  -- person, which is how a refusal becomes a grievance.
  CONSTRAINT staff_absence_refusal_has_note
    CHECK (status <> 'refused' OR length(trim(coalesce(decision_note, ''))) >= 5)
);

CREATE INDEX staff_absence_who_when_idx
  ON staff_absence (tenant_id, staff_id, starts_on DESC);
CREATE INDEX staff_absence_on_day_idx
  ON staff_absence (tenant_id, starts_on, ends_on) WHERE status = 'approved';

-- ---------------------------------------------------------------------------
-- Cover — the part that changes who can see what
-- ---------------------------------------------------------------------------

CREATE TABLE cover_assignment (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES organization (id),
  -- The section being covered. Named, never "everything this person taught":
  -- a blanket grant is how somebody ends up with a term's worth of access to
  -- a class they stood in front of once.
  section_id        uuid NOT NULL REFERENCES section (id),
  covering_staff_id uuid NOT NULL REFERENCES staff (id),
  -- Who is away. NULL for cover that is not against an absence — a vacancy
  -- between appointments, which is a real case and must not be forced into a
  -- fake absence row.
  absent_staff_id   uuid REFERENCES staff (id),
  staff_absence_id  uuid REFERENCES staff_absence (id),

  on_date           date NOT NULL,
  -- A single period, or the whole day when NULL. Per period because a cover
  -- teacher who takes one lesson should not thereby be able to mark the
  -- afternoon's register.
  period_no         smallint CHECK (period_no IS NULL OR period_no > 0),

  assigned_by       uuid REFERENCES user_account (id),
  assigned_at       timestamptz NOT NULL DEFAULT now(),
  note              text,

  -- Somebody covering for themselves is either a typo or a way of granting
  -- oneself access to a class with a paper trail that looks legitimate.
  CONSTRAINT cover_not_self CHECK (
    absent_staff_id IS NULL OR absent_staff_id <> covering_staff_id),
  CONSTRAINT cover_once UNIQUE (tenant_id, section_id, on_date, period_no,
                                covering_staff_id)
);

CREATE INDEX cover_today_idx
  ON cover_assignment (tenant_id, on_date, covering_staff_id);

COMMENT ON TABLE cover_assignment IS
  'The only thing in this schema that widens somebody''s reach. Dated to a '
  'day, named to a section, and attributed to whoever granted it — because '
  'cover without those three is a permission change with a friendly name.';

-- ---------------------------------------------------------------------------
-- Cover reaches the register
-- ---------------------------------------------------------------------------
--
-- `app_actor_section_ids()` is what every section-scoped policy in this system
-- consults. Adding cover to it is the smallest possible change and the one
-- with the widest blast radius, which is why the date bound is inside the
-- function rather than in whatever calls it.
--
-- CURRENT_DATE, not a parameter. A teacher looking at last Tuesday's register
-- for a class they covered last Tuesday is a real need, and it is not this:
-- granting it would mean the grant follows the date being viewed, and a
-- covering teacher could reach any day by asking for it.

CREATE OR REPLACE FUNCTION app_actor_section_ids() RETURNS uuid[]
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(array_agg(DISTINCT s.id), ARRAY[]::uuid[])
    FROM section s
    LEFT JOIN class_group cg ON cg.id = s.class_group_id
   WHERE s.tenant_id = app_current_tenant_id()
     AND EXISTS (
       SELECT 1 FROM staff st
        WHERE st.tenant_id = s.tenant_id
          AND st.deleted_at IS NULL
          AND st.person_id = app_current_person_id()
          AND (
            s.class_teacher_staff_id = st.id
            OR EXISTS (SELECT 1 FROM course_offering co
                        WHERE co.class_group_id = cg.id
                          AND co.primary_teacher_staff_id = st.id)
            OR EXISTS (SELECT 1 FROM schedule_slot sl
                        WHERE sl.section_id = s.id AND sl.staff_id = st.id)
            -- Relief cover, for today only. See 0073's header for why this
            -- exists at all: without it, the teacher standing in front of the
            -- class cannot mark its register, and somebody in the office
            -- marks it instead from what they were told.
            OR EXISTS (SELECT 1 FROM cover_assignment ca
                        WHERE ca.section_id = s.id
                          AND ca.tenant_id = s.tenant_id
                          AND ca.covering_staff_id = st.id
                          AND ca.on_date = CURRENT_DATE)))
$$;

COMMENT ON FUNCTION app_actor_section_ids() IS
  'Sections this staff member teaches, is class teacher of, is timetabled '
  'into, or is covering TODAY. Empty for somebody who teaches nothing — '
  'closed by default. The cover branch is dated deliberately: a teacher who '
  'covered 9B in March has no business in 9B''s register in September.';

-- ---------------------------------------------------------------------------
-- Who the caller is, as a member of staff
-- ---------------------------------------------------------------------------
--
-- Every policy below asks "is this row about me", and "me" here is a staff id
-- rather than a person or an account. SECURITY DEFINER because it reads
-- `staff`, whose own policy would otherwise be evaluated inside a policy on
-- another table — nested evaluation on the hot path, and a recursion risk the
-- moment `staff` is scoped by anything this function touches. The same reason
-- 0045 gave for `app_actor_section_ids`.
--
-- NULL for a guardian, a learner, or a platform console session. That is the
-- closed-by-default answer: a NULL never equals a staff_id, so every policy
-- below refuses rather than matching.

CREATE OR REPLACE FUNCTION app_current_staff_id() RETURNS uuid
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT st.id FROM staff st
   WHERE st.tenant_id = app_current_tenant_id()
     AND st.person_id = app_current_person_id()
     AND st.deleted_at IS NULL
   -- A person with two staff rows is a data error, and picking the live one
   -- is the safer failure than returning two and erroring in a policy.
   ORDER BY (st.status = 'active') DESC, st.joined_on DESC
   LIMIT 1
$$;

REVOKE ALL ON FUNCTION app_current_staff_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_current_staff_id() TO paathshala_app;

COMMENT ON FUNCTION app_current_staff_id() IS
  'The caller''s staff row in this school, or NULL for a guardian, a learner '
  'or a console session. NULL never equals a staff_id, so every policy that '
  'uses it refuses by default.';

-- ---------------------------------------------------------------------------
-- Privileges and policies
-- ---------------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE ON staff_contract, leave_type, leave_balance,
  staff_absence, cover_assignment TO paathshala_app;

ALTER TABLE staff_contract ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_contract FORCE ROW LEVEL SECURITY;
ALTER TABLE leave_type ENABLE ROW LEVEL SECURITY;
ALTER TABLE leave_type FORCE ROW LEVEL SECURITY;
ALTER TABLE leave_balance ENABLE ROW LEVEL SECURITY;
ALTER TABLE leave_balance FORCE ROW LEVEL SECURITY;
ALTER TABLE staff_absence ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_absence FORCE ROW LEVEL SECURITY;
ALTER TABLE cover_assignment ENABLE ROW LEVEL SECURITY;
ALTER TABLE cover_assignment FORCE ROW LEVEL SECURITY;

-- The list of leave types is not sensitive — it is the school's policy, and
-- every member of staff needs it to file a request.
CREATE POLICY tenant_isolation ON leave_type
  FOR ALL TO paathshala_app
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id()
              AND app_actor_has_whole_school_scope());

-- A contract is about one person's employment. They see their own; the office
-- sees everybody's. A head of department does not, because "department" is not
-- a scope this system models and inventing one here would be a guess about
-- somebody's org chart.
CREATE POLICY own_or_office ON staff_contract
  FOR ALL TO paathshala_app
  USING (tenant_id = app_current_tenant_id()
         AND (app_actor_has_whole_school_scope()
              OR staff_id = app_current_staff_id()))
  WITH CHECK (tenant_id = app_current_tenant_id()
              AND app_actor_has_whole_school_scope());

CREATE POLICY own_or_office ON leave_balance
  FOR ALL TO paathshala_app
  USING (tenant_id = app_current_tenant_id()
         AND (app_actor_has_whole_school_scope()
              OR staff_id = app_current_staff_id()))
  WITH CHECK (tenant_id = app_current_tenant_id()
              AND app_actor_has_whole_school_scope());

-- An absence is readable by the person it is about and by the office. NOT by
-- colleagues: "who is off sick this week" is a question about other people's
-- health, and a staff room does not need a screen for it.
--
-- The WITH CHECK lets a person file their OWN request and nobody else's, which
-- is the one write a non-office account may make here.
CREATE POLICY own_or_office ON staff_absence
  FOR ALL TO paathshala_app
  USING (tenant_id = app_current_tenant_id()
         AND (app_actor_has_whole_school_scope()
              OR staff_id = app_current_staff_id()))
  WITH CHECK (tenant_id = app_current_tenant_id()
              AND (app_actor_has_whole_school_scope()
                   OR staff_id = app_current_staff_id()));

-- Cover is readable by the person covering — they have to know — and by the
-- office. Writable only by the office: a teacher who could assign themselves
-- cover could assign themselves a class's register.
CREATE POLICY covering_or_office ON cover_assignment
  FOR ALL TO paathshala_app
  USING (tenant_id = app_current_tenant_id()
         AND (app_actor_has_whole_school_scope()
              OR covering_staff_id = app_current_staff_id()
              OR absent_staff_id = app_current_staff_id()))
  WITH CHECK (tenant_id = app_current_tenant_id()
              AND app_actor_has_whole_school_scope());

COMMENT ON POLICY covering_or_office ON cover_assignment IS
  'Written only by the office. A teacher who could assign themselves cover '
  'could assign themselves a class''s register, and the grant would look '
  'exactly like a legitimate one in the trail.';
