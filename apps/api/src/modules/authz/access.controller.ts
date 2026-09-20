/**
 * Who may do what, and who may say so (M32.6).
 *
 * `grantsService` had no caller in `src/`. Every account in this system was
 * created by the seed or by a test: a school that hired a teacher in October
 * could not give them a login, which makes every other permission in the
 * product decorative.
 *
 * **Delegation is checked in the service and not here.** `canDelegate` decides
 * whether the CALLER'S own grants permit the grant they are asking for — you
 * cannot hand out a role you do not hold, and you cannot widen your own scope
 * by granting yourself. A controller that re-implemented that check would be a
 * second answer to the question, and the second answer is the one that drifts.
 *
 * The one rule that IS here: a caller cannot revoke their own last
 * organisation-wide grant. Locking the only owner out of a school is a support
 * call that needs a database, and the schema cannot see it because a grant row
 * knows nothing about who is asking.
 */
import { Controller, Get, Post, Body, Param, Query } from '@nestjs/common';
import { z } from 'zod';
import { grantsService } from './grants.service.ts';
// Static, not `await import(...)`. `rewriteRelativeImportExtensions` turns a
// `.ts` specifier into `.js` on the way out for a static import and for the
// top-level dynamic ones in `main.ts`, and it left this one alone inside a
// class method — so the built server 500'd on a route every test passed,
// because the tests run from TypeScript source and never load `dist`.
import { authzService } from './authz.service.ts';
import { withTenant } from '../../db/tenant.ts';
import { currentScope } from '../../common/scope.ts';
import { ApiError } from '../../common/errors.ts';

const uuid = z.string().uuid();

const ROLES = ['ORG_OWNER', 'CAMPUS_ADMIN', 'ADMISSIONS', 'ACCOUNTANT',
               'TEACHER', 'STUDENT', 'GUARDIAN', 'TRANSPORT',
               'SUPPORT_AGENT'] as const;
const SCOPE_TYPES = ['organization', 'campus', 'academic_unit', 'class_group',
                     'section', 'self'] as const;

const grantBody = z.object({
  userAccountId: uuid,
  role: z.enum(ROLES),
  scopeType: z.enum(SCOPE_TYPES),
  scopeId: uuid.nullable().optional(),
});

@Controller('v1/access')
export class AccessController {
  /**
   * The people with a login in this school, and what each of them holds.
   *
   * `tenant_principal` is the join between an account and a school — the same
   * row the login path resolves — so this is the list of who can actually sign
   * in, not the list of everybody on file. A school's staff roster and its
   * accounts are different sets, and conflating them is how somebody is
   * "removed" from the roster and keeps their password.
   */
  @Get('accounts')
  async accounts() {
    return {
      data: await withTenant(currentScope(), async (db) => {
        const { rows } = await db.query(
          `SELECT tp.user_account_id, tp.person_id,
                  p.given_name, p.family_name,
                  st.employee_code, st.designation, st.left_on::text,
                  COALESCE(json_agg(json_build_object(
                    'id', rg.id, 'role', rg.role,
                    'scope_type', rg.scope_type, 'scope_id', rg.scope_id,
                    'granted_at', rg.granted_at, 'expires_at', rg.expires_at
                  ) ORDER BY rg.granted_at) FILTER (WHERE rg.id IS NOT NULL), '[]')
                    AS grants
             FROM tenant_principal tp
             LEFT JOIN person p ON p.id = tp.person_id
             LEFT JOIN staff st ON st.person_id = p.id AND st.deleted_at IS NULL
             LEFT JOIN role_grant rg ON rg.user_account_id = tp.user_account_id
                                    AND rg.revoked_at IS NULL
            GROUP BY tp.user_account_id, tp.person_id, p.given_name, p.family_name,
                     st.employee_code, st.designation, st.left_on
            ORDER BY p.given_name NULLS LAST`);
        return rows;
      }),
    };
  }

  @Get('accounts/:id/grants')
  async grants(@Param('id') id: string) {
    const userAccountId = uuid.safeParse(id);
    if (!userAccountId.success) throw ApiError.fromZod(userAccountId.error);
    return { data: await grantsService.list(currentScope(), userAccountId.data) };
  }

  @Post('grants')
  async grant(@Body() body: unknown) {
    const parsed = grantBody.safeParse(body);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    return {
      data: await grantsService.grant(currentScope(), {
        ...parsed.data,
        // `self` is the guardian and learner shape: the grant is scoped to the
        // person, not to a structure, so an id would be meaningless.
        scopeId: parsed.data.scopeType === 'self' ? null : parsed.data.scopeId ?? null,
      }),
    };
  }

  @Post('grants/:id/revoke')
  async revoke(@Param('id') id: string) {
    const grantId = uuid.safeParse(id);
    if (!grantId.success) throw ApiError.fromZod(grantId.error);
    const scope = currentScope();

    // The one check the schema cannot make. A grant row does not know who is
    // asking, so "am I about to remove my own last way back in" is a question
    // only this layer can pose.
    const lockout = await withTenant(scope, async (db) => {
      const { rows } = await db.query<{ n: string }>(
        `SELECT count(*)::text AS n
           FROM role_grant
          WHERE user_account_id = $1::uuid
            AND revoked_at IS NULL
            AND role = 'ORG_OWNER'
            AND scope_type = 'organization'
            AND id <> $2::uuid`,
        [scope.actorId ?? null, grantId.data]);
      const { rows: mine } = await db.query<{ owned: boolean }>(
        `SELECT (user_account_id = $1::uuid
                 AND role = 'ORG_OWNER'
                 AND scope_type = 'organization') AS owned
           FROM role_grant WHERE id = $2::uuid`,
        [scope.actorId ?? null, grantId.data]);
      return Boolean(mine[0]?.owned) && rows[0]!.n === '0';
    });

    if (lockout) {
      throw ApiError.make('conflict', 'would_lock_yourself_out',
        'This is your own last organisation-wide grant. Give somebody else '
        + 'that role first — a school with no owner needs a database to fix.');
    }

    await grantsService.revoke(scope, grantId.data);
    return { data: { revoked: true } };
  }

  /**
   * Which roles this caller may hand out.
   *
   * Asked of the service's own rule rather than hard-coded, so the picker on
   * the screen and the refusal on the POST cannot disagree — the way they do
   * the moment somebody lists the roles twice.
   */
  @Get('delegatable')
  async delegatable(@Query('scopeType') scopeType?: string) {
    const parsed = z.enum(SCOPE_TYPES).optional().safeParse(scopeType ?? undefined);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    const scope = currentScope();
    const mine = scope.actorId
      ? await grantsService.list(scope, scope.actorId)
      : [];

    const roles = ROLES.filter((role) => authzService.canDelegate(mine, {
      role,
      scopeType: parsed.data ?? 'organization',
      scopeId: null,
    }).ok);

    return { data: { roles, held: mine } };
  }
}
