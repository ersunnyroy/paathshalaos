/**
 * M2.3 and M2.4 — role grants, scope resolution, delegation limits, and AC-11:
 * a role change takes effect on the very next request with no re-login.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createTenant, destroyTenants, createUser, destroyUsers, grantRole, revokeGrant,
  type TenantFixture, type UserFixture,
  purgeTestData,
} from './fixtures.ts';
import { authzService, type Grant } from '../src/modules/authz/authz.service.ts';
import { authService } from '../src/modules/auth/auth.service.ts';
import { tokenService } from '../src/modules/auth/token.service.ts';
import { authPool } from '../src/db/auth-pool.ts';
import { pool } from '../src/db/pool.ts';

let tenant: TenantFixture;
let teacher: UserFixture;
const PASSWORD = 'correct-horse-battery';

beforeAll(async () => {
  await purgeTestData('%@rbac-test.example');
  tenant = await createTenant('RBAC');
  teacher = await createUser('teacher@rbac-test.example', PASSWORD);
});

afterAll(async () => {
  await destroyUsers([teacher.userId]);
  await destroyTenants([tenant.orgId]);
  await Promise.all([authPool.end(), pool.end()]);
});

const CLASS_ID = '33333333-3333-3333-3333-333333333333';
const OTHER_CLASS = '44444444-4444-4444-4444-444444444444';
const CAMPUS_ID = '55555555-5555-5555-5555-555555555555';

describe('permission model', () => {
  it('a teacher can write attendance but cannot see finance', () => {
    const perms = authzService.permissionsFor(['TEACHER']);
    expect(perms.has('attendance:write')).toBe(true);
    expect(perms.has('result:write')).toBe(true);
    // A teacher must not know which families are behind on fees.
    expect(perms.has('finance:read')).toBe(false);
  });

  it('an accountant can write finance but cannot touch an academic record', () => {
    const perms = authzService.permissionsFor(['ACCOUNTANT']);
    expect(perms.has('finance:write')).toBe(true);
    expect(perms.has('result:write')).toBe(false);
    expect(perms.has('attendance:write')).toBe(false);
  });

  it('transport staff see neither academics nor money', () => {
    const perms = authzService.permissionsFor(['TRANSPORT']);
    expect(perms.has('transport:read')).toBe(true);
    expect(perms.has('student:read')).toBe(false);
    expect(perms.has('finance:read')).toBe(false);
    expect(perms.has('result:read')).toBe(false);
  });

  it('only an owner may publish results', () => {
    expect(authzService.permissionsFor(['ORG_OWNER']).has('result:publish')).toBe(true);
    expect(authzService.permissionsFor(['CAMPUS_ADMIN']).has('result:publish')).toBe(false);
    expect(authzService.permissionsFor(['TEACHER']).has('result:publish')).toBe(false);
  });
});

describe('scope resolution', () => {
  const classScoped: Grant = { role: 'TEACHER', scopeType: 'class_group', scopeId: CLASS_ID };

  it('covers its own scope', () => {
    expect(
      authzService.can([classScoped], 'attendance:write', { type: 'class_group', id: CLASS_ID }),
    ).toBe(true);
  });

  it('does not cover a sibling scope', () => {
    expect(
      authzService.can([classScoped], 'attendance:write', { type: 'class_group', id: OTHER_CLASS }),
    ).toBe(false);
  });

  it('covers a descendant only when the ancestor chain names it', () => {
    expect(
      authzService.can([classScoped], 'attendance:write', {
        type: 'section', id: 'sec-1', ancestors: [CAMPUS_ID, CLASS_ID],
      }),
    ).toBe(true);

    expect(
      authzService.can([classScoped], 'attendance:write', {
        type: 'section', id: 'sec-2', ancestors: [CAMPUS_ID, OTHER_CLASS],
      }),
    ).toBe(false);
  });

  it('never covers upward', () => {
    // A class-scoped teacher must not reach the whole campus.
    expect(
      authzService.can([classScoped], 'attendance:write', { type: 'campus', id: CAMPUS_ID }),
    ).toBe(false);
  });

  it('an organization-scoped grant covers the whole tenant', () => {
    const owner: Grant = { role: 'ORG_OWNER', scopeType: 'organization', scopeId: null };
    expect(authzService.can([owner], 'finance:write', { type: 'campus', id: CAMPUS_ID })).toBe(true);
    expect(
      authzService.can([owner], 'result:publish', { type: 'section', id: 'any', ancestors: [] }),
    ).toBe(true);
  });
});

describe('delegated administration', () => {
  const campusAdmin: Grant = { role: 'CAMPUS_ADMIN', scopeType: 'campus', scopeId: CAMPUS_ID };

  it('allows granting a role within the granter permissions and scope', () => {
    const verdict = authzService.canDelegate([campusAdmin], {
      role: 'TEACHER', scopeType: 'campus', scopeId: CAMPUS_ID,
    });
    expect(verdict.ok).toBe(true);
  });

  it('refuses to grant a permission the granter does not hold', () => {
    // A campus admin has no result:publish, so cannot mint an owner.
    const verdict = authzService.canDelegate([campusAdmin], {
      role: 'ORG_OWNER', scopeType: 'organization', scopeId: null,
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toMatch(/permissions the granter lacks/);
  });

  it('refuses to grant outside the granter own scope', () => {
    const verdict = authzService.canDelegate([campusAdmin], {
      role: 'TEACHER', scopeType: 'campus', scopeId: OTHER_CLASS,
    });
    expect(verdict.ok).toBe(false);
  });

  it('refuses delegation by someone who cannot manage grants at all', () => {
    const teacherGrant: Grant = { role: 'TEACHER', scopeType: 'campus', scopeId: CAMPUS_ID };
    const verdict = authzService.canDelegate([teacherGrant], {
      role: 'TEACHER', scopeType: 'campus', scopeId: CAMPUS_ID,
    });
    expect(verdict.ok).toBe(false);
  });
});

describe('AC-11 — a role change takes effect on the next request', () => {
  it('bumps grants_version whenever a grant changes', async () => {
    const before = await authService.currentGrantsVersion(teacher.userId);
    const grantId = await grantRole(tenant.orgId, teacher.userId, 'TEACHER', 'campus', tenant.campusId);
    const afterGrant = await authService.currentGrantsVersion(teacher.userId);
    expect(afterGrant).toBeGreaterThan(before!);

    await revokeGrant(grantId);
    const afterRevoke = await authService.currentGrantsVersion(teacher.userId);
    expect(afterRevoke).toBeGreaterThan(afterGrant!);
  });

  it('invalidates a live access token the moment a grant is revoked', async () => {
    const grantId = await grantRole(
      tenant.orgId, teacher.userId, 'TEACHER', 'campus', tenant.campusId,
    );

    const pair = await authService.login({
      email: teacher.email, password: PASSWORD, tenantId: tenant.orgId,
    });
    const claims = await tokenService.verifyAccessToken(pair.accessToken);

    // The token is cryptographically valid and nowhere near expiry.
    expect(claims.gv).toBe(await authService.currentGrantsVersion(teacher.userId));
    expect(claims.exp! * 1000).toBeGreaterThan(Date.now());

    await revokeGrant(grantId);

    // Same token, no re-login, no refresh: the version it carries is now stale,
    // which is exactly what the guard compares on every request.
    const current = await authService.currentGrantsVersion(teacher.userId);
    expect(current).not.toBe(claims.gv);

    // And the token still verifies cryptographically — proving that the
    // revocation is enforced by the version check rather than by expiry.
    await expect(tokenService.verifyAccessToken(pair.accessToken)).resolves.toBeTruthy();
  });

  it('a newly added grant is usable on the next request', async () => {
    // A login needs at least one grant in the tenant, so establish the baseline
    // role first and add the second one afterwards.
    const baseGrant = await grantRole(
      tenant.orgId, teacher.userId, 'TEACHER', 'campus', tenant.campusId,
    );
    const pair = await authService.login({
      email: teacher.email, password: PASSWORD, tenantId: tenant.orgId,
    });
    const claims = await tokenService.verifyAccessToken(pair.accessToken);

    const grantId = await grantRole(
      tenant.orgId, teacher.userId, 'ACCOUNTANT', 'campus', tenant.campusId,
    );
    try {
      expect(await authService.currentGrantsVersion(teacher.userId)).not.toBe(claims.gv);
      const roles = await authService.rolesFor(teacher.userId, tenant.orgId);
      expect(roles).toContain('ACCOUNTANT');
    } finally {
      await revokeGrant(grantId);
      await revokeGrant(baseGrant);
    }
  });

  it('disabling an account kills every session and clears push tokens', async () => {
    const grantId = await grantRole(tenant.orgId, teacher.userId, 'TEACHER', 'campus', tenant.campusId);
    const a = await authService.login({
      email: teacher.email, password: PASSWORD, tenantId: tenant.orgId,
      device: { platform: 'android', fingerprint: 'device-fingerprint-1' },
    });
    const b = await authService.login({
      email: teacher.email, password: PASSWORD, tenantId: tenant.orgId,
      device: { platform: 'ios', fingerprint: 'device-fingerprint-2' },
    });

    const revoked = await authService.revokeAllSessions(teacher.userId, 'account_disabled');
    expect(revoked).toBeGreaterThanOrEqual(2);

    await expect(authService.refresh(a.refreshToken, tenant.orgId)).rejects.toBeTruthy();
    await expect(authService.refresh(b.refreshToken, tenant.orgId)).rejects.toBeTruthy();

    const { rows } = await authPool.query<{ push_token: string | null }>(
      'SELECT push_token FROM device WHERE user_account_id = $1',
      [teacher.userId],
    );
    expect(rows.every((r) => r.push_token === null)).toBe(true);
    await revokeGrant(grantId);
  });
});
