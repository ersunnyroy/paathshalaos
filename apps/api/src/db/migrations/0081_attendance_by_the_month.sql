-- 0081: attendance_record, partitioned by the month it happened in (M30.1).
--
-- 0021 wrote down why this was deferred, and the reason was right at the time:
--
--   "a partitioned table's unique constraints must include the partition key —
--    so UNIQUE (tenant_id, client_event_id) would become
--    UNIQUE (tenant_id, session_date, client_event_id), and the offline
--    idempotency guarantee would hold only within a date rather than
--    absolutely."
--
-- What that reasoning missed is that **a record's date is not a free variable**.
-- It is the date of the session the record belongs to. A replayed batch carries
-- the same session id, so it resolves to the same date, so it lands in the same
-- partition, so it still collides. The offline guarantee survives the narrowing
-- intact — but only if the date is DERIVED and cannot be supplied.
--
-- So the date is derived, and the derivation is enforced by a composite foreign
-- key to `attendance_session (id, session_date)`: a record may only claim a date
-- that its own session agrees to. No caller can choose which partition a record
-- lands in, because no caller supplies a date — every INSERT reads it back out
-- of the session in the same statement.
--
-- The obvious implementation — a BEFORE ROW trigger that fills the column in —
-- does not work, and the reason is worth recording because it is not in the
-- error message anybody will search for. Tuple routing happens BEFORE a
-- partitioned table's row triggers fire on the chosen partition, so a row
-- arriving with a NULL key routes to the default partition, the trigger then
-- sets a real date, and PostgreSQL refuses: "moving row to another partition
-- during a BEFORE FOR EACH ROW trigger is not supported". The key has to be
-- right before the row is routed, which means it has to be in the INSERT.
--
-- That is not a weaker guarantee. It is the same one with fewer moving parts:
-- the foreign key refuses a wrong pair outright, whoever wrote it and however.
--
-- What genuinely changes, stated rather than discovered: the same
-- `client_event_id` submitted for two different learners on two DIFFERENT dates
-- is now accepted, where it used to be rejected as a client bug. The same id on
-- the same date is still caught, which is where the damage was — and
-- `one_per_enrollment` still makes a duplicate mark in any one session
-- impossible either way.
--
-- The lesson 0021 told this migration to remember — from 0009, that a policy on
-- a partitioned parent is not applied to a query naming a partition directly —
-- is handled at the bottom, and it is worse than 0021 expected. See §7.

------------------------------------------------------------------------------
-- 1. The invariant has to learn about partitions BEFORE anything is partitioned
------------------------------------------------------------------------------
--
-- `rls_coverage` (0004) is the check that every table with a `tenant_id` has
-- RLS enabled, forced, and at least one policy with an explicit WITH CHECK. It
-- selects `WHERE c.relkind = 'r'`.
--
-- A partitioned parent is relkind 'p'. Its partitions are 'r', and they each
-- have a `tenant_id` column. So the moment attendance_record is partitioned,
-- the invariant would stop looking at the table that matters and start
-- demanding policies on twelve partitions that neither have nor need them —
-- a policy lives on the parent and is applied to every partition reached
-- through it. The invariant would fail loudly for the wrong reason, and the
-- fix somebody reaches for at 2am is to drop the table from the check.
--
-- Partitions are excluded because their parent answers for them; partitioned
-- parents are included because they are the table.
CREATE OR REPLACE VIEW rls_coverage AS
SELECT
  c.relname                                   AS table_name,
  c.relrowsecurity                            AS rls_enabled,
  c.relforcerowsecurity                       AS rls_forced,
  COALESCE(p.policy_count, 0)                 AS policy_count,
  COALESCE(p.implicit_check_count, 0)         AS policies_without_explicit_with_check,
  (
    c.relrowsecurity
    AND c.relforcerowsecurity
    AND COALESCE(p.policy_count, 0) > 0
    AND COALESCE(p.implicit_check_count, 0) = 0
  ) AS is_covered
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND a.attnum > 0 AND NOT a.attisdropped
LEFT JOIN (
  SELECT
    polrelid,
    count(*) AS policy_count,
    -- polcmd: '*' = ALL, 'r' = SELECT, 'a' = INSERT, 'w' = UPDATE, 'd' = DELETE.
    -- Only the three that can write a row are required to be explicit — 0016's
    -- correction, and the reason this view is re-stated in full rather than
    -- patched: writing it out from memory reverted 0016 on the first attempt,
    -- and only the isolation suite's own invariant caught it.
    count(*) FILTER (
      WHERE polwithcheck IS NULL AND polcmd IN ('*', 'a', 'w')
    ) AS implicit_check_count
  FROM pg_policy GROUP BY polrelid
) p ON p.polrelid = c.oid
WHERE c.relkind IN ('r', 'p')
  AND NOT c.relispartition
  AND n.nspname = 'public';

GRANT SELECT ON rls_coverage TO paathshala_app;

------------------------------------------------------------------------------
-- 2. A session can be named together with its date
------------------------------------------------------------------------------
ALTER TABLE attendance_session
  ADD CONSTRAINT attendance_session_id_date_key UNIQUE (id, session_date);

------------------------------------------------------------------------------
-- 3. The partition factory
------------------------------------------------------------------------------
--
-- This system has one worker (the webhook relay) and no scheduler, which is
-- recorded elsewhere as a gap. A partitioned table that needs a monthly cron to
-- stay writable would turn that gap into an outage every 1st of the month, in
-- the one hour of the year when every teacher is marking a register.
--
-- So partitions are made on demand, by the path that opens a session, and there
-- is a DEFAULT partition underneath so that a date nobody anticipated is slow
-- rather than refused. "No partition of relation found" is an outage; a row in
-- the default is a row.
--
-- The awkward part of having a default is that PostgreSQL refuses to attach a
-- partition whose range overlaps rows already sitting in it. That is handled
-- here rather than left for whoever meets it: the rows are moved out of the
-- default and into the new partition in the same transaction as the attach.
CREATE OR REPLACE FUNCTION ensure_attendance_partition(p_day date)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_start date := date_trunc('month', p_day)::date;
  v_end   date := (date_trunc('month', p_day) + interval '1 month')::date;
  v_name  text := 'attendance_record_y' || to_char(v_start, 'YYYY') || 'm' || to_char(v_start, 'MM');
BEGIN
  IF to_regclass('public.' || v_name) IS NOT NULL THEN
    RETURN v_name;
  END IF;

  EXECUTE format('CREATE TABLE %I (LIKE attendance_record INCLUDING DEFAULTS INCLUDING CONSTRAINTS)', v_name);

  -- Declared before the attach so PostgreSQL can prove the rows are in range
  -- without scanning them. Without it the attach takes ACCESS EXCLUSIVE on the
  -- parent for the length of a full scan, which is every teacher's register
  -- waiting.
  EXECUTE format(
    'ALTER TABLE %I ADD CONSTRAINT %I CHECK (session_date >= %L AND session_date < %L)',
    v_name, v_name || '_range', v_start, v_end);

  -- Anything for this month that landed in the default before the partition
  -- existed. Almost always zero rows; the attach fails outright if it is not
  -- and they are left there.
  EXECUTE format(
    'WITH moved AS (DELETE FROM attendance_record_unscheduled
                     WHERE session_date >= %L AND session_date < %L RETURNING *)
     INSERT INTO %I SELECT * FROM moved', v_start, v_end, v_name);

  EXECUTE format(
    'ALTER TABLE attendance_record ATTACH PARTITION %I FOR VALUES FROM (%L) TO (%L)',
    v_name, v_start, v_end);

  RETURN v_name;
EXCEPTION
  -- Two teachers opening the first register of a month at the same second. The
  -- loser does not need to do anything; the partition it wanted exists.
  WHEN duplicate_table OR unique_violation THEN
    RETURN v_name;
END;
$$;

REVOKE ALL ON FUNCTION ensure_attendance_partition(date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ensure_attendance_partition(date) TO paathshala_app;

COMMENT ON FUNCTION ensure_attendance_partition(date) IS
  'Creates the monthly partition of attendance_record containing p_day, moving '
  'any rows already in the default partition into it. SECURITY DEFINER because '
  'the application role has no DDL rights and this system has no scheduler to '
  'do it out of band. Takes a date and nothing else; the name is built with '
  'to_char, so there is no string from a caller anywhere in the DDL.';

------------------------------------------------------------------------------
-- 4. Out with the old
------------------------------------------------------------------------------
CREATE TABLE attendance_record_carried AS
  SELECT r.*, s.session_date
    FROM attendance_record r
    JOIN attendance_session s ON s.id = r.attendance_session_id;

ALTER TABLE attendance_correction
  DROP CONSTRAINT attendance_correction_attendance_record_id_fkey;

DROP TABLE attendance_record;

------------------------------------------------------------------------------
-- 5. In with the new
------------------------------------------------------------------------------
CREATE TABLE attendance_record (
  id                     uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL REFERENCES organization (id),
  attendance_session_id  uuid NOT NULL,

  -- The partition key. Never typed by a caller: every INSERT reads it out of
  -- the session in the same statement, and the composite foreign key below
  -- refuses the pair if it is ever wrong. A client that could choose this
  -- could choose which partition its replay landed in, and the idempotency
  -- guarantee would be exactly the one 0021 was afraid of losing.
  session_date           date NOT NULL,

  enrollment_id          uuid NOT NULL REFERENCES enrollment (id),

  state                  text NOT NULL
                           CHECK (state IN ('present', 'absent', 'late', 'excused', 'half_day')),
  minutes_late           integer,

  source                 text NOT NULL DEFAULT 'app'
                           CHECK (source IN ('app', 'web', 'device', 'import')),

  client_event_id        uuid,
  device_recorded_at     timestamptz,
  recorded_at            timestamptz NOT NULL DEFAULT now(),
  recorded_by_staff_id   uuid REFERENCES staff (id),

  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),

  -- A partitioned table's primary key must contain the partition key.
  PRIMARY KEY (id, session_date),

  -- The whole design in one constraint: a record's session and a record's date
  -- must be a pair that the session table itself agrees on.
  CONSTRAINT attendance_record_belongs_to_its_session
    FOREIGN KEY (attendance_session_id, session_date)
    REFERENCES attendance_session (id, session_date) ON DELETE CASCADE,

  CONSTRAINT attendance_record_late_has_minutes
    CHECK (state <> 'late' OR minutes_late IS NOT NULL),
  CONSTRAINT attendance_record_minutes_sane
    CHECK (minutes_late IS NULL OR (minutes_late >= 0 AND minutes_late <= 600))
) PARTITION BY RANGE (session_date);

-- The backstop. Named for what it means rather than "default": a row in here is
-- one for a month nobody scheduled, and its presence is worth noticing.
CREATE TABLE attendance_record_unscheduled PARTITION OF attendance_record DEFAULT;

-- Both unique indexes gain the partition key, and both are unchanged in effect
-- because the key is derived from the session. See the header.
CREATE UNIQUE INDEX attendance_record_one_per_enrollment
  ON attendance_record (tenant_id, session_date, attendance_session_id, enrollment_id);
CREATE UNIQUE INDEX attendance_record_client_event_key
  ON attendance_record (tenant_id, session_date, client_event_id)
  WHERE client_event_id IS NOT NULL;
CREATE INDEX attendance_record_enrollment_idx
  ON attendance_record (tenant_id, enrollment_id, recorded_at DESC);
-- The parent-side index for the composite FK, which PostgreSQL does not create.
CREATE INDEX attendance_record_session_idx
  ON attendance_record (tenant_id, attendance_session_id);

------------------------------------------------------------------------------
-- 6. What is deliberately NOT here
------------------------------------------------------------------------------
--
-- There is no trigger filling in `session_date`. See the header: a BEFORE ROW
-- trigger fires after tuple routing on a partitioned table, so it cannot set
-- the column that decides the routing. The composite foreign key above is the
-- guarantee, and it is a stronger one — it refuses a wrong pair from any
-- writer, including a hand-typed UPDATE by somebody with the owner role.
--
CREATE TRIGGER attendance_record_set_updated_at
  BEFORE UPDATE ON attendance_record FOR EACH ROW EXECUTE FUNCTION set_updated_at();

------------------------------------------------------------------------------
-- 7. Row-level security, and the part 0021 could not have known
------------------------------------------------------------------------------
--
-- 0021 warned that "a policy on a partitioned parent is not applied to a query
-- naming a partition directly". True, and the defence is not a policy on every
-- partition — it is that the application role has no grant on any partition.
-- Privileges are checked against the table the query names, so the app cannot
-- name a partition at all; it can only come through the parent, where the
-- policies are.
--
-- Nothing below grants on a partition, and `ensure_attendance_partition` does
-- not either. That omission is the mechanism, so it is written down here rather
-- than left as something nobody thought of.
ALTER TABLE attendance_record ENABLE ROW LEVEL SECURITY;
ALTER TABLE attendance_record FORCE  ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON attendance_record TO paathshala_app;

CREATE POLICY record_read ON attendance_record
  FOR SELECT TO paathshala_app
  USING (
    tenant_id = app_current_tenant_id()
    AND (
      app_actor_has_staff_scope()
      OR EXISTS (
        SELECT 1 FROM enrollment e JOIN student s ON s.id = e.student_id
         WHERE e.id = attendance_record.enrollment_id
           AND s.person_id = app_current_person_id()
      )
      OR EXISTS (
        SELECT 1 FROM enrollment e JOIN guardian_link gl ON gl.student_id = e.student_id
         WHERE e.id = attendance_record.enrollment_id
           AND gl.guardian_person_id = app_current_person_id()
           AND gl.effective_to IS NULL
      )
    )
  );
CREATE POLICY record_staff_insert ON attendance_record
  FOR INSERT TO paathshala_app
  WITH CHECK (tenant_id = app_current_tenant_id() AND app_actor_has_staff_scope());
CREATE POLICY record_staff_update ON attendance_record
  FOR UPDATE TO paathshala_app
  USING (tenant_id = app_current_tenant_id() AND app_actor_has_staff_scope())
  WITH CHECK (tenant_id = app_current_tenant_id() AND app_actor_has_staff_scope());
CREATE POLICY record_staff_delete ON attendance_record
  FOR DELETE TO paathshala_app
  USING (tenant_id = app_current_tenant_id() AND app_actor_has_staff_scope());

------------------------------------------------------------------------------
-- 8. Partitions for what exists, and a window around today
------------------------------------------------------------------------------
DO $$
DECLARE d date;
BEGIN
  FOR d IN SELECT DISTINCT date_trunc('month', session_date)::date FROM attendance_session
  LOOP PERFORM ensure_attendance_partition(d); END LOOP;

  -- A year behind and two ahead, so a school importing last year's registers
  -- and one planning next year both stay off the default partition.
  FOR d IN SELECT generate_series(
             date_trunc('month', CURRENT_DATE - interval '12 months'),
             date_trunc('month', CURRENT_DATE + interval '24 months'),
             interval '1 month')::date
  LOOP PERFORM ensure_attendance_partition(d); END LOOP;
END $$;

INSERT INTO attendance_record
  (id, tenant_id, attendance_session_id, session_date, enrollment_id, state,
   minutes_late, source, client_event_id, device_recorded_at, recorded_at,
   recorded_by_staff_id, created_at, updated_at)
SELECT id, tenant_id, attendance_session_id, session_date, enrollment_id, state,
       minutes_late, source, client_event_id, device_recorded_at, recorded_at,
       recorded_by_staff_id, created_at, updated_at
  FROM attendance_record_carried;

DROP TABLE attendance_record_carried;

------------------------------------------------------------------------------
-- 9. The correction's reference, and a cascade that was never possible
------------------------------------------------------------------------------
--
-- The old constraint was `ON DELETE CASCADE`, and it could never have run:
-- `attendance_correction_append_only` fires BEFORE DELETE for every role and
-- raises unconditionally, so a cascade from attendance_record would always have
-- been refused by the trigger at the other end. The schema declared a behaviour
-- the database would never perform.
--
-- Re-declared as what actually happens. A record with evidence attached to it
-- cannot be deleted, and now the constraint says so — in a message naming the
-- constraint, rather than a trigger exception raised halfway through somebody
-- else's cascade.
--
-- The date comes along because the parent's key now has two columns. It is
-- maintained by the same trigger idea as the record's: derived, not supplied.
ALTER TABLE attendance_correction ADD COLUMN record_session_date date;

UPDATE attendance_correction c
   SET record_session_date = r.session_date
  FROM attendance_record r
 WHERE r.id = c.attendance_record_id;

ALTER TABLE attendance_correction
  ADD CONSTRAINT attendance_correction_record_has_date
    CHECK ((attendance_record_id IS NULL) = (record_session_date IS NULL)),
  ADD CONSTRAINT attendance_correction_attendance_record_id_fkey
    FOREIGN KEY (attendance_record_id, record_session_date)
    REFERENCES attendance_record (id, session_date) ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION attendance_correction_dates_its_record() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.attendance_record_id IS NULL THEN
    NEW.record_session_date := NULL;
  ELSE
    SELECT session_date INTO NEW.record_session_date
      FROM attendance_record WHERE id = NEW.attendance_record_id;
  END IF;
  RETURN NEW;
END;
$$;

-- BEFORE the append-only trigger, alphabetically, which is how PostgreSQL
-- orders triggers of the same kind — `attendance_correction_append_only` sorts
-- after `attendance_correction_dates_its_record`. That matters: the append-only
-- trigger refuses a rewrite of attendance_record_id, and this one must have
-- settled the date before it looks.
CREATE TRIGGER attendance_correction_dates_its_record
  BEFORE INSERT OR UPDATE ON attendance_correction
  FOR EACH ROW EXECUTE FUNCTION attendance_correction_dates_its_record();
