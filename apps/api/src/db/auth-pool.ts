import pg from 'pg';
import { loadEnv } from '../config/env.ts';
import { logger } from '../common/logger.ts';

const env = loadEnv();

/**
 * A second pool on a second database role, used only by the authentication
 * module. It can read credentials; it holds no privilege on any tenant table.
 *
 * The separation is the point. If the login path is compromised, the blast
 * radius is identity, not every student record in every tenant — and if a
 * tenant-facing query is compromised, it cannot reach a password hash.
 */
export const authPool = new pg.Pool({
  connectionString: env.DATABASE_AUTH_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  application_name: 'paathshala-auth',
});

authPool.on('error', (err) => logger.error({ err }, 'idle auth pool client error'));

/** Proves at boot that the separation is real and not just intended. */
export async function assertAuthRoleIsIsolated(): Promise<void> {
  const { rows } = await authPool.query<{ rolsuper: boolean; rolbypassrls: boolean; rolname: string }>(
    'SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
  );
  const role = rows[0];
  if (!role) throw new Error('Could not resolve the auth database role.');
  if (role.rolsuper || role.rolbypassrls) {
    throw new Error(`Auth role "${role.rolname}" can bypass row-level security. Refusing to start.`);
  }

  // The auth role must not be able to read tenant data. If a future migration
  // grants it something, this fails the boot rather than widening quietly.
  const leak = await authPool.query<{ has: boolean }>(
    `SELECT has_table_privilege(current_user, 'campus', 'SELECT') AS has`,
  );
  if (leak.rows[0]?.has) {
    throw new Error('Auth role can read tenant tables. The privilege separation is broken.');
  }
}

export async function closeAuthPool(): Promise<void> {
  await authPool.end();
}
