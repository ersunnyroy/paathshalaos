import { authPool } from '../../db/auth-pool.ts';
import { passwordService } from './password.service.ts';
import { tokenService, hashRefreshToken } from './token.service.ts';
import { loadEnv } from '../../config/env.ts';
import { logger } from '../../common/logger.ts';
import { ApiError } from '../../common/errors.ts';
import { auditService } from '../audit/audit.service.ts';

const env = loadEnv();

const MAX_FAILED_ATTEMPTS = 8;
const LOCKOUT_MINUTES = 15;

export interface LoginInput {
  email: string;
  password: string;
  tenantId: string;
  device?:
    | { platform: 'ios' | 'android' | 'web'; fingerprint: string; appVersion?: string | undefined }
    | undefined;
  ip?: string | undefined;
  userAgent?: string | undefined;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

interface UserRow {
  id: string;
  password_hash: string | null;
  status: string;
  grants_version: number;
  failed_attempts: number;
  locked_until: Date | null;
}

export const authService = {
  async login(input: LoginInput): Promise<TokenPair> {
    const { rows } = await authPool.query<UserRow>(
      `SELECT id, password_hash, status, grants_version, failed_attempts, locked_until
         FROM user_account
        WHERE login_email = $1 AND deleted_at IS NULL`,
      [input.email],
    );
    const user = rows[0];

    if (user?.locked_until && user.locked_until > new Date()) {
      throw ApiError.make('authentication_error', 'account_locked',
        'Too many failed attempts. Try again later.');
    }

    // Always run the verification, even when the account does not exist, so the
    // response time does not distinguish the two cases.
    const ok = await passwordService.verify(user?.password_hash ?? null, input.password);

    if (!user || !ok) {
      if (user) await this.recordFailure(user.id, user.failed_attempts);
      // One message for both cases: a distinct "no such user" is an account
      // enumeration oracle.
      throw ApiError.make('authentication_error', 'invalid_credentials',
        'Email or password is incorrect.');
    }

    if (user.status !== 'active') {
      throw ApiError.make('authentication_error', 'account_inactive', 'This account is not active.');
    }

    const roles = await this.rolesFor(user.id, input.tenantId);
    if (roles.length === 0) {
      // Authenticated, but holds nothing in this tenant. Deliberately the same
      // shape as a bad password so it reveals no tenant membership.
      throw ApiError.make('authentication_error', 'invalid_credentials',
        'Email or password is incorrect.');
    }

    await authPool.query(
      `UPDATE user_account SET failed_attempts = 0, locked_until = NULL, last_login_at = now()
        WHERE id = $1`,
      [user.id],
    );

    const deviceId = input.device ? await this.upsertDevice(user.id, input.device) : null;
    const pair = await this.issueSession({
      userId: user.id,
      tenantId: input.tenantId,
      deviceId,
      grantsVersion: user.grants_version,
      roles,
      ...(input.ip ? { ip: input.ip } : {}),
      ...(input.userAgent ? { userAgent: input.userAgent } : {}),
    });

    await auditService.record({
      tenantId: input.tenantId,
      actorUserId: user.id,
      action: 'auth.login',
      resourceType: 'user_account',
      resourceId: user.id,
      classification: 'RESTRICTED',
      ...(input.ip ? { ip: input.ip } : {}),
    });

    return pair;
  },

  /**
   * Refresh with reuse detection.
   *
   * Every refresh rotates the token and marks the old one rotated. Presenting a
   * token that was already rotated means it was captured and replayed, or the
   * client is broken — and we cannot tell which from here. So the entire family
   * descended from that login is revoked, which logs the real user out too.
   * That is the correct trade: a forced re-login beats a live stolen session.
   */
  async refresh(refreshToken: string, tenantId: string): Promise<TokenPair> {
    const presentedHash = hashRefreshToken(refreshToken);

    const { rows } = await authPool.query<{
      id: string;
      user_account_id: string;
      device_id: string | null;
      family_id: string;
      rotated_at: Date | null;
      revoked_at: Date | null;
      expires_at: Date;
    }>(
      `SELECT id, user_account_id, device_id, family_id, rotated_at, revoked_at, expires_at
         FROM session WHERE refresh_token_hash = $1`,
      [presentedHash],
    );
    const session = rows[0];

    if (!session) {
      throw ApiError.make('authentication_error', 'invalid_refresh_token', 'Session is not valid.');
    }

    if (session.rotated_at !== null || session.revoked_at !== null) {
      await this.revokeFamily(session.family_id, 'refresh_token_reuse_detected');
      logger.warn(
        { family_id: session.family_id, user_account_id: session.user_account_id },
        'refresh token reuse detected — family revoked',
      );
      await auditService.record({
        tenantId,
        actorUserId: session.user_account_id,
        action: 'auth.refresh_reuse_detected',
        resourceType: 'session',
        resourceId: session.id,
        classification: 'RESTRICTED',
        reason: 'A rotated or revoked refresh token was presented; the token family was revoked.',
      });
      throw ApiError.make('authentication_error', 'refresh_token_reused',
        'This session has been ended for security reasons. Please sign in again.');
    }

    if (session.expires_at <= new Date()) {
      throw ApiError.make('authentication_error', 'refresh_token_expired', 'Session has expired.');
    }

    const user = await authPool.query<{ grants_version: number; status: string }>(
      'SELECT grants_version, status FROM user_account WHERE id = $1',
      [session.user_account_id],
    );
    if (user.rows[0]?.status !== 'active') {
      await this.revokeFamily(session.family_id, 'account_not_active');
      throw ApiError.make('authentication_error', 'account_inactive', 'This account is not active.');
    }

    const roles = await this.rolesFor(session.user_account_id, tenantId);
    if (roles.length === 0) {
      await this.revokeFamily(session.family_id, 'no_grants_in_tenant');
      throw ApiError.make('permission_error', 'no_access_to_tenant', 'No access to this institute.');
    }

    await authPool.query('UPDATE session SET rotated_at = now() WHERE id = $1', [session.id]);

    return this.issueSession({
      userId: session.user_account_id,
      tenantId,
      deviceId: session.device_id,
      grantsVersion: user.rows[0].grants_version,
      roles,
      familyId: session.family_id,
      parentSessionId: session.id,
    });
  },

  async logout(refreshToken: string): Promise<void> {
    await authPool.query(
      `UPDATE session SET revoked_at = now(), revoked_reason = 'logout'
        WHERE refresh_token_hash = $1 AND revoked_at IS NULL`,
      [hashRefreshToken(refreshToken)],
    );
  },

  /** Ends every session for a user — used when an account is disabled. */
  async revokeAllSessions(userId: string, reason: string): Promise<number> {
    const r = await authPool.query(
      `UPDATE session SET revoked_at = now(), revoked_reason = $2
        WHERE user_account_id = $1 AND revoked_at IS NULL`,
      [userId, reason],
    );
    // Clearing push tokens matters: a disabled account should stop receiving
    // notifications immediately, not just stop being able to sign in.
    await authPool.query('UPDATE device SET push_token = NULL WHERE user_account_id = $1', [userId]);
    return r.rowCount ?? 0;
  },

  async currentGrantsVersion(userId: string): Promise<number | undefined> {
    const { rows } = await authPool.query<{ grants_version: number }>(
      'SELECT grants_version FROM user_account WHERE id = $1 AND deleted_at IS NULL',
      [userId],
    );
    return rows[0]?.grants_version;
  },

  async rolesFor(userId: string, tenantId: string): Promise<string[]> {
    const { rows } = await authPool.query<{ role: string }>(
      `SELECT DISTINCT role FROM role_grant
        WHERE user_account_id = $1 AND tenant_id = $2
          AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`,
      [userId, tenantId],
    );
    return rows.map((r) => r.role);
  },

  // --- internals ---

  async issueSession(args: {
    userId: string;
    tenantId: string;
    deviceId: string | null;
    grantsVersion: number;
    roles: string[];
    familyId?: string;
    parentSessionId?: string;
    ip?: string;
    userAgent?: string;
  }): Promise<TokenPair> {
    const { token, hash } = tokenService.newRefreshToken();
    const expiresAt = new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 86_400_000);

    const { rows } = await authPool.query<{ id: string }>(
      `INSERT INTO session (user_account_id, device_id, family_id, refresh_token_hash,
                            parent_session_id, ip, user_agent, expires_at)
       VALUES ($1, $2, COALESCE($3, gen_random_uuid()), $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        args.userId,
        args.deviceId,
        args.familyId ?? null,
        hash,
        args.parentSessionId ?? null,
        args.ip ?? null,
        args.userAgent ?? null,
        expiresAt,
      ],
    );

    const accessToken = await tokenService.signAccessToken({
      sub: args.userId,
      tenant_id: args.tenantId,
      session_id: rows[0]!.id,
      gv: args.grantsVersion,
      roles: args.roles,
    });

    return { accessToken, refreshToken: token, expiresIn: env.ACCESS_TOKEN_TTL_SECONDS };
  },

  async revokeFamily(familyId: string, reason: string): Promise<void> {
    await authPool.query(
      `UPDATE session SET revoked_at = now(), revoked_reason = $2
        WHERE family_id = $1 AND revoked_at IS NULL`,
      [familyId, reason],
    );
  },

  async recordFailure(userId: string, current: number): Promise<void> {
    const next = current + 1;
    // Every parameter is cast explicitly. Postgres infers a parameter's type
    // from its first use, and $2 appearing both as an integer column value and
    // inside a comparison made the inference ambiguous — which failed the whole
    // statement, so a wrong password raised a database error instead of a 401.
    await authPool.query(
      `UPDATE user_account
          SET failed_attempts = $2::int,
              locked_until = CASE WHEN $2::int >= $3::int
                                  THEN now() + make_interval(mins => $4::int)
                                  ELSE locked_until END
        WHERE id = $1::uuid`,
      [userId, next, MAX_FAILED_ATTEMPTS, LOCKOUT_MINUTES],
    );
  },

  async upsertDevice(
    userId: string,
    device: { platform: string; fingerprint: string; appVersion?: string | undefined },
  ): Promise<string> {
    const { rows } = await authPool.query<{ id: string }>(
      `INSERT INTO device (user_account_id, platform, fingerprint, app_version)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_account_id, fingerprint)
       DO UPDATE SET app_version = EXCLUDED.app_version, updated_at = now()
       RETURNING id`,
      [userId, device.platform, device.fingerprint, device.appVersion ?? null],
    );
    return rows[0]!.id;
  },
};
