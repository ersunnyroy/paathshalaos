import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * A 20-line .env reader instead of a dependency. It does not expand variables
 * and it never overwrites a value already present in the real environment,
 * which is what we want in CI and in production.
 */
export function loadDotenv(file = '.env', cwd = process.cwd()): void {
  const path = resolve(cwd, file);
  if (!existsSync(path)) return;

  for (const rawLine of readFileSync(path, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
