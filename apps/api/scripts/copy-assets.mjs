/**
 * Copies non-TypeScript build inputs into dist/.
 *
 * Only the migrations, for now. tsc emits .js and nothing else, so a compiled
 * migrate.js looks for `migrations/` next to itself and finds an empty
 * directory — the runner reports "0 migrations" and exits successfully, which
 * is the worst possible failure: it looks like everything is already applied.
 *
 * The alternative is to resolve the migrations from src/ at runtime, which
 * works locally and breaks the moment dist/ is deployed without the source
 * beside it. Copying keeps dist/ self-contained, which is what a build artifact
 * should be.
 *
 * **The destination is emptied first, and that is the whole point of this
 * file's second version.** `cpSync` merges: it adds and overwrites, and never
 * removes. So a migration that was renamed or renumbered in `src/` stayed in
 * `dist/` forever, and every later build kept shipping it. A developer looking
 * at `src/db/migrations` could not see it and `git status` could not show it.
 *
 * What that costs, in the order it bites:
 *
 *   locally   two files claim ordinal 0059 — the real one and its ghost — and
 *             the runner applies both. The second re-runs DDL the first just
 *             ran, and the build dies on `relation "plan" already exists`,
 *             which reads as a broken migration rather than as a stale file.
 *
 *   in prod   far worse and entirely silent: a fresh database gets SQL that no
 *             longer exists anywhere in this repository, applied by a runner
 *             that records it in `schema_migration` as though it were ours. The
 *             schema then diverges from the code by exactly the statements
 *             nobody can read any more.
 *
 * A build artifact that accumulates is not a build artifact. `dist/db/migrations`
 * is now a mirror of `src/db/migrations` or the build fails.
 *
 * Two files claiming one ordinal is checked in `db/migrate.ts` rather than
 * here. The same mistake is makeable by hand — two branches both numbering
 * 0086 — so the check belongs where the files are about to be applied, not
 * where they are copied, and one implementation is better than two that can
 * disagree.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const from = join(root, 'src', 'db', 'migrations');
const to = join(root, 'dist', 'db', 'migrations');

if (!existsSync(from)) {
  console.error(`No migrations at ${from}`);
  process.exit(1);
}

const sources = readdirSync(from).filter((f) => f.endsWith('.sql'));

// Emptied, not merged. See the note above.
rmSync(to, { recursive: true, force: true });
mkdirSync(to, { recursive: true });
cpSync(from, to, { recursive: true });

const copied = readdirSync(to).filter((f) => f.endsWith('.sql'));
if (copied.length === 0) {
  // A silent zero here would let the build "succeed" into a dist that cannot
  // migrate anything.
  console.error('Copied no .sql files — refusing to call that a build.');
  process.exit(1);
}
if (copied.length !== sources.length) {
  console.error(`Copied ${copied.length} of ${sources.length} migrations — dist is not a mirror.`);
  process.exit(1);
}
console.log(`copied ${copied.length} migrations to dist/db/migrations`);
