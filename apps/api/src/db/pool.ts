import pg from 'pg';
import { loadEnv } from '../config/env.ts';
import { logger } from '../common/logger.ts';

const env = loadEnv();

/**
 * Money is numeric(14,2). node-postgres returns numerics as strings by default,
 * which is correct — parsing them into IEEE doubles is how rounding bugs get
 * into a fee ledger. We keep that behaviour explicitly so nobody "fixes" it.
 */
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v: string) => v);
pg.types.setTypeParser(pg.types.builtins.INT8, (v: string) => BigInt(v));

export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  application_name: 'paathshala-api',
});

pool.on('error', (err) => {
  logger.error({ err }, 'idle postgres client error');
});

/**
 * Boot-time assertion, not a comment in a runbook: the role the API connects as
 * must not be able to see past row-level security. If this ever passes silently
 * because someone granted SUPERUSER to unblock a migration, every tenant
 * boundary in the product is gone.
 */
export async function assertAppRoleCannotBypassRls(): Promise<void> {
  const { rows } = await pool.query<{ rolsuper: boolean; rolbypassrls: boolean; rolname: string }>(
    'SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
  );
  const role = rows[0];
  if (!role) throw new Error('Could not resolve current database role.');
  if (role.rolsuper || role.rolbypassrls) {
    throw new Error(
      `Database role "${role.rolname}" can bypass row-level security ` +
        `(superuser=${role.rolsuper}, bypassrls=${role.rolbypassrls}). ` +
        'The API must connect as an unprivileged role. Refusing to start.',
    );
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
}
