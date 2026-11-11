/**
 * M12 — the two gaps a security review finds first.
 *
 * Both have been recorded as carried over since M3, which is long enough that
 * they had stopped reading as defects and started reading as furniture. They
 * are written here as tests BEFORE the fix, so the record shows what was
 * actually true:
 *
 *   1. Any staff role could read a child's medical note. "Classified
 *      RESTRICTED: readable only with an explicit field grant" is a comment in
 *      migration 0011; nothing enforced it.
 *
 *   2. A teacher could list every learner in the school. `/v1/students` says it
 *      is scoped by policy, and the policy grants the whole tenant to anyone
 *      with staff scope — which includes every class teacher.
 *
 * Neither is a data leak across schools, which is why they survived: the
 * isolation suite is green and stays green. Most real exposure is internal.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import {
  createTenant, destroyTenants, createUser, destroyUsers, grantRole, purgeTestData,
  createPersonRaw, createLearnerRaw, createAcademicYear, createAcademicStructure,
  createClassGroupRaw, createSectionFor, OWNER_URL,
  type TenantFixture, type UserFixture,
} from './fixtures.ts';
import { withTenant } from '../src/db/tenant.ts';
import { pool } from '../src/db/pool.ts';
import { authPool } from '../src/db/auth-pool.ts';

const PASSWORD = 'correct-horse-battery';

let tenant: TenantFixture;
let owner: UserFixture;
let teacher: UserFixture;
let otherTeacher: UserFixture;
let nurse: UserFixture;

let ownerScope: { tenantId: string; actorId: string };
let teacherScope: { tenantId: string; actorId: string };
let otherTeacherScope: { tenantId: string; actorId: string };
let nurseScope: { tenantId: string; actorId: string };

let mySection: string;
let theirSection: string;
let myLearner: string;
let theirLearner: string;

async function owned<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: OWNER_URL });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

beforeAll(async () => {
  await purgeTestData('%@fs-test.example');
  tenant = await createTenant('FS');

  owner = await createUser('owner@fs-test.example', PASSWORD);
  teacher = await createUser('teacher@fs-test.example', PASSWORD);
  otherTeacher = await createUser('other@fs-test.example', PASSWORD);
  nurse = await createUser('nurse@fs-test.example', PASSWORD);

  await grantRole(tenant.orgId, owner.userId, 'ORG_OWNER');
  await grantRole(tenant.orgId, teacher.userId, 'TEACHER');
  await grantRole(tenant.orgId, otherTeacher.userId, 'TEACHER');
  await grantRole(tenant.orgId, nurse.userId, 'TEACHER');

  const { yearId } = await createAcademicYear(tenant.orgId, tenant.unitId, '2026-27', 2026);
  const structure = await createAcademicStructure(tenant.orgId, tenant.unitId, tenant.campusId);
  const classGroup = await createClassGroupRaw(
    tenant.orgId, structure.programmeId, yearId, 'Class 9');
  mySection = await createSectionFor(tenant.orgId, classGroup, 'A');
  theirSection = await createSectionFor(tenant.orgId, classGroup, 'B');

  // Each teacher is a person, a staff row, and the class teacher of one section.
  const staffFor = async (user: UserFixture, given: string, code: string) => {
    const personId = await createPersonRaw(tenant.orgId, given, { familyName: 'Teacher' });
    return owned(async (c) => {
      await c.query('UPDATE person SET user_account_id = $2 WHERE id = $1',
        [personId, user.userId]);
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO staff (tenant_id, person_id, campus_id, employee_code,
                            designation, joined_on)
         VALUES ($1, $2, $3, $4, 'Teacher', CURRENT_DATE) RETURNING id`,
        [tenant.orgId, personId, tenant.campusId, code]);
      return rows[0]!.id;
    });
  };

  const mine = await staffFor(teacher, 'Meena', 'FS-T1');
  const theirs = await staffFor(otherTeacher, 'Ravi', 'FS-T2');
  await staffFor(nurse, 'Sunita', 'FS-T3');

  await owned(async (c) => {
    await c.query('UPDATE section SET class_teacher_staff_id = $2 WHERE id = $1',
      [mySection, mine]);
    await c.query('UPDATE section SET class_teacher_staff_id = $2 WHERE id = $1',
      [theirSection, theirs]);
  });

  const enrol = async (name: string, admission: string, section: string) => {
    const learner = await createLearnerRaw(tenant.orgId, name, admission,
      { medicalNote: 'Carries an inhaler', bloodGroup: 'O+' });
    await owned((c) => c.query(
      `INSERT INTO enrollment (tenant_id, student_id, section_id, academic_year_id)
       VALUES ($1, $2, $3, $4)`,
      [tenant.orgId, learner.studentId, section, yearId]));
    return learner.studentId;
  };
  myLearner = await enrol('Asha', 'FS-0001', mySection);
  theirLearner = await enrol('Bilal', 'FS-0002', theirSection);

  ownerScope = { tenantId: tenant.orgId, actorId: owner.userId };
  teacherScope = { tenantId: tenant.orgId, actorId: teacher.userId };
  otherTeacherScope = { tenantId: tenant.orgId, actorId: otherTeacher.userId };
  nurseScope = { tenantId: tenant.orgId, actorId: nurse.userId };
});

afterAll(async () => {
  await destroyUsers([owner.userId, teacher.userId, otherTeacher.userId, nurse.userId]);
  await destroyTenants([tenant.orgId]);
  await pool.end();
  await authPool.end();
});

/* ========================================================================== */
/* M12.1 — a medical note is not ordinary staff data                          */
/* ========================================================================== */

describe('RESTRICTED columns need an explicit field grant', () => {
  it('refuses a medical note to the ordinary application role', async () => {
    // The comment in 0011 has always said "readable only with an explicit field
    // grant". This is the first thing that makes it true.
    await expect(withTenant(ownerScope, (db) =>
      db.query('SELECT medical_note FROM student LIMIT 1')))
      .rejects.toThrow(/permission denied/);
  });

  it('refuses a star-select, which is how it would leak by accident', async () => {
    // Nobody writes `SELECT medical_note` by mistake. They write `SELECT *` in a
    // debug log or a generic row serialiser, and a child's inhaler ends up in a
    // log aggregator.
    await expect(withTenant(ownerScope, (db) =>
      db.query('SELECT * FROM student LIMIT 1')))
      .rejects.toThrow(/permission denied/);
  });

  it('still serves everything a normal screen needs', async () => {
    const rows = await withTenant(ownerScope, async (db) => {
      const { rows } = await db.query(
        `SELECT id, admission_no, lifecycle_status, person_id FROM student`);
      return rows;
    });
    // The restriction must not make the product unusable — every ordinary
    // column stays readable, which is the difference between a field grant and
    // simply revoking the table.
    expect(rows.length).toBeGreaterThan(0);
  });

  it('lets the health role read them, and only them', async () => {
    const { healthPool } = await import('../src/db/health-pool.ts');
    const c = await healthPool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT set_config($1, $2, true)', ['app.tenant_id', tenant.orgId]);
      await c.query('SELECT set_config($1, $2, true)', ['app.actor_id', owner.userId]);

      const { rows } = await c.query<{ medical_note: string | null }>(
        'SELECT medical_note FROM student WHERE id = $1', [myLearner]);
      expect(rows[0]?.medical_note).toBe('Carries an inhaler');

      // A third role that could also read fees would be a worse boundary than
      // none, because it would be used for convenience.
      await expect(c.query('SELECT total FROM invoice LIMIT 1'))
        .rejects.toThrow(/permission denied/);
      await c.query('ROLLBACK');
    } finally {
      c.release();
    }
    await healthPool.end();
  });
});

/* ========================================================================== */
/* M12.2 — a teacher's class, not the school                                  */
/* ========================================================================== */

describe('a teacher sees their own sections', () => {
  it('returns the learners they teach', async () => {
    const ids = await withTenant(teacherScope, async (db) => {
      const { rows } = await db.query<{ id: string }>('SELECT id FROM student');
      return rows.map((r) => r.id);
    });
    expect(ids).toContain(myLearner);
  });

  it('does not return a learner from another teacher\'s section', async () => {
    const ids = await withTenant(teacherScope, async (db) => {
      const { rows } = await db.query<{ id: string }>('SELECT id FROM student');
      return rows.map((r) => r.id);
    });
    // The gap this closes: `/v1/students` said it was scoped by policy, and the
    // policy handed every staff role the whole tenant.
    expect(ids).not.toContain(theirLearner);
  });

  it('is symmetric — the other teacher sees the mirror image', async () => {
    const ids = await withTenant(otherTeacherScope, async (db) => {
      const { rows } = await db.query<{ id: string }>('SELECT id FROM student');
      return rows.map((r) => r.id);
    });
    expect(ids).toContain(theirLearner);
    expect(ids).not.toContain(myLearner);
  });

  it('shows a teacher with no section nobody at all', async () => {
    const ids = await withTenant(nurseScope, async (db) => {
      const { rows } = await db.query<{ id: string }>('SELECT id FROM student');
      return rows.map((r) => r.id);
    });
    // Closed by default. A staff member who teaches nothing has no roll to read,
    // and the failure mode of an unrecognised role is an empty list rather than
    // the whole school.
    expect(ids).toHaveLength(0);
  });

  it('still shows an administrator the whole school', async () => {
    const ids = await withTenant(ownerScope, async (db) => {
      const { rows } = await db.query<{ id: string }>('SELECT id FROM student');
      return rows.map((r) => r.id);
    });
    // The office genuinely needs every learner. Narrowing teachers must not
    // narrow the people who admit, bill and report.
    expect(ids).toEqual(expect.arrayContaining([myLearner, theirLearner]));
  });

  it('narrows enrollment the same way, so a join cannot route around it', async () => {
    const rows = await withTenant(teacherScope, async (db) => {
      const { rows } = await db.query<{ student_id: string }>(
        'SELECT student_id FROM enrollment');
      return rows.map((r) => r.student_id);
    });
    // A policy on `student` alone is defeated by reading `enrollment` and
    // joining back, which is exactly what a report query does.
    expect(rows).toContain(myLearner);
    expect(rows).not.toContain(theirLearner);
  });
});
