/**
 * The scheduler process (M33.1).
 *
 * Thin on purpose: claiming, leasing, retrying and recording are in
 * `scheduler.service.ts`, where a test drives them a tick at a time. What is
 * here is the loop, the signals, and the connection.
 *
 * A separate process from the API, for the reasons the webhook relay already
 * gives — and one more that is specific to this. These jobs touch every tenant
 * and one of them seals the audit log. Running them inside the request path
 * would mean a school's traffic decides when its own audit trail is sealed,
 * and a busy Monday morning would delay the thing that makes the trail
 * defensible.
 *
 * Several copies may run. The claim is an UPDATE, so they share the work
 * rather than duplicating it; see the service.
 */
import pg from 'pg';
import { loadDotenv } from '../config/load-dotenv.ts';

loadDotenv();

const { loadEnv } = await import('../config/env.ts');
const env = loadEnv();
const { logger } = await import('../common/logger.ts');
const { tick, sampleAges } = await import('../modules/scheduler/scheduler.service.ts');
const { closePool } = await import('../db/pool.ts');
const { closeMaintenancePool } = await import('../db/maintenance.ts');

/**
 * How often to look for work.
 *
 * Fifteen seconds, against tasks whose shortest interval is an hour. The gap is
 * deliberate: the cost of asking is one indexed query returning nothing, and
 * the benefit is that "run this now" from the console happens within seconds
 * rather than at the top of the hour.
 */
const IDLE_MS = 15_000;
/** ...and immediately again when something ran, in case more is due. */
const BUSY_MS = 250;

let running = true;

async function main(): Promise<void> {
  const admin = new pg.Client({ connectionString: env.DATABASE_OWNER_URL });
  await admin.connect();
  logger.info('scheduler started');

  try {
    while (running) {
      let busy = false;
      try {
        const outcome = await tick(admin);
        if (outcome) {
          busy = true;
          logger.info({ ...outcome }, 'scheduled task finished');
        }
        await sampleAges(admin);
      } catch (err) {
        // The loop must outlive any one failure, including a failure to talk to
        // the database at all. A scheduler that exits on a blip is a scheduler
        // that has silently stopped, which is the exact failure this whole
        // subsystem exists to end.
        logger.error({ err }, 'scheduler tick failed');
      }
      await new Promise((r) => setTimeout(r, busy ? BUSY_MS : IDLE_MS));
    }
  } finally {
    await admin.end().catch(() => undefined);
    await closeMaintenancePool().catch(() => undefined);
    await closePool();
    logger.info('scheduler stopped');
  }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  // Finishes the task in flight. Abandoning one mid-run leaves `running_since`
  // set and the task held until its lease expires — correct, but a needless
  // delay to something that was about to finish anyway.
  process.on(signal, () => { logger.info({ signal }, 'draining'); running = false; });
}

await main();
