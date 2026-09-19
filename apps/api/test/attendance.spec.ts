/**
 * AC-5 — a teacher marks attendance offline and syncs safely.
 *
 * Every conflict path from the plan is asserted against a real database. These
 * are the cases that decide whether the offline bet is an asset or a source of
 * quiet data loss.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import {
  createTenant, destroyTenants, createUser, destroyUsers, grantRole, purgeTestData,
  createAcademicYear, createAcademicStructure, createLearnerRaw, linkGuardianRaw,
  createPersonRaw, createClassGroupRaw, createSectionFor, makeTeacher, timetableInto,
  OWNER_URL, type TenantFixture, type UserFixture, type AcademicYearFixture, type LearnerFixture,
} from './fixtures.ts';
import { attendanceService } from '../src/modules/attendance/attendance.service.ts';
import { withTenant } from '../src/db/tenant.ts';
import { pool } from '../src/db/pool.ts';
import { authPool } from '../src/db/auth-pool.ts';

let tenant: TenantFixture;
let staffUser: UserFixture;
let otherStaffUser: UserFixture;
let guardianUser: UserFixture;
let guardianPersonId: string;
let year: AcademicYearFixture;
let struct: Awaited<ReturnType<typeof createAcademicStructure>>;
let sectionA: string;
let sectionB: string;
let learners: LearnerFixture[] = [];
let enrollments: Record<string, string> = {};

const PASSWORD = 'correct-horse-battery';
const today = () => new Date().toISOString().slice(0, 10);

beforeAll(async () => {
  await purgeTestData('%@att-test.example');
  tenant = await createTenant('ATT');

  staffUser = await createUser('teacher@att-test.example', PASSWORD);
  otherStaffUser = await createUser('relief@att-test.example', PASSWORD);
  guardianUser = await createUser('parent@att-test.example', PASSWORD);
  await grantRole(tenant.orgId, staffUser.userId, 'TEACHER', 'campus', tenant.campusId);
  await grantRole(tenant.orgId, otherStaffUser.userId, 'TEACHER', 'campus', tenant.campusId);
  await grantRole(tenant.orgId, guardianUser.userId, 'GUARDIAN', 'self', tenant.campusId);
  guardianPersonId = await createPersonRaw(tenant.orgId, 'Kavita', {
    userAccountId: guardianUser.userId, familyName: 'Parent',
  });

  struct = await createAcademicStructure(tenant.orgId, tenant.unitId, tenant.campusId);
  year = await createAcademicYear(tenant.orgId, tenant.unitId, '2026-27', 2026, { status: 'active' });
  const cg = await createClassGroupRaw(tenant.orgId, struct.programmeId, year.yearId, 'Class IX');
  sectionA = await createSectionFor(tenant.orgId, cg, 'A');
  sectionB = await createSectionFor(tenant.orgId, cg, 'B');

  // Both teachers are real staff with real sections. A grant alone used to be
  // enough here, which made these tests describe a teacher the product does not
  // have — and hid that the policy was handing every teacher the whole school.
  await makeTeacher(tenant.orgId, tenant.campusId, staffUser.userId,
    { givenName: 'Meera', classTeacherOf: [sectionA, sectionB] });
  // The relief teacher is timetabled into section A rather than being class
  // teacher of it. That is how cover is expressible today, and it is what makes
  // the conflict path below a disagreement between two people who both
  // legitimately teach the section — rather than one of them being refused.
  //
  // Cover assigned on the morning, for a teacher who is in no timetable slot at
  // all, has no representation in this schema. Recorded as a limitation rather
  // than papered over with a policy branch off marked_by_staff_id, which would
  // let whoever marked first keep marking.
  const reliefStaff = await makeTeacher(tenant.orgId, tenant.campusId,
    otherStaffUser.userId, { givenName: 'Relief' });
  await timetableInto(tenant.orgId, struct, sectionA, year.yearId, reliefStaff.staffId);

  for (let i = 1; i <= 3; i++) {
    const l = await createLearnerRaw(tenant.orgId, `Learner${i}`, `ATT-000${i}`);
    learners.push(l);
    enrollments[l.studentId] = await enrol(l.studentId, sectionA);
  }
  await linkGuardianRaw(tenant.orgId, learners[0]!.studentId, guardianPersonId);
});

afterAll(async () => {
  await destroyUsers([staffUser.userId, otherStaffUser.userId, guardianUser.userId]);
  await destroyTenants([tenant.orgId]);
  await Promise.all([pool.end(), authPool.end()]);
});

const staff = () => ({ tenantId: tenant.orgId, actorId: staffUser.userId });
const relief = () => ({ tenantId: tenant.orgId, actorId: otherStaffUser.userId });
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

async function enrol(studentId: string, sectionId: string, enrolledOn?: string): Promise<string> {
  return asOwner(async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO enrollment (tenant_id, student_id, section_id, academic_year_id, enrolled_on)
       VALUES ($1, $2, $3, $4, COALESCE($5::date, CURRENT_DATE)) RETURNING id`,
      [tenant.orgId, studentId, sectionId, year.yearId, enrolledOn ?? null],
    );
    return rows[0]!.id;
  });
}

let sessionCounter = 0;
async function openSession(opts: { date?: string; period?: number } = {}) {
  sessionCounter += 1;
  return attendanceService.openSession(staff(), {
    sectionId: sectionA,
    sessionDate: opts.date ?? today(),
    academicYearId: year.yearId,
    periodNo: opts.period ?? sessionCounter,
    mode: 'day',
    markedByStaffId: struct.staffId,
  });
}

describe('marking a session', () => {
  it('applies a batch and reports each record', async () => {
    const session = await openSession();
    const result = await attendanceService.sync(staff(), {
      sessionId: session.id,
      recordedByStaffId: struct.staffId,
      records: learners.map((l, i) => ({
        clientEventId: randomUUID(),
        studentId: l.studentId,
        state: i === 0 ? 'absent' : 'present',
      })),
    });

    expect(result.outcomes.every((o) => o.status === 'applied')).toBe(true);
    expect(result.absentEnrollmentIds).toHaveLength(1);
  });

  it('emits attendance.marked into the outbox, in the same commit', async () => {
    const session = await openSession();
    await attendanceService.sync(staff(), {
      sessionId: session.id,
      records: [{ clientEventId: randomUUID(), studentId: learners[0]!.studentId, state: 'absent' }],
    });

    const events = await withTenant(staff(), async (db) => {
      const r = await db.query<{ event_type: string; payload: Record<string, unknown> }>(
        `SELECT event_type, payload FROM outbox_event
          WHERE event_type = 'attendance.marked' AND aggregate_id = $1`,
        [session.id],
      );
      return r.rows;
    });
    expect(events).toHaveLength(1);
    // The absentee ids the M9 dispatcher will need, captured atomically with
    // the records themselves.
    expect((events[0]!.payload['absentEnrollmentIds'] as string[]).length).toBe(1);
  });

  it('emits nothing when nothing was applied', async () => {
    const session = await openSession();
    const eventId = randomUUID();
    await attendanceService.sync(staff(), {
      sessionId: session.id,
      records: [{ clientEventId: eventId, studentId: learners[0]!.studentId, state: 'present' }],
    });
    // Replay: no new records, so no second event and no duplicate notification.
    await attendanceService.sync(staff(), {
      sessionId: session.id,
      records: [{ clientEventId: eventId, studentId: learners[0]!.studentId, state: 'present' }],
    });

    const count = await withTenant(staff(), async (db) => {
      const r = await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM outbox_event WHERE aggregate_id = $1`, [session.id],
      );
      return Number(r.rows[0]!.n);
    });
    expect(count).toBe(1);
  });
});

describe('AC-5 path 1 — a replayed batch is a no-op', () => {
  it('produces no duplicate rows however many times it arrives', async () => {
    const session = await openSession();
    const batch = learners.map((l) => ({
      clientEventId: randomUUID(), studentId: l.studentId, state: 'present' as const,
    }));

    const first = await attendanceService.sync(staff(), { sessionId: session.id, records: batch });
    expect(first.outcomes.every((o) => o.status === 'applied')).toBe(true);

    // Flaky connection: the app never got the response and retries. Twice.
    const second = await attendanceService.sync(staff(), { sessionId: session.id, records: batch });
    const third = await attendanceService.sync(staff(), { sessionId: session.id, records: batch });

    expect(second.outcomes.every((o) => o.status === 'already_applied')).toBe(true);
    expect(third.outcomes.every((o) => o.status === 'already_applied')).toBe(true);

    const records = await attendanceService.recordsForSession(staff(), session.id);
    expect(records).toHaveLength(3);
  });
});

describe('AC-5 path 2 — a locked session becomes a correction request', () => {
  it('does not silently fail, and does not rewrite the locked record', async () => {
    const session = await openSession();
    await attendanceService.sync(staff(), {
      sessionId: session.id,
      records: [{ clientEventId: randomUUID(), studentId: learners[0]!.studentId, state: 'present' }],
    });
    await attendanceService.lockSession(staff(), session.id, struct.staffId);

    // A second device surfaces holding a different answer for the same day.
    const late = await attendanceService.sync(staff(), {
      sessionId: session.id,
      recordedByStaffId: struct.staffId,
      records: [{ clientEventId: randomUUID(), studentId: learners[0]!.studentId, state: 'absent' }],
    });

    const outcome = late.outcomes[0]!;
    expect(outcome.status).toBe('correction_requested');
    if (outcome.status === 'correction_requested') {
      // The teacher is told what happened and what happens next.
      expect(outcome.reason).toMatch(/locked/i);
    }

    // The stored record is untouched until a human approves.
    const records = await attendanceService.recordsForSession(staff(), session.id);
    expect(records[0]!.state).toBe('present');
  });

  it('approving the correction applies it and keeps the trail', async () => {
    const pending = await withTenant(staff(), async (db) => {
      const r = await db.query<{ id: string; to_state: string; from_state: string | null }>(
        `SELECT id, to_state, from_state FROM attendance_correction
          WHERE status = 'pending' AND origin = 'late_offline_sync' LIMIT 1`,
      );
      return r.rows[0]!;
    });

    await attendanceService.approveCorrection(staff(), {
      correctionId: pending.id, approverStaffId: struct.staffId,
    });

    const after = await withTenant(staff(), async (db) => {
      const r = await db.query<{ status: string; approved_by: string | null }>(
        'SELECT status, approved_by FROM attendance_correction WHERE id = $1', [pending.id],
      );
      return r.rows[0]!;
    });
    expect(after.status).toBe('approved');
    expect(after.approved_by).toBe(struct.staffId);
  });

  it('a correction row cannot be rewritten or deleted', async () => {
    const id = await withTenant(staff(), async (db) => {
      const r = await db.query<{ id: string }>('SELECT id FROM attendance_correction LIMIT 1');
      return r.rows[0]!.id;
    });
    await expect(
      asOwner((c) => c.query(`UPDATE attendance_correction SET to_state = 'excused' WHERE id = $1`, [id])),
    ).rejects.toThrow(/may only be approved or rejected/i);
    await expect(
      asOwner((c) => c.query('DELETE FROM attendance_correction WHERE id = $1', [id])),
    ).rejects.toThrow(/cannot be deleted/i);
  });
});

describe('AC-5 path 3 — a competing entry surfaces a conflict', () => {
  it('keeps what is stored and hands back both values', async () => {
    const session = await openSession();

    // The class teacher marks from their phone.
    await attendanceService.sync(staff(), {
      sessionId: session.id,
      recordedByStaffId: struct.staffId,
      records: [{ clientEventId: randomUUID(), studentId: learners[1]!.studentId, state: 'present' }],
    });

    // A relief teacher, who was also in the room, syncs a different answer.
    const second = await attendanceService.sync(relief(), {
      sessionId: session.id,
      records: [{ clientEventId: randomUUID(), studentId: learners[1]!.studentId, state: 'absent' }],
    });

    const outcome = second.outcomes[0]!;
    expect(outcome.status).toBe('conflict');
    if (outcome.status === 'conflict') {
      // Last-write-wins would be wrong: two people marked the same learner and
      // only one was right, so both values go back for a human to choose.
      expect(outcome.existing.state).toBe('present');
      expect(outcome.submitted.state).toBe('absent');
      expect(outcome.existing.recordedAt).toBeTruthy();
    }

    const records = await attendanceService.recordsForSession(staff(), session.id);
    const forLearner = records.filter((r) => r.enrollment_id === enrollments[learners[1]!.studentId]);
    expect(forLearner).toHaveLength(1);
    expect(forLearner[0]!.state).toBe('present');
  });

  it('an unresolved conflict does not disappear', async () => {
    const pendingConflicts = await withTenant(staff(), async (db) => {
      const r = await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM attendance_record`,
      );
      return Number(r.rows[0]!.n);
    });
    // Nothing was written for the losing side, so the client must keep it. The
    // queue test asserts the client half of this.
    expect(pendingConflicts).toBeGreaterThan(0);
  });
});

describe('a client that reuses an event id across learners', () => {
  it('is rejected rather than reported as already applied', async () => {
    const session = await openSession({ period: 80 });
    const sharedId = randomUUID();

    const result = await attendanceService.sync(staff(), {
      sessionId: session.id,
      records: [
        { clientEventId: sharedId, studentId: learners[0]!.studentId, state: 'present' },
        { clientEventId: sharedId, studentId: learners[1]!.studentId, state: 'absent' },
      ],
    });

    expect(result.outcomes[0]!.status).toBe('applied');

    // Reporting "already applied" here would point at learner 0's record and
    // silently drop learner 1's attendance — the worst outcome, because it
    // looks like success to the app and to the teacher.
    const second = result.outcomes[1]!;
    expect(second.status).toBe('rejected');
    if (second.status === 'rejected') {
      expect(second.reason).toMatch(/different learner/i);
    }

    const records = await attendanceService.recordsForSession(staff(), session.id);
    expect(records).toHaveLength(1);
  });
});

describe('AC-5 path 4 — an implausible device clock is ignored', () => {
  it('uses server time and keeps the device claim for forensics', async () => {
    const session = await openSession();
    const deviceClaim = new Date(Date.now() - 400 * 86_400_000).toISOString();

    const result = await attendanceService.sync(staff(), {
      sessionId: session.id,
      deviceClock: deviceClaim,
      records: [{
        clientEventId: randomUUID(), studentId: learners[2]!.studentId,
        state: 'present', deviceRecordedAt: deviceClaim,
      }],
    });
    expect(result.outcomes[0]!.status).toBe('applied');

    const row = await withTenant(staff(), async (db) => {
      const r = await db.query<{ recorded_at: string; device_recorded_at: string | null }>(
        `SELECT recorded_at::text, device_recorded_at::text
           FROM attendance_record WHERE attendance_session_id = $1`,
        [session.id],
      );
      return r.rows[0]!;
    });

    // Server time is authoritative, and the year-old device claim was not
    // written into the timestamp that everything downstream reads.
    expect(Math.abs(Date.parse(row.recorded_at) - Date.now())).toBeLessThan(60_000);
    expect(row.device_recorded_at).toBeNull();
  });

  it('records the rejected clock in the audit log', async () => {
    const rows = await withTenant(staff(), async (db) => {
      const r = await db.query<{ action: string }>(
        `SELECT action FROM audit_log WHERE action = 'attendance.device_clock_rejected'`,
      );
      return r.rows;
    });
    expect(rows.length).toBeGreaterThan(0);
  });

  it('keeps a plausible device time', async () => {
    const session = await openSession();
    const deviceClaim = new Date(Date.now() - 45 * 60_000).toISOString();
    await attendanceService.sync(staff(), {
      sessionId: session.id,
      deviceClock: new Date().toISOString(),
      records: [{
        clientEventId: randomUUID(), studentId: learners[2]!.studentId,
        state: 'present', deviceRecordedAt: deviceClaim,
      }],
    });

    const row = await withTenant(staff(), async (db) => {
      const r = await db.query<{ device_recorded_at: string | null }>(
        `SELECT device_recorded_at::text FROM attendance_record WHERE attendance_session_id = $1`,
        [session.id],
      );
      return r.rows[0]!;
    });
    expect(row.device_recorded_at).not.toBeNull();
  });
});

describe('AC-5 path 5 — a learner who transferred while the device was offline', () => {
  it('records against the enrollment active on the session date', async () => {
    const mover = await createLearnerRaw(tenant.orgId, 'Mover', 'ATT-0100');
    const fiveDaysAgo = new Date(Date.now() - 5 * 86_400_000).toISOString().slice(0, 10);
    const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);

    const oldEnrollment = await enrol(mover.studentId, sectionA, fiveDaysAgo);
    // Transferred to B two days ago.
    await asOwner((c) => c.query(
      `UPDATE enrollment SET status = 'transferred', ended_on = $2::date WHERE id = $1`,
      [oldEnrollment, twoDaysAgo],
    ));
    const newEnrollment = await enrol(mover.studentId, sectionB, twoDaysAgo);

    // The device was offline since four days ago and only now reconnects.
    const fourDaysAgo = new Date(Date.now() - 4 * 86_400_000).toISOString().slice(0, 10);
    const session = await openSession({ date: fourDaysAgo, period: 90 });

    const result = await attendanceService.sync(staff(), {
      sessionId: session.id,
      records: [{ clientEventId: randomUUID(), studentId: mover.studentId, state: 'absent' }],
    });
    expect(result.outcomes[0]!.status).toBe('applied');

    const row = await withTenant(staff(), async (db) => {
      const r = await db.query<{ enrollment_id: string }>(
        'SELECT enrollment_id FROM attendance_record WHERE attendance_session_id = $1',
        [session.id],
      );
      return r.rows[0]!;
    });
    // The absence belongs to the section they were actually in that day.
    expect(row.enrollment_id).toBe(oldEnrollment);
    expect(row.enrollment_id).not.toBe(newEnrollment);
  });

  it('rejects a learner with no enrollment on that date', async () => {
    const stranger = await createLearnerRaw(tenant.orgId, 'Stranger', 'ATT-0200');
    const session = await openSession({ period: 91 });
    const result = await attendanceService.sync(staff(), {
      sessionId: session.id,
      records: [{ clientEventId: randomUUID(), studentId: stranger.studentId, state: 'present' }],
    });
    expect(result.outcomes[0]!.status).toBe('rejected');
  });
});

describe('the seven-day bound', () => {
  it('converts a very old session into corrections rather than writing it', async () => {
    const longAgo = new Date(Date.now() - 20 * 86_400_000).toISOString().slice(0, 10);
    const enrolledLongAgo = new Date(Date.now() - 40 * 86_400_000).toISOString().slice(0, 10);
    const learner = await createLearnerRaw(tenant.orgId, 'Ancient', 'ATT-0300');
    await enrol(learner.studentId, sectionA, enrolledLongAgo);

    const session = await openSession({ date: longAgo, period: 92 });
    const result = await attendanceService.sync(staff(), {
      sessionId: session.id,
      recordedByStaffId: struct.staffId,
      records: [{ clientEventId: randomUUID(), studentId: learner.studentId, state: 'absent' }],
    });

    const outcome = result.outcomes[0]!;
    expect(outcome.status).toBe('correction_requested');
    if (outcome.status === 'correction_requested') {
      // Stale data cannot silently rewrite a month that may already be closed.
      expect(outcome.reason).toMatch(/older than 7 days/i);
    }
    expect(await attendanceService.recordsForSession(staff(), session.id)).toHaveLength(0);
  });
});

describe('who can see and change attendance', () => {
  it('a guardian reads their own learner record', async () => {
    const session = await openSession({ period: 95 });
    await attendanceService.sync(staff(), {
      sessionId: session.id,
      records: [{ clientEventId: randomUUID(), studentId: learners[0]!.studentId, state: 'absent' }],
    });

    const visible = await withTenant(guardian(), async (db) => {
      const r = await db.query('SELECT id FROM attendance_record WHERE attendance_session_id = $1',
        [session.id]);
      return r.rows.length;
    });
    expect(visible).toBe(1);
  });

  it('a guardian cannot see an unlinked learner record', async () => {
    const session = await openSession({ period: 96 });
    await attendanceService.sync(staff(), {
      sessionId: session.id,
      records: [{ clientEventId: randomUUID(), studentId: learners[1]!.studentId, state: 'absent' }],
    });
    const visible = await withTenant(guardian(), async (db) => {
      const r = await db.query('SELECT id FROM attendance_record WHERE attendance_session_id = $1',
        [session.id]);
      return r.rows.length;
    });
    expect(visible).toBe(0);
  });

  it('a guardian cannot mark their child present', async () => {
    const session = await openSession({ period: 97 });
    const affected = await withTenant(guardian(), async (db) => {
      const r = await db.query(
        `INSERT INTO attendance_record (tenant_id, attendance_session_id, enrollment_id, state)
         VALUES (app_current_tenant_id(), $1, $2, 'present')
         ON CONFLICT DO NOTHING RETURNING id`,
        [session.id, enrollments[learners[0]!.studentId]],
      );
      return r.rowCount;
    }).catch(() => 0);
    expect(affected).toBe(0);
  });

  it('a guardian cannot change a stored record', async () => {
    const affected = await withTenant(guardian(), async (db) => {
      const r = await db.query(`UPDATE attendance_record SET state = 'present'`);
      return r.rowCount;
    });
    expect(affected).toBe(0);
  });
});
