import { withTenant, type TenantScope } from '../../db/tenant.ts';
import { authzService, type Grant, type Role, type ScopeType } from './authz.service.ts';
import { auditService } from '../audit/audit.service.ts';
import { ApiError } from '../../common/errors.ts';

export const grantsService = {
  async list(scope: TenantScope, userAccountId: string): Promise<Grant[]> {
    return withTenant(scope, (db) => authzService.grantsFor(db, userAccountId));
  },

  /**
   * Grants a role. The delegation check runs against the granter's *current*
   * grants, read inside the same transaction as the insert — so a granter whose
   * own authority was revoked a moment ago cannot use a stale read to hand out
   * what they no longer hold.
   */
  async grant(
    scope: TenantScope,
    input: { userAccountId: string; role: Role; scopeType: ScopeType; scopeId?: string | null },
  ): Promise<Grant> {
    if (!scope.actorId) throw new Error('grant() requires an actor.');

    const proposed: Grant = {
      role: input.role,
      scopeType: input.scopeType,
      scopeId: input.scopeId ?? null,
    };

    const created = await withTenant(scope, async (db) => {
      const granterGrants = await authzService.grantsFor(db, scope.actorId!);
      const verdict = authzService.canDelegate(granterGrants, proposed);
      if (!verdict.ok) {
        throw ApiError.make('permission_error', 'cannot_delegate', verdict.reason);
      }

      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO role_grant (tenant_id, user_account_id, role, scope_type, scope_id, granted_by)
         VALUES (app_current_tenant_id(), $1, $2, $3, $4, $5)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [input.userAccountId, input.role, input.scopeType, proposed.scopeId, scope.actorId],
      );
      if (!rows[0]) {
        throw ApiError.make('conflict', 'grant_exists', 'That grant already exists.');
      }
      return rows[0];
    });

    await auditService.record({
      tenantId: scope.tenantId,
      actorUserId: scope.actorId,
      action: 'grant.created',
      resourceType: 'role_grant',
      resourceId: created.id,
      classification: 'RESTRICTED',
      after: proposed,
    });

    return proposed;
  },

  /** Revoking bumps grants_version via a database trigger, so it lands next request. */
  async revoke(scope: TenantScope, grantId: string): Promise<void> {
    const revoked = await withTenant(scope, async (db) => {
      const { rows } = await db.query<{ id: string; role: string; user_account_id: string }>(
        `UPDATE role_grant SET revoked_at = now()
          WHERE id = $1 AND revoked_at IS NULL
          RETURNING id, role, user_account_id`,
        [grantId],
      );
      if (!rows[0]) throw ApiError.make('not_found', 'grant_not_found', 'Grant not found.');
      return rows[0];
    });

    await auditService.record({
      tenantId: scope.tenantId,
      actorUserId: scope.actorId,
      action: 'grant.revoked',
      resourceType: 'role_grant',
      resourceId: revoked.id,
      classification: 'RESTRICTED',
      before: { role: revoked.role, userAccountId: revoked.user_account_id },
    });
  },
};
