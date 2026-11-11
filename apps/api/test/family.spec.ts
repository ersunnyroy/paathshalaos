/**
 * M21 — what a parent sees, and what they must never see.
 *
 * Two families, one school. Every test here is an answer to "could this parent
 * see another family's child", asked of a different surface: attendance, fees,
 * marks, the bus, the school's messages. The interesting ones are the marks —
 * a run that is computed but not published is a teacher's working, and a parent
 * reading it is a parent ringing the school about a number that is about to
 * change.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import {
  createTenant, destroyTenants, createUser, destroyUsers, grantRole, purgeTestData,
  createAcademicYear, createAcademicStructure, createLearnerRaw, linkGuardianRaw,
  createPersonRaw, createClassGroupRaw, createSectionFor, makeTeacher,
  OWNER_URL, type TenantFixture, type UserFixture, type LearnerFixture,
} from './fixtures.ts';
import { familyService } from '../src/modules/family/family.service.ts';
import { withTenant } from '../src/db/tenant.ts';
import { pool } from '../src/db/pool.ts';
import { authPool } from '../src/db/auth-pool.ts';

const PASSWORD = 'correct-horse-battery';

let tenant: TenantFixture;
let other: TenantFixture;

let parentA: UserFixture;      // Aarav's mother — sees everything
let parentB: UserFixture;      // Diya's father — a different family
let parentNoMoney: UserFixture; // Aarav's other parent, no finance permission
let parentNoMarks: UserFixture; // an aunt with pickup rights and no academics
let teacherUser: UserFixture;
let otherParent: UserFixture;  // a parent at the OTHER school

let personA: string, personB: string, personNoMoney: string, personNoMarks: string;

let aarav: LearnerFixture;
let diya: LearnerFixture;
let enrolAarav: string;
let enrolDiya: string;
let sectionId: string;
let termId: string;
let offeringId: string;
let publishedRun: string;
let unpublishedRun: string;
let otherSchoolRun: string;

async function owner<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: OWNER_URL });
  await client.connect();
  try { return await fn(client); } finally { await client.end(); }
}

const day = (back: number) =>
  new Date(Date.now() - back * 86_400_000).toISOString().slice(0, 10);

beforeAll(async () => {
  await purgeTestData('%@fam-test.example');
  tenant = await createTenant('FAM');
  other = await createTenant('FAM2');

  parentA = await createUser('mum@fam-test.example', PASSWORD);
  parentB = await createUser('dad@fam-test.example', PASSWORD);
  parentNoMoney = await createUser('other-parent@fam-test.example', PASSWORD);
  parentNoMarks = await createUser('aunt@fam-test.example', PASSWORD);
  teacherUser = await createUser('teacher@fam-test.example', PASSWORD);
  otherParent = await createUser('parent@fam2-test.example', PASSWORD);

  for (const u of [parentA, parentB, parentNoMoney, parentNoMarks]) {
    await grantRole(tenant.orgId, u.userId, 'GUARDIAN', 'self', tenant.campusId);
  }
  await grantRole(tenant.orgId, teacherUser.userId, 'TEACHER', 'campus', tenant.campusId);
  await grantRole(other.orgId, otherParent.userId, 'GUARDIAN', 'self', other.campusId);

  personA = await createPersonRaw(tenant.orgId, 'Kavita',
    { userAccountId: parentA.userId, familyName: 'Kumar' });
  personB = await createPersonRaw(tenant.orgId, 'Rajesh',
    { userAccountId: parentB.userId, familyName: 'Joshi' });
  personNoMoney = await createPersonRaw(tenant.orgId, 'Suresh',
    { userAccountId: parentNoMoney.userId, familyName: 'Kumar' });
  personNoMarks = await createPersonRaw(tenant.orgId, 'Lakshmi',
    { userAccountId: parentNoMarks.userId, familyName: 'Kumar' });

  const struct = await createAcademicStructure(tenant.orgId, tenant.unitId, tenant.campusId);
  const year = await createAcademicYear(tenant.orgId, tenant.unitId, '2026-27', 2026,
    { status: 'active' });
  termId = year.termIds[0]!;
  const cg = await createClassGroupRaw(tenant.orgId, struct.programmeId, year.yearId, 'Class IX');
  sectionId = await createSectionFor(tenant.orgId, cg, 'A');
  const teacherStaff = await makeTeacher(tenant.orgId, tenant.campusId,
    teacherUser.userId, { givenName: 'Meera', classTeacherOf: [sectionId] });

  aarav = await createLearnerRaw(tenant.orgId, 'Aarav', 'FAM-0001');
  diya = await createLearnerRaw(tenant.orgId, 'Diya', 'FAM-0002');

  await linkGuardianRaw(tenant.orgId, aarav.studentId, personA, { isPrimary: true });
  await linkGuardianRaw(tenant.orgId, diya.studentId, personB, { isPrimary: true });
  // The same child, the other parent — allowed academics, not fees. A real
  // arrangement, and the one that proves the flags are per-link and not
  // per-child.
  await linkGuardianRaw(tenant.orgId, aarav.studentId, personNoMoney,
    { canViewFinance: false, canPay: false });
  // An aunt who collects him from school and is not shown his marks. The
  // school decides this per link, and it is the case that proves the marks
  // permission is a permission rather than a label.
  await linkGuardianRaw(tenant.orgId, aarav.studentId, personNoMarks,
    { canViewAcademics: false, canViewFinance: false, canPay: false });
  // The aunt used to have full access, and the school ended that link and made
  // a narrower one. Withdrawing access by ending a link and writing a new one
  // is how a school actually does it, so both rows exist for the same adult —
  // and anything that reads her permissions without asking which link is in
  // force hands back the access that was taken away.
  await owner(async (c) => {
    await c.query(
      `INSERT INTO guardian_link (tenant_id, student_id, guardian_person_id,
                                  relationship, can_view_academics,
                                  can_view_finance, can_pay,
                                  effective_from, effective_to)
       VALUES ($1, $2, $3, 'uncle_aunt', true, true, true,
               CURRENT_DATE - 400, CURRENT_DATE - 30)`,
      [tenant.orgId, aarav.studentId, personNoMarks]);
  });

  await owner(async (c) => {
    const e1 = await c.query<{ id: string }>(
      `INSERT INTO enrollment (tenant_id, student_id, section_id, academic_year_id)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [tenant.orgId, aarav.studentId, sectionId, year.yearId]);
    enrolAarav = e1.rows[0]!.id;
    const e2 = await c.query<{ id: string }>(
      `INSERT INTO enrollment (tenant_id, student_id, section_id, academic_year_id)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [tenant.orgId, diya.studentId, sectionId, year.yearId]);
    enrolDiya = e2.rows[0]!.id;

    const off = await c.query<{ id: string }>(
      `INSERT INTO course_offering (tenant_id, class_group_id, subject_id, term_id)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [tenant.orgId, cg, struct.subjectId, termId]);
    offeringId = off.rows[0]!.id;

    // Attendance: four days, one absence, one late. Two sessions on the same
    // day, disagreeing — the day that proves how a day is summarised.
    for (const [back, a, d] of [[1, 'present', 'present'], [2, 'absent', 'present'],
                                [3, 'late', 'absent'], [4, 'present', 'present']] as const) {
      const s = await c.query<{ id: string }>(
        `INSERT INTO attendance_session
           (tenant_id, section_id, academic_year_id, session_date, mode, status,
            submitted_at)
         VALUES ($1, $2, $3, $4::date, 'day', 'submitted', now()) RETURNING id`,
        [tenant.orgId, sectionId, year.yearId, day(back)]);
      for (const [enrol, state] of [[enrolAarav, a], [enrolDiya, d]] as const) {
        await c.query(
          `INSERT INTO attendance_record
             (tenant_id, attendance_session_id, session_date, enrollment_id, state,
              minutes_late, client_event_id)
           VALUES ($1, $2, (SELECT session_date FROM attendance_session WHERE id = $2),
                   $3, $4,
                   CASE WHEN $4 = 'late' THEN 12 END, gen_random_uuid())`,
          [tenant.orgId, s.rows[0]!.id, enrol, state]);
      }
    }
    // A second session on day 2, where Aarav was present. The day should still
    // read absent: a parent told "present" for a day their child missed a
    // morning has been told the wrong thing.
    const extra = await c.query<{ id: string }>(
      `INSERT INTO attendance_session
         (tenant_id, section_id, course_offering_id, academic_year_id,
          session_date, mode, period_no, status, submitted_at)
       VALUES ($1, $2, $3, $4, $5::date, 'subject', 3, 'submitted', now())
       RETURNING id`,
      [tenant.orgId, sectionId, offeringId, year.yearId, day(2)]);
    await c.query(
      `INSERT INTO attendance_record
         (tenant_id, attendance_session_id, session_date, enrollment_id, state,
          client_event_id)
       VALUES ($1, $2, (SELECT session_date FROM attendance_session WHERE id = $2),
               $3, 'present', gen_random_uuid())`,
      [tenant.orgId, extra.rows[0]!.id, enrolAarav]);

    // Fees: one part-paid invoice each, plus a void one that must not count.
    await c.query(
      `INSERT INTO invoice (tenant_id, campus_id, enrollment_id, invoice_no,
                            financial_year, issued_on, due_on, subtotal, total,
                            amount_paid, status)
       VALUES ($1, $2, $3, 'FAM-INV-1', '2026-27', CURRENT_DATE - 10,
               CURRENT_DATE + 5, 12500.10, 12500.10, 2500.10, 'part_paid')`,
      [tenant.orgId, tenant.campusId, enrolAarav]);
    await c.query(
      `INSERT INTO invoice (tenant_id, campus_id, enrollment_id, invoice_no,
                            financial_year, issued_on, due_on, subtotal, total,
                            amount_paid, status, voided_at, void_reason)
       VALUES ($1, $2, $3, 'FAM-INV-VOID', '2026-27', CURRENT_DATE - 40,
               CURRENT_DATE - 20, 9000.00, 9000.00, 0, 'void', now(),
               'raised against the wrong term')`,
      [tenant.orgId, tenant.campusId, enrolAarav]);
    await c.query(
      `INSERT INTO invoice (tenant_id, campus_id, enrollment_id, invoice_no,
                            financial_year, issued_on, due_on, subtotal, total,
                            amount_paid, status)
       VALUES ($1, $2, $3, 'FAM-INV-2', '2026-27', CURRENT_DATE - 10,
               CURRENT_DATE + 5, 8000.00, 8000.00, 0, 'issued')`,
      [tenant.orgId, tenant.campusId, enrolDiya]);

    const scale = await c.query<{ id: string }>(
      `INSERT INTO grading_scale (tenant_id, academic_unit_id, name, kind,
                                  is_published, published_at)
       VALUES ($1, $2, 'CBSE', 'percentage', true, now()) RETURNING id`,
      [tenant.orgId, tenant.unitId]);

    const published = await c.query<{ id: string }>(
      `INSERT INTO result_run (tenant_id, academic_year_id, term_id, section_id,
                               grading_scale_id, inputs_digest, status,
                               reviewed_by, reviewed_at, published_at)
       VALUES ($1, $2, $3, $4, $5, 'digest-published', 'published', $6,
               now() - interval '1 hour', now())
       RETURNING id`,
      [tenant.orgId, year.yearId, termId, sectionId, scale.rows[0]!.id,
       teacherStaff.staffId]);
    publishedRun = published.rows[0]!.id;

    const draft = await c.query<{ id: string }>(
      `INSERT INTO result_run (tenant_id, academic_year_id, term_id, section_id,
                               grading_scale_id, inputs_digest, status)
       VALUES ($1, $2, $3, $4, $5, 'digest-draft', 'computed') RETURNING id`,
      [tenant.orgId, year.yearId, year.termIds[1]!, sectionId, scale.rows[0]!.id]);
    unpublishedRun = draft.rows[0]!.id;

    for (const run of [publishedRun, unpublishedRun]) {
      for (const [enrol, pct] of [[enrolAarav, 78.5], [enrolDiya, 91.25]] as const) {
        await c.query(
          `INSERT INTO result_line (tenant_id, result_run_id, enrollment_id,
                                    course_offering_id, obtained, maximum,
                                    percentage, grade_label, is_pass)
           VALUES ($1, $2, $3, $4, $5, 100, $5, 'B1', true)`,
          [tenant.orgId, run, enrol, offeringId, pct]);
      }
    }

    // A published run at the OTHER school, so "another tenant's run" is a
    // thing that exists rather than a hypothetical. It is the only way to
    // exercise the tenant clause inside app_family_in_result_run, which runs
    // as the definer and is therefore protected by nothing but itself.
    const otherStruct = await c.query<{ unit: string }>(
      `SELECT id AS unit FROM academic_unit WHERE tenant_id = $1 LIMIT 1`,
      [other.orgId]);
    const oy = await c.query<{ id: string }>(
      `INSERT INTO academic_year (tenant_id, academic_unit_id, label, starts_on,
                                  ends_on, status)
       VALUES ($1, $2, '2026-27', make_date(2026,4,1), make_date(2027,3,31),
               'active') RETURNING id`,
      [other.orgId, otherStruct.rows[0]!.unit]);
    const ot = await c.query<{ id: string }>(
      `INSERT INTO term (tenant_id, academic_year_id, label, sequence,
                         starts_on, ends_on)
       VALUES ($1, $2, 'Term 1', 1, make_date(2026,4,1), make_date(2026,9,30))
       RETURNING id`, [other.orgId, oy.rows[0]!.id]);
    const oprog = await c.query<{ id: string }>(
      `INSERT INTO programme (tenant_id, academic_unit_id, code, name,
                              credential_type)
       VALUES ($1, $2, 'P', 'Programme', 'board_examination') RETURNING id`,
      [other.orgId, otherStruct.rows[0]!.unit]);
    const ocg = await c.query<{ id: string }>(
      `INSERT INTO class_group (tenant_id, programme_id, academic_year_id, name)
       VALUES ($1, $2, $3, 'Class IX') RETURNING id`,
      [other.orgId, oprog.rows[0]!.id, oy.rows[0]!.id]);
    const osec = await c.query<{ id: string }>(
      `INSERT INTO section (tenant_id, class_group_id, name)
       VALUES ($1, $2, 'A') RETURNING id`, [other.orgId, ocg.rows[0]!.id]);
    const operson = await c.query<{ id: string }>(
      `INSERT INTO person (tenant_id, given_name) VALUES ($1, 'Riya')
       RETURNING id`, [other.orgId]);
    const ostudent = await c.query<{ id: string }>(
      `INSERT INTO student (tenant_id, person_id, admission_no, lifecycle_status)
       VALUES ($1, $2, 'FAM2-0001', 'enrolled') RETURNING id`,
      [other.orgId, operson.rows[0]!.id]);
    const oenrol = await c.query<{ id: string }>(
      `INSERT INTO enrollment (tenant_id, student_id, section_id, academic_year_id)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [other.orgId, ostudent.rows[0]!.id, osec.rows[0]!.id, oy.rows[0]!.id]);
    const ostaffPerson = await c.query<{ id: string }>(
      `INSERT INTO person (tenant_id, given_name) VALUES ($1, 'Reviewer')
       RETURNING id`, [other.orgId]);
    const ostaff = await c.query<{ id: string }>(
      `INSERT INTO staff (tenant_id, person_id, campus_id, employee_code,
                          designation, joined_on)
       VALUES ($1, $2, $3, 'EMP-9', 'Teacher', CURRENT_DATE) RETURNING id`,
      [other.orgId, ostaffPerson.rows[0]!.id, other.campusId]);
    const orun = await c.query<{ id: string }>(
      `INSERT INTO result_run (tenant_id, academic_year_id, term_id, section_id,
                               inputs_digest, status, reviewed_by, reviewed_at,
                               published_at)
       VALUES ($1, $2, $3, $4, 'digest-other', 'published', $5,
               now() - interval '1 hour', now())
       RETURNING id`,
      [other.orgId, oy.rows[0]!.id, ot.rows[0]!.id, osec.rows[0]!.id,
       ostaff.rows[0]!.id]);
    otherSchoolRun = orun.rows[0]!.id;
    await c.query(
      `INSERT INTO result_line (tenant_id, result_run_id, enrollment_id,
                                obtained, maximum, percentage, is_pass)
       VALUES ($1, $2, $3, 55, 100, 55, true)`,
      [other.orgId, otherSchoolRun, oenrol.rows[0]!.id]);
    // The same person id is linked as a guardian there too — a coincidence
    // that cannot happen with real accounts, and exactly the thing the tenant
    // clause has to survive.
    await c.query(
      `INSERT INTO guardian_link (tenant_id, student_id, guardian_person_id,
                                  relationship, can_view_academics)
       VALUES ($1, $2, $3, 'mother', true)`,
      [other.orgId, ostudent.rows[0]!.id, personA]);

    // A message to Aarav's mother, and one to Diya's father.
    const template = await c.query<{ id: string }>(
      `INSERT INTO message_template (tenant_id, code, name, purpose)
       VALUES ($1, 'fam-notice', 'School notice', 'core_education_service')
       RETURNING id`, [tenant.orgId]);
    const req = await c.query<{ id: string }>(
      `INSERT INTO message_request (tenant_id, campus_id, message_template_id,
                                    purpose, source_type, idempotency_key, status)
       VALUES ($1, $2, $3, 'core_education_service', 'manual', 'fam-test-1',
               'completed')
       RETURNING id`,
      [tenant.orgId, tenant.campusId, template.rows[0]!.id]);
    for (const [person, body] of [[personA, 'School closed tomorrow'],
                                  [personB, 'Fee reminder for Diya']] as const) {
      await c.query(
        `INSERT INTO message_recipient (tenant_id, message_request_id, person_id,
                                        channel, rendered_body, status)
         VALUES ($1, $2, $3, 'sms', $4, 'delivered')`,
        [tenant.orgId, req.rows[0]!.id, person, body]);
    }
  });
});

afterAll(async () => {
  await destroyUsers([parentA.userId, parentB.userId, parentNoMoney.userId,
    parentNoMarks.userId, teacherUser.userId, otherParent.userId]);
  await destroyTenants([tenant.orgId, other.orgId]);
  await Promise.all([pool.end(), authPool.end()]);
});

const mum = () => ({ tenantId: tenant.orgId, actorId: parentA.userId });
const dad = () => ({ tenantId: tenant.orgId, actorId: parentB.userId });
const coParent = () => ({ tenantId: tenant.orgId, actorId: parentNoMoney.userId });
const aunt = () => ({ tenantId: tenant.orgId, actorId: parentNoMarks.userId });
const elsewhere = () => ({ tenantId: other.orgId, actorId: otherParent.userId });

describe('whose children', () => {
  it('gives a parent their own child and nobody else’s', async () => {
    const mine = await familyService.children(mum());
    expect(mine.map((c) => c.admission_no)).toEqual(['FAM-0001']);
    expect(mine[0]!.given_name).toBe('Aarav');
    expect(mine[0]!.class_name).toBe('Class IX');
    expect(mine[0]!.section_name).toBe('A');
  });

  it('gives the other family theirs', async () => {
    expect((await familyService.children(dad())).map((c) => c.admission_no))
      .toEqual(['FAM-0002']);
  });

  it('reports each parent’s own permissions, not the other parent’s', async () => {
    // Both are linked to Aarav; only one may see the fees. A flag read off the
    // child rather than off the link would hand the second parent the first
    // parent's access.
    expect((await familyService.children(mum()))[0]!.can_view_finance).toBe(true);
    expect((await familyService.children(coParent()))[0]!.can_view_finance).toBe(false);
    expect((await familyService.children(coParent()))[0]!.can_view_academics).toBe(true);
  });

  it('gives a parent at another school nothing', async () => {
    expect(await familyService.children(elsewhere())).toEqual([]);
  });
});

describe('was my child in school', () => {
  it('summarises the days, worst mark first', async () => {
    const seen = await familyService.attendance(mum(),
      { studentId: aarav.studentId, from: day(10), to: day(0) });

    expect(seen.recorded).toBe(4);
    expect(seen.present).toBe(2);
    expect(seen.absent).toBe(1);
    expect(seen.late).toBe(1);

    // Day 2 had two sessions: absent in one, present in the other. The day
    // reads absent, because telling a parent "present" for a day their child
    // missed a morning is telling them the wrong thing.
    expect(seen.days.find((d) => d.on_date === day(2))!.state).toBe('absent');
  });

  it('refuses another family’s child', async () => {
    const seen = await familyService.attendance(mum(),
      { studentId: diya.studentId, from: day(10), to: day(0) });
    expect(seen.days).toEqual([]);
    expect(seen.recorded).toBe(0);
  });

  it('honours the window', async () => {
    const seen = await familyService.attendance(mum(),
      { studentId: aarav.studentId, from: day(2), to: day(1) });
    expect(seen.recorded).toBe(2);
  });
});

describe('what do I owe', () => {
  it('adds up to the rows on the screen, in paise', async () => {
    const owed = await familyService.fees(mum(), aarav.studentId);
    // 12500.10 - 2500.10 = 10000.00, and not a floating-point approximation
    // of it: a parent shown 999999 paise for a 1000000 paise bill will not pay.
    expect(owed.outstanding_paise).toBe('1000000');
    expect(owed.invoices.map((i) => i.invoice_no)).toEqual(['FAM-INV-1']);
    expect(owed.invoices[0]!.total_paise).toBe('1250010');
  });

  it('leaves a void invoice out of the total', async () => {
    const owed = await familyService.fees(mum(), aarav.studentId);
    expect(owed.invoices.map((i) => i.invoice_no)).not.toContain('FAM-INV-VOID');
  });

  it('gives the parent without finance permission nothing to see', async () => {
    // Not an error. The other parent handles the fees; this one is not being
    // told off for opening the screen.
    const owed = await familyService.fees(coParent(), aarav.studentId);
    expect(owed.invoices).toEqual([]);
    expect(owed.outstanding_paise).toBe('0');
  });

  it('gives another family nothing', async () => {
    expect((await familyService.fees(mum(), diya.studentId)).invoices).toEqual([]);
  });
});

describe('how did they do', () => {
  it('shows a published run, with its term', async () => {
    const seen = await familyService.results(mum(), aarav.studentId);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.result_run_id).toBe(publishedRun);
    // The term is the point of 0068. A column of percentages with no heading
    // is how last term's marks get read as this term's.
    expect(seen[0]!.term_label).toBe('Term 1');
    expect(seen[0]!.lines[0]!.percentage).toBe('78.500');
    expect(seen[0]!.lines[0]!.subject).toBe('Physics');
  });

  it('never shows a run that has not been published', async () => {
    // A computed run is a teacher's working. A parent reading it is a parent
    // ringing the school about a number that is about to change.
    const seen = await familyService.results(mum(), aarav.studentId);
    expect(seen.map((r) => r.result_run_id)).not.toContain(unpublishedRun);
  });

  it('shows only this child’s lines from a shared run', async () => {
    // Both children are in the same published run. The run is visible to both
    // families; the lines must not be.
    const seen = await familyService.results(mum(), aarav.studentId);
    const pcts = seen.flatMap((r) => r.lines.map((l) => l.percentage));
    expect(pcts).toEqual(['78.500']);
    expect(pcts).not.toContain('91.250');
  });

  it('gives another family nothing', async () => {
    expect(await familyService.results(mum(), diya.studentId)).toEqual([]);
  });
});

describe('what has the school told me', () => {
  it('gives a parent the messages addressed to them', async () => {
    const seen = await familyService.messages(mum());
    expect(seen.map((m) => m.body)).toEqual(['School closed tomorrow']);
  });

  it('does not give them the other family’s', async () => {
    expect((await familyService.messages(mum())).map((m) => m.body))
      .not.toContain('Fee reminder for Diya');
  });

  it('includes a message that was delivered, not only one that was sent', async () => {
    // Both are terminal successes. Filtering on 'sent' alone hides exactly the
    // messages that arrived.
    expect(await familyService.messages(dad())).toHaveLength(1);
  });
});

describe('the office is not collateral damage', () => {
  it('can still read marks joined to their run', async () => {
    // 0068 gave result_run a family policy that read result_line, whose policy
    // reads result_run. That pair recurses, and Postgres refuses the read for
    // EVERYBODY — the office's results screen included. The claim in 0069 that
    // the first attempt jammed every other door is asserted here rather than
    // believed.
    const staff = { tenantId: tenant.orgId, actorId: teacherUser.userId };
    const rows = await withTenant(staff, async (db) => {
      const { rows } = await db.query<{ status: string; percentage: string }>(
        `SELECT r.status, l.percentage::text
           FROM result_line l JOIN result_run r ON r.id = l.result_run_id
          WHERE r.section_id = $1 ORDER BY l.percentage`, [sectionId]);
      return rows;
    });
    // Both runs, both children: four lines. A teacher sees the draft too.
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.status)).toContain('computed');
  });
});

describe('the run policy itself, not the query that uses it', () => {
  /*
   * `familyService.results` inner-joins result_line to result_run, and
   * result_line's own policy already demands a published run and
   * can_view_academics. So every assertion made through the service passes
   * whether or not result_run's policy says anything at all — weakening it to
   * a bare membership test left all nineteen tests green.
   *
   * That is the boarding WITH CHECK lesson again: a guarantee asserted only
   * through the one query that happens to be written today is a guarantee that
   * the next query does not have. These read the table directly, the way any
   * other caller would.
   */
  const runsVisibleTo = (scope: { tenantId: string; actorId: string }) =>
    withTenant(scope, async (db) => {
      const { rows } = await db.query<{ id: string; status: string }>(
        'SELECT id, status FROM result_run ORDER BY status');
      return rows;
    });

  it('shows a family the published run and not the draft', async () => {
    const seen = await runsVisibleTo(mum());
    expect(seen.map((r) => r.id)).toEqual([publishedRun]);
  });

  it('shows a family with no academics permission no run at all', async () => {
    // Not even that one exists. A family that may not read the marks must not
    // learn that a set of them has been published about their child.
    expect(await runsVisibleTo(aunt())).toEqual([]);
  });

  it('shows another family nothing', async () => {
    expect(await runsVisibleTo(elsewhere())).toEqual([]);
  });

  it('still shows the office everything', async () => {
    const staff = { tenantId: tenant.orgId, actorId: teacherUser.userId };
    expect((await runsVisibleTo(staff)).map((r) => r.status).sort())
      .toEqual(['computed', 'published']);
  });
});

describe('the function that bypasses row-level security', () => {
  it('answers no for a run in another school', async () => {
    // app_family_in_result_run is SECURITY DEFINER: inside it, no policy is
    // evaluated and nothing but its own WHERE clause stands between a caller
    // and every result_line in the database. Dropping its tenant clause failed
    // no test until this one existed, because every OTHER path to it already
    // had a tenant check in front. A guard on a definer function is exactly
    // the guard that must be asserted rather than assumed.
    const answer = await withTenant(mum(), async (db) => {
      const { rows } = await db.query<{ ok: boolean }>(
        'SELECT app_family_in_result_run($1) AS ok', [otherSchoolRun]);
      return rows[0]!.ok;
    });
    expect(answer).toBe(false);
  });

  it('answers yes for this family’s own run', async () => {
    const answer = await withTenant(mum(), async (db) => {
      const { rows } = await db.query<{ ok: boolean }>(
        'SELECT app_family_in_result_run($1) AS ok', [publishedRun]);
      return rows[0]!.ok;
    });
    expect(answer).toBe(true);
  });
});

describe('a staff account on the family endpoints', () => {
  /*
   * Two filters in this service looked redundant and are not.
   *
   * `message_recipient`'s policy already restricts a guardian to their own
   * rows, and `guardian_link`'s already restricts them to their own links — so
   * deleting either filter from the service failed no test. Both policies open
   * up for staff, and these endpoints are reachable by anybody with a session:
   * a teacher opening /v1/family/messages without the filter would be handed
   * every message the school has ever sent.
   *
   * There is no bug to fix here — the filters are correct — but a guarantee
   * that only holds because of who happened to be in the test is not a
   * guarantee. These use the caller the others do not.
   */
  const staff = () => ({ tenantId: tenant.orgId, actorId: teacherUser.userId });

  it('does not hand a teacher the whole school’s messages', async () => {
    // The teacher has no messages addressed to them. Without the person filter
    // they would get both families'.
    expect(await familyService.messages(staff())).toEqual([]);
  });

  it('does not credit a teacher with a family’s permissions', async () => {
    // A teacher sees the section's children here, which is what the student
    // policy allows. What they must not pick up is can_view_finance from
    // somebody else's guardian link.
    const seen = await familyService.children(staff());
    expect(seen.length).toBeGreaterThan(0);
    for (const child of seen) {
      expect(child.can_view_finance).toBe(false);
      expect(child.can_view_academics).toBe(false);
    }
  });
});

describe('access that was taken away', () => {
  it('does not give back a permission from an ended link', async () => {
    // The aunt held full access until a month ago. The old row is still there,
    // as the school's record of what she used to be allowed — and it must not
    // be read as what she is allowed now.
    const seen = await familyService.children(aunt());
    expect(seen.map((c) => c.admission_no)).toEqual(['FAM-0001']);
    expect(seen[0]!.can_view_academics).toBe(false);
    expect(seen[0]!.can_view_finance).toBe(false);
  });

  it('still refuses her the marks', async () => {
    expect(await familyService.results(aunt(), aarav.studentId)).toEqual([]);
  });
});
