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
  makeTeacher, OWNER_URL, type TenantFixture, type UserFixture,
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
let sectionA = '';
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

  const t = await makeTeacher(tenant.orgId, tenant.campusId, teacherUser.userId,
    { givenName: 'Meera', employeeCode: 'WS-T1', classTeacherOf: [sectionA] });
  teacherStaffId = t.staffId;
  coverStaffId = struct.staffId;

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
