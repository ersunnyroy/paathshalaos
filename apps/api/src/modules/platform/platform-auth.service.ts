/**
 * Signing in to the console.
 *
 * M14 shipped provisioning endpoints that nobody could reach: the only way to
 * obtain a token was `/v1/auth/login`, which requires a role grant in a school,
 * and a platform administrator has none anywhere. The console was unreachable
 * by construction, which a test suite full of service-level calls cannot see.
 *
 * So this is a second front door, with the same lock. It reuses the credential
 * check, the lockout counter and the timing defence from the tenant path — the
 * only difference is what it checks afterwards (a platform capability rather
 * than a role grant) and what it mints (a token with no tenant in it).
 */
import { authPool } from '../../db/auth-pool.ts';
import { passwordService } from '../auth/password.service.ts';
import { authService } from '../auth/auth.service.ts';
import { tokenService } from '../auth/token.service.ts';
import { auditService } from '../audit/audit.service.ts';
import { ApiError } from '../../common/errors.ts';
import { loadEnv } from '../../config/env.ts';
import { PLATFORM_TENANT } from './platform-admin.service.ts';

const env = loadEnv();

interface Row {
  id: string;
  password_hash: string | null;
  status: string;
  grants_version: number;
  failed_attempts: number;
  locked_until: Date | null;
}

export interface ConsoleSession {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  capabilities: string[];
}

export const platformAuthService = {
  async login(input: { email: string; password: string; ip?: string | undefined }):
  Promise<ConsoleSession> {
    const { rows } = await authPool.query<Row>(
      `SELECT id, password_hash, status, grants_version, failed_attempts, locked_until
         FROM user_account WHERE login_email = $1 AND deleted_at IS NULL`,
      [input.email]);
    const user = rows[0];

    if (user?.locked_until && user.locked_until > new Date()) {
      throw ApiError.make('authentication_error', 'account_locked',
        'Too many failed attempts. Try again later.');
    }

    // Run the verification even with no account, so the response time does not
    // tell an attacker which addresses are platform staff.
    const ok = await passwordService.verify(user?.password_hash ?? null, input.password);
    if (!user || !ok) {
      if (user) await authService.recordFailure(user.id, user.failed_attempts);
      throw ApiError.make('authentication_error', 'invalid_credentials',
        'Email or password is incorrect.');
    }
    if (user.status !== 'active') {
      throw ApiError.make('authentication_error', 'account_inactive',
        'This account is not active.');
    }

    // Through the definer function, not the table: the auth role holds every
    // password hash in the system and no grant on platform_admin, and that
    // separation is worth a function call.
    const { rows: caps } = await authPool.query<{ capability: string }>(
      'SELECT capability FROM platform_capabilities_of($1)', [user.id]);

    if (caps.length === 0) {
      // Same shape as a wrong password. Whether an address is platform staff is
      // not something a login form should confirm — most of the value of this
      // console to an attacker is knowing which four people can open it.
      throw ApiError.make('authentication_error', 'invalid_credentials',
        'Email or password is incorrect.');
    }

    await authPool.query(
      `UPDATE user_account SET failed_attempts = 0, locked_until = NULL, last_login_at = now()
        WHERE id = $1`, [user.id]);

    const { token, hash } = tokenService.newRefreshToken();
    const expiresAt = new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 86_400_000);
    const { rows: session } = await authPool.query<{ id: string }>(
      `INSERT INTO session (user_account_id, refresh_token_hash, ip, expires_at)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [user.id, hash, input.ip ?? null, expiresAt]);

    const accessToken = await tokenService.signAccessToken({
      sub: user.id,
      // No tenant_id, deliberately. The auth guard refuses a token without one,
      // so this cannot be turned round and pointed at a school's data.
      session_id: session[0]!.id,
      gv: user.grants_version,
      roles: caps.map((c) => `platform:${c.capability}`),
    });

    await auditService.record({
      tenantId: PLATFORM_TENANT,
      actorUserId: user.id,
      action: 'platform.login',
      resourceType: 'user_account',
      resourceId: user.id,
      classification: 'RESTRICTED',
      after: { capabilities: caps.map((c) => c.capability) },
      ...(input.ip ? { ip: input.ip } : {}),
    });

    return {
      accessToken,
      refreshToken: token,
      expiresIn: env.ACCESS_TOKEN_TTL_SECONDS,
      capabilities: caps.map((c) => c.capability),
    };
  },
};
