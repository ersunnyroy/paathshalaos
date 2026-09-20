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

    const pending = readMigrations();

    // Names this database has applied that this build does not ship.
    //
    // The runner used to ignore these entirely, and that silence is what makes
    // the resulting failure unreadable. A database migrated by a different
    // revision of this repository — a renamed or renumbered migration, a branch
    // that shipped one and was rebased away, a volume older than a renumbering
    // — has objects in it that no recorded name accounts for. The next
    // migration that creates one of those objects then fails with Postgres's
    // own words, `relation "x" already exists`, which reads as a broken
    // migration rather than as a history that no longer corresponds to this
    // build.
    //
    // This is not fatal on its own: a database ahead of the code is normal
    // mid-deploy, and `assertSchemaMatchesCode` already makes that call at
    // boot. Here it is context, printed before the first statement runs and
    // again on the failure it explains.
    const shippedNames = new Set(pending.map((m) => m.name));
    const unrecognised = done.map((r) => r.name).filter((n) => !shippedNames.has(n)).sort();

    if (unrecognised.length > 0) {
      console.warn(
        `warning: ${unrecognised.length} applied migration(s) are not shipped by this build: ` +
          `${unrecognised.slice(0, 5).join(', ')}${unrecognised.length > 5 ? ', …' : ''}`,
      );
    }

    for (const m of pending) {
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
        const reason = err instanceof Error ? err.message : String(err);
        const divergence =
          unrecognised.length > 0
            ? ` This database has applied ${unrecognised.length} migration(s) this build does ` +
              `not ship (${unrecognised.slice(0, 5).join(', ')}` +
              `${unrecognised.length > 5 ? ', …' : ''}), so it was migrated by a different ` +
              'revision of this repository and its recorded history no longer accounts for ' +
              'every object in it. That is the likely cause, and re-running will not clear it.'
            : '';
        throw new Error(`Migration ${m.name} failed: ${reason}.${divergence}`);
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
