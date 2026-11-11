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
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import S3rver from 's3rver';
import {
  createTenant, destroyTenants, createUser, destroyUsers, grantRole, revokeGrant,
  purgeTestData,
  createAcademicYear, createAcademicStructure, createClassGroupRaw, createSectionFor,
  makeTeacher, createLearnerRaw, createPersonRaw, linkGuardianRaw,
  OWNER_URL, type TenantFixture, type UserFixture,
} from './fixtures.ts';
import { AppModule } from '../src/app.module.ts';
import { tokenService } from '../src/modules/auth/token.service.ts';
import { catalogueService } from '../src/modules/billing-plans/catalogue.service.ts';
import { subscriptionService } from '../src/modules/billing-plans/subscription.service.ts';
import { pool } from '../src/db/pool.ts';
import { closeRedis } from '../src/db/redis.ts';
import { makeObjectStore, useObjectStore, type ObjectStore }
  from '../src/storage/object-store.ts';
import { makeScanner, useScanner } from '../src/storage/scanner.ts';
import { objectKey } from '../src/storage/keys.ts';
import { jobs } from '../src/modules/scheduler/jobs.ts';
import { authPool } from '../src/db/auth-pool.ts';

const PASSWORD = 'correct-horse-battery';

let app: INestApplication;
let base: string;
let tenant: TenantFixture;

let officeUser: UserFixture;
let teacherUser: UserFixture;
let platformUser: UserFixture;
let guardianUser: UserFixture;

let officeToken = '';
let teacherToken = '';
let guardianToken = '';
let parentAccountPersonId = '';

let teacherStaffId = '';
let coverStaffId = '';
let officeStaffId = '';
let officeStaffPersonId = '';
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

/* --------------------------------------------------------- M37: storage */

/**
 * A real S3 server and a real clamd conversation, in-process.
 *
 * `s3rver` speaks the S3 protocol including presigned GET and PUT, so the URLs
 * these tests follow are signed by the AWS SDK and served by an implementation
 * that was not written to agree with it. It does NOT verify SigV4 — see
 * `storage.spec.ts`, which says so where it matters.
 *
 * The clamd fake implements INSTREAM: `zINSTREAM\0`, length-prefixed chunks, a
 * zero length to finish, one NUL-terminated line back. It answers FOUND for the
 * EICAR string and OK for everything else, which is exactly what a real one does.
 */
const EICAR = ['X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-',
               'ANTIVIRUS-TEST-FILE!$H+H*'].join('');

let s3: S3rver | undefined;
let s3dir = '';
let testStore: ObjectStore;
let clamd: Server | undefined;
const clamdSockets: Socket[] = [];

const BUCKET = 'paathshala-ws-test';

async function startStorage(): Promise<void> {
  s3dir = mkdtempSync(join(tmpdir(), 'paathshala-ws-s3-'));
  s3 = new S3rver({
    port: 0, address: '127.0.0.1', silent: true, directory: s3dir,
    configureBuckets: [{ name: BUCKET, configs: [] }],
  });
  const { port } = await s3.run();
  testStore = makeObjectStore({
    bucket: BUCKET, region: 'ap-south-1',
    endpoint: `http://127.0.0.1:${port}`,
    accessKeyId: 'S3RVER', secretAccessKey: 'S3RVER',
    forcePathStyle: true, urlTtlSeconds: 300,
  });
  useObjectStore(testStore);

  clamd = createServer((socket) => {
    clamdSockets.push(socket);
    let buf = Buffer.alloc(0);
    let greeted = false;
    let body = Buffer.alloc(0);
    socket.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (!greeted) {
        const nul = buf.indexOf(0);
        if (nul === -1) return;
        buf = buf.subarray(nul + 1);
        greeted = true;
      }
      for (;;) {
        if (buf.length < 4) return;
        const len = buf.readUInt32BE(0);
        if (len === 0) {
          socket.write(body.includes('EICAR-STANDARD')
            ? 'stream: Win.Test.EICAR_HDB-1 FOUND\0'
            : 'stream: OK\0');
          return;
        }
        if (buf.length < 4 + len) return;
        body = Buffer.concat([body, buf.subarray(4, 4 + len)]);
        buf = buf.subarray(4 + len);
      }
    });
  });
  await new Promise<void>((r) => clamd!.listen(0, '127.0.0.1', r));
  const addr = clamd.address();
  useScanner(makeScanner({
    host: '127.0.0.1',
    port: typeof addr === 'object' && addr ? addr.port : 0,
    timeoutMs: 5000,
  }));
}

async function stopStorage(): Promise<void> {
  useObjectStore(undefined);
  useScanner(undefined);
  for (const c of clamdSockets) c.destroy();
  if (clamd) await new Promise<void>((r) => clamd!.close(() => r()));
  await s3?.close();
  if (s3dir) rmSync(s3dir, { recursive: true, force: true });
}

/**
 * The signed PUT for a file this suite already asked for.
 *
 * Re-derived from the row rather than remembered from the ask, because asking
 * twice for a digest the tenant already holds correctly returns no URL — and a
 * test that stashed the first one would not notice if that stopped being true.
 */
async function uploadFor(fileId: string): Promise<{
  url: string; headers: Record<string, string>;
}> {
  const row = await owner((c) => c.query<{ sha256: string; mime_type: string; size_bytes: string }>(
    'SELECT sha256, mime_type, size_bytes::text FROM file WHERE id = $1', [fileId]));
  const f = row.rows[0]!;
  const { url, headers } = await testStore.presignUpload({
    key: objectKey(tenant.orgId, f.sha256),
    contentType: f.mime_type,
    sizeBytes: Number(f.size_bytes),
  });
  return { url, headers };
}

/** The nightly erasure job, run on demand. */
async function sweepFiles(tenantId: string): Promise<{ erased: number; failed: number }> {
  const detail = await jobs['files.pending_erasure']!({ tenantId });
  return { erased: Number(detail['erased']), failed: Number(detail['failed']) };
}

const today = () => new Date().toISOString().slice(0, 10);
const inDays = (n: number) =>
  new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

beforeAll(async () => {
  await startStorage();
  await purgeTestData('%@ws-test.example');
  tenant = await createTenant('WS');

  officeUser = await createUser('office@ws-test.example', PASSWORD);
  teacherUser = await createUser('teacher@ws-test.example', PASSWORD);
  platformUser = await createUser('platform@ws-test.example', PASSWORD);
  guardianUser = await createUser('parent@ws-test.example', PASSWORD);

  await grantRole(tenant.orgId, officeUser.userId, 'ORG_OWNER', 'organization', null);
  await grantRole(tenant.orgId, teacherUser.userId, 'TEACHER', 'campus', tenant.campusId);
  await grantRole(tenant.orgId, guardianUser.userId, 'GUARDIAN', 'self', tenant.campusId);

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
  officeStaffPersonId = office.personId;

  // A learner in IX-A with a guardian, so the messaging audience is somebody.
  // Without this the send refuses with `empty_audience` — correctly, which is
  // itself asserted below, and uselessly as a test of sending.
  const child = await createLearnerRaw(tenant.orgId, 'Nisha', 'WS-MSG-1');
  const parentPersonId = await createPersonRaw(tenant.orgId, 'Sunita',
    { familyName: 'Rao', userAccountId: guardianUser.userId });
  parentAccountPersonId = parentPersonId;
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
  guardianToken = await tokenFor(guardianUser, ['GUARDIAN']);

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication({ logger: false });
  await app.init();
  await app.listen(0);
  base = await app.getUrl();
}, 180_000);

afterAll(async () => {
  await app?.close();
  await stopStorage();
  await owner((c) => c.query('DELETE FROM platform_admin WHERE user_account_id = $1',
    [platformUser.userId]));
  await destroyTenants([tenant.orgId]);
  await destroyUsers([officeUser.userId, teacherUser.userId, platformUser.userId,
                     guardianUser.userId]);
  await closeRedis();
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

    // And one digit over it is refused rather than silently rounded.
    //
    // Asserted as a named 422 rather than as `>= 400`, which is how this sat
    // for three milestones while the real answer was a 500. The loose bound
    // was the bug: `internal_error` tells the person typing the number nothing
    // they can act on, and tells whoever reads the log that the server broke.
    const over = await POST('/v1/fees/plans', officeToken, {
      academicUnitId: tenant.unitId, academicYearId, name: 'One too many',
      components: [{
        code: 'X', name: 'Over', amount: '9999999999999.99', frequency: 'annual',
      }],
    });
    expect(over.status).toBe(422);
    expect(over.body.error.code).toBe('amount_too_large');
    // The component's own code, so a plan with eleven lines says which one.
    expect(over.body.error.message).toContain('X');
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

  it('refunds money, and will not let the asker approve their own request',
    async () => {
      const paid = await POST(`/v1/invoices/${invoiceId}/payments`, officeToken, {
        amount: '500.00', method: 'cash', idempotencyKey: `ws-${randomUUID()}`,
      });
      expect(paid.status).toBe(201);

      const asked = await POST('/v1/fees/refunds', officeToken, {
        paymentId: paid.body.data.paymentId, amount: '500.00',
        reason: 'Paid twice by mistake.', idempotencyKey: `ws-${randomUUID()}`,
      });
      expect(asked.status).toBe(201);
      const refundId = asked.body.data.id;

      // The only control on money leaving the building, and the office
      // account is the one that asked.
      const selfApprove = await POST(`/v1/fees/refunds/${refundId}/approve`, officeToken);
      expect(selfApprove.status).toBeGreaterThanOrEqual(400);
      expect(selfApprove.status).toBeLessThan(500);

      const listed = await GET('/v1/fees/refunds?status=requested', officeToken);
      expect(listed.body.data.map((r: any) => r.id)).toContain(refundId);
    });

  it('refuses a refund with no reason and a refund of nothing', async () => {
    const payment = await owner((c) => c.query<{ id: string }>(
      `SELECT id FROM payment ORDER BY created_at DESC LIMIT 1`));

    // An empty string is refused by the schema before the service sees it —
    // which means this assertion alone proves the zod shape, not the service
    // check. A mutation disabling the service's own refusal passed it.
    const noReason = await POST('/v1/fees/refunds', officeToken, {
      paymentId: payment.rows[0]!.id, amount: '100.00', reason: '',
      idempotencyKey: `ws-${randomUUID()}`,
    });
    expect(noReason.status).toBe(422);

    // Whitespace gets past `min(1)` and has to be caught by the service. This
    // is the assertion that actually reaches it.
    const blank = await POST('/v1/fees/refunds', officeToken, {
      paymentId: payment.rows[0]!.id, amount: '100.00', reason: '   ',
      idempotencyKey: `ws-${randomUUID()}`,
    });
    expect(blank.status).toBe(422);
    expect(blank.body.error.code).toBe('reason_required');

    const nothing = await POST('/v1/fees/refunds', officeToken, {
      paymentId: payment.rows[0]!.id, amount: '0.00', reason: 'Why not',
      idempotencyKey: `ws-${randomUUID()}`,
    });
    expect(nothing.status).toBe(422);
    expect(nothing.body.error.code).toBe('amount_must_be_positive');
  });

  /* ------------------------------------------------- M35.4: readers with a screen */

  it('answers "what is invoice INV-…" for somebody holding a printed receipt',
    async () => {
      const res = await GET(`/v1/fees/invoices/${invoiceId}`, officeToken);
      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe(invoiceId);
      expect(res.body.data.invoice_no).toBeTruthy();
      // Decimal strings, like every other money field here.
      expect(res.body.data.total).toMatch(/^\d+\.\d{2}$/);
      expect(res.body.data.amount_paid).toMatch(/^\d+\.\d{2}$/);

      expect((await GET(`/v1/fees/invoices/${randomUUID()}`, officeToken)).status)
        .toBe(404);
    });

  it('totals what one enrollment still owes, counting only real debts',
    async () => {
      const res = await GET(`/v1/fees/outstanding/${enrolmentForFees}`, officeToken);
      expect(res.status).toBe(200);
      expect(res.body.data.outstanding).toMatch(/^\d+\.\d{2}$/);

      // Agrees with the invoices behind it. A screen showing a family
      // "₹4,500 outstanding" beside a list that adds to something else is the
      // failure this has to not have.
      const sum = await owner((c) => c.query<{ due: string }>(
        `SELECT COALESCE(sum(total - amount_paid), 0)::text AS due
           FROM invoice
          WHERE enrollment_id = $1 AND status IN ('issued', 'part_paid')`,
        [enrolmentForFees]));
      expect(res.body.data.outstanding).toBe(sum.rows[0]!.due);
    });

  it('shows the double entry behind an invoice, grouped so each side balances',
    async () => {
      const res = await GET(`/v1/fees/ledger/invoice/${invoiceId}`, officeToken);
      expect(res.status).toBe(200);
      expect(res.body.data.length).toBeGreaterThan(0);

      for (const group of res.body.data) {
        expect(group.lines.length).toBeGreaterThan(1);
        // The assertion worth having. An unbalanced group is the thing a
        // reader is looking for, and a flat list of entries hides it.
        expect(group.debit).toBe(group.credit);
      }
    });

  it('refuses a source type that is not one of ours', async () => {
    // The parameter goes into a WHERE clause on `source_type`. An open string
    // would make this a way to enumerate whatever else is in the ledger.
    const res = await GET(`/v1/fees/ledger/whatever/${invoiceId}`, officeToken);
    expect(res.status).toBe(422);
  });

  it('hands the accountant a day book, as rows and as a file', async () => {
    const json = await GET(
      `/v1/fees/exports/day-book?from=${inDays(-30)}&to=${today()}`, officeToken);
    expect(json.status).toBe(200);
    expect(json.body.data.length).toBeGreaterThan(0);
    // Debits and credits as strings, like every other money field: a day book
    // that has been through a double is a day book an accountant will not
    // reconcile.
    expect(typeof json.body.data[0].debit).toBe('string');

    const csv = await GET(
      `/v1/fees/exports/day-book?from=${inDays(-30)}&to=${today()}&format=csv`,
      officeToken);
    expect(csv.status).toBe(200);
    // Split on \n and trim: the file is CRLF-terminated, which is the CSV
    // convention and what Excel on a Windows machine in a school office
    // expects. Asserting the raw line would be asserting the line ending.
    expect(csv.body.data.content.split('\n')[0]!.trim())
      .toBe('date,voucher,account,debit,credit,source,narration');
    expect(csv.body.data.content).toContain('\r\n');
    expect(csv.body.data.rowCount).toBeGreaterThan(0);
  });

  it('refuses a day book whose range runs backwards', async () => {
    const res = await GET(
      `/v1/fees/exports/day-book?from=${today()}&to=${inDays(-30)}`, officeToken);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('bad_range');
  });

  it('produces Tally XML naming the company Tally will match on', async () => {
    const res = await GET(
      `/v1/fees/exports/tally?from=${inDays(-30)}&to=${today()}`
      + '&companyName=Demo%20Vidyalaya%20Trust', officeToken);
    expect(res.status).toBe(200);
    expect(res.body.data.content).toContain('<ENVELOPE>');
    // Tally matches the import against the company name in the operator's own
    // file. A mismatch imports nothing and says nothing.
    expect(res.body.data.content).toContain('Demo Vidyalaya Trust');
  });

  it('will not export Tally XML with no company named', async () => {
    const res = await GET(
      `/v1/fees/exports/tally?from=${inDays(-30)}&to=${today()}`, officeToken);
    expect(res.status).toBe(422);
  });
});

describe('a school can send a message', () => {
  let sentRequestId = '';
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
      sentRequestId = res.body.data.requestId;
    });

  it('can say what it actually said to each person', async () => {
    // Not a narrower `outcomes`. That route answers "did it arrive"; this one
    // answers "what did you say to them", which is the question a guardian
    // asks under the DPDP Act. Reconstructing it from the template and the
    // variables is not evidence — the template may have been revised since.
    const res = await GET(`/v1/messaging/requests/${sentRequestId}/recipients`,
      officeToken);
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(0);

    const delivered = res.body.data.filter((r: any) => r.status !== 'suppressed');
    expect(delivered.length).toBeGreaterThan(0);
    // The stored text, not a rendering done now.
    expect(delivered[0].rendered_body).toBeTruthy();

    for (const row of res.body.data) {
      // Nothing was rendered for a suppressed recipient because nothing was
      // sent; the reason carries the answer instead.
      if (row.status === 'suppressed') {
        expect(row.rendered_body).toBeNull();
        expect(row.suppression_reason).toBeTruthy();
      }
    }
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

// ---------------------------------------------------------------------------

describe('a school can give somebody a login, and not lock itself out', () => {
  let targetUser = '';
  let grantId = '';

  beforeAll(async () => {
    targetUser = (await createUser('newteacher@ws-test.example', PASSWORD)).userId;
  }, 60_000);

  afterAll(async () => {
    await destroyUsers([targetUser]);
  }, 60_000);

  it('lists the accounts that can actually sign in, with what they hold', async () => {
    const res = await GET('/v1/access/accounts', officeToken);
    expect(res.status).toBe(200);
    const office = res.body.data.find((a: any) => a.user_account_id === officeUser.userId);
    expect(office).toBeDefined();
    expect(office.grants.map((g: any) => g.role)).toContain('ORG_OWNER');
  });

  it('grants a role, and refuses one the caller does not hold', async () => {
    const granted = await POST('/v1/access/grants', officeToken, {
      userAccountId: targetUser, role: 'TEACHER',
      scopeType: 'campus', scopeId: tenant.campusId,
    });
    expect(granted.status).toBe(201);

    const listed = await GET(`/v1/access/accounts/${targetUser}/grants`, officeToken);
    expect(listed.body.data.map((g: any) => g.role)).toContain('TEACHER');
    grantId = (await owner((c) => c.query<{ id: string }>(
      `SELECT id FROM role_grant WHERE user_account_id = $1 AND revoked_at IS NULL`,
      [targetUser]))).rows[0]!.id;

    // The teacher, now holding only TEACHER, cannot hand out ORG_OWNER. The
    // rule is the service's `canDelegate`; this asserts it is actually
    // consulted on the route rather than re-implemented and forgotten.
    const asTeacher = await tokenFor({ userId: targetUser } as UserFixture, ['TEACHER']);
    const overreach = await POST('/v1/access/grants', asTeacher, {
      userAccountId: officeUser.userId, role: 'ORG_OWNER', scopeType: 'organization',
    });
    expect(overreach.status).toBe(403);
    expect(overreach.body.error.code).toBe('cannot_delegate');
  });

  it('tells a screen which roles the caller may hand out', async () => {
    const res = await GET('/v1/access/delegatable?scopeType=campus', officeToken);
    expect(res.status).toBe(200);
    expect(res.body.data.roles).toContain('TEACHER');
    expect(res.body.data.held.map((g: any) => g.role)).toContain('ORG_OWNER');

    // The half that matters. The owner's list contains everything, so
    // asserting only on them passes against a hard-coded array — which is
    // exactly what a mutation replacing the rule with `[...ROLES]` proved.
    // A teacher's list has to be shorter than the catalogue.
    const asTeacher = await tokenFor({ userId: targetUser } as UserFixture, ['TEACHER']);
    const theirs = await GET('/v1/access/delegatable?scopeType=campus', asTeacher);
    expect(theirs.status).toBe(200);
    expect(theirs.body.data.roles).not.toContain('ORG_OWNER');
    expect(theirs.body.data.roles.length).toBeLessThan(res.body.data.roles.length);
  });

  it('refuses to revoke the caller\'s own last way back in', async () => {
    const mine = await owner((c) => c.query<{ id: string }>(
      `SELECT id FROM role_grant
        WHERE user_account_id = $1 AND role = 'ORG_OWNER'
          AND scope_type = 'organization' AND revoked_at IS NULL`,
      [officeUser.userId]));

    const res = await POST(`/v1/access/grants/${mine.rows[0]!.id}/revoke`, officeToken);
    // A school with no owner needs a database to fix. The grant row cannot see
    // who is asking, so this is the one check that has to live above it.
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('would_lock_yourself_out');

    // And somebody else's grant revokes fine.
    expect((await POST(`/v1/access/grants/${grantId}/revoke`, officeToken)).status)
      .toBe(201);
  });
});

describe('consent is recorded against the text somebody agreed to', () => {
  let noticeId = '';
  let childPersonId = '';
  let guardianPersonId = '';

  beforeAll(async () => {
    const child = await createLearnerRaw(tenant.orgId, 'Meher', 'WS-CON-1');
    childPersonId = child.personId;
    guardianPersonId = await createPersonRaw(tenant.orgId, 'Zoya',
      { familyName: 'Khan' });
    await linkGuardianRaw(tenant.orgId, child.studentId, guardianPersonId);

    noticeId = (await owner((c) => c.query<{ id: string }>(
      `INSERT INTO notice_version
         (tenant_id, code, version, locale, title, body, published_at)
       VALUES ($1, 'privacy', 1, 'en-IN', 'Privacy notice',
               'How this school uses your data.', now()) RETURNING id`,
      [tenant.orgId]))).rows[0]!.id;
  }, 60_000);

  it('offers only published notices', async () => {
    await owner((c) => c.query(
      `INSERT INTO notice_version (tenant_id, code, version, locale, title, body)
       VALUES ($1, 'draft_notice', 1, 'en-IN', 'Not ready', 'Draft.')`,
      [tenant.orgId]));

    const res = await GET('/v1/consent/notices', officeToken);
    expect(res.status).toBe(200);
    expect(res.body.data.map((n: any) => n.id)).toContain(noticeId);
    expect(res.body.data.map((n: any) => n.code)).not.toContain('draft_notice');
  });

  it('records a guardian consenting on behalf of a child', async () => {
    const res = await POST('/v1/consent', officeToken, {
      personId: childPersonId,
      givenByPersonId: guardianPersonId,
      purpose: 'attendance_notifications',
      noticeVersionId: noticeId,
      channel: 'paper',
      evidenceRef: 'Admission pack, signed 2026-04-02',
    });
    expect(res.status).toBe(201);
    // Both people on the record: "who agreed, and on whose behalf" has to be
    // answerable years later.
    expect(res.body.data.person_id).toBe(childPersonId);
    expect(res.body.data.given_by_person_id).toBe(guardianPersonId);
    expect(res.body.data.basis).toBe('consent');
  });

  it('will not let a school withdraw what is not consent-based', async () => {
    const res = await POST('/v1/consent/withdraw', officeToken, {
      personId: childPersonId, purpose: 'core_education_service',
    });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('purpose_not_consent_based');
  });

  it('withdraws what is, and takes the child off the gap list either way',
    async () => {
      const before = await GET('/v1/consent/gaps?purpose=attendance_notifications',
        officeToken);
      expect(before.body.data.map((r: any) => r.person_id)).not.toContain(childPersonId);

      expect((await POST('/v1/consent/withdraw', officeToken, {
        personId: childPersonId, purpose: 'attendance_notifications',
        reason: 'Asked at the gate.',
      })).status).toBe(201);

      // Withdrawn, so back on the list of children a school has not got
      // permission for — which is the list somebody acts on.
      const after = await GET('/v1/consent/gaps?purpose=attendance_notifications',
        officeToken);
      expect(after.body.data.map((r: any) => r.person_id)).toContain(childPersonId);
    });
});

describe('a school can roll into the next year without editing this one', () => {
  let nextYearId = '';

  beforeAll(async () => {
    nextYearId = (await createAcademicYear(tenant.orgId, tenant.unitId, '2027-28', 2027,
      { status: 'planning' })).yearId;
  }, 60_000);

  it('says what is in each year before anything is copied', async () => {
    const from = await GET(`/v1/academic-years/${academicYearId}/structure`, officeToken);
    expect(from.status).toBe(200);
    expect(from.body.data.class_groups).toBeGreaterThan(0);

    const to = await GET(`/v1/academic-years/${nextYearId}/structure`, officeToken);
    expect(to.body.data.class_groups).toBe(0);
    expect(to.body.data.enrolments).toBe(0);
  });

  it('copies the structure, and leaves the old year untouched', async () => {
    const before = await owner((c) => c.query<{ h: string }>(
      `SELECT md5(string_agg(cg.id::text || cg.name, ',' ORDER BY cg.id)) AS h
         FROM class_group cg WHERE cg.academic_year_id = $1`, [academicYearId]));

    const res = await POST(`/v1/academic-years/${academicYearId}/rollover`, officeToken,
      { toAcademicYearId: nextYearId });
    expect(res.status).toBe(201);
    expect(res.body.data.created.classGroups).toBeGreaterThan(0);

    const after = await owner((c) => c.query<{ h: string }>(
      `SELECT md5(string_agg(cg.id::text || cg.name, ',' ORDER BY cg.id)) AS h
         FROM class_group cg WHERE cg.academic_year_id = $1`, [academicYearId]));
    // AC-3's whole claim: rollover COPIES. Renaming a class next year cannot
    // alter last year's report cards, because last year's rows are never
    // touched again.
    expect(after.rows[0]!.h).toBe(before.rows[0]!.h);
  });

  it('refuses to roll into a year that already has structure', async () => {
    const res = await POST(`/v1/academic-years/${academicYearId}/rollover`, officeToken,
      { toAcademicYearId: nextYearId });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
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

/**
 * M29.3 — a language somebody can actually change.
 *
 * M29.1 built the chain and nothing could set either end of it:
 * `organization.locale` was whatever 0002's default left it, and
 * `communication_preference.locale` could only be written by a test. A
 * resolution chain nobody can set resolves the same way forever.
 */
describe('setting a language', () => {
  it('tells a caller what they read, and why', async () => {
    const res = await GET('/v1/locale', officeToken);
    expect(res.status).toBe(200);
    // The whole chain, not a winner: a settings screen has to tell "Hindi,
    // because you asked" apart from "Hindi, because the school does".
    expect(res.body.data.chain).toEqual(['en-IN']);
    expect(res.body.data.organization).toBe('en-IN');
    expect(res.body.data.options.map((o: any) => o.tag)).toContain('hi-IN');
  });

  it('lets an owner set the school language, and the chain moves', async () => {
    expect((await POST('/v1/locale/organization', officeToken,
      { locale: 'hi-IN' })).status).toBe(201);

    const after = await GET('/v1/locale', guardianToken);
    expect(after.body.data.organization).toBe('hi-IN');
    // The parent stated nothing, so the school's answer is theirs.
    expect(after.body.data.chain).toEqual(['hi-IN', 'en-IN']);
  });

  it('refuses a parent changing the school language', async () => {
    // Not a check in the controller — the policy from 0079. Every principal of
    // a tenant could UPDATE `organization` from 0003 onwards; the grant was
    // there and only the absence of an endpoint hid it.
    const res = await POST('/v1/locale/organization', guardianToken, { locale: 'ta-IN' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('not_yours_to_change');
    expect((await GET('/v1/locale', officeToken)).body.data.organization).toBe('hi-IN');
  });

  it('refuses a teacher changing it either', async () => {
    // A TEACHER satisfies `app_actor_has_staff_scope()`, which is what every
    // other write in this system leans on. The school's language needs more
    // than that, which is why 0079 added a narrower function rather than
    // reusing the one that was already there.
    expect((await POST('/v1/locale/organization', teacherToken,
      { locale: 'ta-IN' })).status).toBe(403);
  });

  it('reads the grant, not the token: scope, revocation and expiry', async () => {
    // Every clause in 0079's function, one at a time. Found by a mutation
    // pass: with only an organisation-wide CAMPUS_ADMIN in the suite, dropping
    // `scope_type = 'organization'` broke nothing, and with only a
    // campus-scoped grant revoked, dropping `revoked_at IS NULL` broke nothing
    // either — the scope clause was refusing it for the other reason.
    const admin = await createUser('campus@ws-test.example', PASSWORD);
    const attempt = async (locale: string) => {
      const token = await tokenFor(admin, ['CAMPUS_ADMIN']);
      return (await POST('/v1/locale/organization', token, { locale })).status;
    };
    try {
      // An admin of one campus changing what every campus writes in is a
      // scope escalation wearing a settings screen.
      const campusWide = await grantRole(tenant.orgId, admin.userId,
        'CAMPUS_ADMIN', 'campus', tenant.campusId);
      expect(await attempt('ta-IN'), 'one campus is not the school').toBe(403);
      await revokeGrant(campusWide);

      const schoolWide = await grantRole(tenant.orgId, admin.userId,
        'CAMPUS_ADMIN', 'organization', null);
      expect(await attempt('hi-IN'), 'school-wide admin may').toBe(201);

      await revokeGrant(schoolWide);
      expect(await attempt('ta-IN'), 'a revoked grant is not a grant').toBe(403);

      // An org-wide grant written as ALREADY expired, rather than expired
      // afterwards. Changing a grant row bumps `grants_version` and kills every
      // token issued before it, so expiring one in place answers 401 and never
      // reaches the policy. That version bump is the first line of defence;
      // this clause is the second, for the grant that lapses by the passage of
      // time with no row touched and no token invalidated.
      const lapsed = await owner(async (c) => (await c.query<{ id: string }>(
        `INSERT INTO role_grant
           (tenant_id, user_account_id, role, scope_type, scope_id, expires_at)
         VALUES ($1, $2, 'CAMPUS_ADMIN', 'organization', NULL,
                 now() - interval '1 hour') RETURNING id`,
        [tenant.orgId, admin.userId])).rows[0]!.id);
      expect(await attempt('ta-IN'), 'an expired grant is not a grant').toBe(403);

      await owner((c) => c.query(
        'UPDATE role_grant SET expires_at = NULL WHERE id = $1', [lapsed]));
      expect(await attempt('hi-IN')).toBe(201);
    } finally {
      await destroyUsers([admin.userId]);
    }
  });

  it('a family sets their own, and it outranks the school', async () => {
    expect((await POST('/v1/locale/me', guardianToken, { locale: 'bn-IN' })).status).toBe(201);
    const mine = await GET('/v1/locale', guardianToken);
    expect(mine.body.data.chain).toEqual(['bn-IN', 'hi-IN', 'en-IN']);
    expect(mine.body.data.stated).toEqual([
      { purpose: 'core_education_service', locale: 'bn-IN' },
    ]);
  });

  it('leaves one stated language behind, not a row per purpose', async () => {
    // The table is keyed per purpose, so "my language" has no single row. The
    // alternative — writing one row per purpose — manufactures exactly the
    // disagreeing-rows case the chain then has to arbitrate.
    await owner((c) => c.query(
      `INSERT INTO communication_preference (tenant_id, person_id, purpose, locale)
       VALUES ($1, $2, 'fee_notifications', 'ta-IN')`,
      [tenant.orgId, parentAccountPersonId]));

    expect((await POST('/v1/locale/me', guardianToken, { locale: 'mr-IN' })).status).toBe(201);
    const after = await GET('/v1/locale', guardianToken);
    expect(new Set(after.body.data.stated.map((s: any) => s.locale))).toEqual(new Set(['mr-IN']));
    expect(after.body.data.chain).toEqual(['mr-IN', 'hi-IN', 'en-IN']);
  });

  it('lets the office set it on a family’s behalf', async () => {
    // Not a workaround. A parent who cannot read the app cannot reach the
    // screen that changes the language, which is the whole problem — the
    // admissions desk is the only place this reaches those families.
    expect((await POST(`/v1/locale/people/${parentAccountPersonId}`, officeToken,
      { locale: 'ta-IN' })).status).toBe(201);
    expect((await GET('/v1/locale', guardianToken)).body.data.chain[0]).toBe('ta-IN');
  });

  it('refuses a parent setting somebody else’s', async () => {
    const other = await createPersonRaw(tenant.orgId, 'Ramesh', { familyName: 'Iyer' });
    const res = await POST(`/v1/locale/people/${other}`, guardianToken, { locale: 'ta-IN' });
    // 404 rather than 403: whether that person exists is not a parent's
    // business, and the two answers are indistinguishable on purpose.
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('person_not_found');
  });

  it('refuses a language that is not on the list', async () => {
    // Writing is restricted where reading is not. A picker that accepts free
    // text is how `en_US`, `English` and `hindi` end up in one column, none of
    // which match a template row and all of which look like a setting that
    // worked.
    for (const locale of ['en_US', 'klingon', 'zz-ZZ']) {
      const res = await POST('/v1/locale/organization', officeToken, { locale });
      expect(res.status, locale).toBe(422);
      expect(res.body.error.code).toBe('unknown_locale');
    }
    // ...and the message says what IS allowed, because a refusal that does not
    // is a support call.
    expect((await POST('/v1/locale/me', guardianToken, { locale: 'zz-ZZ' }))
      .body.error.message).toMatch(/hi-IN/);
  });

  it('shows a stated language on the account list', async () => {
    // The screen that sets it is the account list, so the list has to say what
    // it is set to. A select that always renders blank is a screen telling the
    // office nobody has chosen anything.
    // Written straight to the table rather than through the endpoint, because
    // the endpoint harmonises every row — so after any change made through the
    // product the rows agree and the ordering below cannot be wrong. Rows that
    // disagree come from an import or an older path, and they are exactly the
    // case the ordering exists for. Found by a surviving mutation: with the
    // rows in agreement, reading the WRONG one passed.
    await owner((c) => c.query(
      `UPDATE communication_preference SET locale = 'bn-IN', updated_at = now()
        WHERE person_id = $1 AND purpose = 'fee_notifications'`,
      [parentAccountPersonId]));

    const accounts = await GET('/v1/access/accounts', officeToken);
    const parent = accounts.body.data.find(
      (a: any) => a.person_id === parentAccountPersonId);
    // The canonical row, not whichever was touched last.
    expect(parent.locale).toBe('ta-IN');
    // ...and somebody who has stated nothing reads as nothing, not as the
    // school's tag: "unset" and "chose what the school uses" are different
    // facts, and the first one moves when the school's does.
    const office = accounts.body.data.find((a: any) => a.person_id === officeStaffPersonId);
    expect(office?.locale ?? null).toBeNull();
  });

  it('accepts a tag in any reasonable spelling and stores one', async () => {
    expect((await POST('/v1/locale/me', guardianToken, { locale: 'HI_in' })).status).toBe(201);
    expect((await GET('/v1/locale', guardianToken)).body.data.stated[0].locale).toBe('hi-IN');
  });
});

/**
 * M34.2 and M34.3 — the routes a method-level sweep found missing.
 *
 * M32 gave thirteen modules a write surface and recorded the lesson. It missed
 * two things that a sweep of "which service methods has nobody called" found
 * immediately: the attendance correction workflow, and the one read in this
 * product that exists to be done in a hurry.
 */
describe('attendance can be finished, locked and corrected', () => {
  let sessionId = '';
  let recordId = '';
  let correctionId = '';

  beforeAll(async () => {
    sessionId = (await owner(async (c) => (await c.query<{ id: string }>(
      `INSERT INTO attendance_session
         (tenant_id, section_id, academic_year_id, session_date, mode, status)
       VALUES ($1, $2, $3, CURRENT_DATE, 'day', 'open') RETURNING id`,
      [tenant.orgId, sectionA, academicYearId])).rows[0]!.id));

    recordId = (await owner(async (c) => (await c.query<{ id: string }>(
      `INSERT INTO attendance_record
         (tenant_id, attendance_session_id, session_date, enrollment_id, state)
       VALUES ($1, $2, (SELECT session_date FROM attendance_session WHERE id = $2),
               (SELECT id FROM enrollment WHERE section_id = $3 LIMIT 1), 'absent')
       RETURNING id`,
      [tenant.orgId, sessionId, sectionA])).rows[0]!.id));
  }, 60_000);

  it('submits a register, then locks it', async () => {
    const submitted = await POST(`/v1/attendance/sessions/${sessionId}/submit`, officeToken);
    expect(submitted.status).toBe(201);
    expect(submitted.body.data.status).toBe('submitted');

    // Locking is what makes a correction necessary rather than an edit. AC-5's
    // whole conflict model is written in terms of locked sessions, and until
    // M34.2 no school could lock one.
    expect((await POST(`/v1/attendance/sessions/${sessionId}/lock`, officeToken)).status)
      .toBe(201);
    expect((await POST(`/v1/attendance/sessions/${sessionId}/lock`, officeToken)).status)
      .toBe(409);
  });

  it('refuses a correction with no reason', async () => {
    // The correction row IS the evidence of what changed and why. "It always
    // said absent" is a thing families dispute years later.
    const res = await POST('/v1/attendance/corrections', officeToken,
      { recordId, toState: 'present', reason: '   ' });
    expect(res.status).toBe(422);
  });

  it('raises one, lists it, and approves it', async () => {
    const asked = await POST('/v1/attendance/corrections', officeToken,
      { recordId, toState: 'present', reason: 'She was in the lab.' });
    expect(asked.status).toBe(201);
    correctionId = asked.body.data.id;

    // The queue nothing could read. `attendance_correction_pending_idx` has
    // existed since 0021 for a query nobody had written.
    const queue = await GET('/v1/attendance/corrections', officeToken);
    expect(queue.status).toBe(200);
    const mine = queue.body.data.find((c: any) => c.id === correctionId);
    expect(mine).toBeTruthy();
    expect(mine.from_state).toBe('absent');
    expect(mine.to_state).toBe('present');
    // Enough context to decide without opening another screen.
    expect(mine.given_name).toBeTruthy();
    expect(mine.session_date).toBeTruthy();

    expect((await POST(`/v1/attendance/corrections/${correctionId}/approve`,
      officeToken)).status).toBe(201);

    const after = await owner(async (c) => (await c.query<{ state: string }>(
      'SELECT state FROM attendance_record WHERE id = $1', [recordId])).rows[0]!.state);
    expect(after).toBe('present');
  });

  it('refuses a second decision on the same correction', async () => {
    expect((await POST(`/v1/attendance/corrections/${correctionId}/approve`,
      officeToken)).status).toBe(409);
  });

  it('rejects one, with the reason the constraint has always required', async () => {
    // `rejection_reason` has been a column with a CHECK since 0021 and no code
    // had ever written it, so a correction a school disagreed with stayed
    // pending for ever.
    const asked = await POST('/v1/attendance/corrections', officeToken,
      { recordId, toState: 'excused', reason: 'Mother says she was ill.' });
    const id = asked.body.data.id;

    expect((await POST(`/v1/attendance/corrections/${id}/reject`, officeToken, {}))
      .status).toBe(422);

    // Whitespace, which the schema's `min(1)` allows through. Without this the
    // service's own check is unreachable from HTTP and a mutation deleting it
    // breaks nothing — the same trap M32 found in the refund refusals.
    expect((await POST(`/v1/attendance/corrections/${id}/reject`, officeToken,
      { reason: '   ' })).status).toBe(422);

    expect((await POST(`/v1/attendance/corrections/${id}/reject`, officeToken,
      { reason: 'No note was produced.' })).status).toBe(201);

    const row = await owner(async (c) => (await c.query<{
      status: string; rejection_reason: string | null;
    }>('SELECT status, rejection_reason FROM attendance_correction WHERE id = $1',
      [id])).rows[0]!);
    expect(row.status).toBe('rejected');
    expect(row.rejection_reason).toBe('No note was produced.');

    // ...and it stays decided. A second refusal would overwrite the first
    // reason, which is the evidence of what the school actually said.
    expect((await POST(`/v1/attendance/corrections/${id}/reject`, officeToken,
      { reason: 'Changed my mind.' })).status).toBe(409);
  });

  it('names the person deciding from the session, not the body', async () => {
    // M32's lesson, applied to the routes it did not reach.
    const asked = await POST('/v1/attendance/corrections', officeToken,
      { recordId, toState: 'late', reason: 'Arrived at 9.10.',
        requestedBy: '00000000-0000-0000-0000-000000000000' });
    const row = await owner(async (c) => (await c.query<{ requested_by: string | null }>(
      'SELECT requested_by FROM attendance_correction WHERE id = $1',
      [asked.body.data.id])).rows[0]!);
    expect(row.requested_by).toBe(officeStaffId);
  });

  it('refuses somebody who is not staff', async () => {
    const res = await POST('/v1/attendance/corrections', guardianToken,
      { recordId, toState: 'present', reason: 'He was there.' });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

describe('the information somebody needs in ten seconds', () => {
  let childId = '';

  beforeAll(async () => {
    const child = await createLearnerRaw(tenant.orgId, 'Ishaan', 'WS-EMG-1',
      { medicalNote: 'Severe peanut allergy — EpiPen in the office.',
        bloodGroup: 'O+' });
    childId = child.studentId;
    await owner((c) => c.query(
      `UPDATE student SET emergency_contact_name = 'Rekha Nair',
                          emergency_contact_phone = '+919876543210'
        WHERE id = $1`, [childId]));
  }, 60_000);

  it('answers with the allergy, which nothing could read before', async () => {
    // `findStudentSensitive` reads on a narrower database role and audits the
    // attempt whether or not it succeeds. It had no caller anywhere in src/:
    // a teacher standing over a child who had collapsed had nothing to read.
    const res = await GET(`/v1/students/${childId}/emergency`, officeToken);
    expect(res.status).toBe(200);
    expect(res.body.data.medical_note).toMatch(/peanut/i);
    expect(res.body.data.blood_group).toBe('O+');
    expect(res.body.data.emergency_contact_phone).toBe('+919876543210');
  });

  it('audits the read, and audits the refusal the same way', async () => {
    // A refused attempt on a medical note is exactly as interesting as a
    // successful one.
    await GET(`/v1/students/${childId}/emergency`, officeToken);
    const hit = await owner(async (c) => (await c.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_log
        WHERE tenant_id = $1 AND resource_id = $2
          AND action IN ('student.sensitive.read', 'student.sensitive.read_denied')`,
      [tenant.orgId, childId])).rows[0]!.n);
    expect(Number(hit)).toBeGreaterThan(0);
  });

  it('keeps the allergy off the ordinary learner read', async () => {
    // A sensitive field that rides along with an ordinary read is a field that
    // ends up in an export, a log line and a support screenshot — and makes
    // every read look like somebody asking for a medical note, which is what
    // ruins the audit trail for spotting one who was.
    const plain = await GET(`/v1/students/${childId}`, officeToken);
    expect(plain.status).toBe(200);
    expect(JSON.stringify(plain.body)).not.toMatch(/peanut/i);
    expect(plain.body.data).not.toHaveProperty('blood_group');
  });

  it('says who may collect the child, and what else they may do', async () => {
    const parentPersonId = await createPersonRaw(tenant.orgId, 'Rekha',
      { familyName: 'Nair' });
    await linkGuardianRaw(tenant.orgId, childId, parentPersonId,
      { isPrimary: true, canAuthorisePickup: true });

    const res = await GET(`/v1/students/${childId}/guardians`, officeToken);
    expect(res.status).toBe(200);
    const link = res.body.data.find((g: any) => g.guardian_person_id === parentPersonId);
    expect(link.can_authorise_pickup).toBe(true);
    expect(link.is_primary).toBe(true);
  });
});

/**
 * M34.4 — a feature that could be seen and not changed.
 *
 * `brandingService.set` shipped in M19 and had no caller anywhere in `src/`
 * until the reachability sweep found it. A school could look at its own name,
 * mark and colours on the settings screen and had no way to alter any of them —
 * which does not read as a missing feature, it reads as something somebody else
 * controls.
 */
describe('a school can change its own branding', () => {
  it('sets a name and a colour, and reads them back', async () => {
    const res = await POST('/v1/branding', officeToken, {
      appName: 'Nalanda Portal', primaryColour: '#14B8A6',
    });
    expect(res.status).toBe(201);
    expect(res.body.data.app_name).toBe('Nalanda Portal');

    const read = await GET('/v1/branding', officeToken);
    expect(read.body.data.primary_colour).toBe('#14B8A6');
  });

  it('leaves a field alone when it is not mentioned', async () => {
    // The service upserts with COALESCE, so an omitted field keeps its value
    // and an explicit null clears it. A screen that sent only what changed
    // would otherwise blank everything else.
    await POST('/v1/branding', officeToken, { supportEmail: 'help@nalanda.example' });
    const read = await GET('/v1/branding', officeToken);
    expect(read.body.data.app_name).toBe('Nalanda Portal');
    expect(read.body.data.support_email).toBe('help@nalanda.example');
  });

  it('refuses a colour that is not one', async () => {
    // The value is interpolated into a CSS custom property on a page served
    // under the school's own domain, so `#fff; background:url(...)` is exactly
    // what the check exists to refuse.
    const res = await POST('/v1/branding', officeToken,
      { primaryColour: '#fff; background:url(//evil)' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('not_a_colour');

    // ...and something merely wrong rather than dangerous is refused by the
    // same rule, in the same place. The schema's length bound is wide enough
    // that the service's check is what answers — otherwise the service's rule
    // is unreachable and deleting it breaks nothing.
    expect((await POST('/v1/branding', officeToken, { inkColour: 'navy' }))
      .body.error.code).toBe('not_a_colour');
    expect((await GET('/v1/branding', officeToken)).body.data.primary_colour)
      .toBe('#14B8A6');
  });
});

// ---------------------------------------------------------------------------

/**
 * M35 — the second halves.
 *
 * M34 counted sixty service methods with no route and wrote down why each one
 * had none. Reading that list back, most of the reasons did not survive
 * contact: "waiting on a payment provider" was guarding four reconciliation
 * methods that need no provider, and "a workflow whose second half has no
 * route" was describing a two-person approval the database has been ready to
 * enforce since 0008.
 *
 * Each block below is one of those second halves, tested through `fetch` for
 * the reason this file exists: a service test proves a function works and
 * cannot prove anybody can call it.
 */
describe('a help article can be revised and taken down, not just published', () => {
  let articleId = '';
  const slug = `fees-${randomUUID().slice(0, 8)}`;

  it('publishes version one', async () => {
    const created = await POST('/v1/help', officeToken, {
      slug,
      title: 'How to pay fees',
      body: 'Pay at the office, or in the app.',
      audience: 'guardians',
    });
    expect(created.status).toBe(201);
    articleId = created.body.data.id;
    expect((await POST(`/v1/help/${articleId}/publish`, officeToken, { version: 1 }))
      .status).toBe(201);
  });

  it('a revision is a new version, and does not go live on its own', async () => {
    const revised = await POST(`/v1/help/${articleId}/revise`, officeToken, {
      title: 'How to pay fees', body: 'Pay in the app. The office no longer takes cash.',
    });
    expect(revised.status).toBe(201);
    expect(revised.body.data.version).toBe(2);

    // Still serving v1. Publishing "the latest" would put a half-written draft
    // in front of a parent the moment somebody saved it.
    const stored = await owner((c) => c.query<{ published_version: number | null }>(
      'SELECT published_version FROM kb_article WHERE id = $1', [articleId]));
    expect(stored.rows[0]!.published_version).toBe(1);
  });

  it('unpublishes without deleting a word', async () => {
    // Asserted through a guardian's token rather than by reading a column,
    // because the guarantee is "a parent stops seeing it" and 0043's policy is
    // what delivers that. `published_version` is deliberately NOT cleared —
    // re-publishing should restore what was there rather than ask somebody to
    // remember which version it was — so a test that checked the column would
    // have been asserting the opposite of the design.
    const before = await GET(`/v1/help/${slug}`, guardianToken);
    expect(before.status).toBe(200);

    expect((await POST(`/v1/help/${articleId}/unpublish`, officeToken)).status).toBe(201);

    const after = await GET(`/v1/help/${slug}`, guardianToken);
    expect(after.status).toBe(404);

    // ...and every word of it still there for the school. A parent who was
    // told the wrong thing last Tuesday is owed the text they actually read.
    const kept = await owner((c) => c.query<{ n: string; published_version: number | null }>(
      `SELECT a.published_version,
              (SELECT count(*)::text FROM kb_article_version v
                WHERE v.kb_article_id = a.id) AS n
         FROM kb_article a WHERE a.id = $1`, [articleId]));
    expect(kept.rows[0]!.n).toBe('2');
    expect(kept.rows[0]!.published_version).toBe(1);
  });
});

describe('a ticket can be handed to somebody', () => {
  it('assigns, and records who to', async () => {
    const raised = await POST('/v1/tickets', officeToken, {
      subject: 'Receipt not generated', body: 'Paid on Tuesday, no receipt.',
      category: 'fees_and_payments',
    });
    expect(raised.status).toBe(201);
    const ticketId = raised.body.data.id;

    const assigned = await POST(`/v1/tickets/${ticketId}/assign`, officeToken,
      { staffId: officeStaffId });
    expect(assigned.status).toBe(201);
    expect(assigned.body.data.assignedTo).toBe(officeStaffId);

    // The thread unions messages and events; an event row's `kind` is the
    // literal 'event' and the event's own kind travels in `body`, which is the
    // shape a screen renders from.
    const thread = await GET(`/v1/tickets/${ticketId}/thread`, officeToken);
    expect(thread.body.data.some((e: any) => e.kind === 'event' && e.body === 'assigned'))
      .toBe(true);

    const stored = await owner((c) => c.query<{ assigned_to_staff_id: string | null }>(
      'SELECT assigned_to_staff_id FROM support_ticket WHERE id = $1', [ticketId]));
    expect(stored.rows[0]!.assigned_to_staff_id).toBe(officeStaffId);
  });

  it('refuses an assignee that is not a uuid, before touching the database', async () => {
    const raised = await POST('/v1/tickets', officeToken, {
      subject: 'Another', body: 'Body.', category: 'other',
    });
    const res = await POST(`/v1/tickets/${raised.body.data.id}/assign`, officeToken,
      { staffId: 'meera' });
    expect(res.status).toBe(422);
  });
});

describe('a learner can be moved, and asked about', () => {
  let studentId = '';
  let enrollmentId = '';

  beforeAll(async () => {
    const learner = await createLearnerRaw(tenant.orgId, 'Ishaan', 'WS-M35-1');
    studentId = learner.studentId;
    enrollmentId = (await owner((c) => c.query<{ id: string }>(
      `INSERT INTO enrollment (tenant_id, student_id, section_id, academic_year_id)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [tenant.orgId, studentId, sectionA, academicYearId]))).rows[0]!.id;
  }, 60_000);

  it('answers "which enrollment is this child on right now"', async () => {
    const res = await GET(`/v1/enrollments/current/${studentId}`, officeToken);
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(enrollmentId);
    expect(res.body.data.status).toBe('active');
  });

  it('says so plainly when a learner is not enrolled', async () => {
    const other = await createLearnerRaw(tenant.orgId, 'Nila', 'WS-M35-2');
    const res = await GET(`/v1/enrollments/current/${other.studentId}`, officeToken);
    // Not an empty body. A null that looks like a missing field is the shape
    // a client renders as a blank row rather than as an answer.
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_enrolled');
  });

  it('refuses a transfer with no reason on it', async () => {
    const res = await POST(`/v1/enrollments/${enrollmentId}/transfer`, officeToken, {
      toSectionId: sectionB, toAcademicYearId: academicYearId, reason: '   ',
    });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('reason_required');
  });

  it('ends the old enrollment and opens a new one, linked', async () => {
    const res = await POST(`/v1/enrollments/${enrollmentId}/transfer`, officeToken, {
      toSectionId: sectionB, toAcademicYearId: academicYearId,
      reason: 'Family moved; joining the Hosur Road campus.',
    });
    expect(res.status).toBe(201);
    expect(res.body.data.from.status).not.toBe('active');
    expect(res.body.data.to.status).toBe('active');
    expect(res.body.data.to.id).not.toBe(enrollmentId);

    // `current` now answers with the new one — which is the whole reason a
    // transfer is two rows and not an UPDATE.
    const now = await GET(`/v1/enrollments/current/${studentId}`, officeToken);
    expect(now.body.data.id).toBe(res.body.data.to.id);

    const history = await GET(`/v1/enrollments/${enrollmentId}/history`, officeToken);
    expect(history.body.data.some((e: any) => e.related_enrollment_id === res.body.data.to.id))
      .toBe(true);
  });
});

describe('consent answers the question a screen actually asks', () => {
  let personId = '';

  beforeAll(async () => {
    personId = (await createLearnerRaw(tenant.orgId, 'Aarav', 'WS-M35-C1')).personId;
  }, 60_000);

  it('permits teaching a child with no consent row anywhere', async () => {
    // The contract-basis rule, and the reason this endpoint is not
    // `listFor(...).length > 0` at the call site. A school that had to collect
    // consent to teach an enrolled child could be told to stop teaching.
    const res = await GET(`/v1/consent/people/${personId}/core_education_service`,
      officeToken);
    expect(res.status).toBe(200);
    expect(res.body.data.permitted).toBe(true);

    const rows = await GET(`/v1/consent/people/${personId}`, officeToken);
    expect(rows.body.data).toEqual([]);
  });

  it('refuses everything else until somebody agrees to it', async () => {
    const before = await GET(`/v1/consent/people/${personId}/marketing`, officeToken);
    expect(before.body.data.permitted).toBe(false);
  });

  it('refuses a purpose that is not one of ours', async () => {
    const res = await GET(`/v1/consent/people/${personId}/selling_it_on`, officeToken);
    expect(res.status).toBe(422);
  });
});

describe('an account can be signed out of everything', () => {
  it('will not touch an account with no grant in this school', async () => {
    // A uuid that is syntactically fine and belongs to nobody here. One school
    // reaching into another's people is the failure this guards.
    const res = await POST(`/v1/access/accounts/${randomUUID()}/sign-out-everywhere`,
      officeToken, { reason: 'Testing.' });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('account_not_found');
  });

  it('ends live sessions and clears the push token', async () => {
    await owner((c) => c.query(
      `INSERT INTO session (user_account_id, refresh_token_hash, expires_at)
       VALUES ($1, $2, now() + interval '30 days')`,
      [teacherUser.userId, `hash-${randomUUID()}`]));

    const res = await POST(
      `/v1/access/accounts/${teacherUser.userId}/sign-out-everywhere`,
      officeToken, { reason: 'Phone left on a bus.' });
    expect(res.status).toBe(201);
    expect(res.body.data.sessionsEnded).toBeGreaterThan(0);

    const live = await owner((c) => c.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM session
        WHERE user_account_id = $1 AND revoked_at IS NULL`, [teacherUser.userId]));
    expect(live.rows[0]!.n).toBe('0');
  });
});

describe('support access still needs two people', () => {
  let requestId = '';
  let agentToken = '';
  let agentUser: UserFixture;

  beforeAll(async () => {
    agentUser = await createUser('agent@ws-test.example', PASSWORD);
    await grantRole(tenant.orgId, agentUser.userId, 'SUPPORT_AGENT', 'organization', null);
    agentToken = await tokenFor(agentUser, ['SUPPORT_AGENT']);
  }, 60_000);

  it('a request grants nothing', async () => {
    const res = await POST('/v1/support-access', agentToken, {
      reason: 'Investigating ticket SUP-4417: receipt not generated after payment.',
      ticketRef: 'SUP-4417',
    });
    expect(res.status).toBe(201);
    requestId = res.body.data.id;
    expect(res.body.data.status).toBe('requested');
    expect(res.body.data.write_enabled).toBe(false);
    expect(res.body.data.started_at).toBeNull();
  });

  it('refuses a reason nobody could act on', async () => {
    const res = await POST('/v1/support-access', agentToken, {
      reason: 'debug', ticketRef: 'SUP-1',
    });
    // 422 from the SERVICE's ten-character rule, not from the schema. The zod
    // bound is deliberately wider, or the service's rule would be unreachable
    // and deleting it would break nothing.
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('reason_too_short');
  });

  it('the requester cannot approve their own request', async () => {
    // `approved_by <> actor_user_id` is a CHECK constraint, so this is refused
    // by the database even if every layer above it forgot.
    const res = await POST(`/v1/support-access/${requestId}/approve`, agentToken);
    expect(res.status).toBeGreaterThanOrEqual(400);

    const still = await owner((c) => c.query<{ status: string }>(
      'SELECT status FROM impersonation_session WHERE id = $1', [requestId]));
    expect(still.rows[0]!.status).toBe('requested');
  });

  it('a second person who is not entitled to approve cannot', async () => {
    // A mutation pass found this one: emptying `requireApprover` broke no
    // test, which meant any account in the school with a token could let
    // somebody into the school's records. Two people is not the control —
    // two people, one of whom is entitled, is.
    //
    // The teacher is a second person by the database's reckoning (the CHECK
    // only compares ids) and holds no `audit:read`.
    const res = await POST(`/v1/support-access/${requestId}/approve`, teacherToken);
    expect(res.status).toBe(404);

    const still = await owner((c) => c.query<{ status: string }>(
      'SELECT status FROM impersonation_session WHERE id = $1', [requestId]));
    expect(still.rows[0]!.status).toBe('requested');
  });

  it('and cannot read the access log either', async () => {
    // Same permission, same answer — 404 rather than 403, because whether a
    // support session exists is itself part of what `audit:read` governs.
    expect((await GET('/v1/platform-access', teacherToken)).status).toBe(404);
  });

  it('a second person approves, and the window opens', async () => {
    const res = await POST(`/v1/support-access/${requestId}/approve`, officeToken,
      { minutes: 30 });
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('active');
    expect(res.body.data.started_at).not.toBeNull();
  });

  it('caps the window at an hour however long is asked for', async () => {
    const made = await POST('/v1/support-access', agentToken, {
      reason: 'Second look at the same receipt problem, ticket SUP-4418.',
      ticketRef: 'SUP-4418',
    });
    const res = await POST(`/v1/support-access/${made.body.data.id}/approve`,
      officeToken, { minutes: 600 });
    // Refused at the edge rather than silently clamped: a console that asked
    // for ten hours and was given one should be told.
    expect(res.status).toBe(422);
  });

  it('the school sees it in its own access log, and can end it', async () => {
    const log = await GET('/v1/platform-access', officeToken);
    expect(log.status).toBe(200);
    const row = log.body.data.find((r: any) => r.id === requestId);
    expect(row.entry_path).toBe('support');
    expect(row.status).toBe('active');
    expect(log.body.notice).toMatch(/in your records right now/);

    expect((await POST(`/v1/platform-access/${requestId}/end`, officeToken,
      { reason: 'Not authorised by us.' })).status).toBe(201);
    const after = await GET('/v1/platform-access', officeToken);
    expect(after.body.data.find((r: any) => r.id === requestId).status).toBe('revoked');
  });
});

describe('an accountant can reconcile a settlement', () => {
  const utr = `UTR${Date.now()}`;

  it('imports a batch and leaves every line unmatched when no payment matches', async () => {
    // M34 filed reconciliation under "waiting on a payment provider" and that
    // was wrong. Presenting a mandate and taking a card need a live gateway.
    // Reconciling a settlement is arithmetic on rows a school already has, and
    // the unmatched queue is most useful precisely when the payments did not
    // come through this system.
    const res = await POST('/v1/fees/settlements', officeToken, {
      provider: 'demo-gateway', utr, settledOn: today(),
      gross: '10000.00', fee: '200.00', tax: '36.00',
      lines: [
        { providerPaymentId: 'pay_A1', amount: '6000.00', providerFee: '120.00' },
        { providerPaymentId: 'pay_A2', amount: '4000.00', providerFee: '80.00' },
      ],
    });
    expect(res.status).toBe(201);
    expect(res.body.data.matched).toBe(0);
    expect(res.body.data.unmatched).toBe(2);
  });

  it('refuses the same UTR twice', async () => {
    // A settlement file re-uploaded is the ordinary way a day gets counted
    // twice, and the second count lands in the ledger.
    const again = await POST('/v1/fees/settlements', officeToken, {
      provider: 'demo-gateway', utr, settledOn: today(),
      gross: '10000.00', fee: '200.00', tax: '36.00',
      lines: [{ providerPaymentId: 'pay_A1', amount: '6000.00', providerFee: '120.00' }],
    });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('settlement_already_imported');
  });

  it('puts both lines on somebody’s work list', async () => {
    const queue = await GET('/v1/fees/settlements/unmatched', officeToken);
    expect(queue.status).toBe(200);
    const mine = queue.body.data.filter((l: any) => l.utr === utr);
    expect(mine.map((l: any) => l.provider_payment_id).sort())
      .toEqual(['pay_A1', 'pay_A2']);
    expect(mine[0].amount).toBe('6000.00');
  });

  it('will not take a manual match with no note on it', async () => {
    const queue = await GET('/v1/fees/settlements/unmatched', officeToken);
    const line = queue.body.data.find((l: any) => l.utr === utr);
    const res = await POST(`/v1/fees/settlements/lines/${line.id}/match`, officeToken,
      { paymentId: randomUUID(), note: '' });
    // A manual match is somebody asserting two records are the same event. In
    // six months the only evidence of why is what they typed here.
    expect(res.status).toBe(422);
  });

  it('reports what the books think is still in transit', async () => {
    const res = await GET('/v1/fees/settlements/clearing-balance', officeToken);
    expect(res.status).toBe(200);
    // A decimal string, not a float and not paise. The number an accountant
    // compares against a bank statement.
    expect(res.body.data.balance).toMatch(/^-?\d+\.\d{2}$/);
  });
});

describe('an application can carry documents, and somebody can check them', () => {
  let applicationId = '';
  let documentId = '';
  let fileId = '';

  beforeAll(async () => {
    const person = await createPersonRaw(tenant.orgId, 'Rhea', { familyName: 'Nair' });
    const made = await owner(async (c) => {
      // Draft, with no form submission. `application_submitted_has_form` means
      // a submitted application must carry the answers it was submitted with,
      // and documents are attachable long before anybody presses submit —
      // which is the ordinary order at a counter.
      const app = await c.query<{ id: string }>(
        `INSERT INTO application
           (tenant_id, applicant_person_id, programme_id, academic_year_id,
            application_no, status)
         VALUES ($1, $2, $3, $4, $5, 'draft') RETURNING id`,
        [tenant.orgId, person, programmeId, academicYearId,
         `WS-APP-${randomUUID().slice(0, 8)}`]);
      const file = await c.query<{ id: string }>(
        `INSERT INTO file (tenant_id, bucket, object_key, mime_type, size_bytes,
                           sha256, classification, virus_scan_state)
         VALUES ($1, 'paathshala-docs', $2, 'application/pdf', 1024,
                 repeat('a', 64), 'SENSITIVE', 'clean') RETURNING id`,
        [tenant.orgId, `apps/${randomUUID()}.pdf`]);
      return { appId: app.rows[0]!.id, fileId: file.rows[0]!.id };
    });
    applicationId = made.appId;
    fileId = made.fileId;
  }, 60_000);

  it('attaches a document', async () => {
    const res = await POST(`/v1/admissions/applications/${applicationId}/documents`,
      officeToken, { documentType: 'birth_certificate', fileId });
    expect(res.status).toBe(201);

    documentId = (await owner((c) => c.query<{ id: string }>(
      `SELECT id FROM application_document
        WHERE application_id = $1 AND document_type = 'birth_certificate'`,
      [applicationId]))).rows[0]!.id;
  });

  it('will not reject one without telling the family why', async () => {
    const res = await POST(`/v1/admissions/application-documents/${documentId}/verify`,
      officeToken, { accept: false });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('rejection_needs_reason');
  });

  it('rejects it with a reason a family can act on', async () => {
    const res = await POST(`/v1/admissions/application-documents/${documentId}/verify`,
      officeToken, { accept: false, reason: 'The scan is cut off at the date of birth.' });
    expect(res.status).toBe(201);

    const row = await owner((c) => c.query<{ status: string; rejection_reason: string | null }>(
      'SELECT status, rejection_reason FROM application_document WHERE id = $1',
      [documentId]));
    expect(row.rows[0]!.status).toBe('rejected');
    expect(row.rows[0]!.rejection_reason).toContain('cut off');
  });

  it('re-uploading clears the old verdict, because it was about the old file',
    async () => {
      const replacement = (await owner((c) => c.query<{ id: string }>(
        `INSERT INTO file (tenant_id, bucket, object_key, mime_type, size_bytes,
                           sha256, classification, virus_scan_state)
         VALUES ($1, 'paathshala-docs', $2, 'application/pdf', 2048,
                 repeat('b', 64), 'SENSITIVE', 'clean') RETURNING id`,
        [tenant.orgId, `apps/${randomUUID()}.pdf`]))).rows[0]!.id;

      expect((await POST(`/v1/admissions/applications/${applicationId}/documents`,
        officeToken, { documentType: 'birth_certificate', fileId: replacement })).status)
        .toBe(201);

      const row = await owner((c) => c.query<{
        status: string; rejection_reason: string | null; file_id: string;
      }>('SELECT status, rejection_reason, file_id FROM application_document WHERE id = $1',
        [documentId]));
      // Leaving "rejected: the scan is cut off" beside a legible scan is how a
      // family gets told twice to send what they already sent.
      expect(row.rows[0]!.status).toBe('uploaded');
      expect(row.rows[0]!.rejection_reason).toBeNull();
      expect(row.rows[0]!.file_id).toBe(replacement);
    });

  it('names the staff member who checked it, from the session and not the body',
    async () => {
      expect((await POST(`/v1/admissions/application-documents/${documentId}/verify`,
        officeToken, { accept: true })).status).toBe(201);

      const row = await owner((c) => c.query<{ status: string; verified_by: string | null }>(
        'SELECT status, verified_by FROM application_document WHERE id = $1',
        [documentId]));
      expect(row.rows[0]!.status).toBe('verified');
      // "Who checked this certificate" is a question asked when the
      // certificate turns out to be forged. A client-supplied answer is one
      // anybody can forge by editing a field.
      expect(row.rows[0]!.verified_by).toBe(officeStaffId);
    });
});

describe('a correction always names its reason before anything else', () => {
  // Both services check the reason first, before reading any row. Asserted
  // with ids that do not exist, which is the cheap way to prove the ordering:
  // if the row lookup came first these would be 404s.
  it('a superseded result run needs one', async () => {
    const res = await POST(`/v1/result-runs/${randomUUID()}/supersede`, officeToken,
      { newRunId: randomUUID(), reason: '  ' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('reason_required');
  });

  it('a corrected report card needs one', async () => {
    const res = await POST(`/v1/result-runs/report-cards/${randomUUID()}/correct`,
      officeToken, { newRunId: randomUUID(), reason: '' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('reason_required');
  });

  it('and says so plainly when the run is simply not there', async () => {
    const res = await POST(`/v1/result-runs/${randomUUID()}/supersede`, officeToken,
      { newRunId: randomUUID(), reason: 'Marks for two papers were transposed.' });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('run_not_found');
  });
});

// ---------------------------------------------------------------------------

/**
 * M36 — the first day, which did not work.
 *
 * A method-level sweep in M34 listed fifteen service methods as "superseded by
 * SQL written inline in a controller". Reading them one at a time, that was
 * true of four. The other eleven had no route of any kind, and four of them
 * were the academic structure.
 *
 * Auditing every structural table for a writer produced this:
 *
 *   academic_unit      provisioning, when the console creates the tenant
 *   academic_year      NOTHING
 *   term               rollover only
 *   programme          NOTHING
 *   subject            NOTHING
 *   class_group        a repository method nothing called, and rollover
 *   section            rollover only
 *   course_offering    rollover only
 *   room               NOTHING
 *
 * Rollover copies last year into next year and refuses a source year with no
 * structure, correctly — so it cannot bootstrap. **The only school that has
 * ever had a working structure in this system is the one in `seed.ts`.**
 *
 * Fourteen milestones of attendance, assessment, fees, messaging and results
 * sat on top of a foundation with no way in. Every one of them was tested
 * against rows a developer had inserted by hand, which is why none of the
 * suites noticed.
 *
 * This block is the first day, in the order a school works in, entirely
 * through HTTP. It is the test that would have failed on day one.
 */
describe('a school can set itself up from nothing', () => {
  let unitId = '';
  let yearId = '';
  let termOneId = '';
  let programmeId36 = '';
  let subjectId = '';
  let roomId = '';
  let otherCampusRoomId = '';
  let classGroupId = '';
  let sectionId = '';
  let offeringId = '';

  it('finds the academic unit it was provisioned with', async () => {
    // Step zero, and the one that was quietly impossible. `academicUnitId` is
    // required by fee plans, report card templates, programmes, subjects and
    // years — and no endpoint would tell a client a single valid value.
    const res = await GET('/v1/academic-units', officeToken);
    expect(res.status).toBe(200);
    const mine = res.body.data.find((u: any) => u.id === tenant.unitId);
    expect(mine).toBeTruthy();
    expect(mine.campus_id).toBe(tenant.campusId);

    unitId = mine.id;
  });

  it('refuses a year that ends before it starts', async () => {
    const res = await POST('/v1/structure/years', officeToken, {
      academicUnitId: unitId, label: 'Backwards',
      startsOn: '2028-03-31', endsOn: '2027-04-01',
    });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('dates_out_of_order');
  });

  it('refuses a term that runs outside its year', async () => {
    // The foreign keys allow it and the CHECK constraints allow it: the schema
    // orders a term's own dates and stops two terms overlapping, and says
    // nothing about the year containing them. A term ending after its year
    // makes every "which term is it" query disagree with every "which year is
    // it" one, months before anybody notices on a report card.
    const res = await POST('/v1/structure/years', officeToken, {
      academicUnitId: unitId, label: '2028-29',
      startsOn: '2028-04-01', endsOn: '2029-03-31',
      terms: [
        { label: 'Term 1', sequence: 1, startsOn: '2028-04-01', endsOn: '2028-09-30' },
        { label: 'Term 2', sequence: 2, startsOn: '2028-10-01', endsOn: '2029-06-30' },
      ],
    });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('term_outside_year');
    // Names the term, not just the rule. A school setting up twelve terms
    // needs to know which one.
    expect(res.body.error.message).toContain('Term 2');

    // ...and nothing was written. The year and Term 1 are inside one
    // transaction with the term that failed.
    const orphan = await owner((c) => c.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM academic_year
        WHERE tenant_id = $1 AND label = '2028-29'`, [tenant.orgId]));
    expect(orphan.rows[0]!.n).toBe('0');
  });

  it('creates the year and its terms in one call', async () => {
    const res = await POST('/v1/structure/years', officeToken, {
      academicUnitId: unitId, label: '2028-29',
      startsOn: '2028-04-01', endsOn: '2029-03-31',
      terms: [
        { label: 'Term 1', sequence: 1, startsOn: '2028-04-01', endsOn: '2028-09-30' },
        { label: 'Term 2', sequence: 2, startsOn: '2028-10-01', endsOn: '2029-03-31' },
      ],
    });
    expect(res.status).toBe(201);
    yearId = res.body.data.id;
    // Planning, not active: a school builds next year while this one runs, and
    // two *active* years may not overlap within a unit.
    expect(res.body.data.status).toBe('planning');
    expect(res.body.data.terms).toHaveLength(2);
    termOneId = res.body.data.terms[0].id;
  });

  it('will not activate a year with no terms', async () => {
    const empty = await POST('/v1/structure/years', officeToken, {
      academicUnitId: unitId, label: '2029-30',
      startsOn: '2029-04-01', endsOn: '2030-03-31',
    });
    expect(empty.status).toBe(201);

    // An active year is the one being taught, and teaching happens in a term.
    // Every assessment, result run and report card is keyed to one, so an
    // active year with none is a year in which nothing can be recorded —
    // visible to a principal only when a teacher tries to set the first exam.
    const res = await POST(`/v1/structure/years/${empty.body.data.id}/activate`,
      officeToken);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('year_has_no_terms');
  });

  it('creates a programme and a subject', async () => {
    const programme = await POST('/v1/structure/programmes', officeToken, {
      academicUnitId: unitId, code: 'M36-CBSE', name: 'CBSE Senior School',
      durationTerms: 2, credentialType: 'board_examination',
    });
    expect(programme.status).toBe(201);
    programmeId36 = programme.body.data.id;

    const subject = await POST('/v1/structure/subjects', officeToken, {
      academicUnitId: unitId, code: 'M36-MATH', name: 'Mathematics',
      subjectType: 'core', defaultCredits: '6.00',
    });
    expect(subject.status).toBe(201);
    subjectId = subject.body.data.id;
    // A decimal string out, like every other numeric that crosses this
    // boundary. Credits are summed onto a transcript.
    expect(subject.body.data.default_credits).toBe('6.00');
  });

  it('refuses a second subject with the same code in the same unit', async () => {
    const res = await POST('/v1/structure/subjects', officeToken, {
      academicUnitId: unitId, code: 'M36-MATH', name: 'Maths again',
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('already_exists');
  });

  it('creates a room', async () => {
    const res = await POST('/v1/structure/rooms', officeToken, {
      campusId: tenant.campusId, code: 'M36-R101', name: 'Room 101',
      capacity: 40, roomType: 'classroom',
    });
    expect(res.status).toBe(201);
    roomId = res.body.data.id;
  });

  it('creates a class group and a section', async () => {
    const group = await POST('/v1/structure/class-groups', officeToken, {
      programmeId: programmeId36, academicYearId: yearId,
      name: 'Class IX', levelSequence: 9, capacity: 80,
    });
    expect(group.status).toBe(201);
    classGroupId = group.body.data.id;
    // Kept separate from the name precisely so renaming it to "Grade 10" next
    // year does not reorder last year's reports.
    expect(group.body.data.level_sequence).toBe(9);

    const section = await POST('/v1/structure/sections', officeToken, {
      classGroupId, name: 'A', capacity: 40,
      classTeacherStaffId: teacherStaffId, roomId,
    });
    expect(section.status).toBe(201);
    sectionId = section.body.data.id;
    expect(section.body.data.room_id).toBe(roomId);

    const listed = await GET(
      `/v1/structure/class-groups/${classGroupId}/sections`, officeToken);
    expect(listed.body.data.map((s: any) => s.id)).toEqual([sectionId]);
  });

  it('refuses a room on another campus', async () => {
    // `room` references `campus` and `section` does not, so the two are only
    // relatable through class group → programme → academic unit → campus. Four
    // joins nobody performs by eye, and a room code like 101 exists on every
    // campus a school has.
    const elsewhere = await owner((c) => c.query<{ id: string }>(
      `INSERT INTO campus (tenant_id, code, name) VALUES ($1, $2, $3) RETURNING id`,
      [tenant.orgId, `${tenant.prefix}-M36B`, 'Second Campus']));
    otherCampusRoomId = (await owner((c) => c.query<{ id: string }>(
      `INSERT INTO room (tenant_id, campus_id, code, name)
       VALUES ($1, $2, 'R-101', 'Room 101 over there') RETURNING id`,
      [tenant.orgId, elsewhere.rows[0]!.id]))).rows[0]!.id;

    const res = await POST('/v1/structure/sections', officeToken, {
      classGroupId, name: 'B', roomId: otherCampusRoomId,
    });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('room_on_another_campus');
  });

  it('refuses an offering whose term belongs to a different year', async () => {
    // Both foreign keys are satisfied: `term` and `class_group` each reference
    // `academic_year`, and nothing requires them to reference the SAME one.
    // Nothing downstream notices either — marks go in, a result run computes,
    // and a report card is issued for a term the child was not in that class
    // for. It surfaces as a parent disputing a grade.
    const otherYear = await POST('/v1/structure/years', officeToken, {
      academicUnitId: unitId, label: '2030-31',
      startsOn: '2030-04-01', endsOn: '2031-03-31',
      terms: [{ label: 'Only', sequence: 1, startsOn: '2030-04-01', endsOn: '2031-03-31' }],
    });
    const wrongTerm = otherYear.body.data.terms[0].id;

    const res = await POST('/v1/structure/course-offerings', officeToken, {
      classGroupId, subjectId, termId: wrongTerm,
    });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('term_from_another_year');
  });

  it('creates the offering, and lists it with names a human reads', async () => {
    const res = await POST('/v1/structure/course-offerings', officeToken, {
      classGroupId, subjectId, termId: termOneId,
      sectionId, primaryTeacherStaffId: teacherStaffId, credits: '6.00',
    });
    expect(res.status).toBe(201);
    offeringId = res.body.data.id;

    const listed = await GET(
      `/v1/structure/course-offerings?classGroupId=${classGroupId}`, officeToken);
    const mine = listed.body.data.find((o: any) => o.id === offeringId);
    expect(mine.subject_name).toBe('Mathematics');
    expect(mine.class_name).toBe('Class IX');
    expect(mine.section_name).toBe('A');
  });

  it('refuses a slot for a section that does not take the subject', async () => {
    const otherGroup = await POST('/v1/structure/class-groups', officeToken, {
      programmeId: programmeId36, academicYearId: yearId, name: 'Class X',
    });
    const otherSection = await POST('/v1/structure/sections', officeToken, {
      classGroupId: otherGroup.body.data.id, name: 'A',
    });

    const res = await POST('/v1/structure/schedule-slots', officeToken, {
      courseOfferingId: offeringId, sectionId: otherSection.body.data.id,
      dayOfWeek: 1, startsAt: '09:00', endsAt: '09:45',
    });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('section_from_another_class');
  });

  it('refuses a period that ends before it starts', async () => {
    const res = await POST('/v1/structure/schedule-slots', officeToken, {
      courseOfferingId: offeringId, dayOfWeek: 1,
      startsAt: '10:00', endsAt: '09:00',
    });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('period_ends_before_it_starts');
  });

  it('puts the lesson on the timetable', async () => {
    const res = await POST('/v1/structure/schedule-slots', officeToken, {
      courseOfferingId: offeringId, sectionId, roomId, staffId: teacherStaffId,
      // ISO-8601: Monday is 1. The other common convention puts Sunday at 0,
      // and a timetable one day out looks right on a screen.
      dayOfWeek: 1, startsAt: '09:00', endsAt: '09:45', periodNo: 1,
    });
    expect(res.status).toBe(201);
    expect(res.body.data.day_of_week).toBe(1);
  });

  it('refuses to double-book the room, through the endpoint', async () => {
    // The exclusion constraint, reached over HTTP rather than from a service
    // test. It has been provably correct since M4 and unreachable until now.
    const res = await POST('/v1/structure/schedule-slots', officeToken, {
      courseOfferingId: offeringId, roomId,
      dayOfWeek: 1, startsAt: '09:30', endsAt: '10:15',
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('timetable_room_clash');
  });

  it('shows the teacher their week, and the class theirs', async () => {
    const staff = await GET(`/v1/timetable/staff/${teacherStaffId}`, officeToken);
    expect(staff.status).toBe(200);
    const lesson = staff.body.data.find((l: any) => l.course_offering_id === offeringId);
    expect(lesson.subject_name).toBe('Mathematics');
    expect(lesson.room_name).toBe('Room 101');
    expect(lesson.starts_at).toMatch(/^09:00/);

    const section = await GET(`/v1/timetable/sections/${sectionId}`, officeToken);
    expect(section.body.data.some((l: any) => l.course_offering_id === offeringId))
      .toBe(true);
  });

  it('includes a whole-class lesson in a section’s timetable', async () => {
    // A slot with no `section_id` means the whole class. Filtering on
    // `section_id = $1` alone empties the timetable for every school that
    // teaches its classes together, which is most of them.
    const wholeClass = await POST('/v1/structure/schedule-slots', officeToken, {
      courseOfferingId: offeringId, roomId,
      dayOfWeek: 2, startsAt: '11:00', endsAt: '11:45',
    });
    expect(wholeClass.status).toBe(201);

    const section = await GET(`/v1/timetable/sections/${sectionId}`, officeToken);
    expect(section.body.data.some((l: any) => l.id === wholeClass.body.data.id))
      .toBe(true);
  });

  it('makes the year active once it has terms', async () => {
    const res = await POST(`/v1/structure/years/${yearId}/activate`, officeToken);
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('active');

    // And only once. planning → active is the transition; active → active is a
    // click somebody made twice.
    const again = await POST(`/v1/structure/years/${yearId}/activate`, officeToken);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('not_in_planning');
  });

  it('refuses the whole structure to a guardian', async () => {
    // Nothing above checks a role. Every INSERT is written against a WITH
    // CHECK that admits staff only, and the service turns the resulting empty
    // result into a named refusal rather than a TypeError and a 500.
    for (const [path, body] of [
      ['/v1/structure/programmes',
       { academicUnitId: unitId, code: 'SNEAK', name: 'Mine' }],
      ['/v1/structure/subjects',
       { academicUnitId: unitId, code: 'SNEAK', name: 'Mine' }],
      ['/v1/structure/rooms',
       { campusId: tenant.campusId, code: 'SNEAK', name: 'Mine' }],
      ['/v1/structure/class-groups',
       { programmeId: programmeId36, academicYearId: yearId, name: 'Mine' }],
    ] as const) {
      const res = await POST(path, guardianToken, body);
      expect(res.status, `${path} let a guardian write`).toBe(403);
      expect(res.body.error.code).toBe('staff_only');
    }
  });
});

describe('the learner list is one query, and it filters', () => {
  let inA = '';

  beforeAll(async () => {
    const learner = await createLearnerRaw(tenant.orgId, 'Meher', 'WS-M36-F1');
    inA = learner.studentId;
    await owner((c) => c.query(
      `INSERT INTO enrollment (tenant_id, student_id, section_id, academic_year_id)
       VALUES ($1, $2, $3, $4)`,
      [tenant.orgId, inA, sectionA, academicYearId]));
  }, 60_000);

  it('narrows to a section', async () => {
    // A surviving mutation found this: neutering the section filter broke no
    // test. `/v1/students?sectionId=` is what a teacher's roster screen calls,
    // it has existed since M9, and nothing had ever asserted that the
    // parameter does anything.
    const all = await GET('/v1/students', officeToken);
    expect(all.body.data.length).toBeGreaterThan(1);

    const inSection = await GET(`/v1/students?sectionId=${sectionA}`, officeToken);
    expect(inSection.status).toBe(200);
    expect(inSection.body.data.map((s: any) => s.id)).toContain(inA);
    expect(inSection.body.data.length).toBeLessThan(all.body.data.length);
    for (const row of inSection.body.data) {
      expect(row.section_id).toBe(sectionA);
    }
  });

  it('searches on either name or the admission number', async () => {
    for (const q of ['Meher', 'WS-M36-F1']) {
      const res = await GET(`/v1/students?q=${encodeURIComponent(q)}`, officeToken);
      expect(res.status, `searching for ${q}`).toBe(200);
      expect(res.body.data.map((s: any) => s.id), `searching for ${q}`).toContain(inA);
    }

    const none = await GET('/v1/students?q=nobodycalledthis', officeToken);
    expect(none.body.data).toEqual([]);
  });

  it('treats a LIKE metacharacter as a character', async () => {
    // `%` must not return the school. The value goes into an ILIKE pattern,
    // and a wildcard that a caller can supply is a filter a caller can remove.
    const res = await GET('/v1/students?q=%25', officeToken);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it('carries the name and class a screen needs, not just ids', async () => {
    const res = await GET(`/v1/students/${inA}`, officeToken);
    expect(res.status).toBe(200);
    expect(res.body.data.given_name).toBe('Meher');
    expect(res.body.data.section_id).toBe(sectionA);
  });
});

describe('a guardian can be linked to a learner without a spreadsheet', () => {
  let studentId = '';
  let guardianPersonId = '';
  let linkId = '';

  beforeAll(async () => {
    studentId = (await createLearnerRaw(tenant.orgId, 'Anaya', 'WS-M36-1')).studentId;
    guardianPersonId = await createPersonRaw(tenant.orgId, 'Deepa',
      { familyName: 'Rao' });
  }, 60_000);

  it('links one, with the permissive defaults', async () => {
    // Before this route the only way to link a guardian was to upload a CSV
    // through the import module. Fine for the first Monday, wrong for a child
    // admitted mid-term or a wrong link typed at the counter.
    const res = await POST('/v1/guardian-links', officeToken, {
      studentId, guardianPersonId, relationship: 'mother', isPrimary: true,
    });
    expect(res.status).toBe(201);
    linkId = res.body.data.id;
    // 0012's defaults: a school adding a parent means a parent. The
    // restrictive case is a deliberate act and looks like one.
    expect(res.body.data.can_view_academics).toBe(true);
    expect(res.body.data.can_pay).toBe(true);
    expect(res.body.data.is_primary).toBe(true);
  });

  it('links a second with narrower capabilities, named one by one', async () => {
    const otherPerson = await createPersonRaw(tenant.orgId, 'Vikram',
      { familyName: 'Rao' });
    const res = await POST('/v1/guardian-links', officeToken, {
      studentId, guardianPersonId: otherPerson, relationship: 'father',
      capabilities: { canViewFinance: false, canPay: false },
      legalCustodyNote: 'Access to academic records only, per the order of 12 May.',
    });
    expect(res.status).toBe(201);
    expect(res.body.data.can_view_finance).toBe(false);
    expect(res.body.data.can_pay).toBe(false);
    // Unnamed flags keep their defaults rather than being cleared along with
    // the two that were named.
    expect(res.body.data.can_view_academics).toBe(true);

    const both = await GET(`/v1/students/${studentId}/guardians`, officeToken);
    expect(both.body.data).toHaveLength(2);
  });

  it('will not end a link without a reason', async () => {
    const res = await POST(`/v1/guardian-links/${linkId}/end`, officeToken, {});
    expect(res.status).toBe(422);
  });

  it('ends it, keeping the row', async () => {
    const res = await POST(`/v1/guardian-links/${linkId}/end`, officeToken,
      { reason: 'Custody order of 3 June.' });
    expect(res.status).toBe(201);

    // "Who could collect this child last March" is a question asked after
    // something has gone wrong, and a deleted row answers it with silence.
    const row = await owner((c) => c.query<{ effective_to: string | null }>(
      'SELECT effective_to::text FROM guardian_link WHERE id = $1', [linkId]));
    expect(row.rows[0]!.effective_to).not.toBeNull();

    const live = await GET(`/v1/students/${studentId}/guardians`, officeToken);
    expect(live.body.data.map((g: any) => g.id)).not.toContain(linkId);
  });

  it('refuses both to a guardian', async () => {
    const res = await POST('/v1/guardian-links', guardianToken, {
      studentId, guardianPersonId, relationship: 'mother',
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('cannot_link_guardian');
  });
});

// ---------------------------------------------------------------------------

/**
 * M37 — the first bytes.
 *
 * `file` has existed since 0017: a bucket, an object key, a digest, a scan
 * state, a legal hold. `application_document` references it. M36's admissions
 * test had to insert a row by hand to have anything to attach, and the
 * `files.pending_erasure` job had been running nightly since M33 reporting a
 * number that could not go down, with the reason in its own run record —
 * *"counted only: this product has no object-storage client"*.
 *
 * A school could not upload a birth certificate.
 *
 * This block runs the whole lifecycle over HTTP against a real S3 server and a
 * real clamd conversation: ask, PUT, confirm, download, delete, erase.
 */
describe('a school can upload a document and get it back', () => {
  const pdf = `%PDF-1.4 a birth certificate ${randomUUID()}`;
  const sha = createHash('sha256').update(pdf).digest('hex');
  let fileId = '';

  it('says what this deployment can do before anybody picks a file', async () => {
    const res = await GET('/v1/files/capabilities', officeToken);
    expect(res.status).toBe(200);
    expect(res.body.data.storage).toBe(true);
    expect(res.body.data.scanner).toBe(true);
    expect(res.body.data.maxBytes).toBeGreaterThan(0);
  });

  it('refuses a mime type this product will not hold', async () => {
    // The store serves whatever it is given, so the allowlist is the decision
    // about what this product is willing to be a host for.
    const res = await POST('/v1/files', officeToken, {
      filename: 'payload.svg', mimeType: 'image/svg+xml',
      sizeBytes: 10, sha256: sha,
    });
    expect(res.status).toBe(422);
  });

  it('refuses a digest that is not one', async () => {
    // The object key is derived from this. A malformed digest reaching the
    // helper is a 500 from a throw rather than a sentence naming the field.
    const res = await POST('/v1/files', officeToken, {
      filename: 'x.pdf', mimeType: 'application/pdf',
      sizeBytes: 10, sha256: 'not-a-digest',
    });
    expect(res.status).toBe(422);
  });

  it('hands back a URL to PUT the bytes to', async () => {
    const res = await POST('/v1/files', officeToken, {
      filename: 'birth certificate.pdf', mimeType: 'application/pdf',
      sizeBytes: Buffer.byteLength(pdf), sha256: sha,
      classification: 'SENSITIVE',
    });
    expect(res.status).toBe(201);
    fileId = res.body.data.file.id;
    // Nothing has been scanned, so nothing is servable yet.
    expect(res.body.data.file.virus_scan_state).toBe('pending');
    expect(res.body.data.upload.url).toContain('X-Amz-Signature');
    expect(res.body.data.upload.headers['content-type']).toBe('application/pdf');
  });

  it('will not serve it before it has been checked', async () => {
    // 0017's rule, and the reason the column defaults to 'pending': a file
    // that skipped the scanner must not be downloadable because somebody
    // forgot to set a flag.
    const res = await POST(`/v1/files/${fileId}/download-url`, officeToken);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('not_cleared');
  });

  it('will not confirm an upload that has not arrived', async () => {
    const res = await POST(`/v1/files/${fileId}/confirm`, officeToken);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('nothing_uploaded');
  });

  it('takes the bytes and clears them', async () => {
    const asked = await POST('/v1/files', officeToken, {
      filename: 'birth certificate.pdf', mimeType: 'application/pdf',
      sizeBytes: Buffer.byteLength(pdf), sha256: sha,
    });
    // Asking again for a digest this tenant already holds returns the row and
    // no URL. Re-uploading the same transfer certificate for a sibling is the
    // ordinary case, not an error.
    expect(asked.body.data.upload).toBeUndefined();
    expect(asked.body.data.file.id).toBe(fileId);

    const { url, headers } = await uploadFor(fileId);
    const put = await fetch(url, { method: 'PUT', body: pdf, headers });
    expect(put.status).toBe(200);

    const confirmed = await POST(`/v1/files/${fileId}/confirm`, officeToken);
    expect(confirmed.status).toBe(201);
    expect(confirmed.body.data.virus_scan_state).toBe('clean');
  });

  it('serves it under the name somebody typed, as an attachment', async () => {
    const res = await POST(`/v1/files/${fileId}/download-url`, officeToken);
    expect(res.status).toBe(201);
    expect(res.body.data.filename).toBe('birth certificate.pdf');

    const fetched = await fetch(res.body.data.url);
    expect(fetched.status).toBe(200);
    expect(await fetched.text()).toBe(pdf);
    expect(fetched.headers.get('content-disposition')).toMatch(/^attachment;/);
  });

  it('records the download, not just the upload', async () => {
    // A signed URL IS the capability. Issuing it is the act, and it is audited
    // whether or not the browser follows it.
    const audited = await owner((c) => c.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_log
        WHERE tenant_id = $1 AND action = 'file.downloaded' AND resource_id = $2`,
      [tenant.orgId, fileId]));
    expect(Number(audited.rows[0]!.n)).toBeGreaterThan(0);
  });

  it('will not confirm the same upload twice', async () => {
    const res = await POST(`/v1/files/${fileId}/confirm`, officeToken);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('already_confirmed');
  });

  it('refuses bytes that are not what was promised', async () => {
    const claimed = `%PDF a different file ${randomUUID()}`;
    const asked = await POST('/v1/files', officeToken, {
      filename: 'swapped.pdf', mimeType: 'application/pdf',
      sizeBytes: Buffer.byteLength(claimed),
      sha256: createHash('sha256').update(claimed).digest('hex'),
    });
    const id = asked.body.data.file.id;

    // Same length, different content — so the size check passes and only the
    // digest catches it. That is the case worth having a test for.
    const swapped = claimed.replace(/.$/, claimed.endsWith('x') ? 'y' : 'x');
    const { url, headers } = await uploadFor(id);
    expect((await fetch(url, { method: 'PUT', body: swapped, headers })).status).toBe(200);

    const res = await POST(`/v1/files/${id}/confirm`, officeToken);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('digest_mismatch');

    // ...and the object is gone, rather than left occupying a key.
    const gone = await POST(`/v1/files/${id}/download-url`, officeToken);
    expect(gone.status).toBe(409);
  });

  it('refuses an infected file and keeps the evidence', async () => {
    const asked = await POST('/v1/files', officeToken, {
      filename: 'invoice.pdf', mimeType: 'application/pdf',
      sizeBytes: Buffer.byteLength(EICAR),
      sha256: createHash('sha256').update(EICAR).digest('hex'),
    });
    const id = asked.body.data.file.id;
    const { url, headers } = await uploadFor(id);
    await fetch(url, { method: 'PUT', body: EICAR, headers });

    const res = await POST(`/v1/files/${id}/confirm`, officeToken);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('file_infected');

    const row = await owner((c) => c.query<{ virus_scan_state: string }>(
      'SELECT virus_scan_state FROM file WHERE id = $1', [id]));
    expect(row.rows[0]!.virus_scan_state).toBe('infected');

    // The bytes stay. "What exactly did somebody try to upload" is a question
    // an incident asks, and an immediate delete answers it with nothing.
    const audited = await owner((c) => c.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_log
        WHERE tenant_id = $1 AND action = 'file.infected'`, [tenant.orgId]));
    expect(Number(audited.rows[0]!.n)).toBeGreaterThan(0);

    expect((await POST(`/v1/files/${id}/download-url`, officeToken)).status).toBe(409);
  });

  it('refuses the whole thing to a guardian', async () => {
    const res = await POST('/v1/files', guardianToken, {
      filename: 'x.pdf', mimeType: 'application/pdf', sizeBytes: 10,
      sha256: createHash('sha256').update('x').digest('hex'),
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('staff_only');
  });

  it('will not delete a file under legal hold', async () => {
    await owner((c) => c.query(
      'UPDATE file SET legal_hold = true WHERE id = $1', [fileId]));
    const res = await POST(`/v1/files/${fileId}/delete`, officeToken,
      { reason: 'No longer needed.' });
    // Litigation outranks a retention schedule, and a school told "not found"
    // during discovery has a problem.
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('under_legal_hold');
    await owner((c) => c.query(
      'UPDATE file SET legal_hold = false WHERE id = $1', [fileId]));
  });

  it('marks it deleted, with a reason, and keeps the bytes until the sweep',
    async () => {
      const bare = await POST(`/v1/files/${fileId}/delete`, officeToken, {});
      expect(bare.status).toBe(422);

      const res = await POST(`/v1/files/${fileId}/delete`, officeToken,
        { reason: 'Superseded by a clearer scan.' });
      expect(res.status).toBe(201);

      // Marked, not erased. Marking is transactional; erasing is a job that
      // can be interrupted and repeated.
      const row = await owner((c) => c.query<{
        deleted_at: string | null; erased_at: string | null;
      }>('SELECT deleted_at::text, erased_at::text FROM file WHERE id = $1', [fileId]));
      expect(row.rows[0]!.deleted_at).not.toBeNull();
      expect(row.rows[0]!.erased_at).toBeNull();

      expect((await GET(`/v1/files/${fileId}`, officeToken)).status).toBe(404);
    });

  it('the sweep takes the bytes, and can be run twice', async () => {
    // The job that counted this liability every night since M33 and could not
    // touch it.
    const first = await sweepFiles(tenant.orgId);
    expect(first.erased).toBeGreaterThan(0);
    expect(first.failed).toBe(0);

    const row = await owner((c) => c.query<{ erased_at: string | null }>(
      'SELECT erased_at::text FROM file WHERE id = $1', [fileId]));
    expect(row.rows[0]!.erased_at).not.toBeNull();

    // A run that died halfway must be safe to repeat, and a store that had
    // already expired an object through its own lifecycle rule must not stop
    // a row being marked erased.
    const second = await sweepFiles(tenant.orgId);
    expect(second.erased).toBe(0);
    expect(second.failed).toBe(0);
  });

  it('never sweeps a file under legal hold', async () => {
    const held = `%PDF held ${randomUUID()}`;
    const asked = await POST('/v1/files', officeToken, {
      filename: 'held.pdf', mimeType: 'application/pdf',
      sizeBytes: Buffer.byteLength(held),
      sha256: createHash('sha256').update(held).digest('hex'),
    });
    const id = asked.body.data.file.id;
    const { url, headers } = await uploadFor(id);
    await fetch(url, { method: 'PUT', body: held, headers });
    await POST(`/v1/files/${id}/confirm`, officeToken);

    // Deleted first, THEN held — the order a real hold arrives in.
    await POST(`/v1/files/${id}/delete`, officeToken, { reason: 'Routine.' });
    await owner((c) => c.query('UPDATE file SET legal_hold = true WHERE id = $1', [id]));

    await sweepFiles(tenant.orgId);
    const row = await owner((c) => c.query<{ erased_at: string | null }>(
      'SELECT erased_at::text FROM file WHERE id = $1', [id]));
    // Skipped by the query, not by a branch. A predicate is harder to forget
    // than an `if`.
    expect(row.rows[0]!.erased_at).toBeNull();
    await owner((c) => c.query('UPDATE file SET legal_hold = false WHERE id = $1', [id]));
  });
});
