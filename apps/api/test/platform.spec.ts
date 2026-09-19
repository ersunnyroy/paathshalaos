/**
 * M14 — onboarding a school, without inventing a god mode.
 *
 * Until this milestone there was no way to create a tenant: migration 0003 said
 * "provisioning a tenant is a platform operation and runs as the owner role",
 * which was true and meant adding a customer required a DBA at a SQL prompt.
 * The seed and these fixtures were the only things that had ever done it.
 *
 * The obvious implementation of an admin console is a role that can see
 * everything, and that role would undo every guarantee the rest of this system
 * makes. So the tests that matter here are the negative ones: what the platform
 * role CANNOT do. The provisioning itself is the easy half.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import {
  createUser, destroyUsers, purgeTestData, OWNER_URL, type UserFixture,
} from './fixtures.ts';
import { withPlatform, platformPool, assertPlatformRoleCannotReadTenants }
  from '../src/db/platform-pool.ts';
import { provisioningService } from '../src/modules/platform/provisioning.service.ts';
import { platformAdminService } from '../src/modules/platform/platform-admin.service.ts';
import { authService } from '../src/modules/auth/auth.service.ts';
import { withTenant } from '../src/db/tenant.ts';
import { pool } from '../src/db/pool.ts';
import { authPool } from '../src/db/auth-pool.ts';

const PASSWORD = 'correct-horse-battery';

let staffA: UserFixture;
let staffB: UserFixture;
let outsider: UserFixture;
const madeTenants: string[] = [];
const madeOwners: string[] = [];

async function owned<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: OWNER_URL });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

beforeAll(async () => {
  await purgeTestData('%@plat-test.example');
  staffA = await createUser('platform-a@plat-test.example', PASSWORD);
  staffB = await createUser('platform-b@plat-test.example', PASSWORD);
  outsider = await createUser('outsider@plat-test.example', PASSWORD);

  // The first administrator is made out of band, as it must be — somebody has
  // to exist before anybody can be granted anything.
  await owned((c) => c.query(
    `INSERT INTO platform_admin (user_account_id, capability) VALUES ($1, 'provision')`,
    [staffA.userId]));
});

afterAll(async () => {
  await owned(async (c) => {
    for (const t of ['role_grant', 'academic_unit', 'campus']) {
      await c.query(`DELETE FROM ${t} WHERE tenant_id = ANY($1)`, [madeTenants]);
    }
    await c.query('DELETE FROM tenant_provisioning WHERE tenant_id = ANY($1)', [madeTenants]);
    await c.query(`DELETE FROM tenant_provisioning WHERE owner_email LIKE '%@plat-test.example'`);
    await c.query('DELETE FROM organization WHERE id = ANY($1)', [madeTenants]);
    await c.query('DELETE FROM platform_admin WHERE user_account_id = ANY($1)',
      [[staffA.userId, staffB.userId, outsider.userId]]);
    await c.query('DELETE FROM user_account WHERE id = ANY($1)', [madeOwners]);
  });
  await destroyUsers([staffA.userId, staffB.userId, outsider.userId]);
  await Promise.all([pool.end(), authPool.end(), platformPool.end()]);
});

/* ========================================================================== */
/* What the console cannot do                                                 */
/* ========================================================================== */

describe('the platform role cannot read inside a school', () => {
  it('has no grant on learner, person or money tables', async () => {
    for (const table of ['student', 'person', 'invoice', 'attendance_record',
                         'message_recipient', 'result_line']) {
      await expect(
        withPlatform((db) => db.query(`SELECT * FROM ${table} LIMIT 1`)),
        `${table} should be unreachable`,
      ).rejects.toThrow(/permission denied/);
    }
  });

  it('fails with permission denied rather than an empty result', async () => {
    // The distinction matters. An empty result is something a person reads as
    // "this school has no students"; a refusal is something they read as "I am
    // not allowed to ask". Only one of those gets reported.
    await expect(withPlatform((db) => db.query('SELECT count(*) FROM student')))
      .rejects.toThrow(/permission denied/);
  });

  it('can write a password hash and never read one', async () => {
    await expect(withPlatform((db) =>
      db.query('SELECT password_hash FROM user_account LIMIT 1')))
      .rejects.toThrow(/permission denied/);

    // But the columns provisioning legitimately needs are readable.
    const rows = await withPlatform(async (db) => {
      const { rows } = await db.query('SELECT id, login_email, status FROM user_account LIMIT 1');
      return rows;
    });
    expect(Array.isArray(rows)).toBe(true);
  });

  it('cannot edit an existing login', async () => {
    // Creating the owner's account is provisioning; editing one is not. A role
    // that can change the email on a school owner's login can take that account
    // over — so there is no UPDATE policy and no grant behind one.
    //
    // This was a claim in a comment with nothing testing it until a mutation
    // granted the privilege and the whole suite still passed.
    await expect(withPlatform((db) => db.query(
      `UPDATE user_account SET login_email = 'taken-over@example.com'
        WHERE login_email LIKE '%@plat-test.example'`)))
      .rejects.toThrow(/permission denied|row-level security/);

    await expect(withPlatform((db) => db.query(
      `DELETE FROM user_account WHERE login_email LIKE '%@plat-test.example'`)))
      .rejects.toThrow(/permission denied|row-level security/);
  });

  it('refuses to boot if any of that changes', async () => {
    // The assertion that runs before the first request is served.
    await expect(assertPlatformRoleCannotReadTenants()).resolves.toBeUndefined();

    await owned((c) => c.query('GRANT SELECT ON student TO paathshala_platform'));
    try {
      await expect(assertPlatformRoleCannotReadTenants())
        .rejects.toThrow(/can read "student"/);
    } finally {
      await owned((c) => c.query('REVOKE SELECT ON student FROM paathshala_platform'));
    }
  });
});

/* ========================================================================== */
/* Provisioning                                                               */
/* ========================================================================== */

describe('onboarding a school', () => {
  it('creates a school somebody can actually sign in to', async () => {
    const key = `prov-${randomUUID()}`;
    const email = `owner-${randomUUID().slice(0, 8)}@plat-test.example`;
    const result = await provisioningService.provision(staffA.userId, {
      requestKey: key,
      legalName: 'Sunrise Educational Trust',
      displayName: 'Sunrise Public School',
      ownerEmail: email,
      campusName: 'Sunrise Main Campus',
      campusCode: 'SUNRISE',
      boardOrAffiliation: 'CBSE',
    });
    madeTenants.push(result.tenantId);
    madeOwners.push(result.ownerUserId);

    expect(result.created).toBe(true);
    expect(result.temporaryPassword.length).toBeGreaterThan(15);

    // The whole point: the owner can log in with what was handed over. A school
    // that exists but cannot be signed into needs a DBA to rescue, which is the
    // situation this module exists to end.
    const session = await authService.login({
      email, password: result.temporaryPassword, tenantId: result.tenantId,
    });
    expect(session.accessToken).toBeTruthy();

    // And they arrive as the owner, with a campus and a unit already under them.
    const structure = await withTenant(
      { tenantId: result.tenantId, actorId: result.ownerUserId },
      async (db) => {
        const { rows } = await db.query<{ campuses: number; units: number }>(
          `SELECT (SELECT count(*)::int FROM campus) AS campuses,
                  (SELECT count(*)::int FROM academic_unit) AS units`);
        return rows[0]!;
      });
    expect(structure).toEqual({ campuses: 1, units: 1 });
  });

  it('replays a repeated request key instead of making a second school', async () => {
    const key = `prov-${randomUUID()}`;
    const email = `twice-${randomUUID().slice(0, 8)}@plat-test.example`;
    const input = {
      requestKey: key,
      legalName: 'Repeat Trust', displayName: 'Repeat School',
      ownerEmail: email, campusName: 'Main', campusCode: 'REPEAT',
    };

    const first = await provisioningService.provision(staffA.userId, input);
    madeTenants.push(first.tenantId);
    madeOwners.push(first.ownerUserId);

    // A sales engineer refreshes the page mid-sale. Without this, a second
    // school appears with the same name and no data, and a week later nobody
    // can tell which one the customer has been using.
    const second = await provisioningService.provision(staffA.userId, input);
    expect(second.created).toBe(false);
    expect(second.tenantId).toBe(first.tenantId);
    // The password is not re-issued: it was shown once, and this is not a
    // recovery path.
    expect(second.temporaryPassword).toBe('');

    const all = await provisioningService.listTenants();
    expect(all.filter((t) => t.display_name === 'Repeat School')).toHaveLength(1);
  });

  it('lets exactly one concurrent attempt create the school', async () => {
    const key = `prov-${randomUUID()}`;
    // A name unique to this run, so the count below is about these four
    // attempts and not about rows an earlier run left behind.
    const name = `Race School ${randomUUID().slice(0, 8)}`;
    // DIFFERENT owner emails, same request key.
    //
    // With the same email, `user_account.login_email` being unique is what
    // stops the duplicates — and a mutation dropping the unique constraint on
    // request_key passed, because the email was quietly doing the work. Varying
    // the email leaves request_key as the only thing that can hold, which is
    // what this test is supposed to be about.
    const attempt = (n: number) => provisioningService.provision(staffA.userId, {
      requestKey: key,
      legalName: 'Race Trust', displayName: name,
      ownerEmail: `race-${n}-${randomUUID().slice(0, 8)}@plat-test.example`,
      campusName: 'Main', campusCode: 'RACE',
    });

    // Four, not two: with two, scheduling alone can serialise them.
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, (_, n) => attempt(n)));
    const created = results.filter(
      (r) => r.status === 'fulfilled' && r.value.created);
    expect(created).toHaveLength(1);

    // And the assertion that does not depend on our own bookkeeping being
    // right: exactly one school by that name exists, whatever the calls
    // reported about themselves.
    const schools = await withPlatform(async (db) => {
      const { rows } = await db.query<{ n: string }>(
        'SELECT count(*) AS n FROM organization WHERE display_name = $1', [name]);
      return Number(rows[0]!.n);
    });
    expect(schools).toBe(1);

    for (const r of results) {
      if (r.status === 'fulfilled') {
        if (!madeTenants.includes(r.value.tenantId)) madeTenants.push(r.value.tenantId);
        if (r.value.ownerUserId && !madeOwners.includes(r.value.ownerUserId)) {
          madeOwners.push(r.value.ownerUserId);
        }
      }
    }
  });

  it('will not record two provisionings under one request key', async () => {
    // Deterministic, unlike the concurrency test above.
    //
    // That test catches a dropped uniqueness constraint only when the four
    // attempts genuinely overlap — with an unlucky schedule they serialise and
    // the replay path covers for it, so under mutation it caught the bug
    // sometimes. A guard that fails intermittently is worse than none: it
    // teaches people to re-run rather than to look.
    //
    // This asserts the constraint itself, which cannot be timing-dependent.
    const key = `prov-dup-${randomUUID()}`;
    await withPlatform((db) => db.query(
      `INSERT INTO tenant_provisioning
         (request_key, legal_name, display_name, owner_email, status,
          failure_reason, provisioned_by)
       VALUES ($1, 'Dup Trust', 'Dup School', 'dup@plat-test.example',
               'failed', 'test fixture', $2)`,
      [key, staffA.userId]));

    await expect(withPlatform((db) => db.query(
      `INSERT INTO tenant_provisioning
         (request_key, legal_name, display_name, owner_email, status,
          failure_reason, provisioned_by)
       VALUES ($1, 'Dup Trust', 'Dup School Again', 'dup2@plat-test.example',
               'failed', 'test fixture', $2)`,
      [key, staffA.userId]))).rejects.toThrow(/duplicate key|unique/i);
  });

  it('shows the customer list without any of their contents', async () => {
    const list = await provisioningService.listTenants();
    expect(list.length).toBeGreaterThan(0);
    for (const row of list) {
      expect(row).toHaveProperty('campuses');
      // Learner and invoice counts are deliberately absent. They would be more
      // useful, and fetching them means granting this role a read on those
      // tables "just for a count" — which is how a console becomes a way to
      // read a school.
      expect(row).not.toHaveProperty('learners');
      expect(row).not.toHaveProperty('invoices');
    }
  });

  it('suspends a school without deleting anything', async () => {
    const tenantId = madeTenants[0]!;
    await provisioningService.setStatus(staffA.userId, tenantId, 'suspended');
    const after = (await provisioningService.listTenants())
      .find((t) => t.id === tenantId);
    expect(after?.status).toBe('suspended');
    await provisioningService.setStatus(staffA.userId, tenantId, 'active');
  });
});

/* ========================================================================== */
/* Who is platform staff                                                      */
/* ========================================================================== */

describe('platform capabilities', () => {
  it('recognises a live capability and not a revoked one', async () => {
    expect(await platformAdminService.has(staffA.userId, 'provision')).toBe(true);
    expect(await platformAdminService.has(outsider.userId, 'provision')).toBe(false);
  });

  it('separates provisioning from support', async () => {
    // Onboarding schools must not confer the ability to ask for access to one's
    // records. They are different jobs and the second one is the sensitive one.
    expect(await platformAdminService.has(staffA.userId, 'support')).toBe(false);
  });

  it('refuses a grant to yourself', async () => {
    await expect(platformAdminService.grant(staffA.userId, staffA.userId, 'support'))
      .rejects.toMatchObject({ response: { error: { code: 'cannot_grant_to_self' } } });
  });

  it('grants, then revokes, and the revocation takes effect immediately', async () => {
    await platformAdminService.grant(staffA.userId, staffB.userId, 'provision');
    expect(await platformAdminService.has(staffB.userId, 'provision')).toBe(true);

    await platformAdminService.revoke(staffA.userId, staffB.userId, 'provision');
    // On the next call, not when a token happens to expire.
    expect(await platformAdminService.has(staffB.userId, 'provision')).toBe(false);
  });

  it('is not something a tenant role grant can confer', async () => {
    const created = madeTenants[0]!;
    await owned((c) => c.query(
      `INSERT INTO role_grant (tenant_id, user_account_id, role, scope_type)
       VALUES ($1, $2, 'ORG_OWNER', 'organization')`,
      [created, outsider.userId]));

    // An owner of a school is the most powerful role inside it, and that is
    // exactly as far as it goes.
    expect(await platformAdminService.has(outsider.userId, 'provision')).toBe(false);
  });
});
