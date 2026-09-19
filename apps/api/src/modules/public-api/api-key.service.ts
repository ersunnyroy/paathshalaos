/**
 * API clients and keys.
 *
 * The credential is presented as `Authorization: Bearer <prefix>.<secret>` —
 * one header, two parts. The prefix is the indexed lookup and is safe to log;
 * the secret after the dot never is. Splitting them this way means
 * authentication is a single-row fetch by unique index rather than a scan that
 * hashes every key in the table, and it means a key found in a log file is
 * identifiable without being usable.
 *
 * Authentication runs on the AUTH pool, for the same reason login does: the
 * role that reads a credential is not the role that reads tenant data, so a
 * flaw in one cannot reach the other. It is also the only honest way to do it —
 * at authentication time nobody knows the tenant yet, so there is no tenant
 * scope to run under.
 */
import { authPool } from '../../db/auth-pool.ts';
import { withTenant, type TenantScope } from '../../db/tenant.ts';
import { ApiError } from '../../common/errors.ts';
import { auditService } from '../audit/audit.service.ts';

export interface ApiIdentity {
  apiKeyId: string;
  tenantId: string;
  apiClientId: string;
  scopes: string[];
  ratePerMin: number;
}

export interface ApiClientRow {
  id: string; name: string; description: string | null;
  scopes: string[]; status: string; rate_per_min: number; created_at: string;
}

export interface ApiKeyRow {
  id: string; api_client_id: string; prefix: string; last_four: string;
  label: string | null; created_at: string; expires_at: string | null;
  revoked_at: string | null; last_used_at: string | null;
}

/** Splits the credential. Returns null on anything that is not the right shape. */
export function parseCredential(raw: string): { prefix: string; secret: string } | null {
  const dot = raw.indexOf('.');
  if (dot <= 0 || dot === raw.length - 1) return null;
  const prefix = raw.slice(0, dot);
  const secret = raw.slice(dot + 1);
  if (!/^pk_(live|test)_[0-9a-f]{16}$/.test(prefix)) return null;
  if (!/^[0-9a-f]{64}$/.test(secret)) return null;
  return { prefix, secret };
}

export const apiKeyService = {
  /**
   * Verifies a credential.
   *
   * Returns the same public message for every rejection while keeping the real
   * reason for the audit record. "Expired" told to the caller is a small
   * oracle — it confirms the key existed — and the person who needs that
   * distinction is the institute reading their own log, not whoever is holding
   * the key.
   */
  async authenticate(credential: string): Promise<ApiIdentity> {
    const parsed = parseCredential(credential);
    if (!parsed) {
      throw ApiError.make('authentication_error', 'invalid_api_key',
        'That API key is not valid.');
    }

    const { rows } = await authPool.query<{
      ok: boolean; reason: string; api_key_id: string | null; tenant_id: string | null;
      api_client_id: string | null; scopes: string[] | null; rate_per_min: number | null;
    }>('SELECT * FROM api_key_authenticate($1, $2)', [parsed.prefix, parsed.secret]);

    const row = rows[0];
    if (!row?.ok) {
      throw ApiError.make('authentication_error', 'invalid_api_key',
        'That API key is not valid.');
    }

    return {
      apiKeyId: row.api_key_id!,
      tenantId: row.tenant_id!,
      apiClientId: row.api_client_id!,
      scopes: row.scopes!,
      ratePerMin: row.rate_per_min!,
    };
  },

  /* ---------------------------------------------------------- management */

  async createClient(
    scope: TenantScope,
    input: { name: string; scopes: string[]; description?: string | undefined;
             ratePerMin?: number | undefined },
  ): Promise<ApiClientRow> {
    return withTenant(scope, async (db) => {
      const { rows } = await db.query<ApiClientRow>(
        `INSERT INTO api_client (tenant_id, name, description, scopes, rate_per_min, created_by)
         VALUES (app_current_tenant_id(), $1, $2, $3::text[], COALESCE($4, 120), app_current_actor_id())
         RETURNING id, name, description, scopes, status, rate_per_min, created_at`,
        // Sorted and de-duplicated on the way in, so two clients with the same
        // authority compare equal and a diff of the audit log is readable.
        [input.name, input.description ?? null,
         [...new Set(input.scopes)].sort(), input.ratePerMin ?? null]);
      const row = rows[0]!;
      await auditService.record({
        tenantId: scope.tenantId, action: 'api_client.created',
        resourceType: 'api_client', resourceId: row.id,
        after: { name: row.name, scopes: row.scopes },
      });
      return row;
    });
  },

  async listClients(scope: TenantScope): Promise<ApiClientRow[]> {
    return withTenant(scope, async (db) => {
      const { rows } = await db.query<ApiClientRow>(
        `SELECT id, name, description, scopes, status, rate_per_min, created_at
           FROM api_client ORDER BY created_at DESC`);
      return rows;
    });
  },

  /**
   * Mints a key. The secret is in this return value and nowhere else, ever
   * again — there is deliberately no endpoint that reads it back.
   */
  async issueKey(
    scope: TenantScope,
    input: { clientId: string; label?: string | undefined; expiresAt?: string | undefined;
             live?: boolean | undefined },
  ): Promise<{ id: string; prefix: string; credential: string }> {
    return withTenant(scope, async (db) => {
      const { rows } = await db.query<{ api_key_id: string; prefix: string; secret: string }>(
        'SELECT * FROM api_key_issue($1, $2, $3, $4)',
        [input.clientId, input.label ?? null, input.expiresAt ?? null, input.live ?? true]);
      const row = rows[0]!;
      await auditService.record({
        tenantId: scope.tenantId, action: 'api_key.issued',
        resourceType: 'api_key', resourceId: row.api_key_id,
        classification: 'RESTRICTED',
        // The prefix identifies the key in the log without being the key.
        after: { prefix: row.prefix, client_id: input.clientId },
      });
      return {
        id: row.api_key_id,
        prefix: row.prefix,
        credential: `${row.prefix}.${row.secret}`,
      };
    });
  },

  async listKeys(scope: TenantScope): Promise<ApiKeyRow[]> {
    return withTenant(scope, async (db) => {
      const { rows } = await db.query<ApiKeyRow>(
        `SELECT id, api_client_id, prefix, last_four, label, created_at,
                expires_at, revoked_at, last_used_at
           FROM api_key ORDER BY created_at DESC`);
      return rows;
    });
  },

  /**
   * Revocation is immediate and one-way. No un-revoke: a key believed leaked is
   * leaked, and an endpoint that could restore it turns "we revoked it" into a
   * thing that has to be checked rather than a thing that is true.
   */
  async revokeKey(scope: TenantScope, keyId: string): Promise<void> {
    await withTenant(scope, async (db) => {
      const { rowCount } = await db.query(
        `UPDATE api_key SET revoked_at = now(), revoked_by = app_current_actor_id()
          WHERE id = $1 AND revoked_at IS NULL`, [keyId]);
      if (rowCount === 0) {
        throw ApiError.make('not_found', 'api_key_not_found',
          'No such API key, or it was already revoked.');
      }
      await auditService.record({
        tenantId: scope.tenantId, action: 'api_key.revoked',
        resourceType: 'api_key', resourceId: keyId, classification: 'RESTRICTED',
      });
    });
  },
};
