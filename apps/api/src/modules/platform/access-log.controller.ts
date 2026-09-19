/**
 * The school's side of platform access.
 *
 * Everything else in this module is the console: us looking at them. This file
 * is them looking at us, and it is the part that makes the rest defensible. A
 * support model where the vendor can enter any school is ordinary; one where
 * the school cannot find out is not, and the difference is a screen.
 *
 * Served from the tenant API under the school's own token, reading through the
 * tenant pool, so it is their row-level security policy that decides what comes
 * back — not a query we wrote that promises to filter.
 */
import { Controller, Get, Post, Param, Body } from '@nestjs/common';
import { z } from 'zod';
import { withTenant } from '../../db/tenant.ts';
import { authzService } from '../authz/authz.service.ts';
import { impersonationService } from './impersonation.service.ts';
import { requireTenantId, getContext } from '../../common/request-context.ts';
import { ApiError } from '../../common/errors.ts';

const endSession = z.object({ reason: z.string().min(3).max(300).optional() });

interface AccessRow {
  id: string;
  actor_email: string | null;
  target_email: string | null;
  assumed_role: string | null;
  entry_path: string;
  status: string;
  reason: string;
  write_enabled: boolean;
  started_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
}

@Controller('v1/platform-access')
export class AccessLogController {
  private scope() {
    const actorId = getContext()?.actorId;
    if (!actorId) throw new Error('No actor; AuthGuard should have refused this.');
    return { tenantId: requireTenantId(), actorId };
  }

  /**
   * Requires audit:read — the same permission that governs the rest of the
   * school's audit trail, because this is part of it and not a separate thing.
   */
  private async requireAuditReader(): Promise<{ tenantId: string; actorId: string }> {
    const scope = this.scope();
    const allowed = await withTenant(scope, async (db) => {
      const grants = await authzService.grantsFor(db, scope.actorId);
      return authzService.can(grants, 'audit:read', { type: 'organization', id: null });
    });
    if (!allowed) throw ApiError.make('not_found', 'not_found', 'Not found.');
    return scope;
  }

  /** Every session ever opened against this school, newest first. */
  @Get()
  async list() {
    const scope = await this.requireAuditReader();
    const rows = await withTenant(scope, async (db) => {
      const { rows } = await db.query<AccessRow>(
        // actor_label rather than a join: the school's policy on user_account
        // does not admit platform staff, and should not.
        `SELECT s.id, s.actor_label AS actor_email, target.login_email AS target_email,
                s.assumed_role, s.entry_path, s.status, s.reason, s.write_enabled,
                s.started_at, s.expires_at, s.revoked_at
           FROM impersonation_session s
           LEFT JOIN user_account target ON target.id = s.target_user_id
          ORDER BY s.requested_at DESC
          LIMIT 200`);
      return rows;
    });
    return {
      data: rows,
      notice: rows.some((r) => r.status === 'active')
        ? 'Somebody from paathshalaOS is in your records right now. You can end it.'
        : undefined,
    };
  }

  /**
   * Ends a session from the school's side.
   *
   * Takes effect on the support agent's next request rather than on a timer:
   * the auth guard re-reads the session on every call, so there is no window in
   * which a revoked session keeps working because a token had not expired.
   */
  @Post(':id/end')
  async end(@Param('id') id: string, @Body() body: unknown) {
    const scope = await this.requireAuditReader();
    const parsed = endSession.safeParse(body ?? {});
    if (!parsed.success) throw ApiError.fromZod(parsed.error);

    await impersonationService.revoke(
      scope, id, scope.actorId,
      parsed.data.reason ?? 'Ended by the institute.');
    return { data: { status: 'ended' } };
  }
}
