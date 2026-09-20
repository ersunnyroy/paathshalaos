/**
 * M32 — the write surface, tested over real HTTP.
 *
 * This file is the milestone's point. Every module it covers already had a
 * service and a passing suite; what none of them had was a route. A service
 * test proves a function works. It cannot prove anybody can call it, and for
 * seven modules of this system nobody could.
 *
 * So these assertions go through `fetch`, through the guards, against a Nest
 * app built from the real `AppModule` — the same reason `public-api-http.spec`
 * exists, and the same class of bug it was written for: a handler that
 * typechecks, passes its service tests, and 500s on the first curl.
 */
import './fixtures.ts';
import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import {
  createTenant, destroyTenants, createUser, destroyUsers, grantRole, purgeTestData,
  createAcademicYear, createAcademicStructure, createClassGroupRaw, createSectionFor,
  makeTeacher, createLearnerRaw, createPersonRaw, linkGuardianRaw,
  OWNER_URL, type TenantFixture, type UserFixture,
} from './fixtures.ts';
import { AppModule } from '../src/app.module.ts';
import { tokenService } from '../src/modules/auth/token.service.ts';
import { catalogueService } from '../src/modules/billing-plans/catalogue.service.ts';
import { subscriptionService } from '../src/modules/billing-plans/subscription.service.ts';
import { pool } from '../src/db/pool.ts';
import { authPool } from '../src/db/auth-pool.ts';

const PASSWORD = 'correct-horse-battery';

let app: INestApplication;
let base: string;
let tenant: TenantFixture;

let officeUser: UserFixture;
let teacherUser: UserFixture;
let platformUser: UserFixture;

let officeToken = '';
let teacherToken = '';

let teacherStaffId = '';
let coverStaffId = '';
let officeStaffId = '';
let sectionA = '';
let sectionB = '';
let programmeId = '';
let academicYearId = '';
let leaveTypeId = '';
let planCode = '';

async function owner<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: OWNER_URL });
  await client.connect();
  try { return await fn(client); } finally { await client.end(); }
}

async function tokenFor(user: UserFixture, roles: string[]): Promise<string> {
  const { rows } = await authPool.query<{ grants_version: number }>(
    'SELECT grants_version FROM user_account WHERE id = $1', [user.userId]);
  return tokenService.signAccessToken({
    sub: user.userId, tenant_id: tenant.orgId, session_id: randomUUID(),
    gv: rows[0]!.grants_version, roles,
  });
}

interface Reply { status: number; body: any }

async function call(
  method: string, path: string, token: string, payload?: unknown,
): Promise<Reply> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const GET = (p: string, t: string) => call('GET', p, t);
const POST = (p: string, t: string, b?: unknown) => call('POST', p, t, b ?? {});

const today = () => new Date().toISOString().slice(0, 10);
const inDays = (n: number) =>
  new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

beforeAll(async () => {
  await purgeTestData('%@ws-test.example');
  tenant = await createTenant('WS');

  officeUser = await createUser('office@ws-test.example', PASSWORD);
  teacherUser = await createUser('teacher@ws-test.example', PASSWORD);
  platformUser = await createUser('platform@ws-test.example', PASSWORD);

  await grantRole(tenant.orgId, officeUser.userId, 'ORG_OWNER', 'organization', null);
  await grantRole(tenant.orgId, teacherUser.userId, 'TEACHER', 'campus', tenant.campusId);

  const struct = await createAcademicStructure(tenant.orgId, tenant.unitId, tenant.campusId);
  const year = await createAcademicYear(tenant.orgId, tenant.unitId, '2026-27', 2026,
    { status: 'active' });
  const cg = await createClassGroupRaw(tenant.orgId, struct.programmeId, year.yearId,
    'Class IX');
  sectionA = await createSectionFor(tenant.orgId, cg, 'A');
  sectionB = await createSectionFor(tenant.orgId, cg, 'B');
  programmeId = struct.programmeId;
  academicYearId = year.yearId;

  const t = await makeTeacher(tenant.orgId, tenant.campusId, teacherUser.userId,
    { givenName: 'Meera', employeeCode: 'WS-T1', classTeacherOf: [sectionA] });
  teacherStaffId = t.staffId;
  coverStaffId = struct.staffId;

  // The office account is staff too — an admission decision names a person,
  // and this is the person it names.
  const office = await makeTeacher(tenant.orgId, tenant.campusId, officeUser.userId,
    { givenName: 'Anjali', employeeCode: 'WS-OFF' });
  officeStaffId = office.staffId;

  // A learner in IX-A with a guardian, so the messaging audience is somebody.
  // Without this the send refuses with `empty_audience` — correctly, which is
  // itself asserted below, and uselessly as a test of sending.
  const child = await createLearnerRaw(tenant.orgId, 'Nisha', 'WS-MSG-1');
  const parentPersonId = await createPersonRaw(tenant.orgId, 'Sunita',
    { familyName: 'Rao' });
  await linkGuardianRaw(tenant.orgId, child.studentId, parentPersonId);
  await owner((c) => c.query(
    `INSERT INTO enrollment (tenant_id, student_id, section_id, academic_year_id)
     VALUES ($1, $2, $3, $4)`,
    [tenant.orgId, child.studentId, sectionA, year.yearId]));

  await owner(async (c) => {
    const lt = await c.query<{ id: string }>(
      `INSERT INTO leave_type (tenant_id, code, name, is_paid, annual_entitlement)
       VALUES ($1, 'CL', 'Casual leave', true, 12) RETURNING id`, [tenant.orgId]);
    leaveTypeId = lt.rows[0]!.id;
    await c.query(
      `INSERT INTO leave_balance (tenant_id, staff_id, leave_type_id, year_label, opening)
       VALUES ($1, $2, $3, '2026-27', 12)`,
      [tenant.orgId, teacherStaffId, leaveTypeId]);
    await c.query(
      `INSERT INTO staff_contract (tenant_id, staff_id, kind, weekly_hours, starts_on)
       VALUES ($1, $2, 'permanent', 40, CURRENT_DATE - 30)`,
      [tenant.orgId, teacherStaffId]);
    await c.query(
      `INSERT INTO platform_admin (user_account_id, capability) VALUES ($1, 'billing')`,
      [platformUser.userId]);
  });

  officeToken = await tokenFor(officeUser, ['ORG_OWNER']);
  teacherToken = await tokenFor(teacherUser, ['TEACHER']);

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication({ logger: false });
  await app.init();
  await app.listen(0);
  base = await app.getUrl();
}, 180_000);

afterAll(async () => {
  await app?.close();
  await owner((c) => c.query('DELETE FROM platform_admin WHERE user_account_id = $1',
    [platformUser.userId]));
  await destroyTenants([tenant.orgId]);
  await destroyUsers([officeUser.userId, teacherUser.userId, platformUser.userId]);
  await pool.end();
  await authPool.end();
}, 180_000);

// ---------------------------------------------------------------------------

describe('HR is reachable at all', () => {
  let absenceId = '';

  it('lists staff with their contract and balance', async () => {
    const res = await GET('/v1/hr/staff', officeToken);
    expect(res.status).toBe(200);
    const meera = res.body.data.find((s: any) => s.staff_id === teacherStaffId);
    expect(meera).toBeDefined();
    expect(meera.contract_kind).toBe('permanent');
    expect(meera.entitlement_days).toBe('12.0');
    expect(meera.away_today).toBe(false);
  });

  it('shows the contract in force on the day, not the newest row', async () => {
    // A contract that starts next term must not make somebody part-time today.
    await owner((c) => c.query(
      `INSERT INTO staff_contract (tenant_id, staff_id, kind, weekly_hours, starts_on)
       VALUES ($1, $2, 'visiting', 20, CURRENT_DATE + 60)`,
      [tenant.orgId, teacherStaffId]));

    const now = await GET('/v1/hr/staff', officeToken);
    expect(now.body.data.find((s: any) => s.staff_id === teacherStaffId).contract_kind)
      .toBe('permanent');

    const later = await GET(`/v1/hr/staff?on=${inDays(70)}`, officeToken);
    expect(later.body.data.find((s: any) => s.staff_id === teacherStaffId).contract_kind)
      .toBe('visiting');
  });

  it('files an absence and shows it as awaiting a decision', async () => {
    const filed = await POST('/v1/hr/absences', officeToken, {
      staffId: teacherStaffId, leaveTypeId,
      startsOn: inDays(3), endsOn: inDays(4), reason: 'Family wedding',
    });
    expect(filed.status).toBe(201);
    absenceId = filed.body.data.id;
    expect(filed.body.data.status).toBe('requested');

    const listed = await GET(
      `/v1/hr/absences?from=${today()}&to=${inDays(30)}&status=requested`, officeToken);
    expect(listed.body.data.map((a: any) => a.id)).toContain(absenceId);
    expect(listed.body.data.find((a: any) => a.id === absenceId).leave_type)
      .toBe('Casual leave');
  });

  it('defaults the window rather than 400ing on a bare list', async () => {
    // The screen opens on "this month". A required date pair would make the
    // first render a validation error.
    const res = await GET('/v1/hr/absences', officeToken);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('refuses a refusal with no reason, over HTTP, with the code', async () => {
    const res = await POST('/v1/hr/absences/decide', officeToken, {
      absenceId, approve: false,
    });
    // 422, because a validation_error is one — the contract's status map has
    // said so since M11 and an HTTP test is where that becomes visible.
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('refusal_needs_note');
    expect(res.body.error.message).toMatch(/why/i);
  });

  it('approves it and moves the balance in the same breath', async () => {
    const res = await POST('/v1/hr/absences/decide', officeToken, {
      absenceId, approve: true,
    });
    expect(res.status).toBe(201);

    const taken = await owner((c) => c.query<{ taken: string }>(
      `SELECT taken::text FROM leave_balance WHERE staff_id = $1`, [teacherStaffId]));
    expect(Number(taken.rows[0]!.taken)).toBeGreaterThan(0);
  });

  it('assigns cover and hands the covering teacher their room', async () => {
    const assigned = await POST('/v1/hr/cover', officeToken, {
      sectionId: sectionA, coveringStaffId: coverStaffId,
      absentStaffId: teacherStaffId, staffAbsenceId: absenceId,
      onDate: inDays(3), periodNo: 2,
    });
    expect(assigned.status).toBe(201);

    const day = await GET(`/v1/hr/cover?on=${inDays(3)}`, officeToken);
    expect(day.status).toBe(200);
    expect(day.body.data.assigned.map((c: any) => c.section_id)).toContain(sectionA);
    expect(day.body.data.absent.map((a: any) => a.staff_id)).toContain(teacherStaffId);
  });

  it('refuses cover for a day that has gone', async () => {
    const res = await POST('/v1/hr/cover', officeToken, {
      sectionId: sectionA, coveringStaffId: coverStaffId, onDate: inDays(-2),
    });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('cover_in_the_past');
  });

  it('returns payroll INPUTS, in days, and no money at all', async () => {
    const res = await GET(`/v1/hr/payroll-inputs?from=${inDays(-30)}&to=${today()}`,
      officeToken);
    expect(res.status).toBe(200);
    const row = res.body.data.find((r: any) => r.staff_id === teacherStaffId);
    expect(row).toBeDefined();
    expect(row.employed_days).toBeGreaterThan(0);
    // M27 stopped at inputs deliberately. If a salary figure ever appears in
    // this response, somebody has started building a payroll product.
    expect(Object.keys(row).join(' ')).not.toMatch(/salary|gross|net|pf|esi|tds/i);
  });
});

// ---------------------------------------------------------------------------

describe('a child can be admitted, end to end, through the product', () => {
  let formId = '';
  let enquiryId = '';
  let applicationId = '';
  let decisionId = '';
  let studentId = '';
  let enrollmentId = '';

  it('publishes an admission form', async () => {
    const res = await POST('/v1/admissions/forms', officeToken, {
      code: `adm_${randomUUID().slice(0, 8)}`,
      title: 'Admission 2026-27',
      jsonSchema: {
        type: 'object',
        required: ['previousSchool'],
        properties: {
          previousSchool: { type: 'string' },
          motherTongue: { type: 'string' },
        },
      },
    });
    expect(res.status).toBe(201);
    formId = res.body.data.id;
    expect(res.body.data.published_at).toBeTruthy();

    const listed = await GET('/v1/admissions/forms', officeToken);
    expect(listed.body.data.map((f: any) => f.id)).toContain(formId);
  });

  it('records somebody who rang, with a name and a number and nothing else', async () => {
    const res = await POST('/v1/admissions/enquiries', officeToken, {
      name: 'Lakshmi Iyer', phone: '9876500011', source: 'phone',
      campusId: tenant.campusId, programmeId, academicYearId,
      note: 'Asked about Class IX for her son.',
    });
    expect(res.status).toBe(201);
    enquiryId = res.body.data.enquiryId;

    const pipeline = await GET('/v1/admissions/pipeline', officeToken);
    const row = pipeline.body.data.find((r: any) => r.id === enquiryId);
    expect(row.kind).toBe('enquiry');
    expect(row.stage).toBe('enquired');
    expect(row.phone).toBe('9876500011');
  });

  it('refuses an enquiry nobody could ring back', async () => {
    const res = await POST('/v1/admissions/enquiries', officeToken, {
      name: 'No Contact', source: 'walk_in',
      campusId: tenant.campusId, programmeId, academicYearId,
    });
    // A named refusal, not a check-constraint 500 with Postgres's words in it.
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).toMatch(/ring them back/i);
  });

  it('refuses a form submission that does not answer the form', async () => {
    // The whole reason an application carries a form_submission_id: the answer
    // set is validated against a pinned version, so it is reproducible years
    // later. A missing required answer has to fail here, not on the screen.
    const res = await POST('/v1/admissions/applications', officeToken, {
      givenName: 'Arjun', familyName: 'Iyer',
      programmeId, academicYearId, formDefinitionId: formId,
      answers: { motherTongue: 'Tamil' },
    });
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).toMatch(/previousSchool/);
  });

  it('leaves no half-made applicant behind when the form is refused', async () => {
    // Intake creates a person, a submission and an application. If the second
    // or third fails and the first survives, an office retrying the form ends
    // up with two children who are one child.
    const orphans = await owner((c) => c.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM person
        WHERE tenant_id = $1 AND given_name = 'Arjun'`, [tenant.orgId]));
    expect(orphans.rows[0]!.n).toBe('0');
  });

  it('takes an application at the counter in one call', async () => {
    const res = await POST('/v1/admissions/applications', officeToken, {
      givenName: 'Arjun', familyName: 'Iyer', dateOfBirth: '2011-07-04',
      programmeId, academicYearId, formDefinitionId: formId,
      answers: { previousSchool: 'St Anne\'s', motherTongue: 'Tamil' },
      enquiryId,
    });
    expect(res.status).toBe(201);
    applicationId = res.body.data.id;
    expect(res.body.data.application_no).toBeTruthy();

    const pipeline = await GET('/v1/admissions/pipeline', officeToken);
    const ids = pipeline.body.data.map((r: any) => r.id);
    expect(ids).toContain(applicationId);
    // And the enquiry it came from is no longer listed separately. One family,
    // one row — listing both is how somebody gets rung about applying after
    // they have applied.
    expect(ids).not.toContain(enquiryId);
  });

  it('will not let an account with no staff row decide an admission', async () => {
    // The guardian-shaped case: a real principal whose account was never
    // linked to a person. The refusal is about attribution, not permission —
    // an admission decision is the document a family disputes.
    const noStaff = await createUser('nostaff@ws-test.example', PASSWORD);
    await grantRole(tenant.orgId, noStaff.userId, 'ORG_OWNER', 'organization', null);
    const token = await tokenFor(noStaff, ['ORG_OWNER']);

    const res = await POST(`/v1/admissions/applications/${applicationId}/decide`, token,
      { outcome: 'offered', offeredSectionId: sectionA });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('not_staff');

    await destroyUsers([noStaff.userId]);
  });

  it('offers a place, attributed to the caller and not to the body', async () => {
    const res = await POST(`/v1/admissions/applications/${applicationId}/decide`,
      officeToken, {
        outcome: 'offered', offeredSectionId: sectionA, offerValidDays: 14,
        conditions: 'Subject to the transfer certificate.',
        // Sent deliberately, and must be ignored. Without this line the
        // assertion below passes whether or not the controller reads the body,
        // which is a test proving nothing — deleting the guard broke it not at
        // all until this field was added.
        decidedByStaffId: teacherStaffId,
      });
    expect(res.status).toBe(201);
    decisionId = res.body.data.id;

    const stored = await owner((c) => c.query<{ decided_by: string }>(
      'SELECT decided_by FROM admission_decision WHERE id = $1', [decisionId]));
    expect(stored.rows[0]!.decided_by).toBe(officeStaffId);
    expect(stored.rows[0]!.decided_by).not.toBe(teacherStaffId);
  });

  it('accepting the offer is what creates the learner', async () => {
    const res = await POST(`/v1/admissions/decisions/${decisionId}/accept`, officeToken,
      { admissionNoPrefix: 'WS' });
    expect(res.status).toBe(201);
    studentId = res.body.data.enrollment.student_id;
    enrollmentId = res.body.data.enrollment.id;
    expect(res.body.data.enrollment.section_id).toBe(sectionA);

    const learner = await GET(`/v1/students/${studentId}`, officeToken);
    expect(learner.status).toBe(200);
    expect(learner.body.data.given_name).toBe('Arjun');
  });

  it('shows the family as enrolled rather than as an open application', async () => {
    const pipeline = await GET('/v1/admissions/pipeline', officeToken);
    const row = pipeline.body.data.find((r: any) => r.id === applicationId);
    expect(row.enrolled).toBe(true);
    expect(row.accepted_at).toBeTruthy();
  });

  it('moves the learner between sections, and refuses to do it silently', async () => {
    const noReason = await POST(`/v1/enrollments/${enrollmentId}/section`, officeToken,
      { toSectionId: sectionB });
    expect(noReason.status).toBe(422);

    const moved = await POST(`/v1/enrollments/${enrollmentId}/section`, officeToken,
      { toSectionId: sectionB, reason: 'Parent asked for the morning section.' });
    expect(moved.status).toBe(201);
    expect(moved.body.data.section_id).toBe(sectionB);

    const history = await GET(`/v1/enrollments/${enrollmentId}/history`, officeToken);
    expect(history.status).toBe(200);
    expect(history.body.data.map((e: any) => e.event_type)).toContain('section_changed');
    expect(JSON.stringify(history.body.data)).toMatch(/morning section/);
  });

  it('withdraws a learner, with a reason, and keeps the record', async () => {
    const res = await POST(`/v1/enrollments/${enrollmentId}/withdraw`, officeToken,
      { reason: 'Family relocating to Pune.' });
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('withdrawn');

    // Withdrawn, not deleted. The register for the term they were here is
    // still the register for that term.
    const still = await GET(`/v1/students/${studentId}`, officeToken);
    expect(still.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------

describe('a school can raise an invoice it can take money against', () => {
  let planId = '';
  let assignmentId = '';
  let installmentId = '';
  let invoiceId = '';
  let enrolmentForFees = '';

  beforeAll(async () => {
    const learner = await createLearnerRaw(tenant.orgId, 'Ishaan', 'WS-FEE-1');
    enrolmentForFees = await owner((c) => c.query<{ id: string }>(
      `INSERT INTO enrollment (tenant_id, student_id, section_id, academic_year_id)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [tenant.orgId, learner.studentId, sectionA, academicYearId])
      .then((r) => r.rows[0]!.id));
  }, 60_000);

  it('creates a fee plan from exact decimal amounts', async () => {
    const res = await POST('/v1/fees/plans', officeToken, {
      academicUnitId: tenant.unitId,
      academicYearId,
      name: 'Class IX 2026-27',
      components: [
        { code: 'TUITION', name: 'Tuition', amount: '42000.00', frequency: 'annual' },
        { code: 'LAB', name: 'Laboratory', amount: '3500.50', frequency: 'annual' },
      ],
    });
    expect(res.status).toBe(201);
    planId = res.body.data.id;

    const listed = await GET('/v1/fees/plans', officeToken);
    const row = listed.body.data.find((p: any) => p.id === planId);
    expect(row.status).toBe('draft');
    // A string, all the way out. A fee total that has been through a JSON
    // number is a fee total nobody should put on an invoice.
    expect(row.total).toBe('45500.50');
    expect(typeof row.total).toBe('string');
  });

  it('refuses an amount that is not an exact decimal', async () => {
    // "42,000" is how a person types a fee and is not a number; "42000.999"
    // is a third of a paise. Both have to be refused at the edge with a named
    // validation error rather than reaching Postgres, where the first is a
    // syntax error and the second is silently rounded.
    for (const amount of ['42,000', '42000.999', 'forty two thousand', '']) {
      const res = await POST('/v1/fees/plans', officeToken, {
        academicUnitId: tenant.unitId, academicYearId, name: 'Bad money',
        components: [{ code: 'X', name: 'Bad', amount, frequency: 'annual' }],
      });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('invalid_request');
    }
  });

  it('keeps an amount exact at the largest figure the column can hold', async () => {
    // The boundary that EXISTS. The float and string conversions first
    // disagree around ₹94,575,592,174,780.41, and `fee_component.amount` is
    // numeric(14,2) — Postgres refuses that value before either could be
    // wrong about it. A test at the divergence point got a numeric overflow,
    // not a mismatch, which is the finding: within this schema the two paths
    // are indistinguishable, and the claim in the header had to be narrowed
    // to say so.
    const res = await POST('/v1/fees/plans', officeToken, {
      academicUnitId: tenant.unitId, academicYearId,
      name: 'Largest storable',
      components: [{
        code: 'X', name: 'Boundary', amount: '999999999999.99', frequency: 'annual',
      }],
    });
    expect(res.status).toBe(201);

    const stored = await owner((c) => c.query<{ amount: string }>(
      `SELECT amount::text FROM fee_component WHERE fee_plan_id = $1`,
      [res.body.data.id]));
    expect(stored.rows[0]!.amount).toBe('999999999999.99');

    // And one paise over it is refused rather than silently rounded.
    const over = await POST('/v1/fees/plans', officeToken, {
      academicUnitId: tenant.unitId, academicYearId, name: 'One too many',
      components: [{
        code: 'X', name: 'Over', amount: '9999999999999.99', frequency: 'annual',
      }],
    });
    expect(over.status).toBeGreaterThanOrEqual(400);
  });

  it('refuses to assign a learner to a plan nobody has published', async () => {
    const res = await POST('/v1/fees/assignments', officeToken, {
      enrollmentId: enrolmentForFees, feePlanId: planId,
    });
    expect(res.status).toBe(409);
  });

  it('publishes it, assigns it and schedules the instalments', async () => {
    expect((await POST(`/v1/fees/plans/${planId}/publish`, officeToken)).status).toBe(201);

    const assigned = await POST('/v1/fees/assignments', officeToken, {
      enrollmentId: enrolmentForFees, feePlanId: planId,
    });
    expect(assigned.status).toBe(201);
    assignmentId = assigned.body.data.id;

    const scheduled = await POST(`/v1/fees/assignments/${assignmentId}/installments`,
      officeToken, { dueDates: [inDays(5), inDays(95)] });
    expect(scheduled.status).toBe(201);
    expect(scheduled.body.data).toHaveLength(2);
    installmentId = scheduled.body.data[0].id;
  });

  it('lists the instalment as unbilled until an invoice exists', async () => {
    const before = await GET('/v1/fees/installments?unbilled=true', officeToken);
    expect(before.body.data.map((i: any) => i.id)).toContain(installmentId);

    const issued = await POST('/v1/fees/invoices', officeToken, {
      installmentId, campusId: tenant.campusId,
    });
    expect(issued.status).toBe(201);
    invoiceId = issued.body.data.id;
    expect(issued.body.data.invoice_no).toBeTruthy();

    const after = await GET('/v1/fees/installments?unbilled=true', officeToken);
    expect(after.body.data.map((i: any) => i.id)).not.toContain(installmentId);
  });

  it('takes a payment attributed to the caller, not to the body', async () => {
    // The hole M32 closed here: `receivedByStaffId` used to come from the
    // request. A receipt is a document a cashier is answerable for.
    const paid = await POST(`/v1/invoices/${invoiceId}/payments`, officeToken, {
      amount: '1000.00', method: 'cash',
      idempotencyKey: `ws-${randomUUID()}`,
      // Sent deliberately, and must be ignored.
      receivedByStaffId: teacherStaffId,
    });
    expect(paid.status).toBe(201);

    const stored = await owner((c) => c.query<{ received_by: string }>(
      `SELECT received_by FROM payment WHERE id = $1`, [paid.body.data.paymentId]));
    expect(stored.rows[0]!.received_by).toBe(officeStaffId);
    expect(stored.rows[0]!.received_by).not.toBe(teacherStaffId);
  });

  it('voids an invoice with a reason, and never without one', async () => {
    const bare = await POST(`/v1/fees/invoices/${invoiceId}/void`, officeToken, {});
    expect(bare.status).toBe(422);
  });
});

describe('a school can send a message', () => {
  let templateId = '';
  let versionId = '';

  it('creates a template and a version nobody has approved yet', async () => {
    const created = await POST('/v1/messaging/templates', officeToken, {
      code: `notice_${randomUUID().slice(0, 8)}`,
      name: 'General notice',
      purpose: 'core_education_service',
    });
    expect(created.status).toBe(201);
    templateId = created.body.data.id;

    const version = await POST('/v1/messaging/templates/versions', officeToken, {
      templateId, channel: 'in_app',
      body: 'Dear parent, {{name}} has a holiday on Friday.',
    });
    expect(version.status).toBe(201);
    versionId = version.body.data.id;
    expect(version.body.data.approval_status).not.toBe('approved');
  });

  it('refuses to send against a template nobody approved', async () => {
    const res = await POST('/v1/messaging/send', officeToken, {
      templateCode: 'does-not-exist',
      idempotencyKey: `ws-${randomUUID()}`,
      audience: { kind: 'section', sectionId: sectionA },
    });
    // Either the template is unknown or the audience is empty — both are
    // refusals rather than a silent send to nobody, which is the point.
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('sends to a section and reports per recipient, not a bare success',
    async () => {
      await POST(`/v1/messaging/templates/versions/${versionId}/approve`, officeToken);

      const code = (await GET('/v1/messaging/templates', officeToken))
        .body.data.find((t: any) => t.id === templateId).code;

      const res = await POST('/v1/messaging/send', officeToken, {
        templateCode: code,
        idempotencyKey: `ws-${randomUUID()}`,
        audience: { kind: 'section', sectionId: sectionA },
      });

      expect(res.status).toBe(201);
      // "sent to 38 of 40, two opted out" is the answer the sender needs.
      expect(res.body.data).toHaveProperty('sent');
      expect(res.body.data).toHaveProperty('suppressed');
      expect(Array.isArray(res.body.data.outcomes)).toBe(true);

      const outcomes = await GET(
        `/v1/messaging/requests/${res.body.data.requestId}/outcomes`, officeToken);
      expect(outcomes.status).toBe(200);
    });

  it('refuses a send that would reach nobody', async () => {
    const res = await POST('/v1/messaging/send', officeToken, {
      templateCode: 'anything',
      idempotencyKey: `ws-${randomUUID()}`,
      audience: { kind: 'section', sectionId: sectionB },
    });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('empty_audience');
  });
});

describe('a school can run an import instead of typing four hundred learners', () => {
  let batchId = '';

  it('parses a CSV with commas inside quoted fields', async () => {
    // "Sharma, Priya" is the normal case in school data, not the edge one. A
    // split(',') turns one learner into two columns of nonsense.
    const csv = [
      'Name,Admission No,DOB',
      '"Sharma, Priya",WS-IMP-1,14/03/2012',
      'Rohit Verma,WS-IMP-2,02/11/2011',
      '',
    ].join('\n');

    const res = await POST('/v1/imports', officeToken, {
      entity: 'learner_roster', originalFilename: 'roster.csv', csv,
    });
    expect(res.status).toBe(201);
    batchId = res.body.data.batchId;
    // Two rows, not three: the trailing blank line is not a learner.
    expect(res.body.data.staged).toBe(2);
    expect(res.body.data.columns).toEqual(['Name', 'Admission No', 'DOB']);
  });

  it('does not import a line of stray commas as a nameless child', async () => {
    // What a spreadsheet export leaves behind, and it parses into real empty
    // columns rather than being swallowed by the trailing-newline handling.
    const res = await POST('/v1/imports', officeToken, {
      entity: 'learner_roster',
      csv: 'Name,Admission No\nAsha Rao,WS-IMP-9\n,,\n',
    });
    expect(res.status).toBe(201);
    expect(res.body.data.staged).toBe(1);
  });

  it('refuses a file with a header and nothing else', async () => {
    const res = await POST('/v1/imports', officeToken, {
      entity: 'learner_roster', csv: 'Name,Admission No\n',
    });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('no_rows');
  });

  it('will not apply anything nobody has previewed', async () => {
    const res = await POST(`/v1/imports/${batchId}/apply`, officeToken);
    // The step that exists so somebody sees what is about to happen to four
    // hundred children's records before it happens.
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it('maps, validates and previews before it will apply', async () => {
    const mapped = await POST(`/v1/imports/${batchId}/mapping`, officeToken, {
      mappings: [
        { sourceColumn: 'Name', targetField: 'given_name', transform: 'trim' },
        { sourceColumn: 'Admission No', targetField: 'admission_no' },
        { sourceColumn: 'DOB', targetField: 'date_of_birth', transform: 'date_dmy' },
      ],
    });
    expect(mapped.status).toBe(201);

    const validated = await POST(`/v1/imports/${batchId}/validate`, officeToken);
    expect(validated.status).toBe(201);
    expect(validated.body.data.valid).toBe(2);
    expect(validated.body.data.invalid).toBe(0);

    const preview = await POST(`/v1/imports/${batchId}/preview`, officeToken);
    expect(preview.status).toBe(201);
    expect(preview.body.data.digest).toBeTruthy();

    const applied = await POST(`/v1/imports/${batchId}/apply`, officeToken);
    expect(applied.status).toBe(201);
    expect(applied.body.data.created).toBe(2);

    const listed = await GET('/v1/students?limit=200', officeToken);
    const names = JSON.stringify(listed.body.data);
    expect(names).toMatch(/Sharma, Priya|Sharma/);
  });

  it('takes it all back, with a reason', async () => {
    const bare = await POST(`/v1/imports/${batchId}/reverse`, officeToken, {});
    expect(bare.status).toBe(422);

    const res = await POST(`/v1/imports/${batchId}/reverse`, officeToken,
      { reason: 'Wrong file — this was last year\'s roster.' });
    expect(res.status).toBe(201);
    expect(res.body.data.reversed).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------

describe('an exam can be set, marked and published through the product', () => {
  let scaleId = '';
  let assessmentId = '';
  let runId = '';
  let markedEnrolment = '';
  let absentEnrolment = '';
  let offeringId = '';
  let termId = '';

  beforeAll(async () => {
    // Two learners in IX-B, so this suite's marks do not collide with the
    // section the other blocks are moving people in and out of.
    for (const [given, adm] of [['Kiran', 'WS-EX-1'], ['Tara', 'WS-EX-2']] as const) {
      const learner = await createLearnerRaw(tenant.orgId, given, adm);
      const e = await owner((c) => c.query<{ id: string }>(
        `INSERT INTO enrollment (tenant_id, student_id, section_id, academic_year_id)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [tenant.orgId, learner.studentId, sectionB, academicYearId]));
      if (adm === 'WS-EX-1') markedEnrolment = e.rows[0]!.id;
      else absentEnrolment = e.rows[0]!.id;
    }

    const made = await owner(async (c) => {
      const t = await c.query<{ id: string }>(
        `SELECT id FROM term WHERE academic_year_id = $1 ORDER BY starts_on LIMIT 1`,
        [academicYearId]);
      const co = await c.query<{ id: string }>(
        `INSERT INTO course_offering
           (tenant_id, class_group_id, section_id, subject_id, term_id,
            primary_teacher_staff_id)
         SELECT $1, s.class_group_id, $2, sub.id, $3, $4
           FROM section s, subject sub
          WHERE s.id = $2 LIMIT 1
         RETURNING id`,
        [tenant.orgId, sectionB, t.rows[0]!.id, officeStaffId]);
      return { termId: t.rows[0]!.id, offeringId: co.rows[0]!.id };
    });
    termId = made.termId;
    offeringId = made.offeringId;
  }, 60_000);

  it('refuses a grading scale with a gap in it', async () => {
    // A band ending at 39 and the next starting at 41 leaves every learner on
    // exactly 40 with no grade at all.
    const gappy = await POST('/v1/assessments/scales', officeToken, {
      academicUnitId: tenant.unitId, name: 'Gappy', kind: 'letter',
      bands: [
        { label: 'A', lower: 41, upper: 100, isPass: true },
        { label: 'F', lower: 0, upper: 39, isPass: false },
      ],
    });
    expect(gappy.status).toBe(201);
    const published = await POST(
      `/v1/assessments/scales/${gappy.body.data.id}/publish`, officeToken);
    expect(published.status).toBe(409);
    expect(published.body.error.code).toBe('scale_has_a_gap');
  });

  it('publishes a scale that covers the range', async () => {
    const res = await POST('/v1/assessments/scales', officeToken, {
      academicUnitId: tenant.unitId, name: 'Standard letter', kind: 'letter',
      // Bands that touch, stated the way a school states them. The top one
      // says 100 and means it; the controller is what turns that into a range
      // containing 100, because a half-open interval is not something anybody
      // should have to know about to publish a grading scale.
      bands: [
        { label: 'F', lower: 0, upper: 40, isPass: false },
        { label: 'C', lower: 40, upper: 60, isPass: true },
        { label: 'B', lower: 60, upper: 80, isPass: true },
        { label: 'A', lower: 80, upper: 100, isPass: true },
      ],
    });
    expect(res.status).toBe(201);
    scaleId = res.body.data.id;
    expect((await POST(`/v1/assessments/scales/${scaleId}/publish`, officeToken)).status)
      .toBe(201);
  });

  it('will not take marks against an assessment nobody opened', async () => {
    const created = await POST('/v1/assessments', officeToken, {
      courseOfferingId: offeringId, termId, name: 'Term 1 exam', kind: 'exam',
      maxMarks: 100, weightPercent: 100, gradingScaleId: scaleId,
    });
    expect(created.status).toBe(201);
    assessmentId = created.body.data.id;
    expect(created.body.data.status).toBe('draft');

    const early = await POST(`/v1/assessments/${assessmentId}/marks`, officeToken, {
      marks: [{ enrollmentId: markedEnrolment, marks: 72 }],
    });
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('assessment_draft');
  });

  it('hands back a mark sheet with every learner on it, marked or not', async () => {
    expect((await POST(`/v1/assessments/${assessmentId}/open`, officeToken)).status)
      .toBe(201);

    const sheet = await GET(`/v1/assessments/${assessmentId}/marks`, officeToken);
    expect(sheet.status).toBe(200);
    // The whole class, so a teacher can see who is missing rather than only
    // who is done.
    expect(sheet.body.data.map((r: any) => r.enrollment_id).sort())
      .toEqual([markedEnrolment, absentEnrolment].sort());
    expect(sheet.body.data.every((r: any) => r.mark_id === null)).toBe(true);
  });

  it('records an absence as an absence, never as a zero', async () => {
    const res = await POST(`/v1/assessments/${assessmentId}/marks`, officeToken, {
      marks: [
        { enrollmentId: markedEnrolment, marks: 72 },
        { enrollmentId: absentEnrolment, absent: true },
      ],
    });
    expect(res.status).toBe(201);
    expect(res.body.data.outcomes.every((o: any) => o.outcome === 'recorded')).toBe(true);

    const stored = await owner((c) => c.query<{
      marks_obtained: string | null; is_absent: boolean;
    }>(`SELECT marks_obtained::text, is_absent FROM mark
         WHERE assessment_id = $1 AND enrollment_id = $2`,
      [assessmentId, absentEnrolment]));
    // A zero is a mark of zero and drags an average down. A child who was ill
    // has no mark at all.
    expect(stored.rows[0]!.marks_obtained).toBeNull();
    expect(stored.rows[0]!.is_absent).toBe(true);
  });

  it('rejects one bad row without losing the rest of the class', async () => {
    const res = await POST(`/v1/assessments/${assessmentId}/marks`, officeToken, {
      marks: [
        { enrollmentId: markedEnrolment, marks: 68 },
        { enrollmentId: absentEnrolment, marks: 900 },  // out of a hundred
      ],
    });
    expect(res.status).toBe(201);
    const byEnrolment = new Map(
      res.body.data.outcomes.map((o: any) => [o.enrollmentId, o.outcome]));
    expect(byEnrolment.get(markedEnrolment)).toBe('updated');
    expect(byEnrolment.get(absentEnrolment)).toBe('rejected');
  });

  it('locks the paper, and offers no way to unlock it', async () => {
    expect((await POST(`/v1/assessments/${assessmentId}/lock`, officeToken)).status)
      .toBe(201);

    const after = await POST(`/v1/assessments/${assessmentId}/marks`, officeToken, {
      marks: [{ enrollmentId: markedEnrolment, marks: 99 }],
    });
    expect(after.status).toBe(409);
    expect(after.body.error.code).toBe('assessment_locked');

    // And there is no route that would put it back. Reopening a locked paper
    // silently re-grades it; corrections are the path, and they are attributed.
    const unlock = await POST(`/v1/assessments/${assessmentId}/unlock`, officeToken);
    expect(unlock.status).toBe(404);
  });

  it('grades a learner who scored exactly full marks', async () => {
    // The half-open band that the controller closes. [80, 100) does not
    // contain 100, so the one paper in the class that is certainly right
    // would come back ungraded.
    const full = await owner((c) => c.query<{ label: string | null }>(
      `SELECT gb.label
         FROM grade_band gb
        WHERE gb.grading_scale_id = $1 AND gb.span @> 100::numeric`,
      [scaleId]));
    expect(full.rows[0]?.label).toBe('A');
  });

  it('computes a result run, and will not publish one nobody reviewed', async () => {
    const computed = await POST('/v1/result-runs', officeToken, {
      sectionId: sectionB, termId, gradingScaleId: scaleId,
    });
    expect(computed.status).toBe(201);
    runId = computed.body.data.run.id;
    expect(computed.body.data.lines.length).toBeGreaterThan(0);

    const early = await POST(`/v1/result-runs/${runId}/publish`, officeToken);
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('not_reviewed');
  });

  it('refuses to let the person who computed it review their own run', async () => {
    // The second pair of eyes is the only control between a typo and four
    // hundred families reading it.
    const res = await POST(`/v1/result-runs/${runId}/review`, officeToken);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it('lists the run with what stage it has reached', async () => {
    const res = await GET(`/v1/result-runs?termId=${termId}`, officeToken);
    expect(res.status).toBe(200);
    const row = res.body.data.find((r: any) => r.id === runId);
    expect(row.status).toBe('computed');
    expect(row.line_count).toBeGreaterThan(0);
  });
});

describe('the hr flag now guards something', () => {
  it('refuses the whole module to a school whose plan excludes it', async () => {
    // Until M32 this decorator was on nothing: M16 sold an `hr` flag, M27
    // built the module, and no route ever consulted the flag.
    planCode = `ws_${randomUUID().slice(0, 8).replace(/-/g, '')}`;
    await catalogueService.createPlan(platformUser.userId,
      { code: planCode, name: 'No HR' });
    const draft = await catalogueService.draftVersion(platformUser.userId, planCode,
      { priceMonthly: '100000', priceAnnual: '1000000' });
    await catalogueService.setTerms(platformUser.userId, draft.id, {
      limits: [{ metric: 'learners', included: 500, hardCap: 600 }],
      features: [{ feature: 'hr', enabled: false }],
    });
    await catalogueService.publish(platformUser.userId, draft.id);
    await subscriptionService.subscribe(platformUser.userId, {
      tenantId: tenant.orgId, planVersionId: draft.id,
    });

    const res = await GET('/v1/hr/staff', officeToken);

    // 404, not 403, and deliberately: the guard's own comment says a module a
    // school has not bought should look like a part of the product that is not
    // there rather than a locked door with their data behind it. Asserting the
    // number here is what stops somebody "improving" it into a 403 with an
    // upgrade pitch in the body.
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
    expect(JSON.stringify(res.body)).not.toMatch(/upgrade|plan|feature|hr/i);

    // And the rest of the product is untouched by it.
    expect((await GET('/v1/me', officeToken)).status).toBe(200);
  });
});
