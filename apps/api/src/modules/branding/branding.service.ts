/**
 * What a school's portal looks like (M19.2).
 *
 * The shape of this is the product decision: a short, closed list of fields
 * rather than "supply your own CSS". Arbitrary styling is the flexible answer
 * and it is wrong twice — it is an injection surface on a page we serve under
 * a school's own domain, and it makes every future layout change somebody's
 * broken portal. What a school can change is its name, its mark and two
 * colours, and that covers what white-labelling is actually for.
 */
import { withTenant, type TenantScope } from '../../db/tenant.ts';
import { withPlatform } from '../../db/platform-pool.ts';
import { ApiError } from '../../common/errors.ts';
import { auditService } from '../audit/audit.service.ts';

const HEX = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export interface Branding {
  app_name: string | null;
  logo_file_id: string | null;
  logo_dark_file_id: string | null;
  primary_colour: string | null;
  ink_colour: string | null;
  support_email: string | null;
  support_phone: string | null;
}

export interface Brand {
  tenantId: string;
  name: string;
  logoUrl: string | null;
  logoDarkUrl: string | null;
  primaryColour: string | null;
  inkColour: string | null;
  supportEmail: string | null;
  supportPhone: string | null;
  /**
   * Always true, on every plan.
   *
   * A school can put its own name on this; it cannot claim to have built it.
   * Kept out of the branding table on purpose — a field that can be set is a
   * field somebody will ask to have set.
   */
  poweredBy: 'paathshalaOS';
}

export const brandingService = {
  /**
   * The sign-in screen's view of a host, with no token involved.
   *
   * Runs on the tenant pool with NO tenant scope, through a SECURITY DEFINER
   * function, because this is the call that establishes which tenant the caller
   * is talking to. It returns only what a sign-in screen needs — a name, a mark,
   * two colours — and nothing that would tell a stranger anything about the
   * school behind it.
   */
  async forHost(host: string): Promise<Brand | null> {
    const cleaned = host.trim().toLowerCase().split(':')[0] ?? '';
    if (!cleaned) return null;

    return withTenant({ tenantId: NO_TENANT }, async (db) => {
      const { rows } = await db.query<{
        tenant_id: string; display_name: string; app_name: string | null;
        logo_object_key: string | null; logo_dark_object_key: string | null;
        primary_colour: string | null; ink_colour: string | null;
        support_email: string | null; support_phone: string | null;
      }>('SELECT * FROM app_brand_for_host($1)', [cleaned]);

      const row = rows[0];
      if (!row) return null;

      return {
        tenantId: row.tenant_id,
        name: row.app_name ?? row.display_name,
        logoUrl: publicFileUrl(row.logo_object_key),
        logoDarkUrl: publicFileUrl(row.logo_dark_object_key),
        primaryColour: row.primary_colour,
        inkColour: row.ink_colour,
        supportEmail: row.support_email,
        supportPhone: row.support_phone,
        poweredBy: 'paathshalaOS',
      };
    });
  },

  async forTenant(scope: TenantScope): Promise<Branding | null> {
    return withTenant(scope, async (db) => {
      const { rows } = await db.query<Branding>(
        `SELECT app_name, logo_file_id, logo_dark_file_id, primary_colour,
                ink_colour, support_email, support_phone
           FROM tenant_branding`);
      return rows[0] ?? null;
    });
  },

  /** The school edits its own. Validated here as well as by the column checks. */
  async set(scope: TenantScope, input: Partial<{
    appName: string | null; primaryColour: string | null; inkColour: string | null;
    supportEmail: string | null; supportPhone: string | null;
    logoFileId: string | null; logoDarkFileId: string | null;
  }>): Promise<Branding> {
    for (const [field, value] of [
      ['primaryColour', input.primaryColour], ['inkColour', input.inkColour],
    ] as const) {
      if (value != null && !HEX.test(value)) {
        // The database refuses this too. Saying it here turns a constraint
        // violation into a sentence — and the anchors matter: this value is
        // interpolated into a CSS custom property, and `#fff; background:…`
        // is what the regex exists to refuse.
        throw ApiError.make('validation_error', 'not_a_colour',
          `${field} must be a hex colour such as #14B8A6.`);
      }
    }

    const saved = await withTenant(scope, async (db) => {
      const { rows } = await db.query<Branding>(
        `INSERT INTO tenant_branding
           (tenant_id, app_name, primary_colour, ink_colour, support_email,
            support_phone, logo_file_id, logo_dark_file_id, updated_by)
         VALUES (app_current_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (tenant_id) DO UPDATE SET
           app_name = COALESCE(EXCLUDED.app_name, tenant_branding.app_name),
           primary_colour = COALESCE(EXCLUDED.primary_colour, tenant_branding.primary_colour),
           ink_colour = COALESCE(EXCLUDED.ink_colour, tenant_branding.ink_colour),
           support_email = COALESCE(EXCLUDED.support_email, tenant_branding.support_email),
           support_phone = COALESCE(EXCLUDED.support_phone, tenant_branding.support_phone),
           logo_file_id = COALESCE(EXCLUDED.logo_file_id, tenant_branding.logo_file_id),
           logo_dark_file_id = COALESCE(EXCLUDED.logo_dark_file_id,
                                        tenant_branding.logo_dark_file_id),
           updated_at = now(), updated_by = EXCLUDED.updated_by
         RETURNING app_name, logo_file_id, logo_dark_file_id, primary_colour,
                   ink_colour, support_email, support_phone`,
        [input.appName ?? null, input.primaryColour ?? null, input.inkColour ?? null,
         input.supportEmail ?? null, input.supportPhone ?? null,
         input.logoFileId ?? null, input.logoDarkFileId ?? null, scope.actorId ?? null]);
      return rows[0]!;
    });

    await auditService.record({
      tenantId: scope.tenantId, actorUserId: scope.actorId, action: 'branding.updated',
      resourceType: 'tenant_branding', resourceId: scope.tenantId,
      classification: 'INTERNAL', after: saved,
    });
    return saved;
  },

  /** The console's view, for onboarding a school's brand with them. */
  async setAsPlatform(actorUserId: string, tenantId: string, input: {
    appName?: string | null; primaryColour?: string | null;
  }): Promise<void> {
    if (input.primaryColour != null && !HEX.test(input.primaryColour)) {
      throw ApiError.make('validation_error', 'not_a_colour',
        'primaryColour must be a hex colour such as #14B8A6.');
    }
    await withPlatform(async (db) => {
      await db.query(
        `INSERT INTO tenant_branding (tenant_id, app_name, primary_colour, updated_by)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenant_id) DO UPDATE SET
           app_name = COALESCE(EXCLUDED.app_name, tenant_branding.app_name),
           primary_colour = COALESCE(EXCLUDED.primary_colour, tenant_branding.primary_colour),
           updated_at = now(), updated_by = EXCLUDED.updated_by`,
        [tenantId, input.appName ?? null, input.primaryColour ?? null, actorUserId]);
    });
    await auditService.record({
      tenantId, actorUserId, action: 'branding.updated',
      resourceType: 'tenant_branding', resourceId: tenantId, classification: 'INTERNAL',
      after: input,
    });
  },
};

/**
 * The all-zero uuid: a scope that matches no tenant.
 *
 * `withTenant` insists on one, and this call deliberately has none — it is the
 * call that decides which tenant the caller gets. Passing a real id here would
 * be the bug; passing one that matches nothing means every ordinary policy in
 * the system returns empty, and only the SECURITY DEFINER function answers.
 */
const NO_TENANT = '00000000-0000-0000-0000-000000000000';

/**
 * Object storage keys become URLs at the edge, not here.
 *
 * Returning a signed URL would put a credential in an UNAUTHENTICATED response;
 * returning a path lets whatever serves files decide. A logo is public by
 * nature — it is on the sign-in page — so it is served from the public prefix.
 */
function publicFileUrl(objectKey: string | null): string | null {
  if (!objectKey) return null;
  const base = process.env['PUBLIC_FILES_URL'] ?? '/files';
  return `${base}/${objectKey}`;
}
