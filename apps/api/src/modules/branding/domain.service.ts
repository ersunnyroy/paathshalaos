/**
 * Hosts, and proving you own one (M19.1).
 *
 * A managed subdomain is ours and is live immediately. A custom domain is
 * somebody else's, and until they have proved they own it this system will not
 * route it, brand it or acknowledge it — because a hostname is an identity, and
 * accepting an unproven claim to one is how a school's parents end up typing
 * their password into a page somebody else controls.
 */
import { withPlatform } from '../../db/platform-pool.ts';
import { withTenant, type TenantScope } from '../../db/tenant.ts';
import { ApiError } from '../../common/errors.ts';
import { auditService } from '../audit/audit.service.ts';
import { resolveTxtRecords } from './dns.ts';

/** Where managed subdomains live. One place, so it cannot drift. */
export const MANAGED_SUFFIX = process.env['PAATHSHALA_DOMAIN'] ?? 'paathshala.app';

/** The DNS record a school adds to prove a custom domain is theirs. */
export const VERIFY_RECORD = '_paathshala-verify';

export interface DomainRow {
  id: string;
  tenant_id: string;
  host: string;
  kind: 'managed' | 'custom';
  verified_at: string | null;
  verify_token: string;
  is_primary: boolean;
}

/**
 * A hostname label from a school's name.
 *
 * Deliberately strict: lowercase, digits and single hyphens, never leading or
 * trailing. A label that is merely *usually* valid produces a school that
 * cannot be reached and a support ticket nobody can reproduce.
 */
export function slugify(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return slug;
}

/** Hosts we will never hand out, whatever a school is called. */
const RESERVED = new Set([
  'www', 'api', 'app', 'admin', 'console', 'platform', 'status', 'docs',
  'mail', 'smtp', 'imap', 'ns1', 'ns2', 'cdn', 'static', 'assets',
  'support', 'help', 'billing', 'login', 'auth', 'dev', 'staging', 'test',
]);

export const domainService = {
  /**
   * Picks a free managed subdomain for a school.
   *
   * Suffixes a number rather than failing, because provisioning must not stop
   * because two trusts are both called "St Mary's".
   */
  async allocateManaged(actorUserId: string, tenantId: string, displayName: string):
  Promise<DomainRow> {
    const base = slugify(displayName) || 'school';
    if (base.length < 3) {
      throw ApiError.make('validation_error', 'name_too_short_for_host',
        'That name does not make a usable web address. Pick one explicitly.');
    }

    const row = await withPlatform(async (db) => {
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const label = attempt === 0 ? base : `${base}-${attempt + 1}`;
        if (RESERVED.has(label)) continue;
        const host = `${label}.${MANAGED_SUFFIX}`;

        const { rows } = await db.query<DomainRow>(
          `INSERT INTO tenant_domain (tenant_id, host, kind, verified_at, is_primary)
           VALUES ($1, $2, 'managed', now(),
                   NOT EXISTS (SELECT 1 FROM tenant_domain WHERE tenant_id = $1 AND is_primary))
           ON CONFLICT (host) DO NOTHING
           RETURNING id, tenant_id, host, kind, verified_at, verify_token, is_primary`,
          [tenantId, host]);
        if (rows[0]) return rows[0];
      }
      throw ApiError.make('conflict', 'no_host_available',
        'Could not find a free web address for that name.');
    });

    await auditService.record({
      tenantId, actorUserId, action: 'domain.allocated',
      resourceType: 'tenant_domain', resourceId: row.id,
      classification: 'INTERNAL', after: { host: row.host, kind: 'managed' },
    });
    return row;
  },

  /**
   * Registers a custom domain, unverified.
   *
   * Returns the TXT record the school has to publish. Nothing routes until
   * `verify` has actually read that record back out of DNS.
   */
  async addCustom(actorUserId: string, tenantId: string, host: string):
  Promise<DomainRow & { record: string; value: string }> {
    const normalised = host.trim().toLowerCase().replace(/\.$/, '');
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(normalised)) {
      throw ApiError.make('validation_error', 'not_a_hostname',
        'That is not a hostname.');
    }
    if (normalised.endsWith(`.${MANAGED_SUFFIX}`) || normalised === MANAGED_SUFFIX) {
      // Otherwise a school could claim a subdomain of ours through the custom
      // path and skip the reserved-name list entirely.
      throw ApiError.make('validation_error', 'not_yours_to_claim',
        `Subdomains of ${MANAGED_SUFFIX} are allocated, not claimed.`);
    }

    const row = await withPlatform(async (db) => {
      const { rows } = await db.query<DomainRow>(
        `INSERT INTO tenant_domain (tenant_id, host, kind) VALUES ($1, $2, 'custom')
         ON CONFLICT (host) DO NOTHING
         RETURNING id, tenant_id, host, kind, verified_at, verify_token, is_primary`,
        [tenantId, normalised]);
      if (!rows[0]) {
        // Deliberately does not say which school holds it. That would turn this
        // endpoint into a way to ask who our customers are.
        throw ApiError.make('conflict', 'host_taken',
          'That hostname is already registered.');
      }
      return rows[0];
    });

    await auditService.record({
      tenantId, actorUserId, action: 'domain.custom_added',
      resourceType: 'tenant_domain', resourceId: row.id,
      classification: 'INTERNAL', after: { host: row.host },
    });

    return { ...row, record: `${VERIFY_RECORD}.${row.host}`, value: row.verify_token };
  },

  /**
   * Checks DNS and marks the domain verified if the token is there.
   *
   * The token is compared against every TXT value on the record, because a
   * domain can legitimately carry several and picking only the first would fail
   * for anybody who also verifies with Google or Microsoft.
   */
  async verify(actorUserId: string, domainId: string): Promise<DomainRow> {
    const row = await withPlatform(async (db) => {
      const { rows } = await db.query<DomainRow>(
        `SELECT id, tenant_id, host, kind, verified_at, verify_token, is_primary
           FROM tenant_domain WHERE id = $1`, [domainId]);
      if (!rows[0]) throw ApiError.make('not_found', 'domain_not_found', 'No such domain.');
      return rows[0];
    });

    if (row.verified_at) return row;

    const records = await resolveTxtRecords(`${VERIFY_RECORD}.${row.host}`);
    if (!records.includes(row.verify_token)) {
      throw ApiError.make('validation_error', 'verification_record_missing',
        `Add a TXT record at ${VERIFY_RECORD}.${row.host} with the value shown, `
        + 'then try again. DNS can take a few minutes to propagate.');
    }

    const verified = await withPlatform(async (db) => {
      const { rows } = await db.query<DomainRow>(
        `UPDATE tenant_domain SET verified_at = now() WHERE id = $1 AND verified_at IS NULL
         RETURNING id, tenant_id, host, kind, verified_at, verify_token, is_primary`,
        [domainId]);
      return rows[0] ?? row;
    });

    await auditService.record({
      tenantId: row.tenant_id, actorUserId, action: 'domain.verified',
      resourceType: 'tenant_domain', resourceId: row.id,
      classification: 'INTERNAL', after: { host: row.host },
    });
    return verified;
  },

  /** Makes one host canonical. The others keep working and redirect. */
  async setPrimary(actorUserId: string, domainId: string): Promise<void> {
    await withPlatform(async (db) => {
      const { rows } = await db.query<{ tenant_id: string; verified_at: string | null }>(
        'SELECT tenant_id, verified_at FROM tenant_domain WHERE id = $1', [domainId]);
      const domain = rows[0];
      if (!domain) throw ApiError.make('not_found', 'domain_not_found', 'No such domain.');
      if (!domain.verified_at) {
        throw ApiError.make('conflict', 'not_verified',
          'An unverified domain cannot be the primary one.');
      }
      await db.query(
        'UPDATE tenant_domain SET is_primary = false WHERE tenant_id = $1',
        [domain.tenant_id]);
      await db.query('UPDATE tenant_domain SET is_primary = true WHERE id = $1', [domainId]);

      await auditService.record({
        tenantId: domain.tenant_id, actorUserId, action: 'domain.primary_changed',
        resourceType: 'tenant_domain', resourceId: domainId, classification: 'INTERNAL',
      });
    });
  },

  async listForTenant(scope: TenantScope): Promise<DomainRow[]> {
    return withTenant(scope, async (db) => {
      const { rows } = await db.query<DomainRow>(
        `SELECT id, tenant_id, host, kind, verified_at, verify_token, is_primary
           FROM tenant_domain ORDER BY is_primary DESC, host`);
      return rows;
    });
  },

  async listAll(): Promise<DomainRow[]> {
    return withPlatform(async (db) => {
      const { rows } = await db.query<DomainRow>(
        `SELECT id, tenant_id, host, kind, verified_at, verify_token, is_primary
           FROM tenant_domain ORDER BY host`);
      return rows;
    });
  },
};
