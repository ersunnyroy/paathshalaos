import {
  Inject, Injectable, SetMetadata, type CanActivate, type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { apiKeyService } from './api-key.service.ts';
import { consume, rateLimitKey } from './rate-limit.ts';
import { ApiError } from '../../common/errors.ts';
import { getContext } from '../../common/request-context.ts';

export const API_SCOPES = 'paathshala:api_scopes';

/**
 * Declares what a public-API route requires.
 *
 * Required rather than optional: a route with no scope on it is refused by the
 * guard below. The alternative — treat "no declaration" as "no requirement" —
 * means every route added in a hurry is open to every key, and nobody finds out
 * until an integration reads something it was never given.
 */
export const ApiScopes = (...scopes: string[]) => SetMetadata(API_SCOPES, scopes);

/**
 * Authenticates a public-API request from an API key.
 *
 * This is a SECOND guard, applied per-controller, rather than a branch inside
 * AuthGuard. Keeping them apart means the session path and the machine path
 * cannot be confused for one another: a JWT is never accepted here, an API key
 * is never accepted there, and neither can drift into the other's privilege
 * model because someone added an `if` to a shared function.
 */
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
export class ApiKeyGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const res = context.switchToHttp().getResponse<Response>();

    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw ApiError.make('authentication_error', 'missing_api_key',
        'Provide your API key as an Authorization: Bearer header.');
    }

    const identity = await apiKeyService.authenticate(header.slice(7));

    const required = this.reflector.getAllAndOverride<string[]>(API_SCOPES, [
      context.getHandler(), context.getClass(),
    ]);
    if (!required || required.length === 0) {
      // A programming error, surfaced as a refusal rather than as access.
      throw ApiError.make('permission_error', 'route_declares_no_scope',
        'This endpoint is not available.');
    }
    const missing = required.filter((s) => !identity.scopes.includes(s));
    if (missing.length > 0) {
      throw ApiError.make('permission_error', 'insufficient_scope',
        `This API key is missing the ${missing.join(', ')} scope.`);
    }

    // Awaited: the counter lives in Redis now (M30.2) and is shared between
    // instances. It never throws — a failure counts locally instead — so there
    // is no infrastructure error path through this guard.
    const verdict = await consume(rateLimitKey(identity), identity.ratePerMin);
    res.setHeader('x-ratelimit-limit', String(verdict.limit));
    res.setHeader('x-ratelimit-remaining', String(verdict.remaining));
    res.setHeader('x-ratelimit-reset', String(verdict.resetAt));
    if (!verdict.allowed) {
      res.setHeader('retry-after', String(Math.max(1, verdict.resetAt - Math.floor(Date.now() / 1000))));
      throw ApiError.make('rate_limited', 'rate_limit_exceeded',
        'Too many requests for this API key. Retry after the window resets.');
    }

    const ctx = getContext();
    if (!ctx) throw new Error('Request context missing; ContextMiddleware did not run.');
    ctx.tenantId = identity.tenantId;
    // The API client acts as itself. There is deliberately no user to borrow:
    // an integration that ran "as" the owner who created its key would inherit
    // an authority nobody reviewed, and would keep it after that person left.
    ctx.actorId = undefined;
    ctx.roles = identity.scopes;
    ctx.apiClientId = identity.apiClientId;
    ctx.apiKeyId = identity.apiKeyId;

    return true;
  }
}
