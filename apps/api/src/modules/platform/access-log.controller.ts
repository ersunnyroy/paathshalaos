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
import { impersonationService, type AccessRow } from './impersonation.service.ts';
import { requireTenantId, getContext } from '../../common/request-context.ts';
import { ApiError } from '../../common/errors.ts';

const endSession = z.object({ reason: z.string().min(3).max(300).optional() });

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
    const rows: AccessRow[] = await impersonationService.listForTenant(scope);
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

/**
 * The ticketed, two-person support path — 0054's `support` entry path.
 *
 * Not a second way to do what the console's `/platform/v1/enter` does. 0054
 * deliberately split the two and wrote the difference into the schema: a
 * `platform` session is one capability-holder with no ticket and no approver,
 * and a `support` session is a named ticket plus a second person, with the
 * database refusing to let it go active otherwise. That trigger has been in
 * 0008 since the beginning and had no caller in `src/` until this file, which
 * means the guarantee AC-12 lists first was enforceable and unreachable at
 * the same time — proved by a suite, offered to nobody.
 *
 * Tenant-scoped, under the school's own token: the requester is somebody who
 * already holds an account here — an implementation partner, a reseller's
 * engineer — asking for a window, not a stranger. Approving is gated on
 * `audit:read`, the same permission that governs seeing the log, because
 * letting somebody in is not a lesser act than reading about it afterwards.
 */
@Controller('v1/support-access')
export class SupportAccessController {
  private scope() {
    const actorId = getContext()?.actorId;
    if (!actorId) throw new Error('No actor; AuthGuard should have refused this.');
    return { tenantId: requireTenantId(), actorId };
  }

  private async requireApprover(): Promise<{ tenantId: string; actorId: string }> {
    const scope = this.scope();
    const allowed = await withTenant(scope, async (db) => {
      const grants = await authzService.grantsFor(db, scope.actorId);
      return authzService.can(grants, 'audit:read', { type: 'organization', id: null });
    });
    if (!allowed) throw ApiError.make('not_found', 'not_found', 'Not found.');
    return scope;
  }

  /**
   * Asks for a window. Grants nothing.
   *
   * The requester is the session's actor and comes from the token, never the
   * body — the database's `approved_by <> actor_user_id` check is only a
   * two-person rule if the first person cannot be chosen by the caller.
   */
  @Post()
  async request(@Body() body: unknown) {
    const parsed = z.object({
      // Deliberately not `.min(10)`: the service refuses a reason shorter than
      // ten characters after trimming, and a stricter rule here would make the
      // service's rule unreachable and its test a tautology.
      reason: z.string().max(2000),
      ticketRef: z.string().min(1).max(60),
      targetUserId: z.string().uuid().optional(),
      writeRequested: z.boolean().optional(),
    }).safeParse(body);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    return { data: await impersonationService.request(this.scope(), parsed.data) };
  }

  /**
   * The second person. Approving and starting the window are one step, because
   * an approval nobody uses should expire rather than sit there.
   */
  @Post(':id/approve')
  async approve(@Param('id') id: string, @Body() body: unknown) {
    const scope = await this.requireApprover();
    const parsed = z.object({ minutes: z.number().int().min(5).max(60).optional() })
      .safeParse(body ?? {});
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    return {
      data: parsed.data.minutes === undefined
        ? await impersonationService.approve(scope, id, scope.actorId)
        : await impersonationService.approve(scope, id, scope.actorId, parsed.data.minutes),
    };
  }
}
