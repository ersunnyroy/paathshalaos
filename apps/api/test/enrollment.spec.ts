/**
 * M5.5-M5.6 — one active enrollment per learner per year, and the difference
 * between a section change and a campus transfer.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import {
  createTenant, destroyTenants, createUser, destroyUsers, grantRole, purgeTestData,
  createAcademicYear, createAcademicStructure, createLearnerRaw, linkGuardianRaw,
  createPersonRaw, createClassGroupRaw, createSectionFor,
  OWNER_URL, type TenantFixture, type UserFixture, type AcademicYearFixture, type LearnerFixture,
} from './fixtures.ts';
import { enrollmentService } from '../src/modules/enrollment/enrollment.service.ts';
import { withTenant } from '../src/db/tenant.ts';
import { pool } from '../src/db/pool.ts';
import { authPool } from '../src/db/auth-pool.ts';

let tenant: TenantFixture;
let staffUser: UserFixture;
let guardianUser: UserFixture;
let guardianPersonId: string;
let year: AcademicYearFixture;
let nextYear: AcademicYearFixture;
let struct: Awaited<ReturnType<typeof createAcademicStructure>>;
let sectionA: string;
let sectionB: string;
let sectionNextYear: string;
let learner: LearnerFixture;

const PASSWORD = 'correct-horse-battery';

beforeAll(async () => {
  await purgeTestData('%@enr-test.example');
  tenant = await createTenant('ENR');

  staffUser = await createUser('registrar@enr-test.example', PASSWORD);
  guardianUser = await createUser('parent@enr-test.example', PASSWORD);
  await grantRole(tenant.orgId, staffUser.userId, 'CAMPUS_ADMIN', 'campus', tenant.campusId);
  await grantRole(tenant.orgId, guardianUser.userId, 'GUARDIAN', 'self', tenant.campusId);
  guardianPersonId = await createPersonRaw(tenant.orgId, 'Nisha', {
    userAccountId: guardianUser.userId, familyName: 'Guardian',
  });

  struct = await createAcademicStructure(tenant.orgId, tenant.unitId, tenant.campusId);
  year = await createAcademicYear(tenant.orgId, tenant.unitId, '2026-27', 2026, { status: 'active' });
  nextYear = await createAcademicYear(tenant.orgId, tenant.unitId, '2027-28', 2027);

  const cg = await createClassGroupRaw(tenant.orgId, struct.programmeId, year.yearId, 'Class VII');
  sectionA = await createSectionFor(tenant.orgId, cg, 'A');
  sectionB = await createSectionFor(tenant.orgId, cg, 'B');

  const cgNext = await createClassGroupRaw(
    tenant.orgId, struct.programmeId, nextYear.yearId, 'Class VIII',
  );
  sectionNextYear = await createSectionFor(tenant.orgId, cgNext, 'A');

  learner = await createLearnerRaw(tenant.orgId, 'Rohan', 'ENR-0001');
  await linkGuardianRaw(tenant.orgId, learner.studentId, guardianPersonId);
});

afterAll(async () => {
  await destroyUsers([staffUser.userId, guardianUser.userId]);
  await destroyTenants([tenant.orgId]);
  await Promise.all([pool.end(), authPool.end()]);
});

const staff = () => ({ tenantId: tenant.orgId, actorId: staffUser.userId });
const guardian = () => ({ tenantId: tenant.orgId, actorId: guardianUser.userId });

async function asOwner<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: OWNER_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function enrol(studentId: string, sectionId: string, yearId: string, rollNo?: string) {
  return withTenant(staff(), async (db) => {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO enrollment (tenant_id, student_id, section_id, academic_year_id, roll_no)
       VALUES (app_current_tenant_id(), $1, $2, $3, $4) RETURNING id`,
      [studentId, sectionId, yearId, rollNo ?? null],
    );
    await db.query(
      `INSERT INTO enrollment_event (tenant_id, enrollment_id, event_type, to_section_id)
       VALUES (app_current_tenant_id(), $1, 'enrolled', $2)`,
      [rows[0]!.id, sectionId],
    );
    return rows[0]!.id;
  });
}

describe('one active enrollment per learner per academic year', () => {
  let enrollmentId: string;

  it('enrols the learner', async () => {
    enrollmentId = await enrol(learner.studentId, sectionA, year.yearId, '14');
    const current = await enrollmentService.current(staff(), learner.studentId);
    expect(current?.id).toBe(enrollmentId);
    expect(current?.roll_no).toBe('14');
  });

  it('refuses a second active enrollment in the same year', async () => {
    // The failure mode this prevents: a learner on two rolls and one fee
    // ledger, noticed in March.
    await expect(enrol(learner.studentId, sectionB, year.yearId)).rejects.toThrow(
      /enrollment_one_active_per_learner_per_year|duplicate key/i,
    );
  });

  it('allows an active enrollment in a different year', async () => {
    const next = await enrol(learner.studentId, sectionNextYear, nextYear.yearId);
    expect(next).toBeTruthy();
    await asOwner((c) => c.query(
      `UPDATE enrollment SET status = 'withdrawn', ended_on = CURRENT_DATE WHERE id = $1`, [next],
    ));
  });

  it('allows a new enrollment once the previous one has ended', async () => {
    const other = await createLearnerRaw(tenant.orgId, 'Sita', 'ENR-0002');
    const first = await enrol(other.studentId, sectionA, year.yearId);
    await enrollmentService.withdraw(staff(), {
      enrollmentId: first, reason: 'Family relocated mid-term.',
    });
    const second = await enrol(other.studentId, sectionB, year.yearId);
    expect(second).toBeTruthy();
  });

  it('refuses two active learners sharing a roll number in one section', async () => {
    const other = await createLearnerRaw(tenant.orgId, 'Tara', 'ENR-0003');
    await expect(enrol(other.studentId, sectionA, year.yearId, '14')).rejects.toThrow(
      /enrollment_roll_no_key|duplicate key/i,
    );
  });

  it('refuses a section from a different academic year', async () => {
    const other = await createLearnerRaw(tenant.orgId, 'Uma', 'ENR-0004');
    // A section belonging to 2027-28 cannot hold a 2026-27 enrollment, or every
    // downstream report disagrees with itself.
    await expect(enrol(other.studentId, sectionNextYear, year.yearId)).rejects.toThrow(
      /belongs to academic year/i,
    );
  });

  it('refuses an active enrollment with an end date, and vice versa', async () => {
    const other = await createLearnerRaw(tenant.orgId, 'Vikram', 'ENR-0005');
    await expect(
      asOwner((c) =>
        c.query(
          `INSERT INTO enrollment (tenant_id, student_id, section_id, academic_year_id,
                                   status, ended_on)
           VALUES ($1, $2, $3, $4, 'active', CURRENT_DATE)`,
          [tenant.orgId, other.studentId, sectionA, year.yearId],
        ),
      ),
    ).rejects.toThrow(/enrollment_status_matches_ended_on/i);
  });
});

describe('a section change keeps one enrollment', () => {
  let enrollmentId: string;

  beforeAll(async () => {
    const s = await createLearnerRaw(tenant.orgId, 'Wasim', 'ENR-0010');
    enrollmentId = await enrol(s.studentId, sectionA, year.yearId, '20');
  });

  it('moves the learner on the same row', async () => {
    const moved = await enrollmentService.changeSection(staff(), {
      enrollmentId, toSectionId: sectionB, reason: 'Balancing section sizes.',
    });
    // Same id: one fee assignment, one attendance history, one roll.
    expect(moved.id).toBe(enrollmentId);
    expect(moved.section_id).toBe(sectionB);
  });

  it('records the move as an event with both sections', async () => {
    const history = await enrollmentService.history(staff(), enrollmentId);
    const change = history.find((e) => e.event_type === 'section_changed');
    expect(change).toBeTruthy();
    expect(change!.from_section_id).toBe(sectionA);
    expect(change!.to_section_id).toBe(sectionB);
    expect(change!.reason).toMatch(/Balancing/);
  });

  it('requires a reason', async () => {
    await expect(
      enrollmentService.changeSection(staff(), {
        enrollmentId, toSectionId: sectionA, reason: '  ',
      }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('refuses a move to the section the learner is already in', async () => {
    await expect(
      enrollmentService.changeSection(staff(), {
        enrollmentId, toSectionId: sectionB, reason: 'No-op.',
      }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('refuses a move into another academic year', async () => {
    await expect(
      enrollmentService.changeSection(staff(), {
        enrollmentId, toSectionId: sectionNextYear, reason: 'Wrong year.',
      }),
    ).rejects.toThrow(/belongs to academic year/i);
  });
});

describe('a campus transfer ends one enrollment and opens another', () => {
  it('links both sides and keeps each history attributable', async () => {
    const s = await createLearnerRaw(tenant.orgId, 'Yash', 'ENR-0020');
    const source = await enrol(s.studentId, sectionA, year.yearId, '31');

    const { from, to } = await enrollmentService.transferCampus(staff(), {
      enrollmentId: source,
      toSectionId: sectionNextYear,
      toAcademicYearId: nextYear.yearId,
      reason: 'Moved to the senior campus.',
      rollNo: '5',
    });

    expect(from.status).toBe('transferred');
    expect(from.ended_on).not.toBeNull();
    expect(to.status).toBe('active');
    expect(to.id).not.toBe(from.id);

    // Two rows, because the learner genuinely belonged to two places and each
    // has its own roll, fees and attendance.
    expect(from.roll_no).toBe('31');
    expect(to.roll_no).toBe('5');

    const outbound = await enrollmentService.history(staff(), from.id);
    const inbound = await enrollmentService.history(staff(), to.id);
    const out = outbound.find((e) => e.event_type === 'transferred_out');
    const inn = inbound.find((e) => e.event_type === 'transferred_in');
    expect(out?.related_enrollment_id).toBe(to.id);
    expect(inn?.related_enrollment_id).toBe(from.id);
  });

  it('leaves exactly one active enrollment throughout', async () => {
    const s = await createLearnerRaw(tenant.orgId, 'Zara', 'ENR-0021');
    const source = await enrol(s.studentId, sectionA, year.yearId);
    await enrollmentService.transferCampus(staff(), {
      enrollmentId: source, toSectionId: sectionNextYear,
      toAcademicYearId: nextYear.yearId, reason: 'Transfer.',
    });

    const active = await withTenant(staff(), async (db) => {
      const r = await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM enrollment
          WHERE student_id = $1 AND status = 'active'`,
        [s.studentId],
      );
      return Number(r.rows[0]!.n);
    });
    expect(active).toBe(1);
  });

  it('refuses to transfer an enrollment that is not active', async () => {
    const s = await createLearnerRaw(tenant.orgId, 'Amit', 'ENR-0022');
    const source = await enrol(s.studentId, sectionA, year.yearId);
    await enrollmentService.withdraw(staff(), { enrollmentId: source, reason: 'Left.' });

    await expect(
      enrollmentService.transferCampus(staff(), {
        enrollmentId: source, toSectionId: sectionNextYear,
        toAcademicYearId: nextYear.yearId, reason: 'Too late.',
      }),
    ).rejects.toMatchObject({ status: 409 });
  });
});

describe('withdrawal and completion', () => {
  it('withdrawing records a reason and updates the learner lifecycle', async () => {
    const s = await createLearnerRaw(tenant.orgId, 'Bina', 'ENR-0030');
    const id = await enrol(s.studentId, sectionA, year.yearId);

    const closed = await enrollmentService.withdraw(staff(), {
      enrollmentId: id, reason: 'Transferred to a school in another city.',
    });
    expect(closed.status).toBe('withdrawn');
    expect(closed.ended_on).not.toBeNull();

    const lifecycle = await withTenant(staff(), async (db) => {
      const r = await db.query<{ lifecycle_status: string }>(
        'SELECT lifecycle_status FROM student WHERE id = $1', [s.studentId],
      );
      return r.rows[0]!.lifecycle_status;
    });
    expect(lifecycle).toBe('withdrawn');
  });

  it('completion is a separate outcome from withdrawal', async () => {
    const s = await createLearnerRaw(tenant.orgId, 'Chetan', 'ENR-0031');
    const id = await enrol(s.studentId, sectionA, year.yearId);
    const done = await enrollmentService.complete(staff(), { enrollmentId: id });
    expect(done.status).toBe('completed');

    const history = await enrollmentService.history(staff(), id);
    expect(history.some((e) => e.event_type === 'completed')).toBe(true);
  });

  it('requires a reason to withdraw', async () => {
    const s = await createLearnerRaw(tenant.orgId, 'Divya', 'ENR-0032');
    const id = await enrol(s.studentId, sectionA, year.yearId);
    await expect(
      enrollmentService.withdraw(staff(), { enrollmentId: id, reason: '' }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('refuses to close an already-closed enrollment', async () => {
    const s = await createLearnerRaw(tenant.orgId, 'Esha', 'ENR-0033');
    const id = await enrol(s.studentId, sectionA, year.yearId);
    await enrollmentService.withdraw(staff(), { enrollmentId: id, reason: 'Left.' });
    await expect(
      enrollmentService.withdraw(staff(), { enrollmentId: id, reason: 'Again.' }),
    ).rejects.toMatchObject({ status: 409 });
  });
});

describe('the lifecycle trail is append-only', () => {
  it('rejects UPDATE and DELETE on enrollment_event', async () => {
    await expect(
      asOwner((c) => c.query(`UPDATE enrollment_event SET event_type = 'enrolled'`)),
    ).rejects.toThrow(/append-only/i);
    await expect(
      asOwner((c) => c.query('DELETE FROM enrollment_event')),
    ).rejects.toThrow(/append-only/i);
  });

  it('keeps events for a reversed decision', async () => {
    const s = await createLearnerRaw(tenant.orgId, 'Farid', 'ENR-0040');
    const id = await enrol(s.studentId, sectionA, year.yearId);
    await enrollmentService.changeSection(staff(), {
      enrollmentId: id, toSectionId: sectionB, reason: 'First move.',
    });
    await enrollmentService.changeSection(staff(), {
      enrollmentId: id, toSectionId: sectionA, reason: 'Moved back.',
    });

    // Both moves stay on the record, including the one that undid the other.
    const history = await enrollmentService.history(staff(), id);
    const moves = history.filter((e) => e.event_type === 'section_changed');
    expect(moves).toHaveLength(2);
  });
});

describe('a guardian reads their learner enrollment but changes nothing', () => {
  it('can read it', async () => {
    const current = await enrollmentService.current(guardian(), learner.studentId);
    expect(current).toBeTruthy();
    expect(current!.student_id).toBe(learner.studentId);
  });

  it('cannot read an unlinked learner enrollment', async () => {
    const other = await createLearnerRaw(tenant.orgId, 'Gita', 'ENR-0050');
    await enrol(other.studentId, sectionB, year.yearId);
    const current = await enrollmentService.current(guardian(), other.studentId);
    expect(current).toBeUndefined();
  });

  it('cannot move their child to another section', async () => {
    const current = await enrollmentService.current(guardian(), learner.studentId);
    // The guardian can SELECT the row, so the read succeeds and the UPDATE is
    // refused by the separate staff-only write policy. Asserting on the error
    // code rather than the message, because HttpException's own message is just
    // "Http Exception" and a regex on it would pass for any failure at all.
    const err = await enrollmentService
      .changeSection(guardian(), {
        enrollmentId: current!.id, toSectionId: sectionB, reason: 'I prefer B.',
      })
      .catch((e) => e);
    expect(err.getStatus()).toBe(403);
    expect(err.getResponse().error.code).toBe('staff_only');
  });

  it('cannot withdraw their child', async () => {
    const current = await enrollmentService.current(guardian(), learner.studentId);
    await expect(
      enrollmentService.withdraw(guardian(), {
        enrollmentId: current!.id, reason: 'Leaving.',
      }),
    ).rejects.toMatchObject({ status: 409 });
  });
});
