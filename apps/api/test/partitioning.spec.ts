/**
 * M30.1 — attendance_record, partitioned by month.
 *
 * 0021 deferred this with a reason: a partitioned table's unique constraints
 * must include the partition key, so the offline idempotency guarantee —
 * `UNIQUE (tenant_id, client_event_id)` — would narrow to hold only within a
 * date. The claim this milestone makes is that the narrowing costs nothing,
 * because a record's date is its SESSION's date and a replay carries the same
 * session id.
 *
 * That claim is only true while the date cannot be chosen by a caller, so the
 * first thing asserted here is that it cannot be. The rest is the machinery
 * around it: routing, pruning, the backstop, and the two ways a partitioned
 * table quietly loses its row-level security.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import {
  createTenant, destroyTenants, createUser, destroyUsers, grantRole, purgeTestData,
  createAcademicYear, createAcademicStructure, createLearnerRaw,
  createClassGroupRaw, createSectionFor, makeTeacher,
  OWNER_URL, type TenantFixture, type UserFixture, type AcademicYearFixture,
} from './fixtures.ts';
import { attendanceService } from '../src/modules/attendance/attendance.service.ts';
import { withTenant } from '../src/db/tenant.ts';
import { pool } from '../src/db/pool.ts';
import { authPool } from '../src/db/auth-pool.ts';

const PASSWORD = 'correct-horse-battery';

let tenant: TenantFixture;
let staffUser: UserFixture;
let year: AcademicYearFixture;
let sectionA = '';
let staffId = '';
let enrollmentId = '';
let studentId = '';

const staff = () => ({ tenantId: tenant.orgId, actorId: staffUser.userId });

async function asOwner<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: OWNER_URL });
  await client.connect();
  try { return await fn(client); } finally { await client.end(); }
}

/** Which partition a record physically lives in. */
async function partitionOf(recordId: string): Promise<string> {
  return asOwner(async (c) => {
    const { rows } = await c.query<{ t: string }>(
      'SELECT tableoid::regclass::text AS t FROM attendance_record WHERE id = $1',
      [recordId]);
    return rows[0]?.t ?? 'nowhere';
  });
}

let period = 0;
async function sessionOn(date: string): Promise<string> {
  period += 1;
  const s = await attendanceService.openSession(staff(), {
    sectionId: sectionA, sessionDate: date, academicYearId: year.yearId,
    mode: 'day', markedByStaffId: staffId,
  });
  // `mode: 'day'` has no period, so a second session on the same date collides
  // on the unique index. Dates here are distinct per test for that reason.
  return s.id;
}

/** Writes one record the way the product does — the date read from the session. */
async function record(sessionId: string, clientEventId: string | null = randomUUID()) {
  return withTenant(staff(), async (db) => {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO attendance_record
         (tenant_id, attendance_session_id, session_date, enrollment_id, state,
          client_event_id)
       VALUES (app_current_tenant_id(), $1,
               (SELECT session_date FROM attendance_session WHERE id = $1),
               $2, 'present', $3)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [sessionId, enrollmentId, clientEventId]);
    return rows[0]?.id ?? null;
  });
}

/**
 * The two months this suite creates partitions for.
 *
 * Dropped before and after, because a test that only passes on a fresh
 * database is a test that fails for the next person and gets "fixed" by
 * deleting the assertion it was written for. Found the hard way: a mutation
 * pass reported eight kills, and seven of them were this test failing on its
 * own residue rather than on the mutation.
 */
const SCRATCH_PARTITIONS = [
  'attendance_record_y2039m07', 'attendance_record_y2041m03',
];

async function dropScratchPartitions(): Promise<void> {
  await asOwner(async (c) => {
    for (const name of SCRATCH_PARTITIONS) {
      // Detached first, then dropped. A plain DROP is refused: a foreign key
      // that references a partitioned table is cloned onto every partition, so
      // `attendance_correction`'s constraint depends on each one. Detaching
      // removes the clone; dropping then takes the rows with it, which belong
      // to this suite's tenant and are going anyway.
      if (!SCRATCH_PARTITIONS.includes(name)) throw new Error('not a scratch partition');
      await c.query(
        `DO $$ BEGIN
           IF to_regclass('public.${name}') IS NOT NULL THEN
             ALTER TABLE attendance_record DETACH PARTITION ${name};
           END IF;
         END $$`);
      await c.query(`DROP TABLE IF EXISTS ${name}`);
    }
  });
}

beforeAll(async () => {
  await purgeTestData('%@part-test.example');
  await dropScratchPartitions();
  tenant = await createTenant('PART');
  staffUser = await createUser('teacher@part-test.example', PASSWORD);
  await grantRole(tenant.orgId, staffUser.userId, 'TEACHER', 'campus', tenant.campusId);

  const struct = await createAcademicStructure(tenant.orgId, tenant.unitId, tenant.campusId);
  year = await createAcademicYear(tenant.orgId, tenant.unitId, '2026-27', 2026,
    { status: 'active' });
  const cg = await createClassGroupRaw(tenant.orgId, struct.programmeId, year.yearId, 'IX');
  sectionA = await createSectionFor(tenant.orgId, cg, 'A');
  const t = await makeTeacher(tenant.orgId, tenant.campusId, staffUser.userId,
    { givenName: 'Meera', employeeCode: 'PART-T1', classTeacherOf: [sectionA] });
  staffId = t.staffId;

  const learner = await createLearnerRaw(tenant.orgId, 'Aarav', 'PART-1');
  studentId = learner.studentId;
  enrollmentId = await asOwner(async (c) => (await c.query<{ id: string }>(
    `INSERT INTO enrollment (tenant_id, student_id, section_id, academic_year_id, enrolled_on)
     VALUES ($1, $2, $3, $4, CURRENT_DATE) RETURNING id`,
    [tenant.orgId, studentId, sectionA, year.yearId])).rows[0]!.id);
}, 120_000);

afterAll(async () => {
  await destroyUsers([staffUser.userId]);
  await destroyTenants([tenant.orgId]);
  await dropScratchPartitions();
  await Promise.all([pool.end(), authPool.end()]);
}, 120_000);

describe('the date is the session’s and nobody else’s', () => {
  it('refuses a record that claims a date its session does not have', async () => {
    // The load-bearing assertion of this milestone. If a caller could supply
    // the date, it could choose which partition its replay landed in — and the
    // unique index that makes a replay a no-op is scoped to the partition. The
    // whole "the narrowing costs nothing" argument rests on this refusal.
    const sessionId = await sessionOn('2026-08-03');
    await expect(withTenant(staff(), (db) => db.query(
      `INSERT INTO attendance_record
         (tenant_id, attendance_session_id, session_date, enrollment_id, state)
       VALUES (app_current_tenant_id(), $1, '2026-09-03'::date, $2, 'present')`,
      [sessionId, enrollmentId],
    ))).rejects.toThrow(/attendance_record_belongs_to_its_session|foreign key/i);
  });

  it('refuses the owner too, not only the application role', async () => {
    // A constraint, not a policy. The owner role bypasses row-level security
    // and does not bypass a foreign key, which is why the guarantee lives in
    // one rather than the other.
    const sessionId = await sessionOn('2026-08-04');
    await expect(asOwner((c) => c.query(
      `INSERT INTO attendance_record
         (tenant_id, attendance_session_id, session_date, enrollment_id, state)
       VALUES ($1, $2, '2026-09-04'::date, $3, 'present')`,
      [tenant.orgId, sessionId, enrollmentId],
    ))).rejects.toThrow(/attendance_record_belongs_to_its_session|foreign key/i);
  });
});

describe('routing', () => {
  it('files a record in the month its session happened in', async () => {
    const august = await record(await sessionOn('2026-08-05'));
    const january = await record(await sessionOn('2027-01-05'));
    expect(await partitionOf(august!)).toBe('attendance_record_y2026m08');
    expect(await partitionOf(january!)).toBe('attendance_record_y2027m01');
  });

  it('keeps a replay a no-op, which is what 0021 was protecting', async () => {
    // The guarantee the deferral was about. Same session, same client event —
    // the second arrival writes nothing, exactly as before partitioning,
    // because it resolves to the same date and therefore the same partition.
    const sessionId = await sessionOn('2026-08-06');
    const event = randomUUID();
    const first = await record(sessionId, event);
    const second = await record(sessionId, event);
    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  it('still refuses two marks for one learner in one session', async () => {
    const sessionId = await sessionOn('2026-08-07');
    expect(await record(sessionId, randomUUID())).not.toBeNull();
    expect(await record(sessionId, randomUUID())).toBeNull();
  });

  it('accepts the same client event id on a different date — the one change', async () => {
    // Stated rather than discovered. Before partitioning this was rejected as a
    // client bug; now the two rows are in different partitions and the index
    // cannot see across. The damage that rejection prevented — a mark silently
    // attributed to the wrong learner within a session — is still impossible,
    // because `one_per_enrollment` has not moved.
    const event = randomUUID();
    expect(await record(await sessionOn('2026-08-10'), event)).not.toBeNull();
    expect(await record(await sessionOn('2026-09-10'), event)).not.toBeNull();
  });
});

describe('pruning', () => {
  it('reads one month without touching the others', async () => {
    // The point of the milestone, asserted rather than assumed. A plan that
    // scans every partition is a partitioned table with all of the operational
    // cost and none of the benefit — and nothing else in this suite would
    // notice, because the answers would still be right.
    // Bound parameters, not literal dates, because that is what the product
    // sends. A plan proven to prune for a constant proves nothing about the
    // query anybody actually runs — PostgreSQL reaches the same answer here by
    // a different route, and this is the route worth pinning.
    const plan = await asOwner(async (c) => {
      const { rows } = await c.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN SELECT count(*) FROM attendance_record
          WHERE tenant_id = $1 AND session_date >= $2::date
            AND session_date < $3::date`,
        [tenant.orgId, '2026-08-01', '2026-09-01']);
      return rows.map((r) => r['QUERY PLAN']).join('\n');
    });
    const scanned = [...plan.matchAll(/attendance_record_y\d{4}m\d{2}/g)]
      .map((m) => m[0]);
    expect(new Set(scanned)).toEqual(new Set(['attendance_record_y2026m08']));
  });

  it('a whole-table count still has every month available', async () => {
    // Pruning is not filtering. A query with no date bound must still see
    // everything — a partitioned table that quietly answers for one month is
    // worse than an unpartitioned one.
    const plan = await asOwner(async (c) => {
      const { rows } = await c.query<{ 'QUERY PLAN': string }>(
        'EXPLAIN SELECT count(*) FROM attendance_record WHERE tenant_id = $1',
        [tenant.orgId]);
      return rows.map((r) => r['QUERY PLAN']).join('\n');
    });
    const scanned = new Set([...plan.matchAll(/attendance_record_y\d{4}m\d{2}/g)]
      .map((m) => m[0]));
    expect(scanned.size).toBeGreaterThan(1);
  });
});

describe('the backstop', () => {
  it('opens a register in a month no partition covers yet', async () => {
    // A school still running this in 2035, or importing 2019's registers. The
    // partition is made by the path that opens the session, because this system
    // has one worker and no scheduler — a monthly cron that has to exist for
    // the product to keep working is an outage with a date on it.
    const far = '2039-07-11';
    const before = await asOwner(async (c) => (await c.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM pg_class
        WHERE relname = 'attendance_record_y2039m07'`)).rows[0]!.n);
    expect(before).toBe('0');

    const id = await record(await sessionOn(far));
    expect(await partitionOf(id!)).toBe('attendance_record_y2039m07');
  });

  it('rescues rows that reached the default before the partition existed', async () => {
    // The trap in having a default partition: PostgreSQL refuses to attach one
    // whose range overlaps rows already sitting in the default. Somebody meets
    // that at the worst possible moment, so the factory does the move itself.
    const sessionId = await asOwner(async (c) => (await c.query<{ id: string }>(
      `INSERT INTO attendance_session
         (tenant_id, section_id, academic_year_id, session_date, mode, status)
       VALUES ($1, $2, $3, '2041-03-09'::date, 'day', 'open') RETURNING id`,
      [tenant.orgId, sectionA, year.yearId])).rows[0]!.id);

    // Written without the factory being called, so it lands in the default.
    const stranded = await record(sessionId);
    expect(await partitionOf(stranded!)).toBe('attendance_record_unscheduled');

    await asOwner((c) => c.query(
      "SELECT ensure_attendance_partition('2041-03-09'::date)"));
    expect(await partitionOf(stranded!)).toBe('attendance_record_y2041m03');
  });

  it('is safe to ask for a partition that already exists', async () => {
    // Two teachers opening the first register of a month at the same second.
    const name = await asOwner(async (c) => (await c.query<{ n: string }>(
      "SELECT ensure_attendance_partition('2026-08-15'::date) AS n")).rows[0]!.n);
    expect(name).toBe('attendance_record_y2026m08');
    await expect(asOwner((c) => c.query(
      "SELECT ensure_attendance_partition('2026-08-15'::date)"))).resolves.toBeTruthy();
  });
});

describe('a partitioned table keeps its row-level security', () => {
  it('gives the application role no way to name a partition', async () => {
    // 0021 told this migration to remember the lesson from 0009: a policy on a
    // partitioned parent is not applied to a query naming a partition
    // directly. The defence is not a policy per partition — it is that the app
    // role has no privilege on one, so it cannot write the query at all.
    const grants = await asOwner(async (c) => (await c.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM information_schema.role_table_grants
        WHERE grantee = 'paathshala_app'
          AND (table_name LIKE 'attendance_record_y%'
               OR table_name = 'attendance_record_unscheduled')`)).rows[0]!.n);
    expect(grants).toBe('0');

    await expect(withTenant(staff(), (db) =>
      db.query('SELECT count(*) FROM attendance_record_y2026m08')))
      .rejects.toThrow(/permission denied/i);
  });

  it('is still the table the invariant checks', async () => {
    // The quiet failure this would otherwise have been: `rls_coverage` looked
    // at relkind 'r', a partitioned parent is 'p', and every partition carries
    // a tenant_id. Unfixed, the invariant would have stopped watching the one
    // table that matters and started demanding policies on twelve that inherit
    // them — and the 2am fix for that is to delete the check.
    const rows = await asOwner(async (c) => (await c.query<{
      table_name: string; is_covered: boolean;
    }>(`SELECT table_name, is_covered FROM rls_coverage
         WHERE table_name LIKE 'attendance_record%'`)).rows);
    expect(rows.map((r) => r.table_name)).toEqual(['attendance_record']);
    expect(rows[0]!.is_covered).toBe(true);
  });

  it('still hides another tenant’s rows through the parent', async () => {
    const other = await createTenant('PART2');
    try {
      const visible = await withTenant(
        { tenantId: other.orgId, actorId: staffUser.userId },
        async (db) => (await db.query<{ n: string }>(
          'SELECT count(*)::text AS n FROM attendance_record')).rows[0]!.n);
      expect(visible).toBe('0');
    } finally {
      await destroyTenants([other.orgId]);
    }
  });
});

describe('a cascade that was never possible', () => {
  it('refuses to delete a record that has a correction against it', async () => {
    // The old foreign key said ON DELETE CASCADE, and it could never have run:
    // `attendance_correction_append_only` fires BEFORE DELETE for every role
    // and raises unconditionally, so the cascade would have been refused at
    // the far end. The schema declared a behaviour the database would never
    // perform; it now declares the one it does.
    const sessionId = await sessionOn('2026-08-20');
    const recordId = await record(sessionId);
    await asOwner((c) => c.query(
      `INSERT INTO attendance_correction
         (tenant_id, attendance_record_id, to_state, reason, requested_by)
       VALUES ($1, $2, 'absent', 'Marked in error.', $3)`,
      [tenant.orgId, recordId, staffId]));

    await expect(asOwner((c) => c.query(
      'DELETE FROM attendance_record WHERE id = $1', [recordId])))
      .rejects.toThrow(/attendance_correction_attendance_record_id_fkey|violates foreign key/i);
  });

  it('carries the record’s date onto the correction without being told', async () => {
    const sessionId = await sessionOn('2026-08-21');
    const recordId = await record(sessionId);
    const carried = await asOwner(async (c) => (await c.query<{ d: string | null }>(
      `INSERT INTO attendance_correction
         (tenant_id, attendance_record_id, to_state, reason, requested_by)
       VALUES ($1, $2, 'absent', 'Marked in error.', $3)
       RETURNING record_session_date::text AS d`,
      [tenant.orgId, recordId, staffId])).rows[0]!.d);
    expect(carried).toBe('2026-08-21');
  });

  it('leaves the date null for a correction that names no record', async () => {
    // A late offline sync into a locked session: the correction points at a
    // session and an enrollment, and there is no record yet to date it from.
    const sessionId = await sessionOn('2026-08-22');
    const carried = await asOwner(async (c) => (await c.query<{ d: string | null }>(
      `INSERT INTO attendance_correction
         (tenant_id, attendance_session_id, enrollment_id, to_state, reason,
          origin, requested_by)
       VALUES ($1, $2, $3, 'absent', 'Arrived after the lock.',
               'late_offline_sync', $4)
       RETURNING record_session_date::text AS d`,
      [tenant.orgId, sessionId, enrollmentId, staffId])).rows[0]!.d);
    expect(carried).toBeNull();
  });
});
