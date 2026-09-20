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
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

/**
 * The scheduler is actually deployed (M33.1).
 *
 * The whole of M33 is one failure repeated four times: work that was described
 * in a comment and never arranged. A scheduler that exists in `src/`, passes
 * its tests, and is not in the compose file is the fifth instance of exactly
 * that — so the deployment is asserted rather than assumed.
 */
describe('the scheduler ships', () => {
  it('compiles to an entry point somebody can run', () => {
    expect(existsSync(join(DIST, 'workers', 'scheduler.js'))).toBe(true);
    const pkg = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as
      { scripts: Record<string, string> };
    expect(pkg.scripts['scheduler']).toContain('dist/workers/scheduler.js');
  });

  it('is a service in the compose file, beside the relay', () => {
    // Not a thread inside the API. Its own process, so an on-call engineer can
    // stop a fleet-wide purge without taking a school's app offline.
    const compose = readFileSync(
      new URL('../../../docker-compose.yml', import.meta.url), 'utf8');
    expect(compose).toMatch(/^ {2}scheduler:$/m);
    expect(compose).toContain('dist/workers/scheduler.js');
  });
});

/**
 * The build output is a mirror of the source, not an accumulation of it.
 *
 * `copy-assets.mjs` used `cpSync` into `dist/db/migrations` without emptying
 * it first, and `cpSync` merges: it adds and overwrites, and never removes. So
 * three migrations renamed in `src/` months earlier were still sitting in
 * `dist/` — invisible to `git status`, invisible to anyone reading the source,
 * and shipped by every build since.
 *
 * Six files then occupied three ordinals. The runner sorts by filename, so it
 * applied `0059_plans.sql`, then applied `0059_plan_catalogue.sql`, which
 * creates the same table, and the build died on Postgres's own words:
 * `relation "plan" already exists`. That reads as a broken migration. The
 * migration was fine.
 *
 * The local failure is the mild version. On a fresh production database it is
 * silent — SQL that exists nowhere in this repository gets applied and
 * recorded in `schema_migration` as though it were ours.
 *
 * Asserted by planting a stray file and rebuilding, because the passing state
 * is indistinguishable either way: `dist/` is correct right now whether the
 * copier mirrors or merges, so a test that only checked the current directory
 * would pass against the bug it exists to catch.
 */
describe('the build output mirrors the source', () => {
  const stray = join(DIST, 'db', 'migrations', '0059_a_migration_that_was_renamed.sql');

  afterAll(() => {
    if (existsSync(stray)) rmSync(stray);
  });

  it('removes a file that is no longer in src/', () => {
    writeFileSync(stray, '-- left over from a rename\nSELECT 1;\n');
    expect(existsSync(stray)).toBe(true);

    execFileSync('node', [join(API_ROOT, 'scripts', 'copy-assets.mjs')],
      { cwd: API_ROOT, encoding: 'utf8' });

    expect(existsSync(stray), 'dist still carries a migration src/ has not had for months')
      .toBe(false);
  });

  it('carries exactly what src/ carries, name for name', () => {
    const sql = (dir: string) => readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    expect(sql(join(DIST, 'db', 'migrations')))
      .toEqual(sql(join(API_ROOT, 'src', 'db', 'migrations')));
  });
});

/**
 * Storage ships with the thing that stores.
 *
 * M37 gave this product its first object-storage client. The failure mode it
 * was closing is a feature that exists in code and has nothing to run against,
 * so shipping the client without shipping a store to point it at would be the
 * same mistake one layer up: a local setup where uploads silently do not work
 * is how "nothing has ever opened a connection to object storage" happens
 * again.
 *
 * These assertions are about two files agreeing. `docker-compose.yml` starts
 * MinIO with a root user and a bucket; `run-local.sh` writes the credentials
 * into `apps/api/.env`. Nothing checks that at runtime — a mismatch is a
 * `SignatureDoesNotMatch` on the first upload, which says nothing about which
 * of the two files is wrong.
 */
describe('a local setup can actually store a file', () => {
  const compose = readFileSync(
    new URL('../../../docker-compose.yml', import.meta.url), 'utf8');
  const runLocal = readFileSync(
    new URL('../../../run-local.sh', import.meta.url), 'utf8');

  it('starts an S3-compatible store and creates the bucket', () => {
    expect(compose).toMatch(/^ {2}minio:$/m);
    // A one-shot container rather than an entrypoint script, so a failure to
    // create the bucket is a failed container somebody can see.
    expect(compose).toMatch(/^ {2}minio-bucket:$/m);
    expect(compose).toContain('mc mb --ignore-existing local/paathshala');
  });

  it('writes credentials that match the ones MinIO is started with', () => {
    // The mismatch this exists for produces `SignatureDoesNotMatch` on the
    // first upload, which names neither file.
    const user = /MINIO_ROOT_USER:\s*(\S+)/.exec(compose)?.[1];
    const password = /MINIO_ROOT_PASSWORD:\s*(\S+)/.exec(compose)?.[1];
    expect(user).toBeTruthy();
    expect(password).toBeTruthy();
    expect(runLocal).toContain(`OBJECT_STORE_ACCESS_KEY_ID=${user}`);
    expect(runLocal).toContain(`OBJECT_STORE_SECRET_ACCESS_KEY=${password}`);
  });

  it('uses path-style addressing, which MinIO requires', () => {
    // Virtual-host addressing needs DNS for every bucket. Without this the
    // failure is a 404 that reads like a missing object.
    expect(runLocal).toContain('OBJECT_STORE_FORCE_PATH_STYLE=true');
  });

  it('adds the storage block to an .env written before it existed', () => {
    // Same reason as the database roles: a file missing one variable refuses
    // to boot on a validation error, and "left alone" straight into a failure
    // is the worst kind of helpful.
    expect(runLocal).toContain('if ! grep -q "OBJECT_STORE_BUCKET" apps/api/.env');
  });

  it('ships a scanner, and does not require it to be up', () => {
    expect(compose).toMatch(/^ {2}clamav:$/m);
    // Nothing depends_on it. It downloads a few hundred megabytes of
    // signatures on first start, and the API treats a scanner that is not
    // there as "failed" rather than "clean", so the rest of the product works
    // while it warms up.
    const services = compose.split(/^ {2}(?=\S)/m);
    for (const service of services) {
      if (/^(api|migrate|scheduler|bootstrap):/.test(service)) {
        expect(service, 'nothing may wait on clamav to start')
          .not.toContain('clamav');
      }
    }
  });
});
