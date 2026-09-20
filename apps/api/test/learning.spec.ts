/**
 * M28 — lessons, assignments and submissions, and the one thing this milestone
 * is really about.
 *
 * The obvious schema gives a submission a `marks_obtained` column, and the bug
 * it produces is invisible until March: a term of graded homework that M8's
 * weighting has never heard of, so the report card is computed without it. So
 * the assertions below are mostly not about lessons. They are about there
 * being exactly ONE place a mark can live, and about the two people who may
 * write to a submission not being able to do each other's half of it.
 */
import './fixtures.ts';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import {
  createTenant, destroyTenants, createUser, destroyUsers, grantRole, purgeTestData,
  createAcademicYear, createAcademicStructure, createLearnerRaw, linkGuardianRaw,
  createPersonRaw, createClassGroupRaw, createSectionFor, makeTeacher,
  OWNER_URL, type TenantFixture, type UserFixture, type LearnerFixture,
} from './fixtures.ts';
import type { HttpException } from '@nestjs/common';
import { learningService } from '../src/modules/learning/learning.service.ts';
import { withTenant, type TenantScope } from '../src/db/tenant.ts';
import { pool } from '../src/db/pool.ts';
import { authPool } from '../src/db/auth-pool.ts';

const PASSWORD = 'correct-horse-battery';

let tenant: TenantFixture;
let other: TenantFixture;

let officeUser: UserFixture;       // ORG_OWNER
let teacherUser: UserFixture;      // primary teacher of the physics offering
let classTeacherUser: UserFixture; // class teacher of IX-A, teaches no physics
let strangerUser: UserFixture;     // a teacher whose sections are elsewhere
let guardianUser: UserFixture;     // parent of child one
let otherGuardianUser: UserFixture;// parent of child two
let otherOfficeUser: UserFixture;  // ORG_OWNER of the OTHER school

let teacherStaffId: string;
let sectionA: string;
let sectionB: string;
let offeringId: string;
let otherOfferingId: string;       // same school, a section the stranger teaches

let childOne: LearnerFixture;
let childTwo: LearnerFixture;
let enrolOne: string;
let enrolTwo: string;

/**
 * The error body, not the exception message.
 *
 * `ApiError.make` builds a Nest `HttpException` whose `.message` is the
 * useless string 'Http Exception' — the code and the sentence a teacher reads
 * are both in the response body, so that is what an assertion about them has
 * to look at.
 */
async function refusal(promise: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await promise;
  } catch (err) {
    const body = (err as HttpException).getResponse?.() as
      { error?: { code: string; message: string } } | undefined;
    if (body?.error) return body.error;
    return { code: '(not an ApiError)', message: String(err) };
  }
  throw new Error('expected a refusal, and the call succeeded');
}

async function owner<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: OWNER_URL });
  await client.connect();
  try { return await fn(client); } finally { await client.end(); }
}

const office = (): TenantScope => ({ tenantId: tenant.orgId, actorId: officeUser.userId });
const teacher = (): TenantScope => ({ tenantId: tenant.orgId, actorId: teacherUser.userId });
const classTeacher = (): TenantScope =>
  ({ tenantId: tenant.orgId, actorId: classTeacherUser.userId });
const stranger = (): TenantScope => ({ tenantId: tenant.orgId, actorId: strangerUser.userId });
const guardian = (): TenantScope => ({ tenantId: tenant.orgId, actorId: guardianUser.userId });
const otherGuardian = (): TenantScope =>
  ({ tenantId: tenant.orgId, actorId: otherGuardianUser.userId });
const otherOffice = (): TenantScope => ({ tenantId: other.orgId, actorId: otherOfficeUser.userId });

/** Tomorrow, so nothing in this suite is accidentally late. */
const soon = () => new Date(Date.now() + 86_400_000).toISOString();
const yesterday = () => new Date(Date.now() - 86_400_000).toISOString();

beforeAll(async () => {
  await purgeTestData('%@lrn-test.example');
  tenant = await createTenant('LRN');
  other = await createTenant('LRN2');

  officeUser = await createUser('office@lrn-test.example', PASSWORD);
  teacherUser = await createUser('teacher@lrn-test.example', PASSWORD);
  classTeacherUser = await createUser('classteacher@lrn-test.example', PASSWORD);
  strangerUser = await createUser('stranger@lrn-test.example', PASSWORD);
  guardianUser = await createUser('parent1@lrn-test.example', PASSWORD);
  otherGuardianUser = await createUser('parent2@lrn-test.example', PASSWORD);
  otherOfficeUser = await createUser('office@lrn2-test.example', PASSWORD);

  await grantRole(tenant.orgId, officeUser.userId, 'ORG_OWNER', 'organization', null);
  await grantRole(tenant.orgId, teacherUser.userId, 'TEACHER', 'campus', tenant.campusId);
  await grantRole(tenant.orgId, classTeacherUser.userId, 'TEACHER', 'campus', tenant.campusId);
  await grantRole(tenant.orgId, strangerUser.userId, 'TEACHER', 'campus', tenant.campusId);
  await grantRole(tenant.orgId, guardianUser.userId, 'GUARDIAN', 'self', tenant.campusId);
  await grantRole(tenant.orgId, otherGuardianUser.userId, 'GUARDIAN', 'self', tenant.campusId);
  await grantRole(other.orgId, otherOfficeUser.userId, 'ORG_OWNER', 'organization', null);

  const struct = await createAcademicStructure(tenant.orgId, tenant.unitId, tenant.campusId);
  const year = await createAcademicYear(tenant.orgId, tenant.unitId, '2026-27', 2026,
    { status: 'active' });
  const cg = await createClassGroupRaw(tenant.orgId, struct.programmeId, year.yearId, 'Class IX');
  sectionA = await createSectionFor(tenant.orgId, cg, 'A');
  sectionB = await createSectionFor(tenant.orgId, cg, 'B');

  const t = await makeTeacher(tenant.orgId, tenant.campusId, teacherUser.userId,
    { givenName: 'Meera', employeeCode: 'LRN-T1' });
  teacherStaffId = t.staffId;

  // Class teacher of IX-A. Reads everything set for their section; owns none
  // of it. The distinction this suite is here to hold.
  await makeTeacher(tenant.orgId, tenant.campusId, classTeacherUser.userId,
    { givenName: 'Anil', employeeCode: 'LRN-T2', classTeacherOf: [sectionA] });

  // A real teacher of a real class, with no connection to IX-A at all.
  const strangerStaff = await makeTeacher(tenant.orgId, tenant.campusId, strangerUser.userId,
    { givenName: 'Vikram', employeeCode: 'LRN-T3', classTeacherOf: [sectionB] });

  const guardianPersonId = await createPersonRaw(tenant.orgId, 'Kavita',
    { userAccountId: guardianUser.userId, familyName: 'Parent' });
  const otherGuardianPersonId = await createPersonRaw(tenant.orgId, 'Ravi',
    { userAccountId: otherGuardianUser.userId, familyName: 'Parent' });

  childOne = await createLearnerRaw(tenant.orgId, 'Asha', 'LRN-0001');
  childTwo = await createLearnerRaw(tenant.orgId, 'Bharat', 'LRN-0002');
  await linkGuardianRaw(tenant.orgId, childOne.studentId, guardianPersonId);
  await linkGuardianRaw(tenant.orgId, childTwo.studentId, otherGuardianPersonId);

  await owner(async (c) => {
    const term = await c.query<{ id: string }>(
      'SELECT id FROM term WHERE academic_year_id = $1 ORDER BY starts_on LIMIT 1',
      [year.yearId]);
    const termId = term.rows[0]!.id;

    const co = await c.query<{ id: string }>(
      `INSERT INTO course_offering
         (tenant_id, class_group_id, section_id, subject_id, term_id,
          primary_teacher_staff_id)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [tenant.orgId, cg, sectionA, struct.subjectId, termId, teacherStaffId]);
    offeringId = co.rows[0]!.id;

    const co2 = await c.query<{ id: string }>(
      `INSERT INTO course_offering
         (tenant_id, class_group_id, section_id, subject_id, term_id,
          primary_teacher_staff_id)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [tenant.orgId, cg, sectionB, struct.subjectId, termId, strangerStaff.staffId]);
    otherOfferingId = co2.rows[0]!.id;

    for (const [child, out] of [[childOne, 'one'], [childTwo, 'two']] as const) {
      const e = await c.query<{ id: string }>(
        `INSERT INTO enrollment (tenant_id, student_id, section_id, academic_year_id)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [tenant.orgId, child.studentId, sectionA, year.yearId]);
      if (out === 'one') enrolOne = e.rows[0]!.id; else enrolTwo = e.rows[0]!.id;
    }
  });
}, 120_000);

afterAll(async () => {
  await destroyTenants([tenant.orgId, other.orgId]);
  await destroyUsers([officeUser.userId, teacherUser.userId, classTeacherUser.userId,
    strangerUser.userId, guardianUser.userId, otherGuardianUser.userId,
    otherOfficeUser.userId]);
  await pool.end();
  await authPool.end();
}, 120_000);

// ---------------------------------------------------------------------------

describe('an assignment that carries marks IS an assessment', () => {
  it('creates the assessment behind it, rather than a second place for a score', async () => {
    const a = await learningService.createAssignment(teacher(), {
      courseOfferingId: offeringId,
      title: 'Newton II problem set',
      maxMarks: 20,
      weightPercent: 5,
      dueAt: soon(),
    });

    expect(a.assessment_id).not.toBeNull();
    expect(a.max_marks).toBe('20.00');

    const row = await owner((c) => c.query<{ kind: string; status: string; weight_percent: string }>(
      'SELECT kind, status, weight_percent::text FROM assessment WHERE id = $1',
      [a.assessment_id]).then((r) => r.rows[0]));
    expect(row?.kind).toBe('assignment');
    // Open, not draft: marks cannot be entered against a draft, and the entire
    // point of this row is that they will be.
    expect(row?.status).toBe('open');
    expect(row?.weight_percent).toBe('5.00');
  });

  it('leaves practice work without one', async () => {
    const a = await learningService.createAssignment(teacher(), {
      courseOfferingId: offeringId,
      title: 'Read chapter 4',
      dueAt: soon(),
    });
    expect(a.assessment_id).toBeNull();
    expect(a.max_marks).toBeNull();
  });

  it('has nowhere to put a number on practice work, and says so', async () => {
    const a = await learningService.createAssignment(teacher(), {
      courseOfferingId: offeringId, title: 'Practice, ungraded', dueAt: soon(),
    });
    await learningService.publishAssignment(teacher(), a.id);
    await learningService.submit(guardian(),
      { assignmentId: a.id, enrollmentId: enrolOne, bodyText: 'done' });

    // The failure this refuses is silent: a teacher types 18, the service has
    // no assessment to write it to, and the mark is dropped on the floor.
    const err = await refusal(learningService.gradeAndReturn(teacher(), {
      assignmentId: a.id,
      grades: [{ enrollmentId: enrolOne, marks: 18 }],
    }));
    expect(err.code).toBe('assignment_not_graded');
    expect(err.message).toMatch(/carries no marks/i);
  });

  it('puts a graded submission in `mark`, where the result run will find it', async () => {
    const a = await learningService.createAssignment(teacher(), {
      courseOfferingId: offeringId, title: 'Graded set', maxMarks: 20, dueAt: soon(),
    });
    await learningService.publishAssignment(teacher(), a.id);
    await learningService.submit(guardian(),
      { assignmentId: a.id, enrollmentId: enrolOne, bodyText: 'my working' });

    const result = await learningService.gradeAndReturn(teacher(), {
      assignmentId: a.id,
      grades: [{ enrollmentId: enrolOne, marks: 17.5, feedback: 'Show the units.' }],
    });
    expect(result.returned).toBe(1);
    expect(result.outcomes[0]?.outcome).toBe('recorded');

    // And it comes back to the marking screen. A teacher reopening returned
    // work to empty boxes retypes the class or assumes nothing saved.
    const listed = await learningService.submissions(teacher(), a.id);
    expect(listed[0]?.marks_obtained).toBe('17.50');

    const mark = await owner((c) => c.query<{ marks_obtained: string }>(
      `SELECT marks_obtained::text FROM mark
        WHERE assessment_id = $1 AND enrollment_id = $2`,
      [a.assessment_id, enrolOne]).then((r) => r.rows[0]));
    expect(mark?.marks_obtained).toBe('17.50');

    // And no second copy anywhere on the submission.
    const cols = await owner((c) => c.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'submission'`).then((r) => r.rows.map((x) => x.column_name)));
    expect(cols).not.toContain('marks_obtained');
    expect(cols).not.toContain('score');
  });

  it('refuses to show work as returned when no mark stands behind it', async () => {
    const a = await learningService.createAssignment(teacher(), {
      courseOfferingId: offeringId, title: 'Ungraded-return test', maxMarks: 10, dueAt: soon(),
    });
    await learningService.publishAssignment(teacher(), a.id);
    const s = await learningService.submit(guardian(),
      { assignmentId: a.id, enrollmentId: enrolOne, bodyText: 'x' });

    // Straight at the table, as the app role, the way a second service written
    // next year would do it.
    await expect(withTenant(teacher(), (db) => db.query(
      `UPDATE submission SET status = 'returned', returned_at = now() WHERE id = $1::uuid`,
      [s.id]))).rejects.toThrow(/enter the mark before returning/i);
  });

  it('does not return the work of a learner whose mark was refused', async () => {
    // One typo must not lose the rest of the class — that is M8's savepoint
    // rule, and it arrives here with a second obligation: the child whose mark
    // bounced must NOT come back marked. A loop that returns every row it was
    // given is a child shown a verdict that does not exist.
    const a = await learningService.createAssignment(teacher(), {
      courseOfferingId: offeringId, title: 'One typo', maxMarks: 10, dueAt: soon(),
    });
    await learningService.publishAssignment(teacher(), a.id);
    await learningService.submit(guardian(),
      { assignmentId: a.id, enrollmentId: enrolOne, bodyText: 'ok' });
    await learningService.submit(otherGuardian(),
      { assignmentId: a.id, enrollmentId: enrolTwo, bodyText: 'ok' });

    const out = await learningService.gradeAndReturn(teacher(), {
      assignmentId: a.id,
      grades: [
        { enrollmentId: enrolOne, marks: 9 },
        { enrollmentId: enrolTwo, marks: 99 },   // out of ten
      ],
    });

    expect(out.returned).toBe(1);
    const byEnrol = new Map(out.outcomes.map((o) => [o.enrollmentId, o.outcome]));
    expect(byEnrol.get(enrolOne)).toBe('recorded');
    expect(byEnrol.get(enrolTwo)).toBe('rejected');

    const rows = await learningService.submissions(teacher(), a.id);
    const good = rows.find((r) => r.enrollment_id === enrolOne);
    const bad = rows.find((r) => r.enrollment_id === enrolTwo);
    expect(good?.status).toBe('returned');
    expect(bad?.status).toBe('submitted');
  });

  it('will not let the assessment be moved once work has come in', async () => {
    const a = await learningService.createAssignment(teacher(), {
      courseOfferingId: offeringId, title: 'Reattribution test', maxMarks: 10, dueAt: soon(),
    });
    const b = await learningService.createAssignment(teacher(), {
      courseOfferingId: offeringId, title: 'Somewhere else', maxMarks: 10, dueAt: soon(),
    });
    await learningService.publishAssignment(teacher(), a.id);
    await learningService.submit(guardian(),
      { assignmentId: a.id, enrollmentId: enrolOne, bodyText: 'x' });

    await expect(owner((c) => c.query(
      'UPDATE assignment SET assessment_id = $2 WHERE id = $1',
      [a.id, b.assessment_id]))).rejects.toThrow(/cannot be changed once work has been submitted/i);
  });
});

describe('the two halves of a submission', () => {
  let graded: string;
  let assessmentId: string | null;
  let submissionId: string;

  beforeAll(async () => {
    const a = await learningService.createAssignment(teacher(), {
      courseOfferingId: offeringId, title: 'Halves', maxMarks: 25, dueAt: soon(),
    });
    graded = a.id;
    assessmentId = a.assessment_id;
    await learningService.publishAssignment(teacher(), a.id);
    const s = await learningService.submit(guardian(),
      { assignmentId: graded, enrollmentId: enrolOne, bodyText: 'first attempt' });
    submissionId = s.id;
  });

  it('lets the family replace their own work before the deadline', async () => {
    const again = await learningService.submit(guardian(),
      { assignmentId: graded, enrollmentId: enrolOne, bodyText: 'second attempt' });
    expect(again.id).toBe(submissionId);
    expect(again.body_text).toBe('second attempt');
    expect(again.is_late).toBe(false);
  });

  it('refuses a learner returning their own work with their own feedback', async () => {
    await expect(withTenant(guardian(), (db) => db.query(
      `UPDATE submission SET feedback = 'Excellent work, 25/25' WHERE id = $1::uuid`,
      [submissionId]))).rejects.toThrow(/only the teacher who set this work can return it/i);
  });

  it('refuses a teacher editing the work they are about to mark', async () => {
    await expect(withTenant(teacher(), (db) => db.query(
      `UPDATE submission SET body_text = 'what I wish they had written' WHERE id = $1::uuid`,
      [submissionId]))).rejects.toThrow(/do not edit it/i);
  });

  it('refuses a learner handing work in that is already marked', async () => {
    // The guard was written for UPDATE, on the assumption that work is handed
    // in and then marked. Nothing enforced the order. One INSERT with a
    // verdict already in it skipped every check below, and the parent app
    // would have shown the child's own feedback as the teacher's.
    const fresh = await learningService.createAssignment(teacher(), {
      courseOfferingId: offeringId, title: 'Born returned', dueAt: soon(),
    });
    await learningService.publishAssignment(teacher(), fresh.id);

    await expect(withTenant(guardian(), (db) => db.query(
      `INSERT INTO submission
         (tenant_id, assignment_id, enrollment_id, student_id, course_offering_id,
          body_text, status, returned_at, feedback)
       VALUES (app_current_tenant_id(), $1::uuid, $2::uuid,
               '00000000-0000-0000-0000-000000000000'::uuid,
               '00000000-0000-0000-0000-000000000000'::uuid,
               'done', 'returned', now(), 'Excellent work')`,
      [fresh.id, enrolOne]))).rejects.toThrow(/only the teacher who set this work can return it/i);
  });

  it('refuses even the teacher recording offline work as marked with no mark', async () => {
    // The realistic version of the INSERT path: paper handed in, so the
    // teacher creates the row themselves. They are allowed to — and the mark
    // requirement still has to hold, because a submission showing as returned
    // with nothing in `mark` behind it is the same lie whichever statement
    // produced it and whoever ran it.
    const paper = await learningService.createAssignment(teacher(), {
      courseOfferingId: offeringId, title: 'Handed in on paper',
      submissionKind: 'offline', maxMarks: 10, dueAt: soon(),
    });
    await learningService.publishAssignment(teacher(), paper.id);

    await expect(withTenant(teacher(), (db) => db.query(
      `INSERT INTO submission
         (tenant_id, assignment_id, enrollment_id, student_id, course_offering_id,
          status, returned_at, feedback)
       VALUES (app_current_tenant_id(), $1::uuid, $2::uuid,
               '00000000-0000-0000-0000-000000000000'::uuid,
               '00000000-0000-0000-0000-000000000000'::uuid,
               'returned', now(), 'Neat work')`,
      [paper.id, enrolOne]))).rejects.toThrow(/enter the mark before returning/i);
  });

  it('lets the teacher return it once the mark exists', async () => {
    const out = await learningService.gradeAndReturn(teacher(), {
      assignmentId: graded,
      grades: [{ enrollmentId: enrolOne, marks: 22, feedback: 'Good.' }],
    });
    expect(out.returned).toBe(1);
    const rows = await learningService.submissions(teacher(), graded);
    expect(rows[0]?.status).toBe('returned');
    expect(rows[0]?.feedback).toBe('Good.');
    expect(assessmentId).not.toBeNull();
  });
});

describe('lateness is decided by the server', () => {
  it('computes it from the deadline, whatever the client says', async () => {
    const a = await learningService.createAssignment(teacher(), {
      courseOfferingId: offeringId, title: 'Late maths', maxMarks: 10,
      dueAt: yesterday(), acceptsLate: true,
    });
    await learningService.publishAssignment(teacher(), a.id);

    // The client insists it is on time. Two clocks, one answer.
    const inserted = await withTenant(guardian(), (db) => db.query<{ is_late: boolean }>(
      `INSERT INTO submission
         (tenant_id, assignment_id, enrollment_id, student_id, course_offering_id,
          body_text, is_late)
       VALUES (app_current_tenant_id(), $1::uuid, $2::uuid,
               '00000000-0000-0000-0000-000000000000'::uuid,
               '00000000-0000-0000-0000-000000000000'::uuid, 'late but claiming otherwise',
               false)
       RETURNING is_late`,
      [a.id, enrolOne]).then((r) => r.rows[0]));
    expect(inserted?.is_late).toBe(true);
  });

  it('refuses late work outright when the teacher said it would', async () => {
    const a = await learningService.createAssignment(teacher(), {
      courseOfferingId: offeringId, title: 'Hard deadline',
      dueAt: yesterday(), acceptsLate: false,
    });
    await learningService.publishAssignment(teacher(), a.id);

    await expect(learningService.submit(guardian(),
      { assignmentId: a.id, enrollmentId: enrolOne, bodyText: 'too slow' }))
      .rejects.toThrow(/does not accept late work/i);
  });

  it('will not take a hard deadline with no deadline in it', async () => {
    const err = await refusal(learningService.createAssignment(teacher(), {
      courseOfferingId: offeringId, title: 'Nonsense', acceptsLate: false,
    }));
    expect(err.code).toBe('late_needs_deadline');
  });

  it('refuses work against an assignment that was never published', async () => {
    const a = await learningService.createAssignment(teacher(), {
      courseOfferingId: offeringId, title: 'Still a draft', dueAt: soon(),
    });
    // Submitted by somebody who CAN see the draft, so the refusal is the one
    // about publication rather than the one about existence.
    await expect(learningService.submit(teacher(),
      { assignmentId: a.id, enrollmentId: enrolOne, bodyText: 'eager' }))
      .rejects.toThrow(/published assignment/i);
  });

  it('does not tell a family that an unpublished assignment exists', async () => {
    const a = await learningService.createAssignment(teacher(), {
      courseOfferingId: offeringId, title: 'Secret draft', dueAt: soon(),
    });
    // The policy hides the row before the trigger can comment on its status,
    // so the parent is told it does not exist. That is the right answer and
    // not an accident: 'this assignment is not published yet' would confirm
    // that a teacher is drafting one.
    await expect(learningService.submit(guardian(),
      { assignmentId: a.id, enrollmentId: enrolOne, bodyText: 'eager' }))
      .rejects.toThrow(/does not exist/i);
  });
});

describe('who sees what', () => {
  let published: string;
  let draft: string;

  beforeAll(async () => {
    const p = await learningService.createAssignment(teacher(), {
      courseOfferingId: offeringId, title: 'Visible work', maxMarks: 15, dueAt: soon(),
    });
    published = p.id;
    await learningService.publishAssignment(teacher(), published);

    const d = await learningService.createAssignment(teacher(), {
      courseOfferingId: offeringId, title: 'Not ready yet', dueAt: soon(),
    });
    draft = d.id;

    await learningService.submit(guardian(),
      { assignmentId: published, enrollmentId: enrolOne, bodyText: 'asha' });
    await learningService.submit(otherGuardian(),
      { assignmentId: published, enrollmentId: enrolTwo, bodyText: 'bharat' });
  });

  it('shows a parent their own child\'s work and no other family\'s', async () => {
    const mine = await learningService.submissions(guardian(), published);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.student_id).toBe(childOne.studentId);

    const theirs = await learningService.submissions(otherGuardian(), published);
    expect(theirs).toHaveLength(1);
    expect(theirs[0]?.student_id).toBe(childTwo.studentId);
  });

  it('shows the teacher the whole class', async () => {
    const all = await learningService.submissions(teacher(), published);
    expect(all.map((s) => s.student_id).sort())
      .toEqual([childOne.studentId, childTwo.studentId].sort());
  });

  it('keeps a draft assignment out of a parent\'s list', async () => {
    const seen = await learningService.assignments(guardian(), offeringId);
    expect(seen.map((a) => a.id)).toContain(published);
    expect(seen.map((a) => a.id)).not.toContain(draft);

    // And the teacher, who is the reason drafts exist, still sees it.
    const mine = await learningService.assignments(teacher(), offeringId);
    expect(mine.map((a) => a.id)).toContain(draft);
  });

  it('shows the class teacher the work set for their section', async () => {
    // Asked about it at the gate every afternoon. Reading is the right answer.
    const seen = await learningService.assignments(classTeacher(), offeringId);
    expect(seen.map((a) => a.id)).toContain(published);
  });

  it('does not let the class teacher edit another teacher\'s assignment', async () => {
    // The half that would have been lost by collapsing read and write into one
    // rule. They can see it; it is not theirs.
    await expect(learningService.createAssignment(classTeacher(), {
      courseOfferingId: offeringId, title: 'Hijacked', dueAt: soon(),
    })).rejects.toThrow();
  });

  it('shows a teacher of another SECTION of the same class nothing', async () => {
    // The 0077 finding, kept as its own assertion because it is not about
    // learning: `app_actor_section_ids` granted every section of a class group
    // to anybody who taught one of them, and that function is underneath the
    // policies on student records, marks, attendance and transport.
    const seen = await withTenant(stranger(), (db) => db.query<{ ids: string[] }>(
      'SELECT app_actor_section_ids() AS ids').then((r) => r.rows[0]!.ids));
    expect(seen).toContain(sectionB);
    expect(seen).not.toContain(sectionA);
  });

  it('shows a teacher of another section nothing at all', async () => {
    expect(await learningService.assignments(stranger(), offeringId)).toHaveLength(0);
    expect(await learningService.submissions(stranger(), published)).toHaveLength(0);
    expect(await learningService.lessons(stranger(), offeringId)).toHaveLength(0);
  });

  it('shows the other school nothing, as ever', async () => {
    expect(await learningService.assignments(otherOffice(), offeringId)).toHaveLength(0);
    expect(await learningService.submissions(otherOffice(), published)).toHaveLength(0);
  });

  it('refuses a parent submitting for a child who is not theirs', async () => {
    await expect(learningService.submit(otherGuardian(),
      { assignmentId: published, enrollmentId: enrolOne, bodyText: 'not mine to hand in' }))
      .rejects.toThrow();
  });

  it('refuses a submission invented by somebody who owns neither the work nor the child', async () => {
    // The assertion above — a parent submitting for another family's child —
    // looked like it proved the WITH CHECK on `submission`. It did not.
    // That caller cannot see the other child's enrolment at all, so the
    // refusal came from 0019's policy before this table was consulted, and
    // deleting `submission`'s entire write rule broke no test.
    //
    // This caller has neither excuse. The class teacher of IX-A can see this
    // assignment and can see these enrolments; the only thing standing between
    // them and a fabricated submission in another teacher's subject is the
    // WITH CHECK, because they are not the family and the offering is not
    // theirs.
    const fresh = await learningService.createAssignment(teacher(), {
      courseOfferingId: offeringId, title: 'Nobody has handed this in', dueAt: soon(),
    });
    await learningService.publishAssignment(teacher(), fresh.id);

    // Both of the refusals that could have stood in for this one are absent:
    const visible = await learningService.assignments(classTeacher(), offeringId);
    expect(visible.map((a) => a.id)).toContain(fresh.id);
    const enrolmentsVisible = await withTenant(classTeacher(), (db) =>
      db.query<{ n: string }>('SELECT count(*)::text AS n FROM enrollment WHERE id = $1::uuid',
        [enrolOne]).then((r) => r.rows[0]!.n));
    expect(enrolmentsVisible).toBe('1');

    await expect(learningService.submit(classTeacher(),
      { assignmentId: fresh.id, enrollmentId: enrolOne, bodyText: 'invented' }))
      .rejects.toThrow();
  });

  it('gives a parent one list across subjects, with what is outstanding', async () => {
    const work = await learningService.dueFor(guardian(), childOne.studentId);
    expect(work.length).toBeGreaterThan(0);
    const row = work.find((w) => w.assignment_id === published);
    expect(row?.subject_name).toBe('Physics');
    expect(row?.submitted_at).not.toBeNull();
    expect(work.map((w) => w.assignment_id)).not.toContain(draft);
  });

  it('will not hand one family another family\'s list', async () => {
    expect(await learningService.dueFor(otherGuardian(), childOne.studentId)).toHaveLength(0);
  });
});

describe('the picker', () => {
  it('offers a teacher their own classes and marks them as theirs', async () => {
    const mine = await learningService.offerings(teacher());
    const row = mine.find((o) => o.id === offeringId);
    expect(row?.is_mine).toBe(true);
    expect(row?.subject_name).toBe('Physics');
    // The other section's offering belongs to somebody else and, since 0077,
    // is not even visible to this teacher.
    expect(mine.map((o) => o.id)).not.toContain(otherOfferingId);
  });

  it('offers the class teacher the same class, not marked as theirs', async () => {
    const seen = await learningService.offerings(classTeacher());
    const row = seen.find((o) => o.id === offeringId);
    expect(row).toBeDefined();
    expect(row?.is_mine).toBe(false);
  });

  it('offers a parent only the classes their own child is in', async () => {
    const seen = await learningService.offerings(guardian());
    expect(seen.map((o) => o.id)).toContain(offeringId);
    expect(seen.map((o) => o.id)).not.toContain(otherOfferingId);
    expect(seen.every((o) => o.is_mine === false)).toBe(true);
  });

  it('offers the other school nothing', async () => {
    expect(await learningService.offerings(otherOffice())).toHaveLength(0);
  });
});

describe('lessons', () => {
  it('are the teacher\'s until they are published', async () => {
    const l = await learningService.createLesson(teacher(), {
      courseOfferingId: offeringId, title: 'Forces', summary: 'F = ma', sequenceNo: 1,
    });
    expect(l.status).toBe('draft');
    expect(await learningService.lessons(guardian(), offeringId)).toHaveLength(0);

    await learningService.publishLesson(teacher(), l.id);
    const seen = await learningService.lessons(guardian(), offeringId);
    expect(seen.map((x) => x.id)).toContain(l.id);
  });

  it('cannot be published twice', async () => {
    const l = await learningService.createLesson(teacher(), {
      courseOfferingId: offeringId, title: 'Momentum', sequenceNo: 2,
    });
    await learningService.publishLesson(teacher(), l.id);
    const err = await refusal(learningService.publishLesson(teacher(), l.id));
    expect(err.code).toBe('lesson_not_draft');
  });

  it('are refused to a teacher who does not own the offering', async () => {
    await expect(learningService.createLesson(stranger(), {
      courseOfferingId: offeringId, title: 'Not mine',
    })).rejects.toThrow();
  });

  it('let the office in, because the office runs the school', async () => {
    const l = await learningService.createLesson(office(), {
      courseOfferingId: otherOfferingId, title: 'Office-set lesson',
    });
    expect(l.id).toBeTruthy();
  });
});
