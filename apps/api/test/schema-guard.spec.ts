/**
 * M22.1 — the check that stops a process serving traffic against a schema it
 * does not understand.
 *
 * The asymmetry is the whole design and it is the part worth testing: the
 * database being BEHIND the code is fatal, and being AHEAD is not. Getting
 * that backwards either breaks every rolling deploy or lets an instance run
 * against tables it has never heard of.
 */
import './fixtures.ts';
import { describe, it, expect } from 'vitest';
import {
  compareSchema, shippedMigrations, assertSchemaMatchesCode,
  SchemaMismatchError,
} from '../src/db/schema-guard.ts';
import { registry } from '../src/common/telemetry/metrics.ts';
import { platformPool } from '../src/db/platform-pool.ts';

const m = (name: string, checksum = `sum-${name}`) => ({ name, checksum });

describe('comparing what is shipped with what is applied', () => {
  it('says nothing is wrong when they match', () => {
    const both = [m('0001'), m('0002')];
    expect(compareSchema(both, both)).toEqual({
      shipped: 2, applied: 2, ahead: [], behind: [], changed: [],
    });
  });

  it('names the migrations this build ships and the database lacks', () => {
    const state = compareSchema([m('0001'), m('0002')], [m('0001')]);
    expect(state.behind).toEqual(['0002']);
    expect(state.ahead).toEqual([]);
  });

  it('names the migrations the database has and this build lacks', () => {
    const state = compareSchema([m('0001')], [m('0001'), m('0002')]);
    expect(state.ahead).toEqual(['0002']);
    expect(state.behind).toEqual([]);
  });

  it('notices an applied migration whose text has changed', () => {
    const state = compareSchema(
      [m('0001', 'new-text')], [m('0001', 'old-text')]);
    expect(state.changed).toEqual(['0001']);
    // Not also "behind": it IS applied, under different text. Reporting both
    // would send somebody to run migrations, which would do nothing.
    expect(state.behind).toEqual([]);
  });

  it('can be both ahead and behind at once', () => {
    // Two branches deployed out of order — the shape nobody plans for and
    // everybody eventually produces.
    const state = compareSchema(
      [m('0001'), m('0003')], [m('0001'), m('0002')]);
    expect(state.behind).toEqual(['0003']);
    expect(state.ahead).toEqual(['0002']);
  });

  it('handles an empty database', () => {
    const state = compareSchema([m('0001')], []);
    expect(state.behind).toEqual(['0001']);
    expect(state.applied).toBe(0);
  });
});

describe('what this build actually ships', () => {
  it('reads the migrations off disk', () => {
    const shipped = shippedMigrations();
    expect(shipped.length).toBeGreaterThan(60);
    expect(shipped[0]!.name).toMatch(/^0001/);
    // Sorted, because the comparison and the runner both depend on order.
    const names = shipped.map((s) => s.name);
    expect(names).toEqual([...names].sort());
  });

  it('gives every migration a distinct checksum', () => {
    // Two migrations with the same checksum would mean identical text, which
    // is either a copy-paste or a file that was never written.
    const sums = shippedMigrations().map((s) => s.checksum);
    expect(new Set(sums).size).toBe(sums.length);
  });
});

describe('at boot, against the real database', () => {
  it('passes when the code and the database agree', async () => {
    const state = await assertSchemaMatchesCode();
    expect(state.behind).toEqual([]);
    expect(state.changed).toEqual([]);
    expect(state.applied).toBe(state.shipped);
  });

  it('reports the version to the metric an alert watches', async () => {
    await assertSchemaMatchesCode();
    const body = await registry.metrics();
    expect(body).toMatch(/paathshala_schema_migrations_applied\{[^}]*\} [1-9]\d*/);
    expect(body).toMatch(/paathshala_schema_migrations_ahead\{[^}]*\} 0/);
  });

  it('refuses to start when the database is behind', async () => {
    // The fatal direction. This process would query columns that do not exist,
    // and — worse — write rows into a table missing a constraint the pending
    // migration was going to add.
    const real = platformPool.connect.bind(platformPool);
    try {
      await expect(withApplied(() => [])).rejects.toThrow(SchemaMismatchError);
      await expect(withApplied(() => [])).rejects.toThrow(/have not been applied/);
    } finally {
      (platformPool as unknown as { connect: unknown }).connect = real;
    }
  });

  it('starts when the database is ahead', async () => {
    // Normal and transient during a rolling deploy: the new version migrated
    // and this instance has not been replaced yet. Refusing here would make
    // every deploy fail at its first step.
    const shipped = shippedMigrations();
    const state = await withApplied(() => [
      ...shipped, { name: '9999_from_the_future.sql', checksum: 'x' },
    ]);
    expect(state.ahead).toEqual(['9999_from_the_future.sql']);
  });

  it('counts how far ahead, for the alert', async () => {
    const shipped = shippedMigrations();
    await withApplied(() => [
      ...shipped,
      { name: '9998_a.sql', checksum: 'x' },
      { name: '9999_b.sql', checksum: 'y' },
    ]);
    expect(await registry.metrics())
      .toMatch(/paathshala_schema_migrations_ahead\{[^}]*\} 2/);
  });

  it('refuses when an applied migration’s text has changed', async () => {
    // Nobody can say what this database's schema is, so no version of the
    // code is safe to run against it.
    const shipped = shippedMigrations();
    await expect(withApplied(() => shipped.map((s, i) =>
      i === 0 ? { ...s, checksum: 'tampered' } : s)))
      .rejects.toThrow(/different text/);
  });
});

/**
 * Runs the boot check with a substituted `schema_migration` result.
 *
 * The rows are swapped rather than the database, because the point is to
 * exercise the comparison against the migrations this build really ships —
 * a fixture list on both sides would test the pure function again.
 */
async function withApplied(
  rows: () => Array<{ name: string; checksum: string }>,
): Promise<Awaited<ReturnType<typeof assertSchemaMatchesCode>>> {
  const real = platformPool.connect.bind(platformPool);
  (platformPool as unknown as { connect: () => Promise<unknown> }).connect =
    async () => ({
      query: async (text: string) =>
        /schema_migration/.test(text)
          ? { rows: rows(), rowCount: rows().length }
          : { rows: [], rowCount: 0 },
      release: () => undefined,
    });
  try {
    return await assertSchemaMatchesCode();
  } finally {
    (platformPool as unknown as { connect: unknown }).connect = real;
  }
}
