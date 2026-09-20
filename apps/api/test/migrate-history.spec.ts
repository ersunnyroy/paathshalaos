/**
 * What the migration runner says when the database's recorded history does not
 * correspond to the migrations this build ships.
 *
 * This is the shape that cost an evening: a Postgres volume carrying schema
 * from a different revision of this repository. The runner skipped every name
 * it recognised, reached the first one it did not, and failed with
 * `relation "plan" already exists` — Postgres's words for "you are creating
 * something that is already here", which reads as a broken migration. The
 * migration was fine. The database was migrated by something else.
 *
 * Both assertions below are about the message, because the message is the
 * entire feature. A runner that fails correctly and says the wrong thing sends
 * somebody looking at the wrong file.
 */
import './fixtures.ts';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { migrate } from '../src/db/migrate.ts';
import { loadEnv } from '../src/config/env.ts';

const owner = loadEnv().DATABASE_OWNER_URL;
const scratchName = 'paathshala_migrate_history_test';

function urlFor(db: string): string {
  const u = new URL(owner);
  u.pathname = `/${db}`;
  return u.toString();
}

async function onOwner<T>(fn: (c: pg.Client) => Promise<T>, url = owner): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** Dropping needs no other session attached to it. */
async function dropScratch(): Promise<void> {
  await onOwner(async (c) => {
    await c.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1`,
      [scratchName],
    );
    await c.query(`DROP DATABASE IF EXISTS ${scratchName}`);
  });
}

beforeAll(async () => {
  await dropScratch();
  await onOwner((c) => c.query(`CREATE DATABASE ${scratchName}`));
}, 60_000);

afterAll(dropScratch, 60_000);

describe('a database whose history this build does not recognise', () => {
  it('names the divergence rather than blaming the migration that trips over it', async () => {
    // The state a stale volume is actually in: names recorded that this build
    // has never heard of, and an object one of its own migrations creates
    // already sitting there. Migration 0002 creates `organization`.
    await onOwner(async (c) => {
      await c.query(`
        CREATE TABLE schema_migration (
          name text PRIMARY KEY, checksum text NOT NULL,
          applied_at timestamptz NOT NULL DEFAULT now()
        )`);
      await c.query(
        `INSERT INTO schema_migration (name, checksum) VALUES ('0059_platform_plans.sql', 'x')`,
      );
      await c.query(`CREATE TABLE organization (id uuid PRIMARY KEY)`);
    }, urlFor(scratchName));

    const err = await migrate(urlFor(scratchName)).then(
      () => null,
      (e: unknown) => e as Error,
    );

    expect(err).toBeInstanceOf(Error);
    // The migration that tripped, and Postgres's reason, both still present:
    // removing them to make room for the explanation would be a worse message,
    // not a better one.
    expect(err!.message).toContain('0002_tenancy.sql');
    expect(err!.message).toContain('already exists');
    // And the part that was missing.
    expect(err!.message).toContain('0059_platform_plans.sql');
    expect(err!.message).toContain('different revision of this repository');
    expect(err!.message).toContain('re-running will not clear it');
  }, 120_000);

  it('stays quiet about divergence when there is none', async () => {
    // Same failure, clean history. The sentence about a different revision is
    // a claim about this database; asserting it unconditionally would make it
    // a lie in the ordinary case.
    await onOwner(async (c) => {
      await c.query(`DELETE FROM schema_migration`);
    }, urlFor(scratchName));

    const err = await migrate(urlFor(scratchName)).then(
      () => null,
      (e: unknown) => e as Error,
    );

    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain('already exists');
    expect(err!.message).not.toContain('different revision of this repository');
  }, 120_000);
});
