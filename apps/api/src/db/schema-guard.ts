/**
 * What this process believes the schema is, checked against what it is (M22.1).
 *
 * The failure this exists for is the one that corrupts data rather than
 * breaking pages: a process serving traffic against a schema it does not
 * understand. It has two shapes, and they are not symmetrical.
 *
 * **The database is BEHIND the code.** The process ships migrations that have
 * not been applied, so it will query columns that do not exist. Every request
 * touching them fails — noisily, which is the good case — but a request that
 * merely WRITES may succeed against a table missing a constraint that the new
 * migration was going to add. This is a refusal to start. There is no
 * legitimate deployment in which code runs ahead of its own migrations.
 *
 * **The database is AHEAD of the code.** Migrations are applied that this
 * process does not ship. During a rolling deploy this is normal and transient:
 * the new version migrates, and old instances keep serving until they are
 * replaced. Refusing here would make every deploy fail at the first step.
 *
 * So the asymmetry is deliberate: behind is fatal, ahead is reported. Reported
 * to a metric rather than only to a log, because M23 already has an alert
 * watching for instances that disagree about the schema — `SchemaVersionSplit`
 * — and the thing that alert needs is for every instance to say what it thinks.
 *
 * A checksum mismatch is fatal in either direction. It means an applied
 * migration's text changed, so nobody can say what this database's schema
 * actually is.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withPlatform } from './platform-pool.ts';
import { logger } from '../common/logger.ts';
import { schemaVersion, schemaAhead } from '../common/telemetry/metrics.ts';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

export interface SchemaState {
  shipped: number;
  applied: number;
  /** Applied here and not shipped by this build — a newer deploy went first. */
  ahead: string[];
  /** Shipped by this build and not applied — this process must not serve. */
  behind: string[];
  /** Applied under a different text than this build ships. */
  changed: string[];
}

export function shippedMigrations(): Array<{ name: string; checksum: string }> {
  if (!existsSync(MIGRATIONS_DIR)) return [];
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((name) => ({
      name,
      checksum: createHash('sha256')
        .update(readFileSync(join(MIGRATIONS_DIR, name), 'utf8'))
        .digest('hex'),
    }));
}

/** Pure, so the comparison is testable without a database. */
export function compareSchema(
  shipped: ReadonlyArray<{ name: string; checksum: string }>,
  applied: ReadonlyArray<{ name: string; checksum: string }>,
): SchemaState {
  const appliedBy = new Map(applied.map((m) => [m.name, m.checksum]));
  const shippedBy = new Map(shipped.map((m) => [m.name, m.checksum]));

  return {
    shipped: shipped.length,
    applied: applied.length,
    ahead: applied.filter((m) => !shippedBy.has(m.name)).map((m) => m.name),
    behind: shipped.filter((m) => !appliedBy.has(m.name)).map((m) => m.name),
    changed: shipped
      .filter((m) => appliedBy.has(m.name) && appliedBy.get(m.name) !== m.checksum)
      .map((m) => m.name),
  };
}

export class SchemaMismatchError extends Error {}

/**
 * Called at boot, before the first request is served.
 *
 * Runs on the platform pool, through `app_schema_migrations()` rather than
 * against the table — the platform role has no grant on `schema_migration`,
 * deliberately, and 0075 gives it the answer instead of the table. The same
 * shape 0070 used for the backlog counts.
 */
export async function assertSchemaMatchesCode(): Promise<SchemaState> {
  const shipped = shippedMigrations();
  const applied = await withPlatform(async (db) => {
    const { rows } = await db.query<{ name: string; checksum: string }>(
      'SELECT name, checksum FROM app_schema_migrations()');
    return rows;
  });

  const state = compareSchema(shipped, applied);
  schemaVersion.set(state.applied);
  schemaAhead.set(state.ahead.length);

  if (state.changed.length > 0) {
    throw new SchemaMismatchError(
      `These migrations were applied under different text than this build ships: `
      + `${state.changed.join(', ')}. Nobody can say what this database's schema `
      + 'is. Refusing to start.');
  }

  if (state.behind.length > 0) {
    throw new SchemaMismatchError(
      `${state.behind.length} migration(s) this build ships have not been applied: `
      + `${state.behind.slice(0, 5).join(', ')}${state.behind.length > 5 ? ', …' : ''}. `
      + 'Run the migrations before starting this version. Refusing to start.');
  }

  if (state.ahead.length > 0) {
    // Normal during a rolling deploy, and a real problem if it persists —
    // which is the distinction an alert can make and a boot check cannot.
    logger.warn({
      ahead: state.ahead.length, newest: state.ahead.at(-1),
      shipped: state.shipped, applied: state.applied,
    }, 'the database has migrations this build does not ship');
  } else {
    logger.info({ migrations: state.applied }, 'schema matches this build');
  }

  return state;
}
