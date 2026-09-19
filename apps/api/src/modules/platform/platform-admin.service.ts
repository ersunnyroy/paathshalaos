/**
 * Who holds platform capabilities.
 *
 * Read through the AUTH pool rather than the platform pool, because the check
 * runs before any platform work is authorised — asking the platform role
 * whether you may use the platform role is circular, and granting the tenant
 * role a peek at `platform_admin` would put the answer inside the blast radius
 * of every tenant query.
 */
import { authPool } from '../../db/auth-pool.ts';
import { withPlatform } from '../../db/platform-pool.ts';
import { auditService } from '../audit/audit.service.ts';
import { ApiError } from '../../common/errors.ts';
import type { PlatformCapability } from './platform.guard.ts';

export const platformAdminService = {
  async has(userId: string, capability: string): Promise<boolean> {
    const { rows } = await authPool.query<{ platform_admin_has: boolean }>(
      'SELECT platform_admin_has($1, $2)', [userId, capability]);
    return rows[0]?.platform_admin_has === true;
  },

  async list(): Promise<Array<{
    user_account_id: string; login_email: string | null;
    capability: string; granted_at: string; revoked_at: string | null;
  }>> {
    return withPlatform(async (db) => {
      const { rows } = await db.query<{
        user_account_id: string; login_email: string | null;
        capability: string; granted_at: string; revoked_at: string | null;
      }>(
        `SELECT pa.user_account_id, ua.login_email, pa.capability,
                pa.granted_at, pa.revoked_at
           FROM platform_admin pa
           LEFT JOIN user_account ua ON ua.id = pa.user_account_id
          ORDER BY pa.granted_at DESC`);
      return rows;
    });
  },

  /**
   * Grants a capability.
   *
   * Two people, like impersonation approval: whoever is already platform staff
   * grants it, and the record says who. A system where the first administrator
   * can silently mint more of themselves has one administrator as far as the
   * audit log is concerned.
   */
  async grant(
    actorUserId: string, userId: string,
    capability: PlatformCapability, note?: string | undefined,
  ): Promise<void> {
    if (actorUserId === userId) {
      throw ApiError.make('permission_error', 'cannot_grant_to_self',
        'Platform capabilities are granted by somebody else. Ask a colleague.');
    }

    await withPlatform(async (db) => {
      await db.query(
        `INSERT INTO platform_admin (user_account_id, capability, granted_by, note)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_account_id, capability)
         DO UPDATE SET revoked_at = NULL, revoked_by = NULL,
                       granted_by = EXCLUDED.granted_by, granted_at = now()`,
        [userId, capability, actorUserId, note ?? null]);
    });

    await auditService.record({
      action: 'platform.capability.granted',
      resourceType: 'platform_admin', resourceId: userId,
      actorUserId, classification: 'RESTRICTED',
      tenantId: PLATFORM_TENANT,
      after: { capability, note },
    });
  },

  async revoke(actorUserId: string, userId: string, capability: string): Promise<void> {
    await withPlatform(async (db) => {
      const { rowCount } = await db.query(
        `UPDATE platform_admin SET revoked_at = now(), revoked_by = $3
          WHERE user_account_id = $1 AND capability = $2 AND revoked_at IS NULL`,
        [userId, capability, actorUserId]);
      if (rowCount === 0) {
        throw ApiError.make('not_found', 'capability_not_held',
          'That capability is not currently held.');
      }
    });

    await auditService.record({
      action: 'platform.capability.revoked',
      resourceType: 'platform_admin', resourceId: userId,
      actorUserId, classification: 'RESTRICTED',
      tenantId: PLATFORM_TENANT,
      before: { capability },
    });
  },
};

/**
 * Audit rows need a tenant, and a platform action has none.
 *
 * A fixed nil uuid rather than a real organization: it groups platform actions
 * in one place and cannot be confused with any school's audit trail. Using a
 * customer's tenant id would file "we granted somebody platform access" inside
 * that customer's record, which is both wrong and visible to them.
 */
export const PLATFORM_TENANT = '00000000-0000-0000-0000-000000000000';
