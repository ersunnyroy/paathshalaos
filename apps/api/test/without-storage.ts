/**
 * Import this second — straight after `./fixtures.ts` — in a suite that must
 * run as a deployment with no bucket and no virus scanner.
 *
 * `fixtures.ts` loads `apps/api/.env`, and since M38 `run-local.sh` writes
 * `OBJECT_STORE_*` and `CLAMD_HOST` into that file. A suite whose comment says
 * "this suite configures none, deliberately" was therefore configured by the
 * developer's own machine, and failed there while passing in CI. The
 * environment a test asserts about has to be set by the test.
 *
 * It must run before anything calls `loadEnv()`, which caches on first use —
 * hence the import order, and hence a module rather than a `beforeAll`.
 */
for (const key of Object.keys(process.env)) {
  if (key.startsWith('OBJECT_STORE_') || key.startsWith('CLAMD_')) delete process.env[key];
}
