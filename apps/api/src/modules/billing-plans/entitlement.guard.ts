/**
 * One place where a disabled module is refused (M16.3), and one where an
 * overdue school stops writing (the bottom rung of M16.5).
 *
 * Both questions are answered by a database function rather than by this file,
 * so the answer is the same for an HTTP request, a scheduled job, an import and
 * anything added later. A feature check written per-controller is a feature
 * check that is missing from the third controller somebody adds.
 *
 * The two refusals are deliberately different errors. "You do not have the
 * transport module" is a conversation about buying something; "your account is
 * past due" is a conversation about a card. A product that returns one code for
 * both produces support tickets that cannot be routed.
 */
import {
  Inject, Injectable, SetMetadata, type CanActivate, type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { withCurrentTenant } from '../../db/tenant.ts';
import { ApiError } from '../../common/errors.ts';
import { getContext } from '../../common/request-context.ts';

export const REQUIRED_FEATURE = 'paathshala:required_feature';

export type Feature =
  | 'transport' | 'hr' | 'lms' | 'public_api' | 'whatsapp' | 'advanced_reports';

/** Declares that a route belongs to a module a school may not have bought. */
export const RequiresFeature = (feature: Feature) =>
  SetMetadata(REQUIRED_FEATURE, feature);

/**
 * Methods that do not create or change anything.
 *
 * A read-only school keeps all of these, including every export. Withholding an
 * export from a school that owes money is the one thing in this ladder that
 * would be indefensible: it is their register, their children, their record —
 * we are the processor, not the owner.
 */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/* Reflector by token — see the note in AuthGuard. esbuild drops the metadata
 * Nest's implicit injection reads, and the symptom is every route 500ing. */
@Injectable()
export class EntitlementGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const ctx = getContext();
    // No tenant means this is the console, a login, or a health check. Billing
    // has nothing to say about those.
    if (!ctx?.tenantId) return true;

    const feature = this.reflector.getAllAndOverride<Feature>(REQUIRED_FEATURE, [
      context.getHandler(), context.getClass(),
    ]);
    const req = context.switchToHttp().getRequest<Request>();
    const isWrite = !SAFE_METHODS.has(req.method.toUpperCase());

    // One round trip for both questions when both are asked.
    const verdict = await withCurrentTenant(async (db) => {
      const { rows } = await db.query<{ has_feature: boolean; read_only: boolean }>(
        `SELECT CASE WHEN $1::text IS NULL THEN true
                     ELSE app_tenant_has_feature($1) END AS has_feature,
                app_tenant_is_read_only() AS read_only`,
        [feature ?? null]);
      return rows[0]!;
    });

    if (feature && !verdict.has_feature) {
      // 404, not 403. A module the school has not bought should look like a
      // part of the product that is not there, rather than a locked door with
      // their data behind it — and the upgrade conversation belongs to a
      // salesperson, not to an error body.
      throw ApiError.make('not_found', 'not_found', 'Not found.');
    }

    if (isWrite && verdict.read_only) {
      throw ApiError.make('permission_error', 'account_read_only',
        'This account is past due, so new entries are paused. Everything already '
        + 'here can still be read and exported. Ask your administrator to settle '
        + 'the account and this lifts immediately.');
    }

    return true;
  }
}
