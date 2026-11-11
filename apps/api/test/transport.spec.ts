/**
 * M20 — transport, and the one document in this system that is dangerous.
 *
 * A manifest lists children, the corner they stand on, and the minute they
 * stand there. Every assertion in the first describe block exists because that
 * list must reach the driver running the route today and nobody else — not the
 * driver who ran it last term, not a teacher with `student:read`, not another
 * school. Those are not defence-in-depth extras; they are the feature.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import {
  createTenant, destroyTenants, createUser, destroyUsers, grantRole, purgeTestData,
  createAcademicYear, createAcademicStructure, createLearnerRaw, linkGuardianRaw,
  createPersonRaw, createClassGroupRaw, createSectionFor, makeTeacher,
  OWNER_URL, type TenantFixture, type UserFixture, type LearnerFixture,
} from './fixtures.ts';
import { transportService } from '../src/modules/transport/transport.service.ts';
import { withTenant } from '../src/db/tenant.ts';
import { pool } from '../src/db/pool.ts';
import { authPool } from '../src/db/auth-pool.ts';

const PASSWORD = 'correct-horse-battery';

let tenant: TenantFixture;
let other: TenantFixture;

let officeUser: UserFixture;      // ORG_OWNER — the transport office
let driverUser: UserFixture;      // drives route 1 today
let exDriverUser: UserFixture;    // drove route 1 until yesterday
let teacherUser: UserFixture;     // TEACHER, teaches nobody on a bus
let guardianUser: UserFixture;    // parent of child 1
let otherOfficeUser: UserFixture; // ORG_OWNER of the OTHER school

let driverPersonId: string;
let exDriverPersonId: string;
let guardianPersonId: string;

let driverId: string;
let exDriverId: string;
let vehicleId: string;
let routeOne: string;
let routeTwo: string;
let stopA: string;   // on route one
let stopB: string;   // on route one
let stopFar: string; // on route TWO

let children: LearnerFixture[] = [];

const today = () => new Date().toISOString().slice(0, 10);

async function owner<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: OWNER_URL });
  await client.connect();
  try { return await fn(client); } finally { await client.end(); }
}

beforeAll(async () => {
  await purgeTestData('%@bus-test.example');
  tenant = await createTenant('BUS');
  other = await createTenant('BUS2');

  officeUser = await createUser('office@bus-test.example', PASSWORD);
  driverUser = await createUser('driver@bus-test.example', PASSWORD);
  exDriverUser = await createUser('exdriver@bus-test.example', PASSWORD);
  teacherUser = await createUser('teacher@bus-test.example', PASSWORD);
  guardianUser = await createUser('parent@bus-test.example', PASSWORD);
  otherOfficeUser = await createUser('office@bus2-test.example', PASSWORD);

  await grantRole(tenant.orgId, officeUser.userId, 'ORG_OWNER', 'organization', null);
  await grantRole(tenant.orgId, driverUser.userId, 'TRANSPORT', 'campus', tenant.campusId);
  await grantRole(tenant.orgId, exDriverUser.userId, 'TRANSPORT', 'campus', tenant.campusId);
  await grantRole(tenant.orgId, teacherUser.userId, 'TEACHER', 'campus', tenant.campusId);
  await grantRole(tenant.orgId, guardianUser.userId, 'GUARDIAN', 'self', tenant.campusId);
  await grantRole(other.orgId, otherOfficeUser.userId, 'ORG_OWNER', 'organization', null);

  driverPersonId = await createPersonRaw(tenant.orgId, 'Ramesh',
    { userAccountId: driverUser.userId, familyName: 'Yadav' });
  exDriverPersonId = await createPersonRaw(tenant.orgId, 'Suresh',
    { userAccountId: exDriverUser.userId, familyName: 'Former' });
  guardianPersonId = await createPersonRaw(tenant.orgId, 'Kavita',
    { userAccountId: guardianUser.userId, familyName: 'Parent' });

  // A teacher who is a real teacher — class teacher of a section none of the
  // bus children are in. The point of this account is that having
  // `student:read` over SOME children buys nothing over transport rows.
  const struct = await createAcademicStructure(tenant.orgId, tenant.unitId, tenant.campusId);
  const year = await createAcademicYear(tenant.orgId, tenant.unitId, '2026-27', 2026,
    { status: 'active' });
  const cg = await createClassGroupRaw(tenant.orgId, struct.programmeId, year.yearId, 'Class IX');
  const section = await createSectionFor(tenant.orgId, cg, 'A');
  await makeTeacher(tenant.orgId, tenant.campusId, teacherUser.userId,
    { givenName: 'Meera', classTeacherOf: [section] });

  for (let i = 1; i <= 3; i++) {
    children.push(await createLearnerRaw(tenant.orgId, `Rider${i}`, `BUS-000${i}`));
  }
  await linkGuardianRaw(tenant.orgId, children[0]!.studentId, guardianPersonId);

  await owner(async (c) => {
    const v = await c.query<{ id: string }>(
      `INSERT INTO vehicle (tenant_id, campus_id, registration, capacity,
                            fitness_expires_on, insurance_expires_on, permit_expires_on)
       VALUES ($1, $2, 'KA01AB1234', 42, CURRENT_DATE + 10, CURRENT_DATE - 3,
               CURRENT_DATE + 200) RETURNING id`,
      [tenant.orgId, tenant.campusId]);
    vehicleId = v.rows[0]!.id;

    const d = await c.query<{ id: string }>(
      `INSERT INTO driver (tenant_id, person_id, licence_number, licence_expires_on)
       VALUES ($1, $2, 'DL-2031-0001', CURRENT_DATE + 400) RETURNING id`,
      [tenant.orgId, driverPersonId]);
    driverId = d.rows[0]!.id;

    const ed = await c.query<{ id: string }>(
      `INSERT INTO driver (tenant_id, person_id, licence_number, licence_expires_on)
       VALUES ($1, $2, 'DL-2029-0002', CURRENT_DATE + 30) RETURNING id`,
      [tenant.orgId, exDriverPersonId]);
    exDriverId = ed.rows[0]!.id;

    const r1 = await c.query<{ id: string }>(
      `INSERT INTO route (tenant_id, campus_id, code, name, direction)
       VALUES ($1, $2, 'R1', 'Jayanagar loop', 'both') RETURNING id`,
      [tenant.orgId, tenant.campusId]);
    routeOne = r1.rows[0]!.id;

    const r2 = await c.query<{ id: string }>(
      `INSERT INTO route (tenant_id, campus_id, code, name, direction)
       VALUES ($1, $2, 'R2', 'Whitefield loop', 'both') RETURNING id`,
      [tenant.orgId, tenant.campusId]);
    routeTwo = r2.rows[0]!.id;

    const s = await c.query<{ id: string }>(
      `INSERT INTO route_stop (tenant_id, route_id, name, sequence_no, pickup_time, drop_time)
       VALUES ($1, $2, '4th Block', 1, '07:10', '15:40') RETURNING id`,
      [tenant.orgId, routeOne]);
    stopA = s.rows[0]!.id;

    const s2 = await c.query<{ id: string }>(
      `INSERT INTO route_stop (tenant_id, route_id, name, sequence_no, pickup_time, drop_time)
       VALUES ($1, $2, '9th Main', 2, '07:22', '15:28') RETURNING id`,
      [tenant.orgId, routeOne]);
    stopB = s2.rows[0]!.id;

    const s3 = await c.query<{ id: string }>(
      `INSERT INTO route_stop (tenant_id, route_id, name, sequence_no, pickup_time, drop_time)
       VALUES ($1, $2, 'ITPL gate', 1, '06:55', '16:05') RETURNING id`,
      [tenant.orgId, routeTwo]);
    stopFar = s3.rows[0]!.id;

    // Today's crew on route one.
    await c.query(
      `INSERT INTO route_assignment (tenant_id, route_id, vehicle_id, driver_id, effective_from)
       VALUES ($1, $2, $3, $4, CURRENT_DATE - 7)`,
      [tenant.orgId, routeOne, vehicleId, driverId]);
    // Last term's crew, ended yesterday. Same route, same bus, different person.
    await c.query(
      `INSERT INTO route_assignment (tenant_id, route_id, vehicle_id, driver_id,
                                     effective_from, effective_to)
       VALUES ($1, $2, $3, $4, CURRENT_DATE - 200, CURRENT_DATE - 1)`,
      [tenant.orgId, routeOne, vehicleId, exDriverId]);

    // A phone number for child 1's guardian, so the manifest has one to carry.
    await c.query(
      `INSERT INTO contact_method (tenant_id, person_id, kind, value, is_primary)
       VALUES ($1, $2, 'phone', '+919845000111', true)`,
      [tenant.orgId, guardianPersonId]);
  });
});

afterAll(async () => {
  await destroyUsers([officeUser.userId, driverUser.userId, exDriverUser.userId,
    teacherUser.userId, guardianUser.userId, otherOfficeUser.userId]);
  await destroyTenants([tenant.orgId, other.orgId]);
  await Promise.all([pool.end(), authPool.end()]);
});

const office = () => ({ tenantId: tenant.orgId, actorId: officeUser.userId });
const driver = () => ({ tenantId: tenant.orgId, actorId: driverUser.userId });
const exDriver = () => ({ tenantId: tenant.orgId, actorId: exDriverUser.userId });
const teacher = () => ({ tenantId: tenant.orgId, actorId: teacherUser.userId });
const guardian = () => ({ tenantId: tenant.orgId, actorId: guardianUser.userId });
const otherOffice = () => ({ tenantId: other.orgId, actorId: otherOfficeUser.userId });

describe('who may read a manifest', () => {
  it('the office puts children on the bus', async () => {
    await transportService.assignChild(office(), {
      studentId: children[0]!.studentId, routeId: routeOne,
      stopId: stopA, direction: 'both',
    });
    await transportService.assignChild(office(), {
      studentId: children[1]!.studentId, routeId: routeOne,
      stopId: stopB, direction: 'both',
    });
    // Child 3 rides a different route, which is what makes "only your route"
    // a claim with something to fail against.
    await transportService.assignChild(office(), {
      studentId: children[2]!.studentId, routeId: routeTwo,
      stopId: stopFar, direction: 'both',
    });

    const rows = await transportService.manifest(office(),
      { routeId: routeOne, direction: 'pickup' });
    expect(rows.map((r) => r.admission_no)).toEqual(['BUS-0001', 'BUS-0002']);
  });

  it('gives the driver of the route today the children, their stops and a phone', async () => {
    const rows = await transportService.manifest(driver(),
      { routeId: routeOne, direction: 'pickup' });

    expect(rows.map((r) => r.admission_no)).toEqual(['BUS-0001', 'BUS-0002']);
    // Sequence order, not alphabetical: this is the order the bus meets them in.
    expect(rows.map((r) => r.sequence_no)).toEqual([1, 2]);
    expect(rows[0]!.stop_name).toBe('4th Block');
    expect(rows[0]!.pickup_time).toBe('07:10:00');
    // The number the driver rings when a child is not at the kerb.
    expect(rows[0]!.guardian_phone).toBe('+919845000111');
  });

  it('refuses that driver a route they do not run', async () => {
    // Refused, not emptied. A driver handed [] cannot tell "you are not on
    // this route today" from "nobody is booked" — and the second of those is
    // a reason to drive off.
    const err = await transportService.manifest(driver(),
      { routeId: routeTwo, direction: 'pickup' }).catch((e) => e);
    expect(err.getResponse().error.code).toBe('not_this_route');
  });

  it('refuses the driver whose assignment ended yesterday', async () => {
    // Same person, same route, same bus — and the assignment closed at
    // midnight. "Drove it last term" is not a reason to hold the list.
    const err = await transportService.manifest(exDriver(),
      { routeId: routeOne, direction: 'pickup' }).catch((e) => e);
    expect(err.getResponse().error.code).toBe('not_this_route');
  });

  it('gives a teacher with student:read nothing at all', async () => {
    const err = await transportService.manifest(teacher(),
      { routeId: routeOne, direction: 'pickup' }).catch((e) => e);
    expect(err.getResponse().error.code).toBe('not_this_route');

    // And not through the raw table either, in case the document function is
    // what happens to refuse rather than the policy underneath it.
    const raw = await withTenant(teacher(), async (db) => {
      const { rows } = await db.query('SELECT id FROM transport_enrolment');
      return rows;
    });
    expect(raw).toEqual([]);
  });

  it('drops a driver the moment they are suspended', async () => {
    // Suspension has to take effect on the next request, not at the next
    // roster change. A school suspends a driver for a reason, and "we will
    // take them off route 1 on Monday" is not a safeguarding answer.
    await owner(async (c) => {
      await c.query(`UPDATE driver SET status = 'suspended' WHERE id = $1`, [driverId]);
    });
    const err = await transportService.manifest(driver(),
      { routeId: routeOne, direction: 'pickup' }).catch((e) => e);
    expect(err.getResponse().error.code).toBe('not_this_route');

    await owner(async (c) => {
      await c.query(`UPDATE driver SET status = 'active' WHERE id = $1`, [driverId]);
    });
    const back = await transportService.manifest(driver(),
      { routeId: routeOne, direction: 'pickup' });
    expect(back).toHaveLength(2);
  });

  it('gives another school nothing', async () => {
    // Whole-school scope passes the door check — in their OWN school. The
    // route belongs to a different tenant, so there is nothing behind it.
    const rows = await transportService.manifest(otherOffice(),
      { routeId: routeOne, direction: 'pickup' });
    expect(rows).toEqual([]);
  });
});

describe('a guardian', () => {
  it('sees their own child’s bus', async () => {
    const seen = await transportService.forChild(guardian(), children[0]!.studentId);
    expect(seen?.route_code).toBe('R1');
    expect(seen?.stop_name).toBe('4th Block');
    expect(seen?.vehicle_registration).toBe('KA01AB1234');
  });

  it('sees nothing for a child who is not theirs', async () => {
    const seen = await transportService.forChild(guardian(), children[1]!.studentId);
    expect(seen).toBeNull();
  });

  it('cannot put a child on a bus', async () => {
    // WITH CHECK on transport_enrolment demands whole-school scope. A parent
    // choosing their own stop is a request to the office, not a write.
    await expect(transportService.assignChild(guardian(), {
      studentId: children[0]!.studentId, routeId: routeOne,
      stopId: stopB, direction: 'pickup',
    })).rejects.toThrow();
  });
});

describe('moving a child', () => {
  it('amends an arrangement that has not carried anyone yet', async () => {
    // Child 2 was put on stop B earlier today. Correcting that five minutes
    // later is a correction, not a move: closing the first row the day before
    // it opened would record a journey from Tuesday to Monday.
    await transportService.assignChild(office(), {
      studentId: children[1]!.studentId, routeId: routeOne,
      stopId: stopA, direction: 'both',
    });

    const rows = await owner(async (c) => {
      const { rows } = await c.query<{ stop_id: string }>(
        `SELECT stop_id FROM transport_enrolment WHERE student_id = $1`,
        [children[1]!.studentId]);
      return rows;
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.stop_id).toBe(stopA);
  });

  it('ends the old arrangement instead of erasing it', async () => {
    // Now the arrangement has been running a fortnight, so changing it is a
    // move and the old row has to survive: "which bus was my child on last
    // Tuesday" must stay answerable after the office moves them.
    await owner(async (c) => {
      await c.query(
        `UPDATE transport_enrolment SET effective_from = CURRENT_DATE - 14
          WHERE student_id = $1 AND effective_to IS NULL`,
        [children[1]!.studentId]);
    });

    await transportService.assignChild(office(), {
      studentId: children[1]!.studentId, routeId: routeOne,
      stopId: stopB, direction: 'both',
    });

    const rows = await owner(async (c) => {
      const { rows } = await c.query<{ stop_id: string; effective_to: string | null }>(
        `SELECT stop_id, effective_to::text FROM transport_enrolment
          WHERE student_id = $1 ORDER BY effective_from, effective_to NULLS LAST`,
        [children[1]!.studentId]);
      return rows;
    });

    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.effective_to === null)).toHaveLength(1);
    expect(rows.find((r) => r.effective_to === null)!.stop_id).toBe(stopB);
    // The closed row kept where the child used to get off.
    expect(rows.find((r) => r.effective_to !== null)!.stop_id).toBe(stopA);
  });

  it('refuses a stop that is not on the route', async () => {
    // The failure this prevents is a child assigned to a stop the bus never
    // reaches, which looks correct on every screen until the afternoon.
    const err = await transportService.assignChild(office(), {
      studentId: children[0]!.studentId, routeId: routeOne,
      stopId: stopFar, direction: 'pickup',
    }).catch((e) => e);
    expect(err.getResponse().error.code).toBe('stop_not_on_route');
  });
});

describe('boarding from a bus with no signal', () => {
  it('records once and replays the retry', async () => {
    const clientEventId = randomUUID();
    const event = {
      clientEventId, studentId: children[0]!.studentId, routeId: routeOne,
      stopId: stopA, vehicleId, direction: 'pickup' as const,
      kind: 'boarded' as const,
    };

    const first = await transportService.recordBoarding(driver(), [event]);
    expect(first).toEqual({ recorded: 1, replayed: 0 });

    // The device came back into signal and sent its queue again. Same id,
    // because the id was minted before the first attempt and never regenerated.
    const second = await transportService.recordBoarding(driver(), [event]);
    expect(second).toEqual({ recorded: 0, replayed: 1 });

    const count = await owner(async (c) => {
      const { rows } = await c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM boarding_event
          WHERE student_id = $1 AND on_date = CURRENT_DATE`,
        [children[0]!.studentId]);
      return Number(rows[0]!.n);
    });
    expect(count).toBe(1);
  });

  it('shows on the manifest as today’s state', async () => {
    const rows = await transportService.manifest(driver(),
      { routeId: routeOne, direction: 'pickup' });
    const child = rows.find((r) => r.admission_no === 'BUS-0001');
    expect(child?.boarded_today).toBe('boarded');
  });

  it('refuses a driver marking a child on a route they do not run', async () => {
    // WITH CHECK, not USING: the insert itself is what must fail, because a
    // policy that only filters reads still lets a stranger write rows into a
    // child's record.
    await expect(transportService.recordBoarding(exDriver(), [{
      clientEventId: randomUUID(), studentId: children[0]!.studentId,
      routeId: routeOne, direction: 'pickup', kind: 'boarded',
    }])).rejects.toThrow();
  });

  it('refuses a stranger writing into a child’s record, at the table', async () => {
    // Asserted with a bare INSERT rather than through recordBoarding, because
    // the service insert carries ON CONFLICT DO NOTHING — and Postgres applies
    // a FOR ALL policy's USING clause on that path as well as its WITH CHECK.
    // Going through the service therefore passes whether or not the WITH CHECK
    // says anything at all, so the assertion above proves idempotency, not
    // authority. A mutation that weakened the WITH CHECK to tenant_id alone
    // left every test green; this is the one that catches it.
    await expect(withTenant(exDriver(), async (db) =>
      db.query(`INSERT INTO boarding_event
          (tenant_id, student_id, route_id, on_date, direction, kind, client_event_id)
        VALUES (app_current_tenant_id(), $1, $2, CURRENT_DATE, 'pickup', 'boarded',
                gen_random_uuid())`, [children[0]!.studentId, routeOne])))
      .rejects.toThrow(/row-level security/);
  });
});

describe('papers that expire', () => {
  it('lists what has lapsed first, then what is about to', async () => {
    const due = await transportService.complianceDue(office(), 45);
    const kinds = due.map((d) => d.kind);

    // Insurance lapsed three days ago; fitness goes in ten days. An expiry
    // report that only warns about the future is no use on the day.
    expect(kinds[0]).toBe('vehicle_insurance');
    expect(due[0]!.days_left).toBeLessThan(0);
    expect(kinds).toContain('vehicle_fitness');
    // The permit is 200 days out and the driver's licence 400. Neither is due.
    // The permit is 200 days out, well beyond the window.
    expect(kinds).not.toContain('vehicle_permit');
  });

  it('hands back a calendar day, not an instant', async () => {
    // A `date` that crosses as a JavaScript Date is midnight UTC, which in IST
    // is the evening before — so a certificate expiring on the 16th reaches
    // the school as the 15th. The column is a calendar day and has no business
    // becoming a timestamp on the way out.
    const due = await transportService.complianceDue(office(), 45);
    expect(due[0]!.expires_on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('includes a licence that expires inside the window', async () => {
    // The former driver's licence has 30 days on it.
    const due = await transportService.complianceDue(office(), 45);
    expect(due.filter((d) => d.kind === 'driver_licence')).toHaveLength(1);
  });
});
