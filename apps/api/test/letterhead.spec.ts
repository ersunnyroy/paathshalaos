/**
 * M47.4 — the school's letterhead: who may read it, who may change it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import {
  createTenant, destroyTenants, createUser, destroyUsers, grantRole, purgeTestData,
  createPersonRaw, OWNER_URL, type TenantFixture, type UserFixture,
} from './fixtures.ts';
import { letterheadService } from '../src/modules/branding/letterhead.service.ts';
import { withTenant } from '../src/db/tenant.ts';
import { withPlatform } from '../src/db/platform-pool.ts';
import { pool } from '../src/db/pool.ts';
import { authPool } from '../src/db/auth-pool.ts';

const PASSWORD = 'correct-horse-battery';
let tenant: TenantFixture, other: TenantFixture;
let ownerUser: UserFixture, campusAdminUser: UserFixture, teacherUser: UserFixture;
let parentUser: UserFixture, otherOwnerUser: UserFixture;

const as = (u: UserFixture, t: TenantFixture = tenant) => ({ tenantId: t.orgId, actorId: u.userId });

beforeAll(async () => {
  await purgeTestData('%@lh-test.example');
  tenant = await createTenant('LH');
  other = await createTenant('LH2');
  ownerUser = await createUser('owner@lh-test.example', PASSWORD);
  campusAdminUser = await createUser('campus@lh-test.example', PASSWORD);
  teacherUser = await createUser('teacher@lh-test.example', PASSWORD);
  parentUser = await createUser('parent@lh-test.example', PASSWORD);
  otherOwnerUser = await createUser('owner@lh2-test.example', PASSWORD);
  await grantRole(tenant.orgId, ownerUser.userId, 'ORG_OWNER', 'organization');
  // An administrator of ONE campus: a settings change that reaches every
  // campus is not theirs to make (0079).
  await grantRole(tenant.orgId, campusAdminUser.userId, 'CAMPUS_ADMIN', 'campus', tenant.campusId);
  await grantRole(tenant.orgId, teacherUser.userId, 'TEACHER', 'campus', tenant.campusId);
  await grantRole(tenant.orgId, parentUser.userId, 'GUARDIAN', 'self', tenant.campusId);
  await grantRole(other.orgId, otherOwnerUser.userId, 'ORG_OWNER', 'organization');
  await createPersonRaw(tenant.orgId, 'Kavita', { userAccountId: parentUser.userId });
});

afterAll(async () => {
  const c = new pg.Client({ connectionString: OWNER_URL });
  await c.connect();
  try {
    await c.query('DELETE FROM school_letterhead WHERE tenant_id = ANY($1)', [[tenant.orgId, other.orgId]]);
  } finally { await c.end(); }
  await destroyUsers([ownerUser, campusAdminUser, teacherUser, parentUser, otherOwnerUser].map((u) => u.userId));
  await destroyTenants([tenant.orgId, other.orgId]);
  await Promise.all([pool.end(), authPool.end()]);
});

describe('the letterhead', () => {
  it('is all blanks for a school that has not set one', async () => {
    const lh = await letterheadService.get(as(ownerUser));
    expect(Object.values(lh).every((v) => v === null)).toBe(true);
    expect(Object.keys(lh)).toContain('affiliation_no');
  });

  it('is saved by the owner, tidied, with blanks stored as nothing', async () => {
    const saved = await letterheadService.save(as(ownerUser), {
      address_line1: '  12   Station Road ', address_line2: '   ', city: 'Munger',
      state: 'Bihar', pincode: '811201', phone: '06344 222333',
      affiliation_body: 'CBSE', affiliation_no: '330123', udise_code: '10240100101',
      signatory_name: 'Anjali Menon', signatory_title: 'Principal',
    });
    expect(saved).toMatchObject({ address_line1: '12 Station Road', address_line2: null,
      city: 'Munger', pincode: '811201', email: null, signatory_title: 'Principal' });
    expect(await letterheadService.get(as(ownerUser))).toEqual(saved);
  });

  it('is replaced whole: a field left out the second time is no longer printed', async () => {
    const saved = await letterheadService.save(as(ownerUser), { city: 'Patna', pincode: '800001' });
    expect(saved.city).toBe('Patna');
    expect(saved.address_line1).toBeNull();
    expect(saved.affiliation_no).toBeNull();
  });

  it('stays one row per school', async () => {
    const n = await withTenant(as(ownerUser), async (db) =>
      (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM school_letterhead')).rows[0]!.n);
    expect(n).toBe(1);
  });

  it('can be read by a teacher and by a parent', async () => {
    expect((await letterheadService.get(as(teacherUser))).city).toBe('Patna');
    expect((await letterheadService.get(as(parentUser))).city).toBe('Patna');
  });

  it('cannot be changed by a teacher, a parent or an administrator of one campus', async () => {
    for (const u of [teacherUser, parentUser, campusAdminUser]) {
      await expect(letterheadService.save(as(u), { city: 'Elsewhere' }), u.email)
        .rejects.toMatchObject({ code: 'not_school_admin' });
    }
    expect((await letterheadService.get(as(ownerUser))).city).toBe('Patna');
  });

  it('the policy refuses the same people even without the service asking first', async () => {
    // The service's own check is a courtesy. This is the guarantee.
    for (const u of [teacherUser, parentUser, campusAdminUser]) {
      const changed = await withTenant(as(u), async (db) =>
        (await db.query(`UPDATE school_letterhead SET city = 'Hacked'`)).rowCount);
      expect(changed, u.email).toBe(0);
    }
    expect((await letterheadService.get(as(ownerUser))).city).toBe('Patna');
  });

  it('is not readable or writable from another school', async () => {
    const theirs = await letterheadService.get(as(otherOwnerUser, other));
    expect(theirs.city).toBeNull();
    await letterheadService.save(as(otherOwnerUser, other), { city: 'Gaya' });
    expect((await letterheadService.get(as(ownerUser))).city).toBe('Patna');
    expect((await letterheadService.get(as(otherOwnerUser, other))).city).toBe('Gaya');
  });

  it('refuses a PIN code or UDISE+ code of the wrong length, in the table itself', async () => {
    await expect(letterheadService.save(as(ownerUser), { pincode: '8000' })).rejects.toThrow();
    await expect(letterheadService.save(as(ownerUser), { pincode: '012345' })).rejects.toThrow();
    await expect(letterheadService.save(as(ownerUser), { udise_code: '123' })).rejects.toThrow();
    expect((await letterheadService.get(as(ownerUser))).pincode).toBe('800001');
  });

  it('is not granted to the platform role at all', async () => {
    await expect(withPlatform((db) => db.query('SELECT 1 FROM school_letterhead LIMIT 1')))
      .rejects.toThrow(/permission denied/);
  });
});
