/**
 * The fourth pool, for platform administration.
 *
 * It creates schools and lists them. It holds no grant on `person`, `student`,
 * `invoice`, `attendance_record` or anything else that lives inside a school —
 * not a policy that filters those tables, no grant at all, so reaching for one
 * raises `permission denied` rather than returning an empty set somebody could
 * mistake for a working query.
 *
 * That distinction is the whole design. An admin console is the obvious place
 * for a role that can see everything, and a role that can see everything undoes
 * every guarantee the rest of this system makes. Support access to a tenant's
 * records stays what migration 0008 made it: a time-boxed, two-person, audited
 * impersonation session, which is a different thing entirely from a console.
 */
import pg from 'pg';
import { loadEnv } from '../config/env.ts';
import { logger } from '../common/logger.ts';

const env = loadEnv();

export const platformPool = new pg.Pool({
  connectionString: env.DATABASE_PLATFORM_URL,
  max: 4,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  application_name: 'paathshala-platform',
});

platformPool.on('error', (err) => logger.error({ err }, 'idle platform pool client error'));

/** Proves at boot that the console cannot read inside a school. */
export async function assertPlatformRoleCannotReadTenants(): Promise<void> {
  const { rows } = await platformPool.query<{
    rolsuper: boolean; rolbypassrls: boolean; rolname: string;
  }>('SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user');
  const role = rows[0];
  if (!role) throw new Error('Could not resolve the platform database role.');
  if (role.rolsuper || role.rolbypassrls) {
    throw new Error(
      `Platform role "${role.rolname}" can bypass row-level security. Refusing to start.`);
  }

  // Named tables rather than a blanket check, because the list is the promise.
  // A future migration that grants one of these fails the boot.
  for (const table of ['student', 'person', 'invoice', 'attendance_record', 'message_recipient']) {
    const { rows: has } = await platformPool.query<{ has: boolean }>(
      'SELECT has_table_privilege(current_user, $1, $2) AS has', [table, 'SELECT']);
    if (has[0]?.has) {
      throw new Error(
        `The platform role can read "${table}". It provisions schools and lists them; `
        + 'reading inside one is what impersonation is for. Refusing to start.');
    }
  }

  // And it must not be able to read a password hash, even though it writes one.
  const { rows: hash } = await platformPool.query<{ has: boolean }>(
    `SELECT has_column_privilege(current_user, 'user_account', 'password_hash', 'SELECT') AS has`);
  if (hash[0]?.has) {
    throw new Error(
      'The platform role can read password hashes. It creates the first owner login '
      + 'and has no reason to read one back. Refusing to start.');
  }
}

export async function closePlatformPool(): Promise<void> {
  await platformPool.end();
}

/**
 * Runs platform work in one transaction.
 *
 * No tenant setting, because a platform operation is not inside a tenant. The
 * policies on the platform tables are `USING (true)` for this role and the role
 * has no grant on anything else — so "which tenant am I" is not a question that
 * arises, and pretending it did would invite somebody to set it and widen the
 * role later.
 */
export async function withPlatform<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await platformPool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
