/**
 * M8 — assessment and results.
 *
 * The three things worth the most test effort, because each is a wrong number
 * that reaches a family on paper:
 *   - an absence is not a zero;
 *   - a result is reviewed by a second person before anybody sees it;
 *   - a correction supersedes, and the card that was sent stays on file.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import {
  createTenant, destroyTenants, createUser, destroyUsers, grantRole, purgeTestData,
  createAcademicYear, createAcademicStructure, createLearnerRaw, linkGuardianRaw,
  createPersonRaw, createClassGroupRaw, createSectionFor,
  OWNER_URL, type TenantFixture, type UserFixture, type AcademicYearFixture,
} from './fixtures.ts';
import { gradingService } from '../src/modules/assessment/grading.service.ts';
import { assessmentService } from '../src/modules/assessment/assessment.service.ts';
import { resultService, digestOf } from '../src/modules/assessment/result.service.ts';
import { reportCardService } from '../src/modules/assessment/report-card.service.ts';
import { withTenant } from '../src/db/tenant.ts';
import { pool } from '../src/db/pool.ts';
import { authPool } from '../src/db/auth-pool.ts';

let tenant: TenantFixture;
let principal: UserFixture;
let teacherUser: UserFixture;
let guardianUser: UserFixture;
let guardianPersonId: string;
let year: AcademicYearFixture;
let struct: Awaited<ReturnType<typeof createAcademicStructure>>;
let secondStaffId: string;
let sectionId: string;
let termId: string;
let offeringId: string;
let scaleId: string;
let learners: Array<{ studentId: string; enrollmentId: string }> = [];

const PASSWORD = 'correct-horse-battery';

beforeAll(async () => {
  await purgeTestData('%@exam-test.example');
  tenant = await createTenant('EXAM');

  principal = await createUser('principal@exam-test.example', PASSWORD);
  teacherUser = await createUser('teacher@exam-test.example', PASSWORD);
  guardianUser = await createUser('parent@exam-test.example', PASSWORD);
  await grantRole(tenant.orgId, principal.userId, 'ORG_OWNER', 'organization', null);
  await grantRole(tenant.orgId, teacherUser.userId, 'TEACHER', 'campus', tenant.campusId);
  await grantRole(tenant.orgId, guardianUser.userId, 'GUARDIAN', 'self', tenant.campusId);
  guardianPersonId = await createPersonRaw(tenant.orgId, 'Meena', {
    userAccountId: guardianUser.userId, familyName: 'Parent',
  });

  struct = await createAcademicStructure(tenant.orgId, tenant.unitId, tenant.campusId);
  year = await createAcademicYear(tenant.orgId, tenant.unitId, '2026-27', 2026,
    { status: 'active' });
  const cg = await createClassGroupRaw(tenant.orgId, struct.programmeId, year.yearId, 'Class X');
  sectionId = await createSectionFor(tenant.orgId, cg, 'A');

  termId = year.termIds[0]!;
  offeringId = await asOwner(async (c) => {
    const offering = await c.query<{ id: string }>(
      `INSERT INTO course_offering
         (tenant_id, class_group_id, section_id, subject_id, term_id, primary_teacher_staff_id)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [tenant.orgId, cg, sectionId, struct.subjectId, termId, struct.staffId],
    );
    return offering.rows[0]!.id;
  });

  secondStaffId = await asOwner(async (c) => {
    const p = await c.query<{ id: string }>(
      `INSERT INTO person (tenant_id, given_name, family_name)
       VALUES ($1, 'Raj', 'Examiner') RETURNING id`, [tenant.orgId],
    );
    const s = await c.query<{ id: string }>(
      `INSERT INTO staff (tenant_id, person_id, campus_id, employee_code, joined_on)
       VALUES ($1, $2, $3, 'EMP-002', CURRENT_DATE) RETURNING id`,
      [tenant.orgId, p.rows[0]!.id, tenant.campusId],
    );
    return s.rows[0]!.id;
  });

  // Three learners: one who does well, one who is absent, one exempt.
  for (let i = 0; i < 3; i++) {
    const l = await createLearnerRaw(tenant.orgId, `Learner${i}`, `EXAM-000${i}`);
    const enrollmentId = await asOwner(async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO enrollment (tenant_id, student_id, section_id, academic_year_id)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [tenant.orgId, l.studentId, sectionId, year.yearId],
      );
      return rows[0]!.id;
    });
    learners.push({ studentId: l.studentId, enrollmentId });
  }
  // The guardian is linked to the first learner only.
  await linkGuardianRaw(tenant.orgId, learners[0]!.studentId, guardianPersonId);

  const scale = await gradingService.createDraft(owner(), {
    academicUnitId: tenant.unitId, name: 'CBSE-like', kind: 'letter',
    bands: [
      { label: 'F', lower: 0, upper: 33, gradePoint: 0, isPass: false },
      { label: 'D', lower: 33, upper: 50, gradePoint: 4 },
      { label: 'C', lower: 50, upper: 65, gradePoint: 6 },
      { label: 'B', lower: 65, upper: 80, gradePoint: 8 },
      { label: 'A', lower: 80, upper: 100.0001, gradePoint: 10 },
    ],
  });
  scaleId = scale.id;
  await gradingService.publish(owner(), scaleId, struct.staffId);
});

afterAll(async () => {
  await destroyUsers([principal.userId, teacherUser.userId, guardianUser.userId]);
  await destroyTenants([tenant.orgId]);
  await Promise.all([pool.end(), authPool.end()]);
});

const owner = () => ({ tenantId: tenant.orgId, actorId: principal.userId });
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

let assessmentCounter = 0;
async function anOpenAssessment(opts: { max?: number; weight?: number } = {}) {
  assessmentCounter += 1;
  const a = await assessmentService.create(owner(), {
    courseOfferingId: offeringId, termId,
    name: `Paper ${assessmentCounter}`, kind: 'exam',
    maxMarks: opts.max ?? 100, weightPercent: opts.weight ?? 100,
    gradingScaleId: scaleId,
  });
  await assessmentService.open(owner(), a.id);
  return a;
}

describe('grading scales', () => {
  it('refuses to publish a scale with a hole in it', async () => {
    // A gap is not a validation nicety: it produces a blank grade on a report
    // card the day it goes home.
    const gapped = await gradingService.createDraft(owner(), {
      academicUnitId: tenant.unitId, name: `Gapped ${randomUUID()}`, kind: 'letter',
      bands: [
        { label: 'LOW', lower: 0, upper: 40 },
        { label: 'HIGH', lower: 60, upper: 100.0001 },
      ],
    });
    await expect(
      gradingService.publish(owner(), gapped.id, struct.staffId),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('refuses two bands that overlap', async () => {
    await expect(
      gradingService.createDraft(owner(), {
        academicUnitId: tenant.unitId, name: `Overlap ${randomUUID()}`, kind: 'letter',
        bands: [
          { label: 'A', lower: 0, upper: 60 },
          { label: 'B', lower: 50, upper: 100.0001 },
        ],
      }),
    ).rejects.toThrow();
  });

  it('a boundary mark belongs to exactly one band', async () => {
    // 80 is an A, not both a B and an A depending on which row was reached
    // first. Half-open ranges are what make this true rather than lucky.
    const verdict = await withTenant(owner(), (db) =>
      gradingService.gradeFor(db, scaleId, '80'));
    expect(verdict!.label).toBe('A');

    const justBelow = await withTenant(owner(), (db) =>
      gradingService.gradeFor(db, scaleId, '79.999'));
    expect(justBelow!.label).toBe('B');
  });

  it('a published scale is frozen, bands and all', async () => {
    await expect(
      asOwner((c) => c.query(
        `UPDATE grading_scale SET name = 'Renamed' WHERE id = $1`, [scaleId])),
    ).rejects.toThrow(/published/i);

    await expect(
      asOwner((c) => c.query(
        `UPDATE grade_band SET span = numrange(0, 90, '[)') WHERE grading_scale_id = $1
           AND label = 'A'`, [scaleId])),
    ).rejects.toThrow(/published/i);

    await expect(
      asOwner((c) => c.query(
        `DELETE FROM grade_band WHERE grading_scale_id = $1 AND label = 'F'`, [scaleId])),
    ).rejects.toThrow(/published/i);
  });

  it('a published scale cannot be unpublished', async () => {
    await expect(
      asOwner((c) => c.query(
        `UPDATE grading_scale SET is_published = false, published_at = NULL WHERE id = $1`,
        [scaleId])),
    ).rejects.toThrow(/cannot be unpublished|published/i);
  });
});

describe('marks entry', () => {
  it('refuses marks against a draft assessment', async () => {
    const a = await assessmentService.create(owner(), {
      courseOfferingId: offeringId, termId, name: `Draft ${randomUUID()}`,
      kind: 'quiz', maxMarks: 20,
    });
    await expect(
      assessmentService.enterMarks(owner(), {
        assessmentId: a.id, enteredByStaffId: struct.staffId,
        marks: [{ enrollmentId: learners[0]!.enrollmentId, marks: 10 }],
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('records a class in one call', async () => {
    const a = await anOpenAssessment({ max: 50 });
    const { outcomes } = await assessmentService.enterMarks(owner(), {
      assessmentId: a.id, enteredByStaffId: struct.staffId,
      marks: learners.map((l, i) => ({ enrollmentId: l.enrollmentId, marks: 20 + i })),
    });
    expect(outcomes.every((o) => o.outcome === 'recorded')).toBe(true);
  });

  it('AN ABSENCE IS NOT A ZERO', async () => {
    // The single most consequential rule in this module. A learner who did not
    // sit the paper has no mark; storing 0 fails them for a paper they never
    // took and cannot be told apart from a genuine zero afterwards.
    const a = await anOpenAssessment({ max: 50 });
    await assessmentService.enterMarks(owner(), {
      assessmentId: a.id, enteredByStaffId: struct.staffId,
      marks: [
        { enrollmentId: learners[0]!.enrollmentId, absent: true },
        { enrollmentId: learners[1]!.enrollmentId, marks: 0 },
      ],
    });

    const rows = await withTenant(owner(), (db) => assessmentService.marksFor(db, a.id));
    const absent = rows.find((r) => r.enrollment_id === learners[0]!.enrollmentId)!;
    const zero = rows.find((r) => r.enrollment_id === learners[1]!.enrollmentId)!;

    expect(absent.is_absent).toBe(true);
    expect(absent.marks_obtained).toBeNull();
    expect(zero.is_absent).toBe(false);
    expect(zero.marks_obtained).toBe('0.00');
  });

  it('refuses a row that claims to be both a mark and an absence', async () => {
    const a = await anOpenAssessment();
    const { outcomes } = await assessmentService.enterMarks(owner(), {
      assessmentId: a.id, enteredByStaffId: struct.staffId,
      marks: [{ enrollmentId: learners[0]!.enrollmentId, marks: 0, absent: true }],
    });
    // Guessing which was meant is how a learner who sat the paper is recorded
    // absent.
    expect(outcomes[0]!.outcome).toBe('rejected');
  });

  it('the database itself refuses a row that is a mark AND an absence', async () => {
    // The service rejects this shape, but the service is not the only thing that
    // will ever write to `mark` — an import, a migration, a later feature. The
    // rule that an absence has no mark belongs in the table.
    const a = await anOpenAssessment({ max: 50 });
    await expect(
      asOwner((c) => c.query(
        `INSERT INTO mark (tenant_id, assessment_id, enrollment_id, marks_obtained, is_absent)
         VALUES ($1, $2, $3, 10, true)`,
        [tenant.orgId, a.id, learners[0]!.enrollmentId])),
    ).rejects.toThrow(/mark_is_exactly_one_thing/i);

    // And neither a mark nor an absence nor an exemption is equally refused: a
    // blank row is not a record of anything.
    await expect(
      asOwner((c) => c.query(
        `INSERT INTO mark (tenant_id, assessment_id, enrollment_id)
         VALUES ($1, $2, $3)`,
        [tenant.orgId, a.id, learners[1]!.enrollmentId])),
    ).rejects.toThrow(/mark_is_exactly_one_thing/i);
  });

  it('refuses a mark above the maximum, in the database', async () => {
    const a = await anOpenAssessment({ max: 50 });
    const { outcomes } = await assessmentService.enterMarks(owner(), {
      assessmentId: a.id, enteredByStaffId: struct.staffId,
      marks: [{ enrollmentId: learners[0]!.enrollmentId, marks: 51 }],
    });
    expect(outcomes[0]).toMatchObject({ outcome: 'rejected', reason: 'exceeds_max_marks' });

    // And not merely in the service: a raw INSERT is refused too.
    await expect(
      asOwner((c) => c.query(
        `INSERT INTO mark (tenant_id, assessment_id, enrollment_id, marks_obtained)
         VALUES ($1, $2, $3, 99)`,
        [tenant.orgId, a.id, learners[1]!.enrollmentId])),
    ).rejects.toThrow(/exceeds the maximum/i);
  });

  it('one bad row does not lose the rest of the class', async () => {
    const a = await anOpenAssessment({ max: 50 });
    const { outcomes } = await assessmentService.enterMarks(owner(), {
      assessmentId: a.id, enteredByStaffId: struct.staffId,
      marks: [
        { enrollmentId: learners[0]!.enrollmentId, marks: 40 },
        { enrollmentId: learners[1]!.enrollmentId, marks: 999 },
        { enrollmentId: learners[2]!.enrollmentId, marks: 30 },
      ],
    });
    expect(outcomes.map((o) => o.outcome)).toEqual(['recorded', 'rejected', 'recorded']);

    const rows = await withTenant(owner(), (db) => assessmentService.marksFor(db, a.id));
    expect(rows.length).toBe(2);
  });

  it('a replayed batch applies nothing the second time', async () => {
    const a = await anOpenAssessment({ max: 50 });
    const batch = learners.map((l) => ({
      enrollmentId: l.enrollmentId, marks: 25, clientEventId: randomUUID(),
    }));

    const first = await assessmentService.enterMarks(owner(), {
      assessmentId: a.id, enteredByStaffId: struct.staffId, marks: batch,
    });
    const second = await assessmentService.enterMarks(owner(), {
      assessmentId: a.id, enteredByStaffId: struct.staffId, marks: batch,
    });

    expect(first.outcomes.every((o) => o.outcome === 'recorded')).toBe(true);
    expect(second.outcomes.every((o) => o.outcome === 'already_applied')).toBe(true);
  });

  it('an event id reused for a different learner is rejected, not misapplied', async () => {
    // The M6 defect, in its new home: resolving "have I seen this?" by a query
    // that could match either the event id or the natural key attributed one
    // learner's entry to another.
    const a = await anOpenAssessment({ max: 50 });
    const shared = randomUUID();
    await assessmentService.enterMarks(owner(), {
      assessmentId: a.id, enteredByStaffId: struct.staffId,
      marks: [{ enrollmentId: learners[0]!.enrollmentId, marks: 10, clientEventId: shared }],
    });
    const { outcomes } = await assessmentService.enterMarks(owner(), {
      assessmentId: a.id, enteredByStaffId: struct.staffId,
      marks: [{ enrollmentId: learners[1]!.enrollmentId, marks: 40, clientEventId: shared }],
    });
    expect(outcomes[0]).toMatchObject({
      outcome: 'rejected', reason: 'client_event_id_belongs_to_another_learner',
    });

    const rows = await withTenant(owner(), (db) => assessmentService.marksFor(db, a.id));
    expect(rows.length).toBe(1);
    expect(rows[0]!.enrollment_id).toBe(learners[0]!.enrollmentId);
  });

  it('max_marks cannot change once marks exist', async () => {
    const a = await anOpenAssessment({ max: 50 });
    await assessmentService.enterMarks(owner(), {
      assessmentId: a.id, enteredByStaffId: struct.staffId,
      marks: [{ enrollmentId: learners[0]!.enrollmentId, marks: 40 }],
    });
    // Rescaling every learner's percentage without touching a single mark.
    await expect(
      asOwner((c) => c.query(`UPDATE assessment SET max_marks = 25 WHERE id = $1`, [a.id])),
    ).rejects.toThrow(/max_marks cannot change/i);
  });
});

describe('locking and corrections', () => {
  it('a locked assessment refuses new marks', async () => {
    const a = await anOpenAssessment({ max: 50 });
    await assessmentService.lock(owner(), a.id, struct.staffId);
    await expect(
      assessmentService.enterMarks(owner(), {
        assessmentId: a.id, enteredByStaffId: struct.staffId,
        marks: [{ enrollmentId: learners[0]!.enrollmentId, marks: 10 }],
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('a locked assessment cannot be reopened', async () => {
    const a = await anOpenAssessment({ max: 50 });
    await assessmentService.lock(owner(), a.id, struct.staffId);
    await expect(
      asOwner((c) => c.query(`UPDATE assessment SET status = 'open' WHERE id = $1`, [a.id])),
    ).rejects.toThrow(/cannot be reopened/i);
  });

  it('an approved correction changes the mark and keeps what it was', async () => {
    const a = await anOpenAssessment({ max: 50 });
    const entry = await assessmentService.enterMarks(owner(), {
      assessmentId: a.id, enteredByStaffId: struct.staffId,
      marks: [{ enrollmentId: learners[0]!.enrollmentId, marks: 34 }],
    });
    const markId = (entry.outcomes[0] as { markId: string }).markId;
    await assessmentService.lock(owner(), a.id, struct.staffId);

    const correction = await assessmentService.requestCorrection(owner(), {
      markId, toMarks: 43, reason: 'Transposed digits on entry.',
      requestedByStaffId: struct.staffId,
    });
    await assessmentService.approveCorrection(owner(), {
      correctionId: correction.id, approverStaffId: secondStaffId,
    });

    const rows = await withTenant(owner(), (db) => assessmentService.marksFor(db, a.id));
    expect(rows[0]!.marks_obtained).toBe('43.00');

    // "It always said 34" is answerable.
    const trail = await asOwner(async (c) => {
      const r = await c.query<{ from_marks: string; to_marks: string }>(
        `SELECT from_marks::text, to_marks::text FROM mark_correction WHERE id = $1`,
        [correction.id],
      );
      return r.rows[0]!;
    });
    expect(trail.from_marks).toBe('34.00');
    expect(trail.to_marks).toBe('43.00');
  });

  it('the requester cannot approve their own correction', async () => {
    const a = await anOpenAssessment({ max: 50 });
    const entry = await assessmentService.enterMarks(owner(), {
      assessmentId: a.id, enteredByStaffId: struct.staffId,
      marks: [{ enrollmentId: learners[0]!.enrollmentId, marks: 10 }],
    });
    await assessmentService.lock(owner(), a.id, struct.staffId);
    const correction = await assessmentService.requestCorrection(owner(), {
      markId: (entry.outcomes[0] as { markId: string }).markId,
      toMarks: 45, reason: 'Adjusting.', requestedByStaffId: struct.staffId,
    });
    await expect(
      assessmentService.approveCorrection(owner(), {
        correctionId: correction.id, approverStaffId: struct.staffId,
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('a correction cannot smuggle a mark past the maximum', async () => {
    const a = await anOpenAssessment({ max: 50 });
    const entry = await assessmentService.enterMarks(owner(), {
      assessmentId: a.id, enteredByStaffId: struct.staffId,
      marks: [{ enrollmentId: learners[0]!.enrollmentId, marks: 10 }],
    });
    await assessmentService.lock(owner(), a.id, struct.staffId);
    const correction = await assessmentService.requestCorrection(owner(), {
      markId: (entry.outcomes[0] as { markId: string }).markId,
      toMarks: 500, reason: 'Nope.', requestedByStaffId: struct.staffId,
    });
    // A correction is permission to change a mark, never permission to store an
    // impossible one.
    await expect(
      assessmentService.approveCorrection(owner(), {
        correctionId: correction.id, approverStaffId: secondStaffId,
      }),
    ).rejects.toThrow();
  });

  it('setting the correction flag alone does not unlock the assessment', async () => {
    // The flag is not the gate: a matching PENDING correction has to exist.
    const a = await anOpenAssessment({ max: 50 });
    await assessmentService.enterMarks(owner(), {
      assessmentId: a.id, enteredByStaffId: struct.staffId,
      marks: [{ enrollmentId: learners[0]!.enrollmentId, marks: 10 }],
    });
    await assessmentService.lock(owner(), a.id, struct.staffId);

    await expect(
      withTenant(owner(), async (db) => {
        await db.query(`SELECT set_config('app.applying_correction', $1, true)`,
          [randomUUID()]);
        await db.query(
          `UPDATE mark SET marks_obtained = 49 WHERE assessment_id = $1::uuid`, [a.id]);
      }),
    ).rejects.toThrow(/locked/i);
  });

  it('a settled correction cannot be edited or deleted', async () => {
    const a = await anOpenAssessment({ max: 50 });
    const entry = await assessmentService.enterMarks(owner(), {
      assessmentId: a.id, enteredByStaffId: struct.staffId,
      marks: [{ enrollmentId: learners[0]!.enrollmentId, marks: 11 }],
    });
    await assessmentService.lock(owner(), a.id, struct.staffId);
    const correction = await assessmentService.requestCorrection(owner(), {
      markId: (entry.outcomes[0] as { markId: string }).markId,
      toMarks: 22, reason: 'Fix.', requestedByStaffId: struct.staffId,
    });
    await assessmentService.approveCorrection(owner(), {
      correctionId: correction.id, approverStaffId: secondStaffId,
    });

    await expect(
      asOwner((c) => c.query(
        `UPDATE mark_correction SET to_marks = 50 WHERE id = $1`, [correction.id])),
    ).rejects.toThrow(/settled|cannot be edited/i);
    await expect(
      asOwner((c) => c.query(`DELETE FROM mark_correction WHERE id = $1`, [correction.id])),
    ).rejects.toThrow(/cannot be deleted/i);
  });
});

describe('result computation', () => {
  async function aGradedTerm(opts: { weights?: number[] } = {}) {
    const weights = opts.weights ?? [60, 40];
    const created = [];
    for (const w of weights) {
      const a = await anOpenAssessment({ max: 50, weight: w });
      created.push(a);
    }
    return created;
  }

  // Asserting the status alone is not enough here: several different refusals
  // in compute() are 409, so a test that only checks the status passes even when
  // the check it is about has been deleted. The code is the assertion.
  const codeOf = (e: unknown) =>
    (e as { getResponse(): { error: { code: string } } }).getResponse().error.code;

  it('refuses to compute while an assessment is still open', async () => {
    await anOpenAssessment({ max: 50, weight: 100 });
    const err = await resultService.compute(owner(), {
      sectionId, termId, gradingScaleId: scaleId, computedByStaffId: struct.staffId,
    }).catch((e) => e);
    expect(codeOf(err)).toBe('assessments_not_locked');
  });

  it('refuses to compute on an unpublished scale', async () => {
    const draft = await gradingService.createDraft(owner(), {
      academicUnitId: tenant.unitId, name: `Draft ${randomUUID()}`, kind: 'letter',
      bands: [{ label: 'X', lower: 0, upper: 100.0001 }],
    });
    const err = await resultService.compute(owner(), {
      sectionId, termId, gradingScaleId: draft.id, computedByStaffId: struct.staffId,
    }).catch((e) => e);
    expect(codeOf(err)).toBe('scale_not_published');
  });

  it('refuses to compute when a subject\'s weights do not add to 100', async () => {
    // A percentage computed over weights that sum to 90 is not a percentage of
    // anything. Checked at compute rather than at insert, because assessments
    // are created over weeks and an incomplete set mid-term is normal.
    const cg = await createClassGroupRaw(tenant.orgId, struct.programmeId, year.yearId,
      `Weights ${randomUUID().slice(0, 8)}`);
    const weightSection = await createSectionFor(tenant.orgId, cg, 'W');
    const offering = await asOwner(async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO course_offering (tenant_id, class_group_id, section_id, subject_id, term_id)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [tenant.orgId, cg, weightSection, struct.subjectId, termId],
      );
      return rows[0]!.id;
    });

    for (const weight of [60, 30]) {
      const a = await assessmentService.create(owner(), {
        courseOfferingId: offering, termId, name: `W${weight}`, kind: 'exam',
        maxMarks: 50, weightPercent: weight, gradingScaleId: scaleId,
      });
      await assessmentService.open(owner(), a.id);
      await assessmentService.lock(owner(), a.id, struct.staffId);
    }

    const err = await resultService.compute(owner(), {
      sectionId: weightSection, termId, gradingScaleId: scaleId,
      computedByStaffId: struct.staffId,
    }).catch((e) => e);
    expect(codeOf(err)).toBe('weights_do_not_total_100');
  });

  it('a learner with no mark at all is not graded zero', async () => {
    // Nobody recorded anything — which is not the same as an absence, and must
    // not read as one. The gap has to be VISIBLE to the reviewer, because the
    // alternative is a learner failing a subject the office simply forgot.
    const cg = await createClassGroupRaw(tenant.orgId, struct.programmeId, year.yearId,
      `Missing ${randomUUID().slice(0, 8)}`);
    const gapSection = await createSectionFor(tenant.orgId, cg, 'M');
    const offering = await asOwner(async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO course_offering (tenant_id, class_group_id, section_id, subject_id, term_id)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [tenant.orgId, cg, gapSection, struct.subjectId, termId],
      );
      return rows[0]!.id;
    });

    const marked = await createLearnerRaw(tenant.orgId, 'Marked', `EXAM-20${randomUUID().slice(0, 4)}`);
    const forgotten = await createLearnerRaw(tenant.orgId, 'Forgotten', `EXAM-21${randomUUID().slice(0, 4)}`);
    const enrol = async (studentId: string) => asOwner(async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO enrollment (tenant_id, student_id, section_id, academic_year_id)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [tenant.orgId, studentId, gapSection, year.yearId],
      );
      return rows[0]!.id;
    });
    const markedEnrollment = await enrol(marked.studentId);
    const forgottenEnrollment = await enrol(forgotten.studentId);

    const a = await assessmentService.create(owner(), {
      courseOfferingId: offering, termId, name: 'Only paper', kind: 'exam',
      maxMarks: 50, weightPercent: 100, gradingScaleId: scaleId,
    });
    await assessmentService.open(owner(), a.id);
    await assessmentService.enterMarks(owner(), {
      assessmentId: a.id, enteredByStaffId: struct.staffId,
      marks: [{ enrollmentId: markedEnrollment, marks: 40 }],
    });
    await assessmentService.lock(owner(), a.id, struct.staffId);

    const { lines } = await resultService.compute(owner(), {
      sectionId: gapSection, termId, gradingScaleId: scaleId,
      computedByStaffId: struct.staffId,
    });

    const missing = lines.find((l) =>
      l.enrollment_id === forgottenEnrollment && l.course_offering_id === null)!;
    expect(missing.percentage).toBeNull();
    expect(missing.not_graded_reason).toBe('no_marks_recorded');

    const present = lines.find((l) =>
      l.enrollment_id === markedEnrollment && l.course_offering_id === null)!;
    expect(Number(present.percentage)).toBeCloseTo(80, 3);
  });

  it('the digest changes when any input changes', () => {
    const base = {
      assessments: [{ id: 'a1', course_offering_id: 'c1', max_marks: '50.00',
        weight_percent: '100.00' }],
      marks: [{ assessment_id: 'a1', enrollment_id: 'e1', marks_obtained: '40.00',
        is_absent: false, is_exempt: false }],
      enrollments: ['e1'],
      bands: [{ label: 'A', lower: '0', upper: '100', grade_point: '10' }],
    };
    const original = digestOf(base);

    // Halving the maximum doubles everyone's percentage without touching a mark.
    // A digest that missed this would call the two runs identical.
    expect(digestOf({ ...base,
      assessments: [{ ...base.assessments[0]!, max_marks: '25.00' }] })).not.toBe(original);
    expect(digestOf({ ...base,
      marks: [{ ...base.marks[0]!, marks_obtained: '41.00' }] })).not.toBe(original);
    expect(digestOf({ ...base,
      marks: [{ ...base.marks[0]!, is_absent: true, marks_obtained: null }] }))
      .not.toBe(original);
    expect(digestOf({ ...base,
      bands: [{ ...base.bands[0]!, lower: '1' }] })).not.toBe(original);
    expect(digestOf(base)).toBe(original);
  });
});

describe('a term end to end', () => {
  let runId: string;
  let secondSection: string;
  let cohort: string[] = [];

  beforeAll(async () => {
    // A clean section of its own, so the earlier tests' half-finished
    // assessments do not bleed into the arithmetic.
    const cg = await createClassGroupRaw(tenant.orgId, struct.programmeId, year.yearId,
      'Class XI');
    secondSection = await createSectionFor(tenant.orgId, cg, 'B');

    for (let i = 0; i < 3; i++) {
      const l = await createLearnerRaw(tenant.orgId, `End${i}`, `EXAM-10${i}`);
      const enrollmentId = await asOwner(async (c) => {
        const { rows } = await c.query<{ id: string }>(
          `INSERT INTO enrollment (tenant_id, student_id, section_id, academic_year_id)
           VALUES ($1, $2, $3, $4) RETURNING id`,
          [tenant.orgId, l.studentId, secondSection, year.yearId],
        );
        return rows[0]!.id;
      });
      cohort.push(enrollmentId);
    }

    const offering = await asOwner(async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO course_offering
           (tenant_id, class_group_id, section_id, subject_id, term_id)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [tenant.orgId, cg, secondSection, struct.subjectId, termId],
      );
      return rows[0]!.id;
    });

    // Two papers, 60/40. Learner 0 does well in both; learner 1 is absent from
    // the second; learner 2 is exempt from the second.
    const midterm = await assessmentService.create(owner(), {
      courseOfferingId: offering, termId, name: 'Midterm', kind: 'exam',
      maxMarks: 50, weightPercent: 60, gradingScaleId: scaleId,
    });
    const final = await assessmentService.create(owner(), {
      courseOfferingId: offering, termId, name: 'Final', kind: 'exam',
      maxMarks: 50, weightPercent: 40, gradingScaleId: scaleId,
    });
    await assessmentService.open(owner(), midterm.id);
    await assessmentService.open(owner(), final.id);

    await assessmentService.enterMarks(owner(), {
      assessmentId: midterm.id, enteredByStaffId: struct.staffId,
      marks: [
        { enrollmentId: cohort[0]!, marks: 45 },
        { enrollmentId: cohort[1]!, marks: 40 },
        { enrollmentId: cohort[2]!, marks: 25 },
      ],
    });
    await assessmentService.enterMarks(owner(), {
      assessmentId: final.id, enteredByStaffId: struct.staffId,
      marks: [
        { enrollmentId: cohort[0]!, marks: 40 },
        { enrollmentId: cohort[1]!, absent: true },
        { enrollmentId: cohort[2]!, exempt: true },
      ],
    });

    await assessmentService.lock(owner(), midterm.id, struct.staffId);
    await assessmentService.lock(owner(), final.id, struct.staffId);
  });

  it('computes the weighted percentages', async () => {
    const { run, lines } = await resultService.compute(owner(), {
      sectionId: secondSection, termId, gradingScaleId: scaleId,
      computedByStaffId: struct.staffId,
    });
    runId = run.id;

    const overall = (id: string) =>
      lines.find((l) => l.enrollment_id === id && l.course_offering_id === null)!;

    // 45/50 at 60% + 40/50 at 40% = 54 + 32 = 86.
    expect(Number(overall(cohort[0]!).percentage)).toBeCloseTo(86, 3);
    expect(overall(cohort[0]!).grade_label).toBe('A');

    // Absent from the 40% paper: assessed on both, scored zero on one.
    // 40/50 at 60% = 48, over a denominator of 100 → 48.
    expect(Number(overall(cohort[1]!).percentage)).toBeCloseTo(48, 3);
    expect(overall(cohort[1]!).grade_label).toBe('D');

    // Exempt from the 40% paper: it leaves the denominator entirely.
    // 25/50 over a denominator of 60 → 50.
    expect(Number(overall(cohort[2]!).percentage)).toBeCloseTo(50, 3);
    expect(overall(cohort[2]!).grade_label).toBe('C');
  });

  it('an exemption is not an absence', async () => {
    // The pair above is the whole point: identical raw marks, different
    // denominators, because "this does not count for you" is not "you scored
    // nothing".
    const lines = await withTenant(owner(), (db) => resultService.linesFor(db, runId));
    const absent = lines.find((l) =>
      l.enrollment_id === cohort[1]! && l.course_offering_id === null)!;
    const exempt = lines.find((l) =>
      l.enrollment_id === cohort[2]! && l.course_offering_id === null)!;
    expect(Number(absent.percentage)).toBeGreaterThan(0);
    expect(Number(exempt.percentage)).not.toBe(Number(absent.percentage));
  });

  it('re-running over unchanged inputs returns the same run', async () => {
    const again = await resultService.compute(owner(), {
      sectionId: secondSection, termId, gradingScaleId: scaleId,
      computedByStaffId: struct.staffId,
    });
    expect(again.unchanged).toBe(true);
    expect(again.run.id).toBe(runId);
  });

  it('cannot be published without a review', async () => {
    await expect(
      resultService.publish(owner(), { runId, publishedByStaffId: struct.staffId }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('cannot be reviewed by the person who computed it', async () => {
    // A wrong subject weighting published single-handed reaches three hundred
    // families before anybody reads a number.
    await expect(
      resultService.review(owner(), { runId, reviewerStaffId: struct.staffId }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('a reviewed run publishes', async () => {
    await resultService.review(owner(), { runId, reviewerStaffId: secondStaffId });
    await resultService.publish(owner(), { runId, publishedByStaffId: secondStaffId });
    const run = await resultService.byId(owner(), runId);
    expect(run!.status).toBe('published');
  });

  it('a result line cannot be edited, ever', async () => {
    await expect(
      asOwner((c) => c.query(
        `UPDATE result_line SET percentage = 99 WHERE result_run_id = $1`, [runId])),
    ).rejects.toThrow(/cannot be edited/i);
  });

  it('a published run cannot be unpublished or deleted', async () => {
    await expect(
      asOwner((c) => c.query(
        `UPDATE result_run SET status = 'computed' WHERE id = $1`, [runId])),
    ).rejects.toThrow(/only be superseded/i);
    await expect(
      asOwner((c) => c.query(`DELETE FROM result_run WHERE id = $1`, [runId])),
    ).rejects.toThrow(/cannot be deleted/i);
  });

  it('two runs cannot both be published for one section and term', async () => {
    await expect(
      asOwner((c) => c.query(
        `INSERT INTO result_run
           (tenant_id, academic_year_id, term_id, section_id, inputs_digest,
            status, reviewed_at, reviewed_by, published_at)
         SELECT tenant_id, academic_year_id, term_id, section_id, 'other-digest',
                'published', now(), $2, now()
           FROM result_run WHERE id = $1`,
        [runId, secondStaffId])),
    ).rejects.toThrow(/duplicate key|result_run_one_published/i);
  });

  describe('report cards', () => {
    let cardId: string;

    it('are issued as drafts from a published run', async () => {
      const { created, cards } = await reportCardService.issueForRun(owner(), { runId });
      expect(created).toBe(cohort.length);
      expect(cards.every((c) => c.status === 'draft')).toBe(true);
      cardId = cards.find((c) => c.enrollment_id === cohort[0]!)!.id;
    });

    it('a guardian cannot see a draft card', async () => {
      const seen = await withTenant(guardian(), async (db) => {
        const r = await db.query('SELECT id FROM report_card');
        return r.rows.length;
      });
      expect(seen).toBe(0);
    });

    it('publishing freezes it', async () => {
      await reportCardService.publish(owner(), {
        cardId, publishedByStaffId: secondStaffId,
      });
      await expect(
        asOwner((c) => c.query(
          `UPDATE report_card SET snapshot = '{}'::jsonb WHERE id = $1`, [cardId])),
      ).rejects.toThrow(/immutable/i);
      await expect(
        asOwner((c) => c.query(`DELETE FROM report_card WHERE id = $1`, [cardId])),
      ).rejects.toThrow(/cannot be deleted/i);
    });

    it('a draft card is reissued, not "corrected"', async () => {
      // Correcting a draft would record a card as superseded that no family
      // ever received, which makes the version history a lie about what was
      // sent.
      const drafts = await withTenant(owner(), async (db) => {
        const r = await db.query<{ id: string }>(
          `SELECT id FROM report_card WHERE status = 'draft' LIMIT 1`);
        return r.rows[0];
      });
      expect(drafts).toBeDefined();
      const err = await reportCardService.correct(owner(), {
        cardId: drafts!.id, newRunId: runId, reason: 'Nope.', byStaffId: secondStaffId,
      }).catch((e) => e);
      expect(
        (err as { getResponse(): { error: { code: string } } }).getResponse().error.code,
      ).toBe('not_published');
    });

    it('a correction supersedes and the old card stays on file', async () => {
      // A new run to correct towards: change a mark through the correction path
      // so the digest genuinely differs.
      const midterm = await asOwner(async (c) => {
        const r = await c.query<{ id: string }>(
          `SELECT a.id FROM assessment a
             JOIN course_offering co ON co.id = a.course_offering_id
            WHERE co.section_id = $1 AND a.name = 'Midterm'`, [secondSection]);
        return r.rows[0]!.id;
      });
      const markId = await asOwner(async (c) => {
        const r = await c.query<{ id: string }>(
          `SELECT id FROM mark WHERE assessment_id = $1 AND enrollment_id = $2`,
          [midterm, cohort[0]!]);
        return r.rows[0]!.id;
      });
      const correction = await assessmentService.requestCorrection(owner(), {
        markId, toMarks: 48, reason: 'Re-marked on appeal.',
        requestedByStaffId: struct.staffId,
      });
      await assessmentService.approveCorrection(owner(), {
        correctionId: correction.id, approverStaffId: secondStaffId,
      });

      const { run: newRun, unchanged } = await resultService.compute(owner(), {
        sectionId: secondSection, termId, gradingScaleId: scaleId,
        computedByStaffId: struct.staffId,
      });
      expect(unchanged).toBe(false);

      await resultService.review(owner(), {
        runId: newRun.id, reviewerStaffId: secondStaffId,
      });
      await resultService.supersede(owner(), {
        oldRunId: runId, newRunId: newRun.id,
        reason: 'Midterm re-marked on appeal.', byStaffId: secondStaffId,
      });

      const next = await reportCardService.correct(owner(), {
        cardId, newRunId: newRun.id, reason: 'Midterm re-marked on appeal.',
        byStaffId: secondStaffId,
      });
      expect(next.version).toBe(2);

      const versions = await withTenant(owner(), (db) =>
        reportCardService.versionsFor(db, cohort[0]!, termId));
      expect(versions.map((v) => v.status)).toEqual(['superseded', 'published']);

      // The card that went home is still the card on file.
      const old = versions[0]!;
      const snapshot = await asOwner(async (c) => {
        const r = await c.query<{ snapshot: { runId: string } }>(
          `SELECT snapshot FROM report_card WHERE id = $1`, [old.id]);
        return r.rows[0]!.snapshot;
      });
      expect(snapshot.runId).toBe(runId);
      expect(old.artefact_sha256).not.toBe(versions[1]!.artefact_sha256);
    });
  });
});

describe('who can see results', () => {
  it('a guardian sees a published card and a superseded one, never a draft', async () => {
    const seen = await withTenant(guardian(), async (db) => {
      const r = await db.query<{ status: string }>('SELECT status FROM report_card');
      return r.rows.map((x) => x.status);
    });
    expect(seen).not.toContain('draft');
  });

  it('a guardian cannot read a raw mark', async () => {
    // A mark is a working number. Showing it live turns every data-entry slip
    // into a complaint before anybody has noticed it.
    const seen = await withTenant(guardian(), async (db) => {
      const r = await db.query('SELECT id FROM mark');
      return r.rows.length;
    });
    expect(seen).toBe(0);
  });

  it('a guardian cannot read an unpublished result line', async () => {
    const run = await withTenant(owner(), async (db) => {
      const r = await db.query<{ id: string }>(
        `SELECT id FROM result_run WHERE status <> 'published' LIMIT 1`);
      return r.rows[0];
    });
    if (!run) return;

    const seen = await withTenant(guardian(), async (db) => {
      const r = await db.query('SELECT id FROM result_line WHERE result_run_id = $1::uuid',
        [run.id]);
      return r.rows.length;
    });
    expect(seen).toBe(0);
  });

  it('a guardian cannot write a mark', async () => {
    const affected = await withTenant(guardian(), async (db) => {
      const r = await db.query(`UPDATE mark SET marks_obtained = 50`);
      return r.rowCount;
    }).catch(() => 0);
    expect(affected).toBe(0);
  });
});
