/**
 * Makes "read-only" mean read-only.
 *
 * Migration 0008 gave an impersonation session a `write_enabled` flag and the
 * auth guard has always resolved it into the request context — but nothing read
 * it, so a session that said read-only in the database and in the school's
 * audit trail could still post an invoice. A flag nobody enforces is worse than
 * no flag: it is a promise made to the school in writing.
 *
 * Registered globally and after AuthGuard, so it covers every controller that
 * exists now and every one added later. There is no decorator to opt out, and
 * that is deliberate — the exceptions people want ("just this one endpoint") are
 * exactly where the elevation would come back.
 */
import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { ApiError } from '../../common/errors.ts';
import { getContext } from '../../common/request-context.ts';

/** Anything that is not one of these is treated as a change. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

@Injectable()
export class ReadOnlyEntryGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const ctx = getContext();
    // Not inside an entry session: nothing to say.
    if (!ctx?.impersonationId) return true;
    if (ctx.impersonationWriteEnabled === true) return true;

    const req = context.switchToHttp().getRequest<Request>();
    if (SAFE_METHODS.has(req.method.toUpperCase())) return true;

    throw ApiError.make('permission_error', 'entry_is_read_only',
      'This session was opened to look, not to change. Ask for write access and '
      + 'enter again — the school will see that you did.');
  }
}
