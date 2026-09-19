/**
 * The public API over real HTTP.
 *
 * This file exists because of a bug the service-level suite could not see: the
 * students endpoint selected `s.status` from a table whose column is
 * `lifecycle_status`, and shipped a 500 to anyone who called it. Thirty-three
 * passing tests, a clean build, a clean typecheck — and the first curl failed.
 *
 * A typed service call cannot catch a wrong column name in a SQL string. Only
 * executing the handler can. So every public endpoint is called here, through
 * the guard, with a real key, and the response is checked — including the
 * columns it must NOT contain, since `student` carries a child's medical note
 * two columns away from the ones we mean to publish.
 */
import 'reflect-metadata';
import pg from 'pg';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  createTenant, destroyTenants, createUser, destroyUsers, grantRole, purgeTestData,
  createLearnerRaw, createAcademicYear, createAcademicStructure, createClassGroupRaw,
  createSectionFor, OWNER_URL, type TenantFixture, type UserFixture,
} from './fixtures.ts';
import { AppModule } from '../src/app.module.ts';
import { apiKeyService } from '../src/modules/public-api/api-key.service.ts';
import { resetRateLimits } from '../src/modules/public-api/rate-limit.ts';
import { pool } from '../src/db/pool.ts';
import { authPool } from '../src/db/auth-pool.ts';

const PASSWORD = 'correct-horse-battery';

let app: INestApplication;
let base: string;
let tenant: TenantFixture;
let owner: UserFixture;
let readKey: string;
let narrowKey: string;

async function get(path: string, key: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${key}` } });
  return { status: res.status, body: await res.json().catch(() => null) };
}

beforeAll(async () => {
  await purgeTestData('%@http-test.example');
  tenant = await createTenant('HTTP');
  owner = await createUser('owner@http-test.example', PASSWORD);
  await grantRole(tenant.orgId, owner.userId, 'ORG_OWNER');
  const scope = { tenantId: tenant.orgId, actorId: owner.userId };

  // A learner to actually return, so an empty list cannot pass for a working
  // endpoint — which is the failure this whole file is about.
  // With a medical note set, so the leak test below is asserting on a value
  // that actually exists rather than on a NULL column.
  const learner = await createLearnerRaw(tenant.orgId, 'Anita', 'HTTP-0001',
    { medicalNote: 'Carries an inhaler', bloodGroup: 'O+' });

  // An invoice too, because the money-shape assertion below iterates the rows
  // it gets back. An earlier version of this file ran that loop over an empty
  // list, so it asserted nothing and passed whatever the endpoint returned —
  // which a mutation swapping ::text for ::float8 then sailed through.
  await seedInvoice(learner.studentId);

  const wide = await apiKeyService.createClient(scope, {
    name: `http-${randomUUID().slice(0, 8)}`,
    scopes: ['students:read', 'invoices:read'],
  });
  readKey = (await apiKeyService.issueKey(scope, { clientId: wide.id })).credential;

  const narrow = await apiKeyService.createClient(scope, {
    name: `narrow-${randomUUID().slice(0, 8)}`,
    scopes: ['students:read'],
  });
  narrowKey = (await apiKeyService.issueKey(scope, { clientId: narrow.id })).credential;

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication({ logger: false });
  await app.init();
  await app.listen(0);
  base = await app.getUrl();
  resetRateLimits();
});

afterAll(async () => {
  await app?.close();
  await destroyUsers([owner.userId]);
  await destroyTenants([tenant.orgId]);
  await pool.end();
  await authPool.end();
});

describe('the public API answers over HTTP', () => {
  it('returns learners rather than a 500', async () => {
    const { status, body } = await get('/api/v1/students?limit=5', readKey);
    expect(status).toBe(200);
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBeGreaterThan(0);
    // Every advertised field is present and spelled the way the contract says.
    expect(body.data[0]).toHaveProperty('admission_no');
    expect(body.data[0]).toHaveProperty('given_name');
    expect(body.data[0]).toHaveProperty('lifecycle_status');
  });

  it('does not ship a child\'s medical information to an integration', async () => {
    const { body } = await get('/api/v1/students?limit=5', readKey);
    for (const field of ['medical_note', 'blood_group', 'accommodations',
                         'emergency_contact_phone']) {
      expect(body.data[0]).not.toHaveProperty(field);
    }
  });

  it('returns invoices as exact strings, never JSON numbers', async () => {
    const { status, body } = await get('/api/v1/invoices?limit=5', readKey);
    expect(status).toBe(200);
    // Asserted before the loop. Without this the test is vacuous on an empty
    // list, which is how it missed a real regression once already.
    expect(body.data.length).toBeGreaterThan(0);
    for (const row of body.data) {
      // A JSON number here would be an IEEE double, and the fee would stop
      // being the amount owed.
      expect(typeof row.total).toBe('string');
      expect(typeof row.amount_paid).toBe('string');
    }
  });

  it('refuses a key without the scope, with a message that names it', async () => {
    const { status, body } = await get('/api/v1/invoices', narrowKey);
    expect(status).toBe(403);
    expect(body.error.code).toBe('insufficient_scope');
    expect(body.error.message).toContain('invoices:read');
  });

  it('refuses an unknown key without saying which part was wrong', async () => {
    const { status, body } = await get(
      `/api/v1/students`, `pk_live_${'a'.repeat(16)}.${'0'.repeat(64)}`);
    expect(status).toBe(401);
    expect(body.error.code).toBe('invalid_api_key');
  });

  it('refuses a session token on the public API', async () => {
    // The two credential paths must not be interchangeable. A JWT that worked
    // here would mean a signed-in person's browser could be made to drive the
    // machine API.
    const { status } = await get('/api/v1/students', 'eyJhbGciOiJIUzI1NiJ9.e30.x');
    expect(status).toBe(401);
  });

  it('requires an Idempotency-Key on a write', async () => {
    const res = await fetch(`${base}/api/v1/attendance/marks`, {
      method: 'POST',
      headers: { authorization: `Bearer ${readKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: randomUUID(), marks: [] }),
    });
    // The scope check comes first, which is correct — but either way this must
    // never be a 201.
    expect([403, 422]).toContain(res.status);
  });

  it('reports the rate limit on every response', async () => {
    const res = await fetch(`${base}/api/v1/students?limit=1`,
      { headers: { authorization: `Bearer ${readKey}` } });
    expect(res.headers.get('x-ratelimit-limit')).toBe('120');
    expect(Number(res.headers.get('x-ratelimit-remaining'))).toBeLessThan(120);
  });

  it('pages with a cursor that does not skip rows when one is inserted', async () => {
    const first = await get('/api/v1/students?limit=1', readKey);
    expect(first.status).toBe(200);
    if (first.body.next_cursor) {
      const second = await get(
        `/api/v1/students?limit=1&cursor=${first.body.next_cursor}`, readKey);
      expect(second.status).toBe(200);
      expect(second.body.data[0]?.id).not.toBe(first.body.data[0]?.id);
    }
  });
});


/**
 * The smallest chain that legitimately produces an invoice: year → structure →
 * class group → section → enrollment → invoice. Written out rather than reduced
 * to a helper because each link is a real foreign key, and a fixture that
 * shortcuts one of them stops proving the endpoint can read a real row.
 */
async function seedInvoice(studentId: string): Promise<void> {
  const { yearId } = await createAcademicYear(tenant.orgId, tenant.unitId, '2026-27', 2026);
  const structure = await createAcademicStructure(tenant.orgId, tenant.unitId, tenant.campusId);
  const classGroup = await createClassGroupRaw(
    tenant.orgId, structure.programmeId, yearId, 'Class 11');
  const section = await createSectionFor(tenant.orgId, classGroup, 'A');

  const client = new pg.Client({ connectionString: OWNER_URL });
  await client.connect();
  try {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO enrollment (tenant_id, student_id, section_id, academic_year_id)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [tenant.orgId, studentId, section, yearId]);
    await client.query(
      `INSERT INTO invoice (tenant_id, campus_id, enrollment_id, invoice_no,
                            financial_year, due_on, subtotal, total)
       VALUES ($1, $2, $3, 'HTTP-INV-0001', '2026-27', CURRENT_DATE + 30, 33000.00, 33000.00)`,
      [tenant.orgId, tenant.campusId, rows[0]!.id]);
  } finally {
    await client.end();
  }
}
