/**
 * M47.6 — the certificate register: who may issue, who may read, and that a
 * number is never used twice or changed afterwards.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import {
  createTenant, destroyTenants, createUser, destroyUsers, grantRole, purgeTestData,
  createAcademicYear, createAcademicStructure, createLearnerRaw, linkGuardianRaw,
  createPersonRaw, createClassGroupRaw, createSectionFor, makeTeacher,
  OWNER_URL, type TenantFixture, type UserFixture, type LearnerFixture,
} from './fixtures.ts';
import { certificateService } from '../src/modules/people/certificate.service.ts';
import { withTenant } from '../src/db/tenant.ts';
import { pool } from '../src/db/pool.ts';
import { authPool } from '../src/db/auth-pool.ts';

const PASSWORD = 'correct-horse-battery';
let tenant: TenantFixture, other: TenantFixture;
let ownerUser: UserFixture, admissionsUser: UserFixture, teacherUser: UserFixture;
let mumUser: UserFixture, strangerUser: UserFixture, otherOwnerUser: UserFixture;
let aarav: LearnerFixture, unplaced: LearnerFixture, theirs: LearnerFixture;

const as = (u: UserFixture, t: TenantFixture = tenant) => ({ tenantId: t.orgId, actorId: u.userId });

async function owner<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: OWNER_URL });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

beforeAll(async () => {
  await purgeTestData('%@cert-test.example');
  tenant = await createTenant('CRT');
  other = await createTenant('CRT2');
  ownerUser = await createUser('owner@cert-test.example', PASSWORD);
  admissionsUser = await createUser('admissions@cert-test.example', PASSWORD);
  teacherUser = await createUser('teacher@cert-test.example', PASSWORD);
  mumUser = await createUser('mum@cert-test.example', PASSWORD);
  strangerUser = await createUser('dad@cert-test.example', PASSWORD);
  otherOwnerUser = await createUser('owner@cert2-test.example', PASSWORD);

  await grantRole(tenant.orgId, ownerUser.userId, 'ORG_OWNER', 'organization');
  await grantRole(tenant.orgId, admissionsUser.userId, 'ADMISSIONS', 'campus', tenant.campusId);
  await grantRole(tenant.orgId, teacherUser.userId, 'TEACHER', 'campus', tenant.campusId);
  await grantRole(tenant.orgId, mumUser.userId, 'GUARDIAN', 'self', tenant.campusId);
  await grantRole(tenant.orgId, strangerUser.userId, 'GUARDIAN', 'self', tenant.campusId);
  await grantRole(other.orgId, otherOwnerUser.userId, 'ORG_OWNER', 'organization');

  const mum = await createPersonRaw(tenant.orgId, 'Sunita', { userAccountId: mumUser.userId, familyName: 'Kumar' });
  await createPersonRaw(tenant.orgId, 'Rajesh', { userAccountId: strangerUser.userId });

  const struct = await createAcademicStructure(tenant.orgId, tenant.unitId, tenant.campusId);
  const year = await createAcademicYear(tenant.orgId, tenant.unitId, '2026-27', 2026, { status: 'active' });
  const cg = await createClassGroupRaw(tenant.orgId, struct.programmeId, year.yearId, 'Class IX');
  const sectionId = await createSectionFor(tenant.orgId, cg, 'A');
  await makeTeacher(tenant.orgId, tenant.campusId, teacherUser.userId, { classTeacherOf: [sectionId] });
  await makeTeacher(tenant.orgId, tenant.campusId, admissionsUser.userId,
    { givenName: 'Priya', employeeCode: 'EMP-ADM' });

  aarav = await createLearnerRaw(tenant.orgId, 'Aarav', 'CRT-0001');
  unplaced = await createLearnerRaw(tenant.orgId, 'Nobody', 'CRT-0002');
  theirs = await createLearnerRaw(other.orgId, 'Zoya', 'CRT2-0001');
  await linkGuardianRaw(tenant.orgId, aarav.studentId, mum, { isPrimary: true });
  await owner(async (c) => {
    await c.query(`UPDATE person SET date_of_birth = '2011-01-10' WHERE id = $1`, [aarav.personId]);
    await c.query(
      `INSERT INTO enrollment (tenant_id, student_id, section_id, academic_year_id)
       VALUES ($1, $2, $3, $4)`, [tenant.orgId, aarav.studentId, sectionId, year.yearId]);
  });
});

afterAll(async () => {
  await owner((c) => c.query('DELETE FROM certificate_issue WHERE tenant_id = ANY($1)',
    [[tenant.orgId, other.orgId]]));
  await destroyUsers([ownerUser, admissionsUser, teacherUser, mumUser, strangerUser, otherOwnerUser]
    .map((u) => u.userId));
  await destroyTenants([tenant.orgId, other.orgId]);
  await Promise.all([pool.end(), authPool.end()]);
});

describe('issuing', () => {
  it('numbers from one, per kind and year, and stores the words', async () => {
    const first = await certificateService.issue(as(ownerUser),
      { studentId: aarav.studentId, kind: 'bonafide', purpose: '  a passport   application ' });
    expect(first.certificate_no).toBe('BON/2026-27/0001');
    expect(first.purpose).toBe('a passport application');
    expect(first.title).toBe('Bonafide certificate');
    expect(first.paragraphs[0]).toContain('Aarav Learner, ward of Sunita Kumar, (admission number CRT-0001)');
    expect(first.paragraphs[0]).toContain('studying in Class IX A during the academic year 2026-27');
    expect(first.paragraphs.at(-1)).toContain('for the purpose of a passport application.');

    const second = await certificateService.issue(as(admissionsUser),
      { studentId: aarav.studentId, kind: 'bonafide' });
    expect(second.certificate_no).toBe('BON/2026-27/0002');
    // Named: a certificate says who in the office issued it.
    expect(second.issued_by_name).toBe('Priya Teacher');

    // Another kind has its own run of numbers.
    const dob = await certificateService.issue(as(ownerUser), { studentId: aarav.studentId, kind: 'dob' });
    expect(dob.certificate_no).toBe('DOB/2026-27/0001');
  });

  it('does not reuse a number when two are issued at once', async () => {
    const both = await Promise.all([
      certificateService.issue(as(ownerUser), { studentId: aarav.studentId, kind: 'study' }),
      certificateService.issue(as(admissionsUser), { studentId: aarav.studentId, kind: 'study' }),
    ]);
    expect(both.map((c) => c.certificate_no).sort())
      .toEqual(['STU/2026-27/0001', 'STU/2026-27/0002']);
  });

  it('refuses a teacher and a parent, and writes nothing', async () => {
    for (const u of [teacherUser, mumUser]) {
      await expect(certificateService.issue(as(u), { studentId: aarav.studentId, kind: 'bonafide' }),
        u.email).rejects.toMatchObject({ code: 'not_office' });
    }
    expect((await certificateService.listFor(as(ownerUser), aarav.studentId))
      .filter((c) => c.kind === 'bonafide')).toHaveLength(2);
  });

  it('refuses one that would have a gap in it', async () => {
    await expect(certificateService.issue(as(ownerUser), { studentId: unplaced.studentId, kind: 'bonafide' }))
      .rejects.toMatchObject({ code: 'certificate_cannot_be_issued' });
    await expect(certificateService.issue(as(ownerUser), { studentId: unplaced.studentId, kind: 'dob' }))
      .rejects.toMatchObject({ code: 'certificate_cannot_be_issued' });
  });

  it('will not issue for another school’s learner', async () => {
    await expect(certificateService.issue(as(ownerUser), { studentId: theirs.studentId, kind: 'bonafide' }))
      .rejects.toMatchObject({ code: 'student_not_found' });
  });
});

describe('the register', () => {
  it('is readable by the office, the class teacher and the child’s parent', async () => {
    for (const u of [ownerUser, teacherUser, mumUser]) {
      expect((await certificateService.listFor(as(u), aarav.studentId)).length, u.email)
        .toBeGreaterThanOrEqual(5);
    }
  });

  it('is closed to another family and another school', async () => {
    expect(await certificateService.listFor(as(strangerUser), aarav.studentId)).toEqual([]);
    expect(await certificateService.listFor(as(otherOwnerUser, other), aarav.studentId)).toEqual([]);
  });

  it('cannot be altered or removed by anybody in the school', async () => {
    for (const sql of [
      `UPDATE certificate_issue SET purpose = 'something else'`,
      `DELETE FROM certificate_issue`,
    ]) {
      await expect(withTenant(as(ownerUser), (db) => db.query(sql)))
        .rejects.toThrow(/permission denied/);
    }
  });

  it('the policy refuses a teacher even without the service asking first', async () => {
    await expect(withTenant(as(teacherUser), (db) => db.query(
      `INSERT INTO certificate_issue (tenant_id, student_id, kind, year_label, serial_no,
                                      certificate_no, issued_on, title, paragraphs)
       VALUES (app_current_tenant_id(), $1, 'bonafide', '2026-27', 999, 'BON/2026-27/0999',
               CURRENT_DATE, 'x', '["x"]'::jsonb)`, [aarav.studentId])))
      .rejects.toThrow(/row-level security/);
  });

  it('keeps the words it was issued with when the record changes afterwards', async () => {
    const before = (await certificateService.listFor(as(ownerUser), aarav.studentId))
      .find((c) => c.certificate_no === 'BON/2026-27/0001')!;
    await owner((c) => c.query(`UPDATE person SET given_name = 'Arav' WHERE id = $1`, [aarav.personId]));
    const after = (await certificateService.listFor(as(ownerUser), aarav.studentId))
      .find((c) => c.certificate_no === 'BON/2026-27/0001')!;
    expect(after.paragraphs).toEqual(before.paragraphs);
    await owner((c) => c.query(`UPDATE person SET given_name = 'Aarav' WHERE id = $1`, [aarav.personId]));
  });
});
