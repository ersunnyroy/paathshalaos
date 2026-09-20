/**
 * The compiled entry points actually run.
 *
 * Every other suite imports from `src/` and exercises logic. This one spawns
 * what a person actually types — `node dist/db/migrate.js` — because two bugs
 * got through that no logic test could see:
 *
 *   The scripts ran off `.ts` with `--experimental-strip-types`, which exists
 *   only on Node 22.6+ and fails on anything older with `node: bad option`.
 *
 *   Once compiled, `migrate.js` exited **0 having applied nothing**. Its
 *   direct-run guard tested `argv[1].endsWith('migrate.ts')`, which stopped
 *   being true the moment it was compiled — and a migration runner that
 *   succeeds silently against an empty database is worse than one that crashes,
 *   because the next command runs against a schema that does not exist.
 *
 * So the assertions are about packaging: does the binary exist, does it carry
 * its SQL, does it do the thing, and is it idempotent.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { OWNER_URL } from './fixtures.ts';

const API_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(API_ROOT, 'dist');
const DB = `pkg_check_${Date.now()}`;

/** A scratch database, so this cannot disturb the one the other suites use. */
function adminUrl(): string {
  const url = new URL(OWNER_URL);
  url.pathname = '/postgres';
  return url.toString();
}
function scratchUrl(): string {
  const url = new URL(OWNER_URL);
  url.pathname = `/${DB}`;
  return url.toString();
}

async function onAdmin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: adminUrl() });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

const built = existsSync(join(DIST, 'db', 'migrate.js'));

function run(script: string): string {
  return execFileSync(process.execPath, [join(DIST, 'db', script)], {
    cwd: API_ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      // Only the owner url matters to the runner, but env validation demands
      // the whole set, so the others point at the scratch database too.
      DATABASE_OWNER_URL: scratchUrl(),
      DATABASE_URL: scratchUrl(),
      DATABASE_AUTH_URL: scratchUrl(),
      DATABASE_HEALTH_URL: scratchUrl(),
      DATABASE_PLATFORM_URL: scratchUrl(),
    },
  });
}

// The documented order is bootstrap, then migrate. Bootstrap creates the
// unprivileged roles, which are cluster-level; the migrations then grant them
// what they may touch. Running migrate alone against a fresh database is not a
// supported path, and pretending otherwise in a test would have hidden a real
// ordering requirement rather than asserting it.
const runMigrate = () => run('migrate.js');
const runBootstrap = () => run('bootstrap.js');

beforeAll(async () => {
  if (!built) return;
  await onAdmin(async (c) => {
    await c.query(`DROP DATABASE IF EXISTS ${DB}`);
    await c.query(`CREATE DATABASE ${DB}`);
  });
  runBootstrap();
});

afterAll(async () => {
  if (!built) return;
  await onAdmin((c) => c.query(`DROP DATABASE IF EXISTS ${DB}`));
});

describe.skipIf(!built)('the compiled build', () => {
  it('ships its migrations beside the runner', () => {
    // tsc emits .js and nothing else. Without the copy step in the build, this
    // directory is empty and the runner has nothing to apply.
    const sql = readdirSync(join(DIST, 'db', 'migrations')).filter((f) => f.endsWith('.sql'));
    expect(sql.length).toBeGreaterThan(40);
  });

  it('applies every migration to an empty database', () => {
    const out = runMigrate();
    // Not just "exited 0" — it has to SAY it applied things. Exit 0 with no
    // output was exactly the failure this test exists for.
    //
    // Compared against the directory rather than a hard-coded last filename,
    // which went stale the first time a migration was added after this was
    // written. A test that has to be edited whenever the thing it guards grows
    // is a test people start editing without reading.
    const onDisk = readdirSync(join(DIST, 'db', 'migrations'))
      .filter((f) => f.endsWith('.sql')).sort();
    expect(out).toMatch(/applied 0001_/);
    expect(out).toContain(`applied ${onDisk[onDisk.length - 1]}`);
    const appliedCount = (out.match(/^applied /gm) ?? []).length;
    expect(appliedCount).toBe(onDisk.length);
  });

  it('actually created the schema, not just the bookkeeping table', async () => {
    const c = new pg.Client({ connectionString: scratchUrl() });
    await c.connect();
    try {
      const { rows } = await c.query<{ n: string }>(
        `SELECT count(*) AS n FROM information_schema.tables WHERE table_schema = 'public'`);
      expect(Number(rows[0]!.n)).toBeGreaterThan(50);
    } finally {
      await c.end();
    }
  });

  it('is idempotent on a second run', () => {
    const out = runMigrate();
    expect(out).toContain('database is up to date');
    expect(out).not.toMatch(/applied /);
  });

  it('needs no experimental flags to start', () => {
    // The whole point of compiling these. If a script reintroduces
    // --experimental-strip-types, this fails on any Node below 22.6 — which is
    // the machine the person reporting the bug is on.
    const pkg = JSON.parse(
      readdirSync(API_ROOT).includes('package.json')
        ? execFileSync('cat', [join(API_ROOT, 'package.json')], { encoding: 'utf8' })
        : '{}') as { scripts?: Record<string, string> };
    for (const [name, script] of Object.entries(pkg.scripts ?? {})) {
      expect(`${name}: ${script}`).not.toContain('--experimental-strip-types');
    }
  });
});

describe('the typecheck covers the tests', () => {
  it('has a tsconfig that includes test/, and a build that runs it', () => {
    /*
     * Twenty-seven spec files had never been typechecked. `tsconfig.json`
     * excludes `test` — correctly, because that config emits to `dist` and the
     * tests must not ship — and nothing else picked them up, so a test could
     * assert against a type that did not exist and still go green. A mutation
     * that broke a shared type failed nothing, which is how it surfaced.
     *
     * Three real errors were hiding there, including a test reading a JWT claim
     * the declared type denied existed.
     */
    const test = JSON.parse(
      readFileSync(new URL('../tsconfig.test.json', import.meta.url), 'utf8')) as
      { include: string[]; compilerOptions: { noEmit: boolean } };
    expect(test.include).toContain('test/**/*.ts');
    expect(test.compilerOptions.noEmit).toBe(true);

    const pkg = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as
      { scripts: Record<string, string> };
    expect(pkg.scripts['build'], 'the build must typecheck the tests')
      .toContain('tsconfig.test.json');
  });
});

/**
 * Nothing in the build still asks for a `.ts` file.
 *
 * `rewriteRelativeImportExtensions` turns a `.ts` specifier into `.js` on the
 * way out — for static imports, and for the top-level dynamic ones in
 * `main.ts`. It did NOT rewrite a dynamic `import('./authz.service.ts')`
 * inside a class method, and the built server answered that route with a 500
 * while every test passed: the suite runs from TypeScript source and never
 * loads `dist`.
 *
 * This is the cheapest possible guard against the whole class. It reads the
 * built output rather than the source, which is the only place the mistake is
 * visible.
 */
describe('the built output does not reference TypeScript files', () => {
  it('has no .ts specifier left in any emitted module', () => {
    const offenders: string[] = [];

    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!entry.name.endsWith('.js')) continue;
        const text = readFileSync(full, 'utf8');
        // Only relative specifiers: a package called something.ts is not our
        // problem, and neither is the word `.ts` in a comment or a string of
        // SQL, which is why the quote and the leading dot are both required.
        const bad = text.match(/from\s+['"]\.[^'"]*\.ts['"]|import\(\s*['"]\.[^'"]*\.ts['"]/g);
        if (bad) offenders.push(`${full.slice(DIST.length + 1)}: ${bad[0]}`);
      }
    };
    walk(DIST);

    expect(offenders).toEqual([]);
  });
});
