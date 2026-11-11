/**
 * Writes the spec to disk at build time.
 *
 * A file rather than only a live endpoint, so it can be committed, diffed in a
 * pull request, and served as a static asset by the docs page. A breaking change
 * to the contract should show up as a red line in a review, not as a surprise
 * for somebody's integration.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSpec } from './spec.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const out = join(root, 'openapi.json');

const spec = buildSpec();
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(spec, null, 2)}\n`);

const paths = Object.keys((spec as { paths: Record<string, unknown> }).paths).length;
console.log(`wrote ${out} (${paths} paths)`);
