/**
 * A third pool on a third role, for the RESTRICTED columns on `student`.
 *
 * `paathshala_app` deliberately has no column privilege on blood_group,
 * medical_note, accommodations or the emergency contacts — see migration 0045.
 * That closes the way those fields would actually leak, which is not somebody
 * writing `SELECT medical_note` but somebody writing `SELECT *` in a debug log
 * or a generic row serialiser.
 *
 * The role is narrow on purpose. It reads those five columns and enough
 * identity to know whose they are, and holds no privilege on money, attendance,
 * results or messaging. A role that could reach those as well would get used
 * for convenience and stop being a boundary within a month.
 *
 * Row-level security still applies to it exactly as to the app role: a field
 * grant widens which COLUMNS are visible, never which rows.
 */
import pg from 'pg';
import { loadEnv } from '../config/env.ts';
import { logger } from '../common/logger.ts';

const env = loadEnv();

export const healthPool = new pg.Pool({
  connectionString: env.DATABASE_HEALTH_URL,
  // Small on purpose: this is a rare read, and a large pool would invite using
  // it as a general-purpose connection.
  max: 4,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  application_name: 'paathshala-health',
});

healthPool.on('error', (err) => logger.error({ err }, 'idle health pool client error'));

/** Proves at boot that the third role is as narrow as it claims to be. */
export async function assertHealthRoleIsNarrow(): Promise<void> {
  const { rows } = await healthPool.query<{
    rolsuper: boolean; rolbypassrls: boolean; rolname: string;
  }>('SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user');
  const role = rows[0];
  if (!role) throw new Error('Could not resolve the health database role.');
  if (role.rolsuper || role.rolbypassrls) {
    throw new Error(`Health role "${role.rolname}" can bypass row-level security. Refusing to start.`);
  }

  // If a future migration grants this role something it should not have, the
  // boot fails rather than the boundary widening quietly.
  const leak = await healthPool.query<{ has: boolean }>(
    `SELECT has_table_privilege(current_user, 'invoice', 'SELECT') AS has`);
  if (leak.rows[0]?.has) {
    throw new Error(
      'The health role can read invoices. It is meant to reach the RESTRICTED '
      + 'columns on student and nothing else. Refusing to start.');
  }
}

export async function closeHealthPool(): Promise<void> {
  await healthPool.end();
}

/**
 * Runs one read or write of the restricted fields, tenant-scoped.
 *
 * Mirrors withTenant() rather than reusing it, because reuse would mean one
 * function that can run on either pool — and the whole point is that the choice
 * of pool is explicit at every call site.
 */
export async function withHealthScope<T>(
  scope: { tenantId: string; actorId: string },
  fn: (client: { query: pg.Pool['query'] }) => Promise<T>,
): Promise<T> {
  const client = await healthPool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', ['app.tenant_id', scope.tenantId]);
    await client.query('SELECT set_config($1, $2, true)', ['app.actor_id', scope.actorId]);
    const result = await fn(client as unknown as { query: pg.Pool['query'] });
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
