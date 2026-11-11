/**
 * M15 — entering a school from the platform console.
 *
 * The product claim is blunt: a platform administrator can enter any school, as
 * any of its people, in one click. No approver, no ticket, no wait. The whole
 * defence of that is a set of properties that must hold on every request, not a
 * policy document — so this file asserts them, and several are asserted against
 * live HTTP rather than against a service call, because the read-only promise
 * is enforced by a guard and a guard only exists in a running app.
 *
 * What is being proven:
 *   1. entering requires a capability, and writing requires a second one;
 *   2. the token names the person being stood in for, so the school's own
 *      row-level security decides what is visible — no privileged view exists;
 *   3. a read-only session cannot change anything, by HTTP method, everywhere;
 *   4. the school sees the session and can end it, and ending it lands on the
 *      next request rather than when a token expires;
 *   5. every audit row carries both identities;
 *   6. the 60-minute cap is the database's, not this code's.
 */
import 'reflect-metadata';
import pg from 'pg';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import {
  createTenant, destroyTenants, createUser, destroyUsers, grantRole, revokeGrant,
  makeTeacher, purgeTestData, OWNER_URL,
  type TenantFixture, type UserFixture,
} from './fixtures.ts';
import { AppModule } from '../src/app.module.ts';
import { entryService } from '../src/modules/platform/entry.service.ts';
import { tokenService } from '../src/modules/auth/token.service.ts';
import { pool } from '../src/db/pool.ts';
import { authPool } from '../src/db/auth-pool.ts';
import { platformPool } from '../src/db/platform-pool.ts';

const PASSWORD = 'correct-horse-battery';
const REASON = 'Owner reports the fee report is empty; checking her view.';

let app: INestApplication;
let base: string;
let tenant: TenantFixture;
let otherTenant: TenantFixture;
let admin: UserFixture;      // platform: impersonate only
let writer: UserFixture;     // platform: impersonate + impersonate_write
let nobody: UserFixture;     // platform: no capability at all
let schoolOwner: UserFixture;
let teacher: UserFixture;
let stranger: UserFixture;   // a person in the OTHER school

async function owned<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: OWNER_URL });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

async function req(
  method: string, path: string, token: string, body?: unknown,
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

/** A normal signed-in token for somebody in the school — no impersonation. */
async function tokenFor(user: UserFixture, tenantId: string, roles: string[]): Promise<string> {
  const { rows } = await authPool.query<{ grants_version: number }>(
    'SELECT grants_version FROM user_account WHERE id = $1', [user.userId]);
  return tokenService.signAccessToken({
    sub: user.userId, tenant_id: tenantId, session_id: crypto.randomUUID(),
    gv: rows[0]!.grants_version, roles,
  });
}

beforeAll(async () => {
  await purgeTestData('%@entry-test.example');
  tenant = await createTenant('ENTRY');
  otherTenant = await createTenant('ENTRYB');

  admin = await createUser('admin@entry-test.example', PASSWORD);
  writer = await createUser('writer@entry-test.example', PASSWORD);
  nobody = await createUser('nobody@entry-test.example', PASSWORD);
  schoolOwner = await createUser('head@entry-test.example', PASSWORD);
  teacher = await createUser('teacher@entry-test.example', PASSWORD);
  stranger = await createUser('stranger@entry-test.example', PASSWORD);

  await grantRole(tenant.orgId, schoolOwner.userId, 'ORG_OWNER');
  // Linked to a person, so the owner can raise a support ticket — the audited
  // write this suite uses to check attribution from inside a session.
  await makeTeacher(tenant.orgId, tenant.campusId, schoolOwner.userId,
    { givenName: 'Head' });
  await grantRole(tenant.orgId, teacher.userId, 'TEACHER');
  await grantRole(otherTenant.orgId, stranger.userId, 'ORG_OWNER');

  await owned(async (c) => {
    for (const [user, caps] of [
      [admin.userId, ['impersonate', 'support']],
      [writer.userId, ['impersonate', 'impersonate_write']],
    ] as const) {
      for (const cap of caps) {
        await c.query(
          'INSERT INTO platform_admin (user_account_id, capability) VALUES ($1, $2)',
          [user, cap]);
      }
    }
  });

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication({ logger: false });
  await app.init();
  await app.listen(0);
  base = await app.getUrl();
});

afterAll(async () => {
  await app?.close();
  await owned(async (c) => {
    await c.query('DELETE FROM platform_admin WHERE user_account_id = ANY($1)',
      [[admin.userId, writer.userId, nobody.userId]]);
  });
  await destroyTenants([tenant.orgId, otherTenant.orgId]);
  await destroyUsers([admin.userId, writer.userId, nobody.userId,
                      schoolOwner.userId, teacher.userId, stranger.userId]);
  await Promise.all([pool.end(), authPool.end(), platformPool.end()]);
});

describe('who may enter', () => {
  it('refuses somebody with no platform capability, as a 404', async () => {
    await expect(entryService.enter(nobody.userId, {
      tenantId: tenant.orgId, targetUserId: teacher.userId, reason: REASON,
    })).rejects.toMatchObject({ response: { error: { code: 'not_found' } } });
  });

  it('refuses write to a holder of impersonate alone', async () => {
    await expect(entryService.enter(admin.userId, {
      tenantId: tenant.orgId, targetUserId: teacher.userId, reason: REASON, write: true,
    })).rejects.toMatchObject({ response: { error: { code: 'write_not_permitted' } } });
  });

  it('refuses a reason that is not a sentence', async () => {
    await expect(entryService.enter(admin.userId, {
      tenantId: tenant.orgId, targetUserId: teacher.userId, reason: 'looking',
    })).rejects.toMatchObject({ response: { error: { code: 'reason_too_short' } } });
  });

  it('refuses a target who holds no role in THAT school', async () => {
    // `stranger` is a real, live user — in the other tenant. A uuid that exists
    // is the case a presence check has to catch; a nonsense uuid would pass a
    // weaker implementation too.
    await expect(entryService.enter(admin.userId, {
      tenantId: tenant.orgId, targetUserId: stranger.userId, reason: REASON,
    })).rejects.toMatchObject({ response: { error: { code: 'target_not_in_school' } } });
  });

  it('refuses a role the target does not actually hold', async () => {
    await expect(entryService.enter(admin.userId, {
      tenantId: tenant.orgId, targetUserId: teacher.userId,
      assumedRole: 'ACCOUNTANT', reason: REASON,
    })).rejects.toMatchObject({ response: { error: { code: 'role_not_held' } } });
  });
});

describe('what the entry token is', () => {
  it('names the person stood in for, not the administrator', async () => {
    const session = await entryService.enter(admin.userId, {
      tenantId: tenant.orgId, targetUserId: teacher.userId, reason: REASON,
    });
    const claims = await tokenService.verifyAccessToken(session.accessToken);

    // This is the load-bearing assertion of the whole design. Every policy in
    // the database decides by app.actor_id, which comes from `sub`. If `sub`
    // were the administrator, either they would see nothing or somebody would
    // have written a policy exception for them — and that exception would be
    // the bypass.
    expect(claims.sub).toBe(teacher.userId);
    expect(claims.imp).toBe(session.id);
    expect(claims.tenant_id).toBe(tenant.orgId);
    expect(claims.write).toBe(false);
    expect(claims.roles).toEqual(['TEACHER']);

    await entryService.leave(admin.userId, session.id);
  });

  it('narrows to the assumed role rather than widening', async () => {
    // The owner also holds a teacher grant here; entering "as a teacher" must
    // not carry the owner's authority along with it.
    await grantRole(tenant.orgId, schoolOwner.userId, 'TEACHER');
    const session = await entryService.enter(admin.userId, {
      tenantId: tenant.orgId, targetUserId: schoolOwner.userId,
      assumedRole: 'TEACHER', reason: REASON,
    });
    const claims = await tokenService.verifyAccessToken(session.accessToken);
    expect(claims.roles).toEqual(['TEACHER']);
    expect(claims.roles).not.toContain('ORG_OWNER');
    await entryService.leave(admin.userId, session.id);
  });

  it('opens the school to the platform administrator over real HTTP', async () => {
    const session = await entryService.enter(admin.userId, {
      tenantId: tenant.orgId, targetUserId: schoolOwner.userId, reason: REASON,
    });
    const { status, body } = await req('GET', '/v1/campuses', session.accessToken);
    expect(status).toBe(200);
    expect(body.data.length).toBeGreaterThan(0);
    await entryService.leave(admin.userId, session.id);
  });

  it('cannot be turned round and used on the console', async () => {
    // Otherwise a chain of entries is possible with only its first link
    // recorded — and the target here would have to be platform staff, which is
    // exactly the account somebody would pick.
    const session = await entryService.enter(admin.userId, {
      tenantId: tenant.orgId, targetUserId: schoolOwner.userId, reason: REASON,
    });
    const { status, body } = await req('GET', '/platform/v1/sessions', session.accessToken);
    expect(status).toBe(403);
    expect(body.error?.code ?? body.code).toBe('entry_token_on_console');
    await entryService.leave(admin.userId, session.id);
  });
});

describe('read-only means read-only', () => {
  it('refuses a change through a session opened to look', async () => {
    const session = await entryService.enter(admin.userId, {
      tenantId: tenant.orgId, targetUserId: schoolOwner.userId, reason: REASON,
    });
    const { status, body } = await req('POST', '/v1/campuses', session.accessToken,
      { code: 'ENTRY-SNEAK', name: 'Added while looking' });
    expect(status).toBe(403);
    expect(body.error?.code ?? body.code).toBe('entry_is_read_only');

    // And nothing landed.
    const after = await req('GET', '/v1/campuses', session.accessToken);
    expect(after.body.data.some((c: any) => c.code === 'ENTRY-SNEAK')).toBe(false);
    await entryService.leave(admin.userId, session.id);
  });

  it('allows it through a session opened with write, and records both names',
    async () => {
      const session = await entryService.enter(writer.userId, {
        tenantId: tenant.orgId, targetUserId: schoolOwner.userId,
        write: true, reason: 'Fixing the campus code the owner cannot edit.',
      });
      expect(session.writeEnabled).toBe(true);

      const { status } = await req('POST', '/v1/campuses', session.accessToken,
        { code: 'ENTRY-FIXED', name: 'Created on their behalf' });
      expect(status).toBeLessThan(300);

      await entryService.leave(writer.userId, session.id);
    });

  it('leaves a normal signed-in user completely untouched', async () => {
    // The guard is global. If it read the context wrongly it would refuse every
    // POST in the product, so this is the test that would catch that.
    const token = await tokenFor(schoolOwner, tenant.orgId, ['ORG_OWNER']);
    const { status } = await req('POST', '/v1/campuses', token,
      { code: 'ENTRY-NORMAL', name: 'Made by the school itself' });
    expect(status).toBeLessThan(300);
  });
});

describe('the school can see it and stop it', () => {
  it('shows the session to the school and ends it on the next request', async () => {
    const session = await entryService.enter(admin.userId, {
      tenantId: tenant.orgId, targetUserId: teacher.userId, reason: REASON,
    });

    const ownerToken = await tokenFor(schoolOwner, tenant.orgId, ['ORG_OWNER']);
    const seen = await req('GET', '/v1/platform-access', ownerToken);
    expect(seen.status).toBe(200);
    const row = seen.body.data.find((r: any) => r.id === session.id);
    expect(row).toBeTruthy();
    expect(row.status).toBe('active');
    expect(row.entry_path).toBe('platform');
    expect(row.actor_email).toBe(admin.email);
    expect(row.target_email).toBe(teacher.email);
    expect(row.reason).toBe(REASON);
    expect(seen.body.notice).toMatch(/in your records right now/);

    // The token works right up until the moment they end it.
    expect((await req('GET', '/v1/campuses', session.accessToken)).status).toBe(200);

    const ended = await req('POST', `/v1/platform-access/${session.id}/end`, ownerToken,
      { reason: 'We did not ask for this.' });
    expect(ended.status).toBeLessThan(300);

    // Next request, not next token expiry. The token is still cryptographically
    // valid and within its lifetime; the session behind it is not.
    const after = await req('GET', '/v1/campuses', session.accessToken);
    expect(after.status).toBe(403);
    expect(after.body.error?.code ?? after.body.code).toBe('impersonation_not_active');
  });

  it('does not show the access log to somebody without audit:read', async () => {
    const teacherToken = await tokenFor(teacher, tenant.orgId, ['TEACHER']);
    const { status } = await req('GET', '/v1/platform-access', teacherToken);
    expect(status).toBe(404);
  });

  it('does not show one school the sessions opened against another', async () => {
    const session = await entryService.enter(admin.userId, {
      tenantId: tenant.orgId, targetUserId: teacher.userId, reason: REASON,
    });
    const strangerToken = await tokenFor(stranger, otherTenant.orgId, ['ORG_OWNER']);
    const { body } = await req('GET', '/v1/platform-access', strangerToken);
    expect(body.data.some((r: any) => r.id === session.id)).toBe(false);
    await entryService.leave(admin.userId, session.id);
  });
});

describe('the entry follows the person it borrows', () => {
  it('dies when the borrowed account\'s own access is revoked', async () => {
    // The token carries the TARGET's grants version, not the administrator's.
    // That is what makes this work: a school that revokes a teacher mid-session
    // also closes every window standing in for her, on the next request, with
    // nobody having to think about impersonation at all.
    const victim = await createUser('temp@entry-test.example', PASSWORD);
    const grantId = await grantRole(tenant.orgId, victim.userId, 'TEACHER');
    try {
      const session = await entryService.enter(admin.userId, {
        tenantId: tenant.orgId, targetUserId: victim.userId, reason: REASON,
      });
      expect((await req('GET', '/v1/campuses', session.accessToken)).status).toBe(200);

      await revokeGrant(grantId);

      const after = await req('GET', '/v1/campuses', session.accessToken);
      expect(after.status).toBe(401);
      expect(after.body.error?.code ?? after.body.code).toBe('grants_changed');
    } finally {
      // The access log holds a reference to the account, deliberately — in
      // production accounts are soft-deleted and the log keeps its names. Here
      // the rows have to go first.
      await owned((c) => c.query(
        'DELETE FROM impersonation_session WHERE target_user_id = $1', [victim.userId]));
      await destroyUsers([victim.userId]);
    }
  });
});

describe('the record', () => {
  it('carries both identities on every audit row written inside the session',
    async () => {
      const session = await entryService.enter(writer.userId, {
        tenantId: tenant.orgId, targetUserId: schoolOwner.userId,
        write: true, reason: 'Recording check: creating a campus on their behalf.',
      });
      // Raising a ticket, not creating a campus: this is a handler that audits
      // WITHOUT naming an actor, so the row is attributed entirely from the
      // request context the auth guard built. That is the code under test. An
      // earlier version of this test used a path that passed both identities
      // explicitly, so inverting the context logic changed nothing and the test
      // still passed — a mutation that changes nothing is a finding, not a pass.
      const raised = await req('POST', '/v1/tickets', session.accessToken, {
        subject: 'Checking the fee report on the owner\'s behalf',
        body: 'Raised from inside an entry session so attribution is exercised.',
        category: 'fees_and_payments',
      });
      expect(raised.status).toBeLessThan(300);

      const { rows } = await owned((c) => c.query<{
        action: string; actor_user_id: string; on_behalf_of_user_id: string;
        impersonation_id: string;
      }>(
        `SELECT action, actor_user_id, on_behalf_of_user_id, impersonation_id
           FROM audit_log WHERE impersonation_id = $1 ORDER BY occurred_at`,
        [session.id]));

      // Both the explicit entry row and the one derived from context.
      expect(rows.map((r) => r.action)).toContain('support_ticket.raised');

      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        // The hands are the platform administrator's. The identity is the
        // owner's. A row with only one of them is the failure this exists for.
        expect(row.actor_user_id).toBe(writer.userId);
        expect(row.on_behalf_of_user_id).toBe(schoolOwner.userId);
      }
      expect(rows.map((r) => r.action)).toContain('platform.entered_school');

      await entryService.leave(writer.userId, session.id);
    });

  it('records leaving as well as entering', async () => {
    const session = await entryService.enter(admin.userId, {
      tenantId: tenant.orgId, targetUserId: teacher.userId, reason: REASON,
    });
    await entryService.leave(admin.userId, session.id);
    const { rows } = await owned((c) => c.query<{ action: string }>(
      'SELECT action FROM audit_log WHERE resource_id = $1', [session.id]));
    expect(rows.map((r) => r.action)).toContain('platform.left_school');
  });
});

describe('the window is the database\'s rule, not this code\'s', () => {
  it('refuses a session longer than an hour even when inserted directly', async () => {
    // The service clamps to 60 minutes. That clamp is a convenience; this is
    // the guarantee. A second code path — a script, a future endpoint, a
    // migration — must not be able to grant itself a longer window.
    await expect(owned((c) => c.query(
      `INSERT INTO impersonation_session
         (tenant_id, actor_user_id, target_user_id, reason, entry_path, status,
          started_at, expires_at)
       VALUES ($1, $2, $3, $4, 'platform', 'active', now(), now() + interval '61 minutes')`,
      [tenant.orgId, admin.userId, teacher.userId, REASON])))
      .rejects.toThrow(/may not exceed 60 minutes/);
  });

  it('still demands an approver on the support path', async () => {
    // M15 removed the second person for the platform path only. The original
    // AC-12 support path keeps it, and 0054 rewrote one trigger to serve both —
    // so this asserts the rewrite did not quietly relax the older rule.
    await expect(owned((c) => c.query(
      `INSERT INTO impersonation_session
         (tenant_id, actor_user_id, target_user_id, reason, ticket_ref, entry_path,
          status, started_at, expires_at)
       VALUES ($1, $2, $3, $4, 'TCK-1', 'support', 'active', now(), now() + interval '10 minutes')`,
      [tenant.orgId, admin.userId, teacher.userId, REASON])))
      .rejects.toThrow(/without an approver/);
  });

  it('stops working the moment the window closes', async () => {
    const session = await entryService.enter(admin.userId, {
      tenantId: tenant.orgId, targetUserId: teacher.userId, reason: REASON, minutes: 5,
    });
    expect((await req('GET', '/v1/campuses', session.accessToken)).status).toBe(200);

    // Wind the clock rather than wait five minutes. The expiry is evaluated on
    // every request, so moving the row is enough.
    await owned((c) => c.query(
      `UPDATE impersonation_session SET expires_at = now() - interval '1 second'
        WHERE id = $1`, [session.id]));

    const after = await req('GET', '/v1/campuses', session.accessToken);
    expect(after.status).toBe(403);
    expect(after.body.error?.code ?? after.body.code).toBe('impersonation_expired');
  });
});

describe('what the console can answer without entering (M15.4, M15.5)', () => {
  /** A console token: a normal sign-in, no impersonation claim. */
  async function consoleToken(): Promise<string> {
    return tokenFor(admin, tenant.orgId, []);
  }

  it('finds a school by name and an account by email', async () => {
    const token = await consoleToken();
    const { status, body } = await req('GET', '/platform/v1/search?q=ENTRY', token);
    expect(status).toBe(200);
    expect(body.data.schools.some((s: any) => s.id === tenant.orgId)).toBe(true);

    const byEmail = await req(
      'GET', `/platform/v1/search?q=${encodeURIComponent('teacher@entry-test')}`, token);
    const hit = byEmail.body.data.accounts.find(
      (a: any) => a.user_account_id === teacher.userId);
    expect(hit).toBeTruthy();
    expect(hit.tenant_id).toBe(tenant.orgId);
    expect(hit.roles).toContain('TEACHER');
  });

  it('treats a LIKE metacharacter as a character, not a wildcard', async () => {
    // Searching for "%" must not return every school in the estate. This is the
    // difference between a search box and an export button.
    const token = await consoleToken();
    const { body } = await req('GET', '/platform/v1/search?q=%25%25', token);
    expect(body.data.schools).toHaveLength(0);
    expect(body.data.accounts).toHaveLength(0);
  });

  it('reports the estate without counting anything inside a school', async () => {
    const session = await entryService.enter(admin.userId, {
      tenantId: tenant.orgId, targetUserId: teacher.userId, reason: REASON,
    });
    const token = await consoleToken();
    const { status, body } = await req('GET', '/platform/v1/health', token);
    expect(status).toBe(200);

    const row = body.data.find((r: any) => r.id === tenant.orgId);
    expect(row).toBeTruthy();
    expect(row.accounts).toBeGreaterThan(0);
    expect(row.owners).toBeGreaterThan(0);
    expect(row.live_sessions).toBe(1);
    expect(row.last_entered_at).not.toBeNull();

    // And nothing from inside the school. A future "helpful" join is the thing
    // this assertion is here to stop.
    for (const field of ['learners', 'students', 'invoices', 'revenue', 'attendance']) {
      expect(row).not.toHaveProperty(field);
    }
    await entryService.leave(admin.userId, session.id);
  });

  it('lists who you could enter a school as, filtered by role', async () => {
    const token = await consoleToken();
    const { status, body } = await req(
      'GET', `/platform/v1/tenants/${tenant.orgId}/people?role=TEACHER`, token);
    expect(status).toBe(200);
    expect(body.data.some((p: any) => p.user_account_id === teacher.userId)).toBe(true);
    // The other school's people are not in this school's list.
    expect(body.data.some((p: any) => p.user_account_id === stranger.userId)).toBe(false);
    // Emails and roles only — no names, because names are inside the school.
    for (const person of body.data) {
      expect(person).not.toHaveProperty('given_name');
      expect(person).not.toHaveProperty('family_name');
    }
  });
});

describe('signing in to the console', () => {
  it('lets a platform administrator in, without a school', async () => {
    // The gap this closes: M14 shipped provisioning endpoints reachable only
    // with a token that required a role grant in a school — which platform
    // staff do not have. Every service-level test passed and the console could
    // not be opened by anybody.
    const { status, body } = await req('POST', '/platform/v1/login', 'none', {
      email: admin.email, password: PASSWORD,
    });
    expect(status).toBeLessThan(300);
    expect(body.data.capabilities).toEqual(expect.arrayContaining(['impersonate', 'support']));

    const claims = await tokenService.verifyAccessToken(body.data.accessToken);
    expect(claims.tenant_id).toBeUndefined();

    // And it works on the console.
    const health = await req('GET', '/platform/v1/health', body.data.accessToken);
    expect(health.status).toBe(200);
  });

  it('will not open a school with a console token', async () => {
    // The other half of having no tenant in the token: it must fail closed at
    // the tenant API rather than arriving there with an undefined tenant.
    const { body } = await req('POST', '/platform/v1/login', 'none', {
      email: admin.email, password: PASSWORD,
    });
    const { status, body: refused } =
      await req('GET', '/v1/campuses', body.data.accessToken);
    expect(status).toBe(401);
    expect(refused.error?.code ?? refused.code).toBe('not_a_tenant_token');
  });

  it('says the same thing to a real account with no platform capability', async () => {
    // schoolOwner is a genuine account with a correct password. If the console
    // said something different here, the login form would be a list of who can
    // open it.
    const wrongPassword = await req('POST', '/platform/v1/login', 'none', {
      email: admin.email, password: 'not-the-password',
    });
    const notStaff = await req('POST', '/platform/v1/login', 'none', {
      email: schoolOwner.email, password: PASSWORD,
    });
    expect(notStaff.status).toBe(wrongPassword.status);
    expect(notStaff.body.error.code).toBe(wrongPassword.body.error.code);
  });
});

/**
 * M33.3 — the operator's view of the jobs.
 *
 * Over HTTP, because M32's whole lesson was that a service test cannot prove
 * anybody can call the service — and a scheduler nobody can look at is the
 * same failure as a job nobody runs, one layer up.
 */
describe('the schedule, from the console', () => {
  const consoleToken = () => tokenFor(admin, tenant.orgId, []);

  it('lists every task with the number that matters', async () => {
    const { status, body } = await req('GET', '/platform/v1/schedule', await consoleToken());
    expect(status).toBe(200);

    const seal = body.data.find((t: any) => t.key === 'audit.seal');
    expect(seal).toBeTruthy();
    // `seconds_since_success` is the one to read: a task that FAILS is loud,
    // and a task that has stopped being claimed produces nothing at all except
    // this number growing.
    expect(seal).toHaveProperty('seconds_since_success');
    // A decimal string, not a BigInt. The first version of this endpoint
    // returned `::bigint`, which node-postgres hands back as a JavaScript
    // BigInt and `JSON.stringify` refuses — a 500 from an endpoint whose every
    // query was correct, and invisible to any test below HTTP.
    expect(seal.seconds_since_success === null
      || typeof seal.seconds_since_success === 'string').toBe(true);
    expect(seal).toHaveProperty('overdue');
    expect(seal.implemented).toBe(true);
  });

  it('marks a task the code no longer implements', async () => {
    // A compliance job dropped by a deploy otherwise sits in the table looking
    // perfectly scheduled.
    await owned((c) => c.query(
      `INSERT INTO scheduled_task (key, description, interval_seconds)
       VALUES ('ghost.console', 'Nothing implements this', 3600)
       ON CONFLICT (key) DO NOTHING`));
    try {
      const { body } = await req('GET', '/platform/v1/schedule', await consoleToken());
      const ghost = body.data.find((t: any) => t.key === 'ghost.console');
      expect(ghost.implemented).toBe(false);
    } finally {
      // Taken away at both ends: `scheduler.spec` compares the table against
      // the registry, and a row left here fails a suite in another file.
      await owned((c) => c.query("DELETE FROM task_run WHERE task_key = 'ghost.console'"));
      await owned((c) => c.query("DELETE FROM scheduled_task WHERE key = 'ghost.console'"));
    }
  });

  it('shows the runs of one task across every school', async () => {
    await owned((c) => c.query(
      `INSERT INTO task_run (tenant_id, task_key, finished_at, status, detail)
       VALUES ($1, 'files.pending_erasure', now(), 'ok', '{"pending":0}'::jsonb)`,
      [tenant.orgId]));
    const { status, body } = await req(
      'GET', '/platform/v1/schedule/files.pending_erasure/runs', await consoleToken());
    expect(status).toBe(200);
    expect(body.data[0].tenant_name).toBeTruthy();
  });

  it('refuses "run now" to a console account that can only read', async () => {
    // `admin` holds support and impersonate. Forcing the fleet-wide retention
    // purge is a destructive act on every school at once, and read access to
    // the console must not carry it.
    const { status } = await req(
      'POST', '/platform/v1/schedule/retention.applicant_documents/run-now',
      await consoleToken(), {});
    expect(status).toBe(404);
  });

  it('queues a run rather than running it on the request', async () => {
    // An endpoint that executed a fleet-wide purge inline would put it on an
    // HTTP timeout, and the first thing anybody would do about a slow one is
    // press the button again.
    await owned((c) => c.query(
      `INSERT INTO platform_admin (user_account_id, capability)
       VALUES ($1, 'provision') ON CONFLICT DO NOTHING`, [admin.userId]));
    try {
      const before = await owned(async (c) => (await c.query<{ n: string }>(
        `SELECT next_run_at::text AS n FROM scheduled_task
          WHERE key = 'files.pending_erasure'`)).rows[0]!.n);

      const { status, body } = await req(
        'POST', '/platform/v1/schedule/files.pending_erasure/run-now',
        await consoleToken(), {});
      expect(status).toBe(201);
      expect(body.data.queued).toBe(true);

      const after = await owned(async (c) => (await c.query<{ n: string }>(
        `SELECT next_run_at::text AS n FROM scheduled_task
          WHERE key = 'files.pending_erasure'`)).rows[0]!.n);
      expect(after).not.toBe(before);

      // ...and an unknown task is a 404 rather than a silent success.
      const missing = await req(
        'POST', '/platform/v1/schedule/no.such.task/run-now', await consoleToken(), {});
      expect(missing.status).toBe(404);
    } finally {
      await owned((c) => c.query(
        `DELETE FROM platform_admin WHERE user_account_id = $1 AND capability = 'provision'`,
        [admin.userId]));
    }
  });
});

/**
 * Custom domains (M35.2).
 *
 * `domainService` had four methods and no caller anywhere in `src/`. The
 * school-facing branding controller's own hint told a school to *ask us* to add
 * a domain they own, and there was no endpoint through which anybody here could
 * be asked — a read surface with no write surface, which is the shape M19
 * shipped white-labelling in and nobody noticed for fourteen milestones.
 *
 * On the console rather than in the school's settings, because getting a
 * hostname wrong means serving one school's sign-in page on another school's
 * domain, and the verification step is not something a school can wave through
 * for itself.
 */
describe('a school can be given a domain it actually owns', () => {
  const host = `fees${Date.now()}.nalanda-test.example`;
  let domainId = '';

  /** A console sign-in with no impersonation claim, as the block above uses. */
  const consoleToken = () => tokenFor(admin, tenant.orgId, []);

  async function provisioner(): Promise<string> {
    await owned((c) => c.query(
      `INSERT INTO platform_admin (user_account_id, capability)
       VALUES ($1, 'provision') ON CONFLICT DO NOTHING`, [admin.userId]));
    return consoleToken();
  }

  afterAll(async () => {
    await owned(async (c) => {
      await c.query('DELETE FROM tenant_domain WHERE host = $1', [host]);
      await c.query(
        `DELETE FROM platform_admin WHERE user_account_id = $1 AND capability = 'provision'`,
        [admin.userId]);
    });
  });

  it('refuses a console account that cannot provision', async () => {
    // `admin` holds support and impersonate. Pointing a hostname at a school is
    // not a read.
    const { status } = await req('POST', '/platform/v1/domains', await consoleToken(),
      { tenantId: tenant.orgId, host });
    expect(status).toBe(404);
  });

  it('adds it unverified, and hands back the record to publish', async () => {
    const { status, body } = await req('POST', '/platform/v1/domains',
      await provisioner(), { tenantId: tenant.orgId, host });
    expect(status).toBe(201);
    domainId = body.data.id;
    expect(body.data.verified_at).toBeNull();
    expect(body.data.record).toBe(`_paathshala-verify.${host}`);
    expect(body.data.value).toBeTruthy();
  });

  it('refuses a hostname that is not one', async () => {
    const { status, body } = await req('POST', '/platform/v1/domains',
      await provisioner(), { tenantId: tenant.orgId, host: 'not a hostname' });
    expect(status).toBe(422);
    expect(body.error.code).toBe('not_a_hostname');
  });

  it('will not let a subdomain of ours be claimed through the custom path',
    async () => {
      // Otherwise the reserved-name list is bypassable: claim
      // `admin.paathshala.app` as a "custom" domain and it is allocated.
      const { status, body } = await req('POST', '/platform/v1/domains',
        await provisioner(), { tenantId: tenant.orgId, host: 'anything.paathshala.app' });
      expect(status).toBe(422);
      expect(body.error.code).toBe('not_yours_to_claim');
    });

  it('does not say which school holds a hostname somebody else registered',
    async () => {
      // A 409 that named the tenant would turn this endpoint into a way to ask
      // who our customers are.
      const { status, body } = await req('POST', '/platform/v1/domains',
        await provisioner(), { tenantId: otherTenant.orgId, host });
      expect(status).toBe(409);
      expect(body.error.code).toBe('host_taken');
      expect(JSON.stringify(body)).not.toContain(tenant.orgId);
    });

  it('will not make an unverified domain primary', async () => {
    // The whole protection. An unverified domain is a claim, not a route, and
    // making it primary would route a school's sign-in page to a hostname
    // nobody has proved they control.
    const { status, body } = await req('POST', `/platform/v1/domains/${domainId}/primary`,
      await provisioner(), {});
    expect(status).toBe(409);
    expect(body.error.code).toBe('not_verified');
  });

  it('reports the domain as unverified when the record is not published',
    async () => {
      // A real DNS lookup against a hostname in `.example`, which by RFC 2606
      // resolves to nothing. So this asserts the honest failure rather than
      // mocking the resolver: no record, no verification.
      const { status, body } = await req('POST', `/platform/v1/domains/${domainId}/verify`,
        await provisioner(), {});
      expect(status).toBeGreaterThanOrEqual(400);
      expect(body.error.code).not.toBe('internal_error');

      const row = await owned(async (c) => (await c.query<{ verified_at: string | null }>(
        'SELECT verified_at::text FROM tenant_domain WHERE id = $1', [domainId])).rows[0]!);
      expect(row.verified_at).toBeNull();
    });

  it('lists it in the estate', async () => {
    const { status, body } = await req('GET', '/platform/v1/domains',
      await provisioner());
    expect(status).toBe(200);
    const mine = body.data.find((d: any) => d.id === domainId);
    expect(mine.host).toBe(host);
    expect(mine.kind).toBe('custom');
    expect(mine.is_primary).toBe(false);
  });
});
