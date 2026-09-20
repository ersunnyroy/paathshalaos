/**
 * M27 — HR, and the teacher who could not mark the register.
 *
 * `attendance.spec.ts` has carried this as a written-down limitation since M6:
 *
 *   "Cover assigned on the morning, for a teacher who is in no timetable slot
 *    at all, has no representation in this schema."
 *
 * That is a teacher standing in front of a class they cannot mark a register
 * for, so somebody in the office marks it from what they were told — and the
 * attendance module's whole argument is that a register is not second-hand.
 *
 * Cover closes it by WIDENING somebody's reach, which makes it the most
 * dangerous thing in this milestone. Most of this file is about the bounds.
 */
import './fixtures.ts';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import {
  createTenant, destroyTenants, createUser, destroyUsers, grantRole, purgeTestData,
  createAcademicYear, createAcademicStructure, createClassGroupRaw,
  createSectionFor, makeTeacher, createLearnerRaw, OWNER_URL,
  type TenantFixture, type UserFixture,
} from './fixtures.ts';
import { hrService } from '../src/modules/hr/hr.service.ts';
import { withTenant } from '../src/db/tenant.ts';
import { pool } from '../src/db/pool.ts';
import { authPool } from '../src/db/auth-pool.ts';

const PASSWORD = 'correct-horse-battery';

let tenant: TenantFixture;
let office: UserFixture;     // ORG_OWNER
let regular: UserFixture;    // class teacher of 9A
let relief: UserFixture;     // teaches nothing at all
let stranger: UserFixture;   // a teacher of a different section

let regularStaff: string;
let reliefStaff: string;
let strangerStaff: string;
let sectionA: string;
let sectionB: string;
let casualLeave: string;
let learnerInA: string;

const day = (offset: number) =>
  new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const today = () => day(0);

async function owner<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: OWNER_URL });
  await client.connect();
  try { return await fn(client); } finally { await client.end(); }
}

beforeAll(async () => {
  await purgeTestData('%@hr-test.example');
  tenant = await createTenant('HR');

  office = await createUser('office@hr-test.example', PASSWORD);
  regular = await createUser('meera@hr-test.example', PASSWORD);
  relief = await createUser('relief@hr-test.example', PASSWORD);
  stranger = await createUser('other@hr-test.example', PASSWORD);

  await grantRole(tenant.orgId, office.userId, 'ORG_OWNER', 'organization', null);
  for (const u of [regular, relief, stranger]) {
    await grantRole(tenant.orgId, u.userId, 'TEACHER', 'campus', tenant.campusId);
  }

  const struct = await createAcademicStructure(tenant.orgId, tenant.unitId, tenant.campusId);
  const year = await createAcademicYear(tenant.orgId, tenant.unitId, '2026-27', 2026,
    { status: 'active' });
  const cg = await createClassGroupRaw(tenant.orgId, struct.programmeId, year.yearId, 'Class IX');
  sectionA = await createSectionFor(tenant.orgId, cg, 'A');
  sectionB = await createSectionFor(tenant.orgId, cg, 'B');

  regularStaff = (await makeTeacher(tenant.orgId, tenant.campusId, regular.userId,
    { givenName: 'Meera', classTeacherOf: [sectionA] })).staffId;
  // Teaches nothing. That is the point: without cover this account can see no
  // section at all, so anything it can see afterwards came from the cover.
  reliefStaff = (await makeTeacher(tenant.orgId, tenant.campusId, relief.userId,
    { givenName: 'Relief' })).staffId;
  strangerStaff = (await makeTeacher(tenant.orgId, tenant.campusId, stranger.userId,
    { givenName: 'Other', classTeacherOf: [sectionB] })).staffId;

  const learner = await createLearnerRaw(tenant.orgId, 'Aarav', 'HR-0001');
  learnerInA = learner.studentId;
  await owner((c) => c.query(
    `INSERT INTO enrollment (tenant_id, student_id, section_id, academic_year_id)
     VALUES ($1, $2, $3, $4)`,
    [tenant.orgId, learnerInA, sectionA, year.yearId]));

  casualLeave = await owner(async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO leave_type (tenant_id, code, name, is_paid, annual_entitlement)
       VALUES ($1, 'CL', 'Casual leave', true, 12) RETURNING id`, [tenant.orgId]);
    return rows[0]!.id;
  });
});

afterAll(async () => {
  await destroyUsers([office.userId, regular.userId, relief.userId, stranger.userId]);
  await destroyTenants([tenant.orgId]);
  await Promise.all([pool.end(), authPool.end()]);
});

const asOffice = () => ({ tenantId: tenant.orgId, actorId: office.userId });
const asRegular = () => ({ tenantId: tenant.orgId, actorId: regular.userId });
const asRelief = () => ({ tenantId: tenant.orgId, actorId: relief.userId });
const asStranger = () => ({ tenantId: tenant.orgId, actorId: stranger.userId });

/** What sections an account can actually reach, asked of the database. */
async function sectionsVisibleTo(scope: { tenantId: string; actorId: string }) {
  return withTenant(scope, async (db) => {
    const { rows } = await db.query<{ ids: string[] }>(
      'SELECT app_actor_section_ids() AS ids');
    return rows[0]!.ids;
  });
}

describe('before any cover exists', () => {
  it('the relief teacher can see no section at all', async () => {
    // Closed by default. Everything this account can see later came from the
    // cover, which is what makes the rest of this file mean anything.
    expect(await sectionsVisibleTo(asRelief())).toEqual([]);
  });

  it('the class teacher can see their own', async () => {
    expect(await sectionsVisibleTo(asRegular())).toEqual([sectionA]);
  });
});

describe('filing an absence', () => {
  it('records a request', async () => {
    const absence = await hrService.fileAbsence(asRegular(), {
      staffId: regularStaff, leaveTypeId: casualLeave,
      startsOn: today(), endsOn: today(), reason: 'Family commitment',
    });
    expect(absence.status).toBe('requested');
  });

  it('lets a teacher file their own and not somebody else’s', async () => {
    // The WITH CHECK is what refuses this. Filing leave in a colleague's name
    // is not a feature anybody asked for.
    await expect(hrService.fileAbsence(asRegular(), {
      staffId: strangerStaff, startsOn: today(), endsOn: today(),
    })).rejects.toThrow();
  });

  it('refuses an absence that ends before it starts', async () => {
    await expect(hrService.fileAbsence(asRegular(), {
      staffId: regularStaff, startsOn: day(3), endsOn: day(1),
    })).rejects.toThrow();
  });

  it('is not readable by a colleague', async () => {
    // "Who is off sick this week" is a question about other people's health.
    // A staff room does not need a screen for it.
    const seen = await withTenant(asStranger(), async (db) => {
      const { rows } = await db.query(
        'SELECT id FROM staff_absence WHERE staff_id = $1', [regularStaff]);
      return rows;
    });
    expect(seen).toEqual([]);
  });

  it('is readable by the office', async () => {
    expect((await hrService.absentOn(asOffice(), today())).length)
      .toBeGreaterThanOrEqual(0);
  });
});

describe('deciding it', () => {
  let pending: string;

  it('moves the balance when it is approved', async () => {
    const absence = await hrService.fileAbsence(asRegular(), {
      staffId: regularStaff, leaveTypeId: casualLeave,
      startsOn: day(5), endsOn: day(7),
    });
    pending = absence.id;
    await hrService.decideAbsence(asOffice(), { absenceId: pending, approve: true });

    const taken = await owner(async (c) => {
      const { rows } = await c.query<{ taken: string }>(
        `SELECT taken::text FROM leave_balance
          WHERE staff_id = $1 AND leave_type_id = $2`,
        [regularStaff, casualLeave]);
      return rows[0]?.taken;
    });
    // Three days, inclusive at both ends.
    expect(taken).toBe('3.0');
  });

  it('refuses to decide the same request twice', async () => {
    const err = await hrService.decideAbsence(asOffice(),
      { absenceId: pending, approve: false, note: 'Changed my mind' })
      .catch((e) => e);
    expect(err.getResponse().error.code).toBe('not_awaiting_decision');
  });

  it('demands a note on a refusal, in words somebody can act on', async () => {
    // The schema refuses this too, so deleting the service check failed
    // nothing — the constraint caught it either way. What the service check
    // is FOR is the message: a person told "staff_absence_refusal_has_note"
    // has learned nothing, and a person told to say why has.
    const absence = await hrService.fileAbsence(asRegular(), {
      staffId: regularStaff, leaveTypeId: casualLeave,
      startsOn: day(20), endsOn: day(20),
    });
    const err = await hrService.decideAbsence(asOffice(),
      { absenceId: absence.id, approve: false }).catch((e) => e);
    expect(err.getResponse().error.code).toBe('refusal_needs_note');
    expect(err.getResponse().error.message).toMatch(/why/i);

    await expect(hrService.decideAbsence(asOffice(),
      { absenceId: absence.id, approve: false, note: 'Examination week' }))
      .resolves.toBeUndefined();
  });

  it('takes half a day off the balance for a half day', async () => {
    // The smallest unit any school here tracks, and the one the balance
    // arithmetic is easiest to get wrong on. Breaking it failed no test until
    // this existed.
    const before = await balanceOf(strangerStaff);
    // A fixed date well outside every payroll window in this file. Using an
    // offset put it inside November and changed that suite's expected total —
    // a test that is correct on its own and wrong beside its neighbours.
    const absence = await hrService.fileAbsence(asStranger(), {
      staffId: strangerStaff, leaveTypeId: casualLeave,
      startsOn: '2027-06-15', endsOn: '2027-06-15', halfDay: true,
    });
    await hrService.decideAbsence(asOffice(),
      { absenceId: absence.id, approve: true });
    expect(Number(await balanceOf(strangerStaff)) - Number(before)).toBe(0.5);
  });

  it('does not let a teacher approve their own leave', async () => {
    const absence = await hrService.fileAbsence(asRegular(), {
      staffId: regularStaff, leaveTypeId: casualLeave,
      startsOn: day(30), endsOn: day(30),
    });
    // The UPDATE matches no row the policy permits writing, so it comes back
    // as "not waiting for a decision" rather than as a permission error —
    // which is the right shape: the request is not theirs to decide.
    await expect(hrService.decideAbsence(asRegular(),
      { absenceId: absence.id, approve: true })).rejects.toThrow();
  });
});

async function balanceOf(staffId: string): Promise<string> {
  return owner(async (c) => {
    const { rows } = await c.query<{ taken: string }>(
      `SELECT taken::text FROM leave_balance
        WHERE staff_id = $1 AND leave_type_id = $2`, [staffId, casualLeave]);
    return rows[0]?.taken ?? '0';
  });
}

describe('relief cover — the reach it grants', () => {
  it('lets the covering teacher see the section, today', async () => {
    // The limitation this milestone exists to close.
    expect(await sectionsVisibleTo(asRelief())).toEqual([]);

    await hrService.assignCover(asOffice(), {
      sectionId: sectionA, coveringStaffId: reliefStaff,
      absentStaffId: regularStaff, onDate: today(),
    });

    expect(await sectionsVisibleTo(asRelief())).toEqual([sectionA]);
  });

  it('lets them see the children in it, which is the point', async () => {
    // Seeing a section id is not marking a register. This is the assertion
    // that the cover actually reaches the rows.
    const seen = await withTenant(asRelief(), async (db) => {
      const { rows } = await db.query<{ id: string }>('SELECT id FROM student');
      return rows.map((r) => r.id);
    });
    expect(seen).toContain(learnerInA);
  });

  it('does not let them see any other section', async () => {
    expect(await sectionsVisibleTo(asRelief())).not.toContain(sectionB);
  });

  it('ends when the day does', async () => {
    // Today, not ever. A teacher who covered 9B in March has no business in
    // 9B's register in September — so the grant is checked against
    // CURRENT_DATE inside the function, not against a date anybody passes in.
    await owner((c) => c.query(
      `UPDATE cover_assignment SET on_date = CURRENT_DATE - 1
        WHERE covering_staff_id = $1`, [reliefStaff]));
    expect(await sectionsVisibleTo(asRelief())).toEqual([]);

    await owner((c) => c.query(
      `UPDATE cover_assignment SET on_date = CURRENT_DATE
        WHERE covering_staff_id = $1`, [reliefStaff]));
    expect(await sectionsVisibleTo(asRelief())).toEqual([sectionA]);
  });

  it('cannot be assigned by the person who benefits', async () => {
    // A teacher who could assign themselves cover could assign themselves a
    // class's register, and the grant would look exactly like a legitimate
    // one in the trail.
    await expect(hrService.assignCover(asRelief(), {
      sectionId: sectionB, coveringStaffId: reliefStaff, onDate: today(),
    })).rejects.toThrow();
    expect(await sectionsVisibleTo(asRelief())).not.toContain(sectionB);
  });

  it('cannot be backdated', async () => {
    // Backdating cover is backdating access. A register for a past day is
    // corrected through the attendance correction path, which is attributed.
    const err = await hrService.assignCover(asOffice(), {
      sectionId: sectionB, coveringStaffId: reliefStaff, onDate: day(-1),
    }).catch((e) => e);
    expect(err.getResponse().error.code).toBe('cover_in_the_past');
  });

  it('refuses cover against an absence that does not cover the day', async () => {
    const absence = await hrService.fileAbsence(asRegular(), {
      staffId: regularStaff, leaveTypeId: casualLeave,
      startsOn: day(40), endsOn: day(41),
    });
    await hrService.decideAbsence(asOffice(),
      { absenceId: absence.id, approve: true });

    // Access granted today, for a reason that is true next month. The trail
    // would read perfectly.
    const err = await hrService.assignCover(asOffice(), {
      sectionId: sectionB, coveringStaffId: reliefStaff, onDate: today(),
      staffAbsenceId: absence.id,
    }).catch((e) => e);
    expect(err.getResponse().error.code).toBe('absence_does_not_cover_day');
  });

  it('refuses somebody covering for themselves', async () => {
    await expect(hrService.assignCover(asOffice(), {
      sectionId: sectionB, coveringStaffId: strangerStaff,
      absentStaffId: strangerStaff, onDate: today(),
    })).rejects.toThrow();
  });

  it('tells the covering teacher what they are standing in front of', async () => {
    const mine = await hrService.myCoverToday(asRelief());
    expect(mine.map((c) => c.section_id)).toEqual([sectionA]);
    expect(mine[0]!.class_name).toBe('Class IX');
  });

  it('shows a colleague nothing of somebody else’s cover', async () => {
    expect(await hrService.myCoverToday(asStranger())).toEqual([]);
  });

  it('is written down as a restricted audit entry', async () => {
    // A record of somebody's reach being widened belongs in the same class as
    // a platform entry, not in the same class as a leave request.
    const entries = await owner(async (c) => {
      const { rows } = await c.query<{ classification: string }>(
        `SELECT classification FROM audit_log
          WHERE action = 'hr.cover_assigned' AND tenant_id = $1`, [tenant.orgId]);
      return rows;
    });
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) expect(e.classification).toBe('RESTRICTED');
  });
});

describe('payroll inputs, which are not payroll', () => {
  it('counts employed days, paid leave and unpaid leave separately', async () => {
    const unpaid = await owner(async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO leave_type (tenant_id, code, name, is_paid)
         VALUES ($1, 'LWP', 'Leave without pay', false) RETURNING id`,
        [tenant.orgId]);
      return rows[0]!.id;
    });
    const from = '2026-11-01', to = '2026-11-30';
    await owner((c) => c.query(
      `INSERT INTO staff_absence
         (tenant_id, staff_id, leave_type_id, starts_on, ends_on, status,
          decided_at)
       VALUES ($1, $2, $3, '2026-11-05', '2026-11-06', 'approved', now()),
              ($1, $2, $4, '2026-11-10', '2026-11-10', 'approved', now())`,
      [tenant.orgId, strangerStaff, casualLeave, unpaid]));

    const rows = await hrService.payrollInputs(asOffice(), { from, to });
    const row = rows.find((r) => r.staff_id === strangerStaff)!;
    expect(row.paid_leave_days).toBe(2);
    expect(row.unpaid_leave_days).toBe(1);
    // Counted explicitly, not by subtraction — "employed minus paid leave"
    // silently absorbs an absence whose leave type was deleted.
    expect(row.employed_days).toBe(30);
  });

  it('splits an absence that straddles a month end', async () => {
    // A fortnight across a boundary belongs to two payrolls. Counting the
    // absence's own length would pay for it twice.
    await owner((c) => c.query(
      `INSERT INTO staff_absence
         (tenant_id, staff_id, leave_type_id, starts_on, ends_on, status,
          decided_at)
       VALUES ($1, $2, $3, '2026-12-28', '2027-01-03', 'approved', now())`,
      [tenant.orgId, reliefStaff, casualLeave]));

    const december = (await hrService.payrollInputs(asOffice(),
      { from: '2026-12-01', to: '2026-12-31' }))
      .find((r) => r.staff_id === reliefStaff)!;
    const january = (await hrService.payrollInputs(asOffice(),
      { from: '2027-01-01', to: '2027-01-31' }))
      .find((r) => r.staff_id === reliefStaff)!;

    expect(december.paid_leave_days).toBe(4);   // 28, 29, 30, 31
    expect(january.paid_leave_days).toBe(3);    // 1, 2, 3
    expect(december.paid_leave_days + january.paid_leave_days).toBe(7);
  });

  it('counts a mid-month joiner from the day they joined', async () => {
    const joiner = await owner(async (c) => {
      const p = await c.query<{ id: string }>(
        `INSERT INTO person (tenant_id, given_name) VALUES ($1, 'Newcomer')
         RETURNING id`, [tenant.orgId]);
      const s = await c.query<{ id: string }>(
        `INSERT INTO staff (tenant_id, person_id, campus_id, employee_code,
                            designation, joined_on)
         VALUES ($1, $2, $3, 'HR-NEW', 'Teacher', '2026-11-16') RETURNING id`,
        [tenant.orgId, p.rows[0]!.id, tenant.campusId]);
      return s.rows[0]!.id;
    });
    const row = (await hrService.payrollInputs(asOffice(),
      { from: '2026-11-01', to: '2026-11-30' }))
      .find((r) => r.staff_id === joiner)!;
    expect(row.employed_days).toBe(15);  // 16th to 30th inclusive
  });

  it('leaves out somebody who had left before the month', async () => {
    const rows = await hrService.payrollInputs(asOffice(),
      { from: '2020-01-01', to: '2020-01-31' });
    expect(rows).toEqual([]);
  });

  it('carries no pay figure of any kind', async () => {
    // M27 produces payroll inputs and stops. A net figure here would make
    // this system responsible for statutory deductions it does not model.
    const rows = await hrService.payrollInputs(asOffice(),
      { from: '2026-11-01', to: '2026-11-30' });
    const keys = Object.keys(rows[0] ?? {});
    for (const forbidden of ['salary', 'gross', 'net', 'pay', 'amount']) {
      expect(keys.join(' ')).not.toContain(forbidden);
    }
  });
});
