/**
 * Creates the two unprivileged application roles. Runs as the owner role, once,
 * before the first migration.
 *
 * Kept separate from migrations on purpose: roles are cluster-level objects, not
 * schema objects, so they do not belong in a versioned schema history.
 *
 *   paathshala_app      serves tenant requests. No credential access.
 *   paathshala_auth     serves login and token refresh. No tenant data access.
 *   paathshala_health   the RESTRICTED columns on a learner, and nothing else.
 *   paathshala_platform creates schools and lists them. No grant on anything
 *                       inside one — not a filtered view, no grant at all.
 *
 * Neither may bypass row-level security, and this script takes that back on
 * every run in case somebody granted it to unblock something.
 */
import pg from 'pg';
import { loadDotenv } from '../config/load-dotenv.ts';
import { loadEnv } from '../config/env.ts';

loadDotenv();
const env = loadEnv();

interface RoleSpec {
  name: string;
  url: string;
}

function passwordFromUrl(url: string, label: string): string {
  const pw = decodeURIComponent(new URL(url).password);
  if (!pw) throw new Error(`${label} has no password.`);
  return pw;
}

async function ensureRole(client: pg.Client, spec: RoleSpec, dbName: string): Promise<void> {
  const password = passwordFromUrl(spec.url, spec.name);

  const { rows } = await client.query<{ exists: boolean }>(
    'SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS exists',
    [spec.name],
  );

  if (rows[0]?.exists) {
    console.log(`role ${spec.name} already exists`);
  } else {
    // CREATE ROLE cannot take bind parameters, so the password is quoted by
    // Postgres itself with quote_literal() and the already-escaped result is
    // interpolated. Role names are module constants, never user input.
    const quoted = await client.query<{ lit: string }>('SELECT quote_literal($1) AS lit', [password]);
    await client.query(`CREATE ROLE ${spec.name} LOGIN PASSWORD ${quoted.rows[0]!.lit}`);
    console.log(`created role ${spec.name}`);
  }

  await client.query(`ALTER ROLE ${spec.name} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`);
  await client.query(`GRANT CONNECT ON DATABASE ${dbName} TO ${spec.name}`);
  console.log(`${spec.name} is NOSUPERUSER NOBYPASSRLS — ok`);
}

async function main(): Promise<void> {
  const dbName = new URL(env.DATABASE_OWNER_URL).pathname.slice(1);
  if (!/^[a-zA-Z0-9_]+$/.test(dbName)) {
    throw new Error(`Refusing to interpolate an unexpected database name: ${dbName}`);
  }

  const client = new pg.Client({ connectionString: env.DATABASE_OWNER_URL });
  await client.connect();
  try {
    await ensureRole(client, { name: 'paathshala_app', url: env.DATABASE_URL }, dbName);
    await ensureRole(client, { name: 'paathshala_auth', url: env.DATABASE_AUTH_URL }, dbName);
    // Created NOLOGIN by migration 0045, because its grants belong with the
    // columns they protect. Here it gains a password so the pool can connect —
    // the split is deliberate: the migration owns what the role may touch, this
    // owns how it authenticates.
    await ensureRole(client, { name: 'paathshala_health', url: env.DATABASE_HEALTH_URL }, dbName);
    await ensureRole(client, { name: 'paathshala_platform', url: env.DATABASE_PLATFORM_URL }, dbName);
  } finally {
    await client.end();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
