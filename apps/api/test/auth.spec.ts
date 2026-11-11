/**
 * M2.1 and M2.2 — login, token lifecycle, refresh rotation and reuse detection.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import {
  createTenant, destroyTenants, createUser, destroyUsers, grantRole,
  OWNER_URL, type TenantFixture, type UserFixture,
  purgeTestData,
} from './fixtures.ts';
import { HttpException } from '@nestjs/common';
import { authService } from '../src/modules/auth/auth.service.ts';
import { passwordService } from '../src/modules/auth/password.service.ts';
import { tokenService } from '../src/modules/auth/token.service.ts';
import { authPool, assertAuthRoleIsIsolated } from '../src/db/auth-pool.ts';

let tenant: TenantFixture;
let other: TenantFixture;
let staff: UserFixture;
const PASSWORD = 'correct-horse-battery';

beforeAll(async () => {
  await purgeTestData('%@auth-test.example');
  tenant = await createTenant('AUTH-A');
  other = await createTenant('AUTH-B');
  staff = await createUser('staff@auth-test.example', PASSWORD);
  await grantRole(tenant.orgId, staff.userId, 'CAMPUS_ADMIN', 'campus', tenant.campusId);
});

afterAll(async () => {
  await destroyUsers([staff.userId]);
  await destroyTenants([tenant.orgId, other.orgId]);
  await authPool.end();
});

describe('password hashing', () => {
  it('produces an Argon2id hash, not a fast one', async () => {
    const h = await passwordService.hash(PASSWORD);
    expect(h.startsWith('$argon2id$')).toBe(true);
  });

  it('salts: the same password hashes differently every time', async () => {
    const [a, b] = await Promise.all([passwordService.hash(PASSWORD), passwordService.hash(PASSWORD)]);
    expect(a).not.toBe(b);
    expect(await passwordService.verify(a, PASSWORD)).toBe(true);
    expect(await passwordService.verify(b, PASSWORD)).toBe(true);
  });

  it('rejects a wrong password and a malformed hash without throwing', async () => {
    const h = await passwordService.hash(PASSWORD);
    expect(await passwordService.verify(h, 'wrong')).toBe(false);
    expect(await passwordService.verify('not-a-hash', PASSWORD)).toBe(false);
    expect(await passwordService.verify(null, PASSWORD)).toBe(false);
  });

  it('refuses to hash a password short enough to be guessed', async () => {
    await expect(passwordService.hash('short')).rejects.toThrow(/at least 12/);
  });
});

describe('login', () => {
  it('issues a token pair for valid credentials', async () => {
    const pair = await authService.login({
      email: staff.email, password: PASSWORD, tenantId: tenant.orgId,
    });
    expect(pair.accessToken.split('.')).toHaveLength(3);
    expect(pair.refreshToken.length).toBeGreaterThan(30);

    const claims = await tokenService.verifyAccessToken(pair.accessToken);
    expect(claims.sub).toBe(staff.userId);
    expect(claims.tenant_id).toBe(tenant.orgId);
    expect(claims.roles).toContain('CAMPUS_ADMIN');
  });

  it('rejects a wrong password with a 401, not a database error', async () => {
    const err = await authService
      .login({ email: staff.email, password: 'wrong', tenantId: tenant.orgId })
      .catch((e) => e);

    // Asserting only on `status` let a raw DatabaseError pass here once.
    // Checking the error contract is what actually pins the behaviour.
    expect(err).toBeInstanceOf(HttpException);
    expect(err.getStatus()).toBe(401);
    expect(err.getResponse().error.code).toBe('invalid_credentials');
  });

  it('gives an unknown account the same answer as a wrong password', async () => {
    // Account enumeration: if these differ, an attacker can harvest which
    // email addresses belong to a customer.
    const unknown = await authService
      .login({ email: 'nobody@auth-test.example', password: 'whatever', tenantId: tenant.orgId })
      .catch((e) => e);
    const wrong = await authService
      .login({ email: staff.email, password: 'wrong', tenantId: tenant.orgId })
      .catch((e) => e);

    expect(unknown.getResponse().error.code).toBe(wrong.getResponse().error.code);
    expect(unknown.getResponse().error.message).toBe(wrong.getResponse().error.message);
  });

  it('refuses a tenant the user holds no grant in, without revealing that', async () => {
    const err = await authService
      .login({ email: staff.email, password: PASSWORD, tenantId: other.orgId })
      .catch((e) => e);
    // Same code as a bad password: otherwise this endpoint reports which
    // institutes a person belongs to.
    expect(err.getResponse().error.code).toBe('invalid_credentials');
  });

  it('never returns the password hash anywhere in the response', async () => {
    const pair = await authService.login({
      email: staff.email, password: PASSWORD, tenantId: tenant.orgId,
    });
    expect(JSON.stringify(pair)).not.toContain('argon2');
  });

  it('locks an account after repeated failures', async () => {
    const victim = await createUser('lockout@auth-test.example', PASSWORD);
    await grantRole(tenant.orgId, victim.userId, 'TEACHER', 'campus', tenant.campusId);
    try {
      for (let i = 0; i < 8; i++) {
        await authService
          .login({ email: victim.email, password: 'wrong', tenantId: tenant.orgId })
          .catch(() => undefined);
      }
      // Correct password now, and it should still be refused.
      const err = await authService
        .login({ email: victim.email, password: PASSWORD, tenantId: tenant.orgId })
        .catch((e) => e);
      expect(err.getResponse().error.code).toBe('account_locked');
    } finally {
      await destroyUsers([victim.userId]);
    }
  });
});

describe('refresh rotation and reuse detection', () => {
  it('rotates the refresh token on every use', async () => {
    const first = await authService.login({
      email: staff.email, password: PASSWORD, tenantId: tenant.orgId,
    });
    const second = await authService.refresh(first.refreshToken, tenant.orgId);
    expect(second.refreshToken).not.toBe(first.refreshToken);

    const third = await authService.refresh(second.refreshToken, tenant.orgId);
    expect(third.refreshToken).not.toBe(second.refreshToken);
  });

  it('revokes the whole family when a rotated token is replayed', async () => {
    const first = await authService.login({
      email: staff.email, password: PASSWORD, tenantId: tenant.orgId,
    });
    const second = await authService.refresh(first.refreshToken, tenant.orgId);
    const third = await authService.refresh(second.refreshToken, tenant.orgId);

    // Replay the first token — already rotated, so it was captured or the
    // client is broken. Either way every descendant is now suspect.
    await expect(authService.refresh(first.refreshToken, tenant.orgId)).rejects.toBeInstanceOf(
      HttpException,
    );

    // The currently-valid token is dead too. That logs out the real user, which
    // is the correct trade against a live stolen session.
    const err = await authService.refresh(third.refreshToken, tenant.orgId).catch((e) => e);
    expect(err.getResponse().error.code).toBe('refresh_token_reused');
  });

  it('records the reuse in the audit log', async () => {
    const first = await authService.login({
      email: staff.email, password: PASSWORD, tenantId: tenant.orgId,
    });
    await authService.refresh(first.refreshToken, tenant.orgId);
    await authService.refresh(first.refreshToken, tenant.orgId).catch(() => undefined);

    const client = new pg.Client({ connectionString: OWNER_URL });
    await client.connect();
    try {
      const { rows } = await client.query(
        `SELECT reason FROM audit_log
          WHERE tenant_id = $1 AND action = 'auth.refresh_reuse_detected'`,
        [tenant.orgId],
      );
      expect(rows.length).toBeGreaterThan(0);
      expect(rows[0].reason).toBeTruthy();
    } finally {
      await client.end();
    }
  });

  it('rejects an unknown refresh token', async () => {
    const err = await authService
      .refresh('not-a-real-token-value-here', tenant.orgId)
      .catch((e) => e);
    expect(err.getStatus()).toBe(401);
  });

  it('logout makes the token unusable', async () => {
    const pair = await authService.login({
      email: staff.email, password: PASSWORD, tenantId: tenant.orgId,
    });
    await authService.logout(pair.refreshToken);
    const err = await authService.refresh(pair.refreshToken, tenant.orgId).catch((e) => e);
    expect(err.getStatus()).toBe(401);
  });

  it('stores only a hash of the refresh token, never the token', async () => {
    const pair = await authService.login({
      email: staff.email, password: PASSWORD, tenantId: tenant.orgId,
    });
    const client = new pg.Client({ connectionString: OWNER_URL });
    await client.connect();
    try {
      const { rows } = await client.query(
        'SELECT refresh_token_hash FROM session WHERE refresh_token_hash = $1',
        [pair.refreshToken],
      );
      expect(rows).toHaveLength(0);
    } finally {
      await client.end();
    }
  });
});

describe('privilege separation between database roles', () => {
  it('the auth role cannot read tenant data', async () => {
    await expect(assertAuthRoleIsIsolated()).resolves.toBeUndefined();
    await expect(authPool.query('SELECT * FROM campus')).rejects.toThrow(/permission denied/i);
  });

  it('the app role cannot read a password hash', async () => {
    const { pool } = await import('../src/db/pool.ts');
    // A column-level grant, so even a wildcard select is refused by the planner.
    await expect(pool.query('SELECT password_hash FROM user_account')).rejects.toThrow(
      /permission denied/i,
    );
    await expect(pool.query('SELECT * FROM user_account')).rejects.toThrow(/permission denied/i);
  });

  it('the app role sees a user only while a grant ties them to the current tenant', async () => {
    const { withTenant } = await import('../src/db/tenant.ts');

    const visible = await withTenant({ tenantId: tenant.orgId }, async (db) => {
      const r = await db.query('SELECT id FROM user_account WHERE id = $1', [staff.userId]);
      return r.rows.length;
    });
    expect(visible).toBe(1);

    const fromOtherTenant = await withTenant({ tenantId: other.orgId }, async (db) => {
      const r = await db.query('SELECT id FROM user_account WHERE id = $1', [staff.userId]);
      return r.rows.length;
    });
    expect(fromOtherTenant).toBe(0);
  });
});
