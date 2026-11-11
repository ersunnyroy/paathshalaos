/**
 * What the school prints at the top of its paper (M47.4): address, contact,
 * affiliation and who signs.
 *
 * One row per school. Reading is open to everybody in the school; writing is
 * for whoever may change school-wide settings, asked of the database's own
 * function so the screen, the service and the policy cannot disagree.
 */
import { withTenant, type TenantScope } from '../../db/tenant.ts';
import { auditService } from '../audit/audit.service.ts';
import { ApiError } from '../../common/errors.ts';

export interface Letterhead {
  address_line1: string | null; address_line2: string | null;
  city: string | null; state: string | null; pincode: string | null;
  phone: string | null; email: string | null; website: string | null;
  affiliation_body: string | null; affiliation_no: string | null;
  school_code: string | null; udise_code: string | null;
  signatory_name: string | null; signatory_title: string | null;
}

export const LETTERHEAD_FIELDS = [
  'address_line1', 'address_line2', 'city', 'state', 'pincode',
  'phone', 'email', 'website',
  'affiliation_body', 'affiliation_no', 'school_code', 'udise_code',
  'signatory_name', 'signatory_title',
] as const satisfies ReadonlyArray<keyof Letterhead>;

const EMPTY: Letterhead = Object.fromEntries(
  LETTERHEAD_FIELDS.map((f) => [f, null])) as unknown as Letterhead;

/** Blank and whitespace-only become NULL: "" on a letterhead is nothing. */
const clean = (value: string | null | undefined): string | null => {
  const text = (value ?? '').replace(/\s+/g, ' ').trim();
  return text === '' ? null : text;
};

export const letterheadService = {
  /** The school's letterhead; every field null for a school that has not set one. */
  async get(scope: TenantScope): Promise<Letterhead> {
    return withTenant(scope, async (db) => {
      const { rows } = await db.query<Letterhead>(
        `SELECT ${LETTERHEAD_FIELDS.join(', ')} FROM school_letterhead
          WHERE tenant_id = app_current_tenant_id()`);
      return rows[0] ?? { ...EMPTY };
    });
  },

  /**
   * Replaces the whole letterhead. Whole, not field by field: it is one form,
   * and a field left blank on it means "we do not print this".
   */
  async save(scope: TenantScope, input: Partial<Record<keyof Letterhead, string | null | undefined>>):
  Promise<Letterhead> {
    const values = LETTERHEAD_FIELDS.map((f) => clean(input[f]));
    const saved = await withTenant(scope, async (db) => {
      const may = await db.query<{ ok: boolean }>(
        'SELECT app_actor_may_change_school_settings() AS ok');
      if (!may.rows[0]?.ok) {
        // Asked first so the answer is a sentence. The policy would refuse
        // anyway, as "new row violates row-level security policy".
        throw ApiError.make('permission_error', 'not_school_admin',
          'Only the school owner or a school-wide administrator can change '
          + 'what is printed on the school\'s documents.');
      }
      const columns = LETTERHEAD_FIELDS.join(', ');
      const params = LETTERHEAD_FIELDS.map((_, i) => `$${i + 1}`).join(', ');
      const updates = LETTERHEAD_FIELDS.map((f) => `${f} = EXCLUDED.${f}`).join(', ');
      const { rows } = await db.query<Letterhead>(
        `INSERT INTO school_letterhead (tenant_id, ${columns}, updated_by)
         VALUES (app_current_tenant_id(), ${params}, $${LETTERHEAD_FIELDS.length + 1})
         ON CONFLICT (tenant_id) DO UPDATE
           SET ${updates}, updated_by = EXCLUDED.updated_by
         RETURNING ${columns}`,
        [...values, scope.actorId ?? null]);
      return rows[0]!;
    });
    await auditService.record({
      tenantId: scope.tenantId, actorUserId: scope.actorId,
      action: 'letterhead.updated', resourceType: 'school_letterhead',
      resourceId: scope.tenantId, classification: 'INTERNAL', after: saved,
    });
    return saved;
  },
};
