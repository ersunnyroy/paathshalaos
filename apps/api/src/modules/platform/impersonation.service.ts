import { withTenant, type TenantScope } from '../../db/tenant.ts';
import { auditService } from '../audit/audit.service.ts';
import { ApiError } from '../../common/errors.ts';

export interface ImpersonationSession {
  id: string;
  tenant_id: string;
  actor_user_id: string;
  target_user_id: string | null;
  status: string;
  write_enabled: boolean;
  started_at: Date | null;
  expires_at: Date | null;
}

/** One row of the school's own access log. A superset of the session itself. */
export interface AccessRow extends ImpersonationSession {
  actor_email: string | null;
  target_email: string | null;
  assumed_role: string | null;
  entry_path: string;
  reason: string;
  revoked_at: Date | null;
}

const MAX_WINDOW_MINUTES = 60;

/**
 * AC-12. Support never holds standing access to tenant data.
 *
 * The guarantees, and where each one is actually enforced:
 *
 *   two people        CHECK constraint (approved_by <> actor_user_id) plus the
 *                     approve() path — the database refuses self-approval even
 *                     if a future code path forgets to check.
 *   time-bounded      a trigger caps the window at 60 minutes; assertActive()
 *                     re-checks on every request, so an open window closes on
 *                     the clock rather than on the next login.
 *   read-only default write_enabled defaults false and is a separate elevation.
 *   both identities   every audit row carries actor and on_behalf_of.
 *   owner visibility  the row is tenant-scoped, so the owner sees it live under
 *                     normal RLS and can revoke it.
 */
export const impersonationService = {
  async request(
    scope: TenantScope,
    input: {
      targetUserId?: string | undefined; reason: string; ticketRef: string;
      writeRequested?: boolean | undefined;
    },
  ): Promise<ImpersonationSession> {
    if (input.reason.trim().length < 10) {
      throw ApiError.make('validation_error', 'reason_too_short',
        'A specific reason is required for support access.');
    }

    const session = await withTenant(scope, async (db) => {
      const { rows } = await db.query<ImpersonationSession>(
        `INSERT INTO impersonation_session
           (tenant_id, actor_user_id, target_user_id, reason, ticket_ref, write_enabled, status)
         VALUES (app_current_tenant_id(), $1, $2, $3, $4, $5, 'requested')
         RETURNING id, tenant_id, actor_user_id, target_user_id, status, write_enabled, started_at, expires_at`,
        [scope.actorId, input.targetUserId ?? null, input.reason, input.ticketRef,
         input.writeRequested ?? false],
      );
      return rows[0]!;
    });

    await auditService.record({
      tenantId: scope.tenantId,
      actorUserId: scope.actorId,
      action: 'impersonation.requested',
      resourceType: 'impersonation_session',
      resourceId: session.id,
      classification: 'RESTRICTED',
      reason: input.reason,
    });

    return session;
  },

  /** Approving and activating are one step: an approval nobody uses should expire. */
  async approve(
    scope: TenantScope,
    sessionId: string,
    approverUserId: string,
    windowMinutes = MAX_WINDOW_MINUTES,
  ): Promise<ImpersonationSession> {
    const minutes = Math.min(windowMinutes, MAX_WINDOW_MINUTES);

    const session = await withTenant(scope, async (db) => {
      const { rows } = await db.query<ImpersonationSession>(
        `UPDATE impersonation_session
            SET status = 'active', approved_by = $2, approved_at = now(),
                started_at = now(), expires_at = now() + ($3 || ' minutes')::interval
          WHERE id = $1 AND status = 'requested'
          RETURNING id, tenant_id, actor_user_id, target_user_id, status, write_enabled,
                    started_at, expires_at`,
        [sessionId, approverUserId, String(minutes)],
      );
      if (!rows[0]) {
        throw ApiError.make('conflict', 'impersonation_not_pending',
          'That request is not awaiting approval.');
      }
      return rows[0];
    });

    await auditService.record({
      tenantId: scope.tenantId,
      actorUserId: approverUserId,
      onBehalfOfUserId: session.actor_user_id,
      impersonationId: session.id,
      action: 'impersonation.started',
      resourceType: 'impersonation_session',
      resourceId: session.id,
      classification: 'RESTRICTED',
      reason: `Approved for ${minutes} minutes by a second platform user.`,
    });

    return session;
  },

  /** Revocation by the institute owner or a platform approver. Effective next request. */
  async revoke(scope: TenantScope, sessionId: string, revokedBy: string, reason: string): Promise<void> {
    await withTenant(scope, async (db) => {
      await db.query(
        `UPDATE impersonation_session
            SET status = 'revoked', revoked_at = now(), revoked_by = $2, revoked_reason = $3
          WHERE id = $1 AND status IN ('requested', 'approved', 'active')`,
        [sessionId, revokedBy, reason],
      );
    });

    await auditService.record({
      tenantId: scope.tenantId,
      actorUserId: revokedBy,
      impersonationId: sessionId,
      action: 'impersonation.revoked',
      resourceType: 'impersonation_session',
      resourceId: sessionId,
      classification: 'RESTRICTED',
      reason,
    });
  },

  /**
   * Called by the auth guard on every impersonated request. Expiry is evaluated
   * here rather than by a sweeper job, so a window closes exactly on time even
   * if no job has run.
   */
  async assertActive(sessionId: string, tenantId: string): Promise<ImpersonationSession> {
    // Read through the tenant pool, not the auth pool. The auth role holds no
    // privilege on any tenant table and this keeps it that way; it also means
    // the lookup is itself subject to RLS, so an impersonation id from one
    // tenant cannot be replayed against another.
    const session = await withTenant({ tenantId }, async (db) => {
      const { rows } = await db.query<ImpersonationSession>(
        `SELECT id, tenant_id, actor_user_id, target_user_id, status, write_enabled,
                started_at, expires_at
           FROM impersonation_session WHERE id = $1`,
        [sessionId],
      );
      return rows[0];
    });

    if (!session || session.status !== 'active') {
      throw ApiError.make('permission_error', 'impersonation_not_active',
        'This support session is no longer active.');
    }
    if (!session.expires_at || session.expires_at <= new Date()) {
      throw ApiError.make('permission_error', 'impersonation_expired',
        'This support session has expired.');
    }
    return session;
  },

  /**
   * Every session against this school, newest first — how an owner watches one
   * happen and how they find the one they want to end.
   *
   * This used to return five columns while `AccessLogController` ran its own
   * richer query inline, which is two answers to one question with the tested
   * one not being the live one. The richer query won and moved here: the
   * school's screen and the suite now exercise the same SQL.
   *
   * `actor_label` rather than a join onto `user_account`: the school's policy
   * on that table does not admit platform staff and should not, so if the name
   * is not copied onto the row at entry it is not knowable by the people it
   * concerns most.
   */
  async listForTenant(scope: TenantScope): Promise<AccessRow[]> {
    return withTenant(scope, async (db) => {
      const { rows } = await db.query<AccessRow>(
        `SELECT s.id, s.tenant_id, s.actor_user_id, s.target_user_id, s.status,
                s.write_enabled, s.started_at, s.expires_at,
                s.actor_label AS actor_email, target.login_email AS target_email,
                s.assumed_role, s.entry_path, s.reason, s.revoked_at
           FROM impersonation_session s
           LEFT JOIN user_account target ON target.id = s.target_user_id
          ORDER BY s.requested_at DESC
          LIMIT 200`,
      );
      return rows;
    });
  },
};
