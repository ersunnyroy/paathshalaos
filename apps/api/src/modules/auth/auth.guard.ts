import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { tokenService } from './token.service.ts';
import { authService } from './auth.service.ts';
import { ApiError } from '../../common/errors.ts';
import { getContext } from '../../common/request-context.ts';
import { PUBLIC_ROUTE } from './public.decorator.ts';
import { impersonationService } from '../platform/impersonation.service.ts';

/*
 * Reflector is injected BY TOKEN rather than by constructor parameter type.
 *
 * Nest's implicit injection reads design:paramtypes, which only exists when the
 * compiler emits decorator metadata. tsc does; esbuild — which vitest and every
 * other fast transform use — does not, and silently. The symptom is not a
 * missing-provider error but `this.reflector` being undefined at the first
 * request, so every route 500s while the build, the typecheck and the unit tests
 * all stay green.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<Request>();
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw ApiError.make('authentication_error', 'missing_token', 'Authentication required.');
    }

    let claims;
    try {
      claims = await tokenService.verifyAccessToken(header.slice(7));
    } catch {
      throw ApiError.make('authentication_error', 'invalid_token', 'Authentication required.');
    }

    // A console token names no school. Reaching the tenant API with one would
    // mean every downstream `requireTenantId()` throwing a 500 instead of this
    // saying no, and worse, it would make "which tenant is this?" a question
    // with an undefined answer inside a request that is already authenticated.
    if (!claims.tenant_id) {
      throw ApiError.make('authentication_error', 'not_a_tenant_token',
        'Authentication required.');
    }

    // AC-11 — the whole point of this block.
    //
    // A token is a claim about authority made when it was minted. Trusting it
    // for its full lifetime means a revoked teacher keeps their class for up to
    // ten more minutes. Instead every request compares the version stamped into
    // the token against the user's current grants_version, which a database
    // trigger bumps on any grant change. A mismatch means "re-read your
    // authority", not "you are logged out": the client refreshes and continues.
    //
    // The cost is one indexed single-row read per request. That is a good trade
    // for a revocation that is immediate rather than eventual, and it is the
    // seam where a Redis cache goes if the read ever shows up in a profile.
    const currentVersion = await authService.currentGrantsVersion(claims.sub);
    if (currentVersion === undefined) {
      throw ApiError.make('authentication_error', 'account_not_found', 'Authentication required.');
    }
    if (currentVersion !== claims.gv) {
      throw ApiError.make('authentication_error', 'grants_changed',
        'Your access has changed. Refresh your session and retry.');
    }

    const ctx = getContext();
    if (!ctx) throw new Error('Request context missing; ContextMiddleware did not run.');

    ctx.tenantId = claims.tenant_id;
    ctx.actorId = claims.sub;
    ctx.actorRole = claims.roles[0] ?? undefined;
    ctx.roles = claims.roles;
    ctx.sessionId = claims.session_id;

    if (claims.imp) {
      // An impersonation token is only as valid as the session behind it, and
      // that session can be revoked by the institute owner mid-window.
      const session = await impersonationService.assertActive(claims.imp, claims.tenant_id);
      ctx.impersonatedBy = session.actor_user_id;
      ctx.impersonationId = session.id;
      ctx.impersonationWriteEnabled = session.write_enabled;
    }

    return true;
  }
}
