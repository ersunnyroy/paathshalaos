/**
 * Migration runner. Ordered .sql files, applied once, recorded with a checksum.
 *
 * Runs as the owner role. The application role has no DDL rights, which is why
 * this is a separate entry point with a separate connection string rather than
 * something the API can do at boot.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { loadDotenv } from '../config/load-dotenv.ts';
import { loadEnv } from '../config/env.ts';

loadDotenv();
const env = loadEnv();

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

interface Migration {
  name: string;
  sql: string;
  checksum: string;
}

function readMigrations(): Migration[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((name) => {
      const sql = readFileSync(join(MIGRATIONS_DIR, name), 'utf8');
      return { name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
    });
}

export async function migrate(connectionString = env.DATABASE_OWNER_URL): Promise<number> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  let applied = 0;

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migration (
        name        text PRIMARY KEY,
        checksum    text NOT NULL,
        applied_at  timestamptz NOT NULL DEFAULT now()
      )
    `);

    const { rows: done } = await client.query<{ name: string; checksum: string }>(
      'SELECT name, checksum FROM schema_migration',
    );
    const seen = new Map(done.map((r) => [r.name, r.checksum]));

    for (const m of readMigrations()) {
      const previous = seen.get(m.name);

      if (previous === m.checksum) continue;

      if (previous !== undefined) {
        // An applied migration was edited. Silently re-running it would make
        // this database diverge from every other one.
        throw new Error(
          `Migration ${m.name} has already been applied but its contents changed. ` +
            'Add a new migration instead of editing an applied one.',
        );
      }

      // Each migration is one transaction: it applies completely or not at all.
      await client.query('BEGIN');
      try {
        await client.query(m.sql);
        await client.query('INSERT INTO schema_migration (name, checksum) VALUES ($1, $2)', [
          m.name,
          m.checksum,
        ]);
        await client.query('COMMIT');
        console.log(`applied ${m.name}`);
        applied += 1;
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${m.name} failed: ${err instanceof Error ? err.message : err}`);
      }
    }

    if (applied === 0) console.log('database is up to date');
    return applied;
  } finally {
    await client.end();
  }
}

/**
 * True when this file was run directly, rather than imported by a test.
 *
 * Compared by resolved path, not by filename suffix. The previous version
 * tested `endsWith('migrate.ts')`, which was true only while this ran off
 * TypeScript source — so the moment the entry points were compiled, the guard
 * went false and `node dist/db/migrate.js` exited 0 having applied nothing.
 *
 * That is the worst shape a bug can take here. It does not crash, it does not
 * warn, and the next command succeeds against an empty database. Both paths are
 * realpath'd because pnpm's node_modules are a forest of symlinks.
 */
const isDirectRun = (() => {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  migrate().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
