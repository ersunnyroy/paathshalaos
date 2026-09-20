-- 0066: transport (M20).
--
-- The module M16 already sells. The plan flag has existed since 0059 and had
-- nothing behind it, which is the wrong order to build things in: a gate that
-- guards nothing is a promise on a pricing page.
--
-- **What makes this different from every other module here is who is looking.**
-- A driver is not school staff in the ordinary sense. They need the name and
-- the stop of every child on their bus this afternoon, and they must not have
-- the school's admission register. A guardian needs to know which bus their own
-- child is on and must not learn which bus anybody else's child is on — a list
-- of children, their stops and their pickup times is precisely the document you
-- would want if you meant a child harm.
--
-- So the scoping here is narrower than `tenant_id = current tenant`, and it is
-- in the policies rather than in the services.

-- ---------------------------------------------------------------------------
-- The fleet
-- ---------------------------------------------------------------------------

CREATE TABLE vehicle (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES organization (id),
  campus_id       uuid REFERENCES campus (id),

  -- As painted on the bus. What a parent reads out over the phone.
  registration    text NOT NULL,
  display_name    text,

  capacity        integer NOT NULL CHECK (capacity > 0 AND capacity <= 120),

  -- Dates, because this is what a transport office is actually tracking and
  -- what a regulator asks for. NOT a validity boolean somebody has to remember
  -- to flip: an expiry that has to be maintained by hand is an expiry that is
  -- wrong by the time it matters.
  fitness_expires_on   date,
  insurance_expires_on date,
  permit_expires_on    date,

  status          text NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'maintenance', 'retired')),
  deleted_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT vehicle_registration_unique UNIQUE (tenant_id, registration)
);

-- A driver is a person with a licence, not a staff designation. Some schools
-- employ them; many contract them; either way the school is responsible for
-- who is behind the wheel of a bus carrying its children.
CREATE TABLE driver (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES organization (id),
  person_id       uuid NOT NULL REFERENCES person (id),

  licence_number  text NOT NULL,
  licence_expires_on date,
  -- Verified by the school, with a date, because "we checked" without a date
  -- is not a check.
  background_checked_on date,

  status          text NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'suspended', 'former')),
  deleted_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT driver_person_once UNIQUE (tenant_id, person_id)
);

-- ---------------------------------------------------------------------------
-- Routes and stops
-- ---------------------------------------------------------------------------

CREATE TABLE route (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES organization (id),
  campus_id     uuid NOT NULL REFERENCES campus (id),

  code          text NOT NULL,
  name          text NOT NULL,

  -- A morning route and an afternoon route are different runs with different
  -- children on them, and modelling them as one is how a child who goes home
  -- with a grandparent on Tuesdays gets marked missing.
  direction     text NOT NULL CHECK (direction IN ('pickup', 'drop', 'both')),

  status        text NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'suspended', 'retired')),
  deleted_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT route_code_unique UNIQUE (tenant_id, code)
);

CREATE TABLE route_stop (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES organization (id),
  route_id      uuid NOT NULL REFERENCES route (id) ON DELETE CASCADE,

  name          text NOT NULL,
  landmark      text,

  -- Where on the run. Gaps are allowed so a stop can be inserted without
  -- renumbering every stop after it.
  sequence_no   integer NOT NULL CHECK (sequence_no > 0),

  -- The time the bus is meant to be there. A parent standing at a stop wants a
  -- time, and "the bus left school at 3" is not one.
  pickup_time   time,
  drop_time     time,

  -- Coordinates are optional and deliberately not required: plenty of Indian
  -- stops are "the neem tree past the petrol pump", and refusing to store a
  -- stop without a latitude would mean refusing to store real stops.
  latitude      numeric(9,6) CHECK (latitude IS NULL OR latitude BETWEEN -90 AND 90),
  longitude     numeric(9,6) CHECK (longitude IS NULL OR longitude BETWEEN -180 AND 180),

  deleted_at    timestamptz,

  CONSTRAINT route_stop_sequence_unique UNIQUE (route_id, sequence_no)
);

CREATE INDEX route_stop_route_idx ON route_stop (route_id, sequence_no);

-- Which bus and driver run a route, from when. History rather than overwrite:
-- "which bus was my child on last Tuesday" has to be answerable after the
-- school swaps a vehicle out.
CREATE TABLE route_assignment (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES organization (id),
  route_id      uuid NOT NULL REFERENCES route (id),
  vehicle_id    uuid NOT NULL REFERENCES vehicle (id),
  driver_id     uuid NOT NULL REFERENCES driver (id),
  attendant_person_id uuid REFERENCES person (id),

  effective_from date NOT NULL DEFAULT CURRENT_DATE,
  effective_to   date,

  CONSTRAINT route_assignment_dates CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

-- One live assignment per route: two would make "which bus is this" a question
-- with two answers, and the code would pick whichever came first.
CREATE UNIQUE INDEX route_assignment_one_live
  ON route_assignment (route_id) WHERE effective_to IS NULL;

CREATE INDEX route_assignment_driver_idx ON route_assignment (driver_id, effective_to);

-- ---------------------------------------------------------------------------
-- Which child is on which bus
-- ---------------------------------------------------------------------------

CREATE TABLE transport_enrolment (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES organization (id),
  student_id    uuid NOT NULL REFERENCES student (id),

  route_id      uuid NOT NULL REFERENCES route (id),
  stop_id       uuid NOT NULL REFERENCES route_stop (id),

  direction     text NOT NULL CHECK (direction IN ('pickup', 'drop', 'both')),

  effective_from date NOT NULL DEFAULT CURRENT_DATE,
  effective_to   date,

  CONSTRAINT transport_enrolment_dates
    CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

-- A child can be on a pickup route and a different drop route, which is
-- ordinary, so the uniqueness is per direction rather than per child.
CREATE UNIQUE INDEX transport_enrolment_one_live
  ON transport_enrolment (student_id, direction) WHERE effective_to IS NULL;

CREATE INDEX transport_enrolment_route_idx
  ON transport_enrolment (route_id) WHERE effective_to IS NULL;

-- ---------------------------------------------------------------------------
-- Boarding
-- ---------------------------------------------------------------------------
--
-- The same shape as classroom attendance and for the same reason: a bus has no
-- signal for most of its run, so this is marked offline and synced later, keyed
-- on a client event id so a retry is a replay rather than a second boarding.
--
-- What it answers is the question a parent rings the school to ask: did my
-- child get on the bus, and did they get off at the right stop.

CREATE TABLE boarding_event (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES organization (id),

  student_id      uuid NOT NULL REFERENCES student (id),
  route_id        uuid NOT NULL REFERENCES route (id),
  stop_id         uuid REFERENCES route_stop (id),
  vehicle_id      uuid REFERENCES vehicle (id),

  on_date         date NOT NULL,
  direction       text NOT NULL CHECK (direction IN ('pickup', 'drop')),
  kind            text NOT NULL CHECK (kind IN ('boarded', 'alighted', 'absent', 'no_show')),

  -- Generated on the device before any network call, exactly as in M6.
  client_event_id uuid NOT NULL,

  -- What the device believed the time was. Never trusted; recorded because the
  -- gap between it and server time is itself worth seeing.
  device_recorded_at timestamptz,
  recorded_at     timestamptz NOT NULL DEFAULT now(),
  recorded_by     uuid REFERENCES user_account (id),

  note            text,

  CONSTRAINT boarding_event_idempotent UNIQUE (tenant_id, client_event_id)
);

CREATE INDEX boarding_event_child_idx
  ON boarding_event (tenant_id, student_id, on_date DESC);
CREATE INDEX boarding_event_route_idx
  ON boarding_event (route_id, on_date DESC);

-- ---------------------------------------------------------------------------
-- Who may see a child on a bus
-- ---------------------------------------------------------------------------
--
-- The whole point of this migration.
--
-- A manifest — children, stops, times — is the document you would want if you
-- meant a child harm. So it is not visible to "staff"; it is visible to the
-- people who need it for the run that is happening.

CREATE OR REPLACE FUNCTION app_driver_person_id()
RETURNS uuid
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT d.id FROM driver d
   WHERE d.tenant_id = app_current_tenant_id()
     AND d.person_id = app_current_person_id()
     AND d.deleted_at IS NULL
     AND d.status = 'active'
$$;

/*
 * Is the current actor responsible for this route today?
 *
 * Today, not ever: a driver who ran route 4 last term has no business reading
 * its manifest this term, and an assignment that ended is an assignment that
 * ended.
 */
CREATE OR REPLACE FUNCTION app_drives_route(p_route_id uuid)
RETURNS boolean
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM route_assignment ra
     WHERE ra.route_id = p_route_id
       AND ra.tenant_id = app_current_tenant_id()
       AND ra.effective_from <= CURRENT_DATE
       AND (ra.effective_to IS NULL OR ra.effective_to >= CURRENT_DATE)
       AND (ra.driver_id = app_driver_person_id()
            OR ra.attendant_person_id = app_current_person_id()))
$$;

/*
 * May the current actor see this child's transport arrangements?
 *
 * Three ways in, and no fourth:
 *   - the office, through the ordinary student-visibility rule from 0049, which
 *     already encodes section scope and guardian links;
 *   - the driver or attendant of the route the child is on TODAY;
 *   - nobody else, including other staff with `student:read`.
 */
CREATE OR REPLACE FUNCTION app_may_see_transport(p_student_id uuid)
RETURNS boolean
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT app_student_visible(p_student_id, app_current_person_id())
      OR EXISTS (
        SELECT 1 FROM transport_enrolment te
         WHERE te.student_id = p_student_id
           AND te.tenant_id = app_current_tenant_id()
           AND te.effective_to IS NULL
           AND app_drives_route(te.route_id))
$$;

REVOKE ALL ON FUNCTION app_driver_person_id() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_drives_route(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_may_see_transport(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_driver_person_id() TO paathshala_app;
GRANT EXECUTE ON FUNCTION app_drives_route(uuid) TO paathshala_app;
GRANT EXECUTE ON FUNCTION app_may_see_transport(uuid) TO paathshala_app;

-- ---------------------------------------------------------------------------
-- Privileges and policies
-- ---------------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE ON vehicle, driver, route, route_stop,
  route_assignment, transport_enrolment TO paathshala_app;
GRANT SELECT, INSERT ON boarding_event TO paathshala_app;

ALTER TABLE vehicle ENABLE ROW LEVEL SECURITY;
ALTER TABLE vehicle FORCE ROW LEVEL SECURITY;
ALTER TABLE driver ENABLE ROW LEVEL SECURITY;
ALTER TABLE driver FORCE ROW LEVEL SECURITY;
ALTER TABLE route ENABLE ROW LEVEL SECURITY;
ALTER TABLE route FORCE ROW LEVEL SECURITY;
ALTER TABLE route_stop ENABLE ROW LEVEL SECURITY;
ALTER TABLE route_stop FORCE ROW LEVEL SECURITY;
ALTER TABLE route_assignment ENABLE ROW LEVEL SECURITY;
ALTER TABLE route_assignment FORCE ROW LEVEL SECURITY;
ALTER TABLE transport_enrolment ENABLE ROW LEVEL SECURITY;
ALTER TABLE transport_enrolment FORCE ROW LEVEL SECURITY;
ALTER TABLE boarding_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE boarding_event FORCE ROW LEVEL SECURITY;

-- The fleet itself is not sensitive: a bus is a bus, and its registration is
-- painted on the side. Ordinary tenant isolation.
CREATE POLICY tenant_isolation ON vehicle
  FOR ALL TO paathshala_app
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());
CREATE POLICY tenant_isolation ON route
  FOR ALL TO paathshala_app
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());
CREATE POLICY tenant_isolation ON route_stop
  FOR ALL TO paathshala_app
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());
CREATE POLICY tenant_isolation ON route_assignment
  FOR ALL TO paathshala_app
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

-- A driver's licence number and background check are about a person, so this
-- follows the same visibility rule as any other person record.
CREATE POLICY driver_visibility ON driver
  FOR ALL TO paathshala_app
  USING (tenant_id = app_current_tenant_id()
         AND (person_id = app_current_person_id()
              OR app_actor_has_whole_school_scope()))
  WITH CHECK (tenant_id = app_current_tenant_id());

-- The manifest. This is the row that must not be readable by "staff".
CREATE POLICY transport_child_visibility ON transport_enrolment
  FOR ALL TO paathshala_app
  USING (tenant_id = app_current_tenant_id()
         AND app_may_see_transport(student_id))
  WITH CHECK (tenant_id = app_current_tenant_id()
              AND app_actor_has_whole_school_scope());

CREATE POLICY boarding_visibility ON boarding_event
  FOR ALL TO paathshala_app
  USING (tenant_id = app_current_tenant_id()
         AND app_may_see_transport(student_id))
  WITH CHECK (tenant_id = app_current_tenant_id()
              AND app_may_see_transport(student_id));

COMMENT ON TABLE transport_enrolment IS
  'Which child is on which bus. Readable by the office and by the driver of '
  'that route TODAY — not by staff generally: a list of children, their stops '
  'and their pickup times is the document you would want if you meant a child '
  'harm.';
COMMENT ON FUNCTION app_drives_route(uuid) IS
  'Today, not ever. A driver who ran this route last term has no business '
  'reading its manifest this term.';
