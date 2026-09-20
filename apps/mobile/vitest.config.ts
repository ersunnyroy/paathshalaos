import { defineConfig } from 'vitest/config';

/**
 * Node only, and deliberately so.
 *
 * Nothing under test here renders. The screens are kept thin on purpose and
 * the logic they lean on — the offline queue and the API client — lives in
 * shared packages with their own suites. What this config covers is the two
 * adapters that bind those packages to a device, and those take their native
 * module as an argument so they can be exercised without one.
 */
export default defineConfig({
  test: { include: ['test/**/*.spec.ts'], environment: 'node' },
});
