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
 */
import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const from = join(root, 'src', 'db', 'migrations');
const to = join(root, 'dist', 'db', 'migrations');

if (!existsSync(from)) {
  console.error(`No migrations at ${from}`);
  process.exit(1);
}

mkdirSync(to, { recursive: true });
cpSync(from, to, { recursive: true });

const count = readdirSync(to).filter((f) => f.endsWith('.sql')).length;
if (count === 0) {
  // A silent zero here would let the build "succeed" into a dist that cannot
  // migrate anything.
  console.error('Copied no .sql files — refusing to call that a build.');
  process.exit(1);
}
console.log(`copied ${count} migrations to dist/db/migrations`);
