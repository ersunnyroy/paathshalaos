import {
  Inject, Injectable, SetMetadata, type CanActivate, type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { tokenService } from '../auth/token.service.ts';
import { authService } from '../auth/auth.service.ts';
import { platformAdminService } from './platform-admin.service.ts';
import { ApiError } from '../../common/errors.ts';
import { getContext } from '../../common/request-context.ts';

export const PLATFORM_CAPABILITY = 'paathshala:platform_capability';

/**
 * The closed set from migration 0055. Kept in one place so that adding a
 * capability to the database without teaching the console about it, or the
 * reverse, fails the typecheck rather than the request.
 */
export type PlatformCapability =
  | 'provision'
  | 'support'
  | 'billing'
  | 'impersonate'
  | 'impersonate_write'
  | 'superadmin';

/** Declares which platform capability a route needs. Required, not optional. */
export const RequiresCapability = (capability: PlatformCapability) =>
  SetMetadata(PLATFORM_CAPABILITY, capability);

/**
 * The one legitimate exception: the console's login route, which cannot require
 * a capability because it is how a capability-bearing token is obtained.
 *
 * A named decorator rather than "no metadata means public", because the guard's
 * default for an undeclared route is refusal — a controller added later with a
 * forgotten @RequiresCapability must fail closed.
 */
export const NoCapabilityNeeded = () => SetMetadata(PLATFORM_CAPABILITY, 'none');

/*
 * Reflector is injected by token — see the note in AuthGuard. esbuild drops the
 * decorator metadata Nest's implicit injection reads, and the symptom is every
 * route 500ing on an undefined reflector while the build stays green.
 */
@Injectable()
export class PlatformGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  /**
   * A third guard, beside the session guard and the API-key guard.
   *
   * Platform staff sign in with the same credentials as anybody else — there is
   * no separate login — but their authority comes from `platform_admin` rather
   * than from a role grant, and it is not scoped to a tenant. Keeping that in
   * its own guard is what stops "is this person platform staff" becoming a
   * branch inside the tenant guard, where it would eventually be reachable by a
   * tenant token.
   */
  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Read first, refuse second. The login route has no token by definition, so
    // checking the header before reading what the route asked for would make it
    // unreachable — and the fix people reach for then is @Public(), which would
    // take it out from under this guard entirely.
    const required = this.reflector.getAllAndOverride<string>(PLATFORM_CAPABILITY, [
      context.getHandler(), context.getClass(),
    ]);
    if (required === 'none') return true;

    const req = context.switchToHttp().getRequest<Request>();
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw ApiError.make('authentication_error', 'missing_token',
        'Authentication required.');
    }

    let claims;
    try {
      claims = await tokenService.verifyAccessToken(header.slice(7));
    } catch {
      throw ApiError.make('authentication_error', 'invalid_token',
        'Authentication required.');
    }

    // A token minted for an entry session is a token for somebody inside a
    // school. It must not open the console, even if the person it names also
    // happens to be platform staff: the console is where a session is started
    // and ended, and letting one be driven from inside another is how a chain
    // of entries ends up with only its first link in the audit trail.
    if (claims.imp) {
      throw ApiError.make('permission_error', 'entry_token_on_console',
        'Leave the school you are in before using the console.');
    }

    // The same revocation check the tenant path does. A platform administrator
    // whose access was withdrawn should lose it on the next request, not when
    // their token happens to expire.
    const currentVersion = await authService.currentGrantsVersion(claims.sub);
    if (currentVersion === undefined || currentVersion !== claims.gv) {
      throw ApiError.make('authentication_error', 'grants_changed',
        'Your access has changed. Refresh your session and retry.');
    }

    if (!required) {
      // A programming error surfaced as a refusal rather than as access.
      throw ApiError.make('permission_error', 'route_declares_no_capability',
        'This endpoint is not available.');
    }

    const allowed = await platformAdminService.has(claims.sub, required);
    if (!allowed) {
      // Deliberately the same shape a tenant user gets for any forbidden route.
      // Whether this deployment has a platform console at all is not something
      // a school's owner needs to learn by probing.
      throw ApiError.make('not_found', 'not_found', 'Not found.');
    }

    const ctx = getContext();
    if (!ctx) throw new Error('Request context missing; ContextMiddleware did not run.');
    // No tenantId. A platform operation is not inside a tenant, and setting one
    // here would let a handler reach for withTenant() and quietly work.
    ctx.actorId = claims.sub;
    ctx.roles = [`platform:${required}`];

    return true;
  }
}
