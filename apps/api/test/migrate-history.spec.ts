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
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate, duplicateOrdinals } from '../src/db/migrate.ts';
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

/**
 * The other way `relation "plan" already exists` happens — and the one that
 * actually happened.
 *
 * The suite above assumed a divergent database: a volume carrying schema from
 * another revision. That diagnosis was half of it. The failure recurred on a
 * clean checkout against a database whose recorded history was exactly right,
 * and the divergence warning stayed silent because there was nothing to warn
 * about — every applied name was shipped by the build.
 *
 * The build was shipping too much. `copy-assets.mjs` used `cpSync` into
 * `dist/db/migrations` without emptying it, and `cpSync` merges: three
 * migrations renamed in `src/` months earlier were still in `dist/`, invisible
 * to `git status` and to anyone reading the source. Six files occupied three
 * ordinals; the runner applied `0059_plans.sql`, then applied
 * `0059_plan_catalogue.sql`, which creates the same table.
 *
 * Locally that is a loud build failure. On a fresh production database it is
 * silent: SQL that exists nowhere in this repository gets applied and recorded
 * in `schema_migration` as though it were ours.
 *
 * `duplicateOrdinals` is tested here against fabricated names rather than
 * against `src/db/migrations`, which has no duplicates — a check that has only
 * ever seen a correct directory passes whether or not it works, and emptying
 * its filter would have killed nothing.
 */
describe('two migrations claiming one ordinal', () => {
  it('finds the pair, whichever order the directory lists them in', () => {
    const found = duplicateOrdinals([
      '0058_platform_capabilities_of.sql',
      '0059_plan_catalogue.sql',
      '0059_plans.sql',
      '0060_plan_actor_fks.sql',
    ]);
    expect(found).toEqual([['0059_plan_catalogue.sql', '0059_plans.sql']]);

    const reversed = duplicateOrdinals([
      '0059_plans.sql', '0059_plan_catalogue.sql',
    ]);
    expect(reversed, 'the pair is the pair regardless of listing order')
      .toEqual([['0059_plan_catalogue.sql', '0059_plans.sql']]);
  });

  it('finds every clash, not just the first', () => {
    // The real dist/ carried three of them. A check that returned after the
    // first would have made the second build failure a fresh mystery.
    expect(duplicateOrdinals([
      '0059_plans.sql', '0059_plan_catalogue.sql',
      '0060_plan_actor_fks.sql', '0060_subscriptions.sql',
      '0061_event_actor_stays.sql', '0061_entitlement_gates.sql',
    ])).toHaveLength(3);
  });

  it('says nothing about a directory that is fine', () => {
    expect(duplicateOrdinals([
      '0001_extensions_and_conventions.sql', '0002_tenancy.sql', '0003_rls.sql',
    ])).toEqual([]);
  });

  it('does not mistake a longer ordinal for a shorter one', () => {
    // '0059' and '00590' are different migrations. A prefix match rather than
    // a full leading-digit match would have paired them.
    expect(duplicateOrdinals(['0059_plans.sql', '00590_plans.sql'])).toEqual([]);
  });

  it('agrees that this build ships no duplicates', () => {
    const names = readdirSync(join(dirname(fileURLToPath(import.meta.url)),
      '..', 'src', 'db', 'migrations')).filter((f) => f.endsWith('.sql'));
    expect(names.length, 'reading the real directory, not an empty one')
      .toBeGreaterThan(80);
    expect(duplicateOrdinals(names)).toEqual([]);
  });
});
