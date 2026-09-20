/**
 * M30.3 — budgets on the paths that grow with a school.
 *
 * Two kinds of budget, both measured against the queries the product actually
 * sends rather than a copy of them written here. A second copy of a query in a
 * test is a copy that drifts, and the drift always goes the same way: the test
 * keeps passing.
 *
 * So the statements are CAPTURED. `pool.connect` is wrapped for the duration of
 * a call, every statement the service issues is recorded with its parameters,
 * and the assertions run against those.
 *
 *   **Partition budget.** Every shipped query that reads `attendance_record`
 *   must name its month. This is the assertion that makes M30.1 worth having:
 *   partitioning a table and then filtering on a column of the table joined to
 *   it gives you all of the operational cost and none of the benefit, and
 *   nothing else in the suite would notice, because the answers stay right.
 *
 *   **Round-trip budget.** A sync batch of thirty marks must not cost
 *   materially more than a batch of ten. Written as a ratchet rather than a
 *   target: it records what the code does today and fails when that gets
 *   worse, which is the only kind of performance test that survives contact
 *   with a codebase.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import {
  createTenant, destroyTenants, createUser, destroyUsers, grantRole, purgeTestData,
  createAcademicYear, createAcademicStructure, createLearnerRaw,
  createClassGroupRaw, createSectionFor, makeTeacher, createPersonRaw, linkGuardianRaw,
  OWNER_URL, type TenantFixture, type UserFixture, type AcademicYearFixture,
} from './fixtures.ts';
import { attendanceService } from '../src/modules/attendance/attendance.service.ts';
import { familyService } from '../src/modules/family/family.service.ts';
import { dashboardService } from '../src/modules/reporting/dashboard.service.ts';
import { pool } from '../src/db/pool.ts';
import { authPool } from '../src/db/auth-pool.ts';

const PASSWORD = 'correct-horse-battery';

let tenant: TenantFixture;
let staffUser: UserFixture;
let year: AcademicYearFixture;
let sectionA = '';
let staffId = '';
let studentId = '';
const enrolments: string[] = [];
const learnerIds: string[] = [];

const staff = () => ({ tenantId: tenant.orgId, actorId: staffUser.userId });
const today = () => new Date().toISOString().slice(0, 10);

async function asOwner<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: OWNER_URL });
  await client.connect();
  try { return await fn(client); } finally { await client.end(); }
}

interface Statement { text: string; values: unknown[] }

/**
 * Runs `fn` and returns every statement it sent.
 *
 * Wrapping `pool.connect` rather than instrumenting `withTenant` keeps this
 * entirely in the test: nothing in `src/` knows the recorder exists, so there
 * is no production code whose only purpose is to be measured.
 */
async function recording<T>(fn: () => Promise<T>): Promise<{
  result: T; statements: Statement[];
}> {
  const statements: Statement[] = [];
  const original = pool.connect.bind(pool);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (pool as any).connect = async () => {
    const client = await original();
    const realQuery = client.query.bind(client);
    const realRelease = client.release.bind(client);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).query = (text: any, params?: any) => {
      if (typeof text === 'string') statements.push({ text, values: params ?? [] });
      return realQuery(text, params);
    };
    // Put the client back the way it was found. Connections are POOLED: a
    // patched `query` left on one is picked up by the next borrower and keeps
    // pushing into an array that belongs to a call which has already finished.
    // The first version of this recorder did exactly that, and reported a
    // three-mark batch costing more statements than a thirty-mark one.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).release = (...args: unknown[]) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (client as any).query = realQuery;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (client as any).release = realRelease;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (realRelease as any)(...args);
    };
    return client;
  };
  try {
    return { result: await fn(), statements };
  } finally {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (pool as any).connect = original;
  }
}

/** Whether a SQL string reads or writes the partitioned table at all. */
export function touchesAttendanceRecord(sql: string): boolean {
  return /(?:FROM|JOIN|INTO)\s+attendance_record\b/i.test(sql);
}

/**
 * Whether a SQL string constrains **the record's own** `session_date`.
 *
 * Not any session_date. A query that filters on the joined
 * `attendance_session` prunes nothing — the planner cannot carry a predicate
 * across a join into a partition list — and reads exactly as if it did. That
 * is the mistake this milestone exists to catch, and a check that merely
 * looked for the word passed three such queries.
 */
export function namesItsMonth(sql: string): boolean {
  const named = /(?:FROM|JOIN|INTO)\s+attendance_record\b\s*(?:AS\s+)?(\w+)?/i.exec(sql);
  if (!named) return true;
  const candidate = named[1];
  const alias = candidate && !/^(WHERE|SET|ON|AS|VALUES|ORDER|GROUP|LIMIT|RETURNING)$/i
    .test(candidate) ? candidate : null;
  return alias
    ? new RegExp(`\\b${alias}\\.session_date\\b`).test(sql)
    : /(?<![.\w])session_date\b/.test(sql);
}

const PARTITION = /attendance_record_(?:y\d{4}m\d{2}|unscheduled)/g;

/**
 * How many partitions of `attendance_record` a statement actually touches.
 *
 * SELECTs are run with ANALYZE, because a subquery-supplied date prunes at RUN
 * time and a plain EXPLAIN shows every partition for a query that will read
 * one. Writes are planned but not executed, for the obvious reason.
 */
async function partitionsTouched(s: Statement): Promise<string[]> {
  const readOnly = /^\s*(SELECT|WITH)/i.test(s.text);
  const prefix = readOnly
    ? 'EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY OFF) '
    : 'EXPLAIN ';
  return asOwner(async (c) => {
    // Inside a transaction that is always rolled back, so an ANALYZE of
    // something unexpectedly writable cannot leave anything behind.
    await c.query('BEGIN');
    try {
      const { rows } = await c.query<{ 'QUERY PLAN': string }>(
        prefix + s.text, s.values as unknown[]);
      const plan = rows.map((r) => r['QUERY PLAN']).join('\n');
      return [...new Set([...plan.matchAll(PARTITION)].map((m) => m[0]))];
    } finally {
      await c.query('ROLLBACK');
    }
  });
}

/**
 * The one shipped query that reads every month on purpose.
 *
 * `/v1/integrations/attendance` is a cursor-paged export feed: an integration
 * walking the whole table from the beginning has no date to give. Partitioning
 * does not help it and is not supposed to. Listed here so that the exception is
 * a decision with a name rather than a query nobody noticed.
 */
const ALLOWED_TO_SCAN_EVERYTHING = [/\$1::uuid IS NULL OR r\.id > \$1/];

beforeAll(async () => {
  await purgeTestData('%@budget-test.example');
  tenant = await createTenant('BUD');
  staffUser = await createUser('teacher@budget-test.example', PASSWORD);
  await grantRole(tenant.orgId, staffUser.userId, 'TEACHER', 'campus', tenant.campusId);

  const struct = await createAcademicStructure(tenant.orgId, tenant.unitId, tenant.campusId);
  year = await createAcademicYear(tenant.orgId, tenant.unitId, '2026-27', 2026,
    { status: 'active' });
  const cg = await createClassGroupRaw(tenant.orgId, struct.programmeId, year.yearId, 'IX');
  sectionA = await createSectionFor(tenant.orgId, cg, 'A');
  staffId = (await makeTeacher(tenant.orgId, tenant.campusId, staffUser.userId,
    { givenName: 'Meera', employeeCode: 'BUD-T1', classTeacherOf: [sectionA] })).staffId;

  const guardianPersonId = await createPersonRaw(tenant.orgId, 'Kavita',
    { familyName: 'Parent' });
  for (let i = 0; i < 30; i++) {
    const l = await createLearnerRaw(tenant.orgId, `Learner${i}`, `BUD-${i}`);
    learnerIds.push(l.studentId);
    if (i === 0) {
      studentId = l.studentId;
      await linkGuardianRaw(tenant.orgId, l.studentId, guardianPersonId);
    }
    enrolments.push(await asOwner(async (c) => (await c.query<{ id: string }>(
      `INSERT INTO enrollment (tenant_id, student_id, section_id, academic_year_id, enrolled_on)
       VALUES ($1, $2, $3, $4, CURRENT_DATE - 60) RETURNING id`,
      [tenant.orgId, l.studentId, sectionA, year.yearId])).rows[0]!.id));
  }
}, 180_000);

afterAll(async () => {
  await destroyUsers([staffUser.userId]);
  await destroyTenants([tenant.orgId]);
  await Promise.all([pool.end(), authPool.end()]);
}, 120_000);

let period = 0;
async function session(date = today()): Promise<{ id: string }> {
  period += 1;
  return attendanceService.openSession(staff(), {
    sectionId: sectionA, sessionDate: date, academicYearId: year.yearId,
    periodNo: period, mode: 'device', markedByStaffId: staffId,
  });
}

function marks(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    studentId: learnerIds[i]!,
    state: 'present' as const,
    clientEventId: randomUUID(),
  }));
}

describe('every query that reads attendance names its month', () => {
  it('holds across the paths a school actually uses', async () => {
    const seen: Array<{ text: string; touched: string[] }> = [];

    const capture = async (fn: () => Promise<unknown>) => {
      const { statements } = await recording(fn);
      for (const s of statements) {
        if (!/attendance_record/.test(s.text)) continue;
        if (ALLOWED_TO_SCAN_EVERYTHING.some((r) => r.test(s.text))) continue;
        seen.push({ text: s.text, touched: await partitionsTouched(s) });
      }
    };

    // The teacher's sync, including its conflict lookups — the batch below is
    // deliberately replayed so the "nothing inserted, work out why" branch runs
    // and its two queries are captured too.
    const s = await session();
    const batch = marks(3);
    await capture(() => attendanceService.sync(staff(), {
      sessionId: s.id, records: batch, recordedByStaffId: staffId,
    }));
    await capture(() => attendanceService.sync(staff(), {
      sessionId: s.id, records: batch, recordedByStaffId: staffId,
    }));
    await capture(() => attendanceService.recordsForSession(staff(), s.id));

    // The parent app's month.
    await capture(() => familyService.attendance(staff(), {
      studentId,
      from: new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10),
      to: today(),
    }));

    // The office's dashboard, all three of its attendance queries. Captured
    // individually rather than through one entry point: a mutation pass found
    // that `todayFor` alone left the campus figures and the thirty-day trend
    // unexercised, and removing their date predicates broke nothing.
    await capture(() => dashboardService.todayFor(staff()));
    await capture(() => dashboardService.campusFigures(staff()));
    await capture(() => dashboardService.trend(staff(), 30));

    // A guard that checks nothing passes. This is the number that makes the
    // assertion below mean something.
    expect(seen.length).toBeGreaterThanOrEqual(8);

    // Two, not one. A parent's screen asks for the last thirty days, and thirty
    // days straddle a month boundary for all but one start date in the year —
    // reading two partitions there is the feature working, not failing. What
    // this catches is the query that reads all thirty-eight, which is what an
    // unpruned one does and what every one of these did before M30.1 put the
    // date on the record's own column.
    const greedy = seen
      .filter((q) => q.touched.length > 2)
      .map((q) => `${q.touched.length} partitions: ${q.text.trim().slice(0, 110)}`);
    expect(greedy).toEqual([]);
  }, 180_000);
});

describe('a sync batch does not cost more per mark as it grows', () => {
  it('stays within its round-trip budget', async () => {
    // A ratchet, not a target. The sync issues a fixed amount of setup and then
    // a bounded number of statements per record; what this refuses is the
    // change that quietly adds one more query inside the loop, which is
    // invisible in a test with three learners and fatal in a school with two
    // thousand.
    const smallSession = await session();
    const largeSession = await session();
    const small = await recording(() => attendanceService.sync(staff(), {
      sessionId: smallSession.id, records: marks(3), recordedByStaffId: staffId,
    }));
    const large = await recording(() => attendanceService.sync(staff(), {
      sessionId: largeSession.id, records: marks(30), recordedByStaffId: staffId,
    }));

    // Two statements per mark today: the enrollment-on-the-date lookup and the
    // insert. Three is the ceiling, so adding one is allowed deliberately and
    // two is not allowed by accident.
    // Two today — the enrollment-on-the-date lookup and the insert — and the
    // ceiling is two. A looser ceiling is not a safety margin, it is room for
    // a regression: at three, a mutation adding a query inside the loop
    // survived this test.
    const perMark = (large.statements.length - small.statements.length) / 27;
    expect(perMark, 'statements per mark').toBeLessThanOrEqual(2);

    // ...and the fixed cost stays fixed. Six today — begin, scope, the session,
    // the clock, the outbox event, commit — and a batch of three must not
    // already be paying for thirty.
    expect(small.statements.length - 3 * perMark, 'fixed cost').toBeLessThanOrEqual(10);
  }, 180_000);
});

/**
 * The dynamic check above can only see the paths this file calls. This one sees
 * all of them.
 *
 * Crude on purpose: it reads the source, finds every SQL string that mentions
 * `attendance_record`, and requires the same string to mention `session_date`.
 * It cannot tell a good predicate from a useless one — that is the EXPLAIN
 * test's job — but it cannot be dodged by a query that no test happens to
 * exercise, which is how the office's day view came to be the one unpruned
 * query left after the first pass.
 */
describe('no shipped query reads attendance without naming a month', () => {
  const SRC = new URL('../src', import.meta.url).pathname;

  function sources(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = join(dir, e.name);
      if (e.isDirectory()) return sources(full);
      return e.name.endsWith('.ts') ? [full] : [];
    });
  }

  it('holds for every SQL string in src/', () => {
    const offenders: string[] = [];
    for (const file of sources(SRC)) {
      // Migrations are the schema, not queries against it.
      if (file.includes('/db/migrations/')) continue;
      const text = readFileSync(file, 'utf8');
      // Template literals, which is how every query in this codebase is written.
      for (const [sql] of text.matchAll(/`[^`]*`/g)) {
        if (!touchesAttendanceRecord(sql)) continue;
        if (ALLOWED_TO_SCAN_EVERYTHING.some((r) => r.test(sql))) continue;
        if (namesItsMonth(sql)) continue;
        offenders.push(`${file.slice(SRC.length + 1)}: ${sql.trim().slice(0, 90)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('finds the queries it claims to be checking', () => {
    // A file-walking test that walks no files passes. This is the number that
    // makes the assertion above mean something.
    let found = 0;
    for (const file of sources(SRC)) {
      if (file.includes('/db/migrations/')) continue;
      for (const [sql] of readFileSync(file, 'utf8').matchAll(/`[^`]*`/g)) {
        if (/attendance_record/.test(sql)) found += 1;
      }
    }
    expect(found).toBeGreaterThanOrEqual(8);
  });
});

/**
 * ...and the check above is worth having only if it fails on a bad query.
 *
 * Every query in `src/` passes it, so a version of it that had stopped working
 * would pass too — the same trap as a catalogue audit run only over a correct
 * catalogue. Found by mutating the check itself and watching nothing break.
 */
describe('the month check catches what it claims to', () => {
  const RECORD_FILTERED = `SELECT r.id FROM attendance_record r
     JOIN attendance_session s ON s.id = r.attendance_session_id
    WHERE r.session_date = $1::date`;
  const SESSION_FILTERED = `SELECT r.id FROM attendance_record r
     JOIN attendance_session s ON s.id = r.attendance_session_id
    WHERE s.session_date = $1::date`;

  it('accepts a query that constrains the record', () => {
    expect(namesItsMonth(RECORD_FILTERED)).toBe(true);
  });

  it('rejects one that constrains only the session it joined', () => {
    // The whole point. This query returns the right rows and reads every month
    // the school has ever had, and nothing else in the suite can tell.
    expect(namesItsMonth(SESSION_FILTERED)).toBe(false);
  });

  it('handles a query with no alias at all', () => {
    expect(namesItsMonth(
      'SELECT id FROM attendance_record WHERE session_date = $1')).toBe(true);
    expect(namesItsMonth(
      'SELECT id FROM attendance_record WHERE recorded_at > now()')).toBe(false);
  });

  it('counts an insert that supplies the column', () => {
    expect(namesItsMonth(
      `INSERT INTO attendance_record (tenant_id, session_date) VALUES ($1, $2)`)).toBe(true);
  });

  it('ignores a string that does not touch the table', () => {
    expect(touchesAttendanceRecord('SELECT * FROM attendance_session')).toBe(false);
  });
});
