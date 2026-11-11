import type { PoolClient, QueryResultRow } from 'pg';
import { pool } from './pool.ts';
import { getContext } from '../common/request-context.ts';

export interface TenantScope {
  tenantId: string;
  actorId?: string | undefined;
  /**
   * Set instead of actorId when the caller is an API client. Never both: a
   * machine acting "as" the person who created its key would inherit authority
   * nobody reviewed and would keep it after that person left.
   */
  apiClientId?: string | undefined;
}

export interface TenantClient {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: readonly unknown[],
  ): Promise<{ rows: R[]; rowCount: number }>;
}

/**
 * The only sanctioned way to touch the database.
 *
 * Everything runs inside one transaction that has set `app.tenant_id`, because
 * that is what the row-level security policies read. `set_config(..., true)`
 * is the parameterised form of `SET LOCAL`: it is scoped to this transaction
 * and released on commit or rollback, so a pooled connection can never leak one
 * tenant's scope into the next request that borrows it.
 *
 * There is deliberately no escape hatch here. Code that needs to cross tenants
 * (platform reporting, migrations) uses a different, explicitly named entry
 * point so that it shows up in review.
 */
export async function withTenant<T>(
  scope: TenantScope,
  fn: (client: TenantClient) => Promise<T>,
): Promise<T> {
  if (!scope.tenantId) {
    throw new Error('withTenant called without a tenantId.');
  }

  const client: PoolClient = await pool.connect();
  try {
    await client.query('BEGIN');

    // One round trip for the whole scope, not one per setting.
    //
    // This was three statements, and on the hot path that is three round trips
    // before any real work. `set_config` composes in a single SELECT, and the
    // empty string is what the reader functions already treat as absent —
    // `NULLIF(current_setting('app.actor_id', true), '')` — so passing '' for
    // a scope that has no actor means exactly what omitting the statement did.
    //
    // `application_name` rides along because it is the only field of a
    // Postgres log line that this process controls. With the request id in it,
    // a slow query in pg_stat_activity or the server log can be traced back to
    // the request that caused it, which is otherwise guesswork. M23 calls that
    // "a request id that survives across services"; the database is a service.
    await client.query(
      `SELECT set_config('app.tenant_id', $1, true),
              set_config('app.actor_id', $2, true),
              set_config('app.api_client_id', $3, true),
              set_config('application_name', $4, true)`,
      [scope.tenantId, scope.actorId ?? '', scope.apiClientId ?? '',
       // Bounded: application_name is truncated by Postgres at NAMEDATALEN and
       // a request id is already length-checked, but the prefix makes the
       // total predictable rather than nearly-the-limit.
       `paathshala/${getContext()?.requestId ?? 'none'}`.slice(0, 63)]);

    const result = await fn({
      query: async (text, params) => {
        const r = await client.query(text, params ? [...params] : undefined);
        return { rows: r.rows, rowCount: r.rowCount ?? 0 };
      },
    });

    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Convenience wrapper that takes the tenant from the ambient request context. */
export async function withCurrentTenant<T>(fn: (client: TenantClient) => Promise<T>): Promise<T> {
  const ctx = getContext();
  if (!ctx?.tenantId) {
    throw new Error('No tenant in request context. A query was attempted outside a tenant scope.');
  }
  return withTenant({
    tenantId: ctx.tenantId,
    ...(ctx.actorId ? { actorId: ctx.actorId } : {}),
    ...(ctx.apiClientId ? { apiClientId: ctx.apiClientId } : {}),
  }, fn);
}
