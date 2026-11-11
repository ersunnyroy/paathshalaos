import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      // The package resolving to itself, so the tests import it exactly as a
      // consumer does rather than by relative path — which is what catches a
      // broken `exports` map before a consumer does.
      '@paathshala/api-client': fileURLToPath(new URL('./src/index.ts', import.meta.url)),
    },
  },
  test: { include: ['test/**/*.spec.ts'] },
});
