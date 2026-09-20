/**
 * The numbers that are a question to the database, not a count of events.
 *
 * Sampled when Prometheus asks rather than on a timer. A backlog gauge driven
 * by its own `setInterval` keeps reporting the last number it saw when the
 * loop that updates it dies — which is exactly the failure a backlog gauge
 * exists to catch, reported as "fine".
 *
 * Every query here is cheap and bounded, and every one runs as a role that
 * cannot read a school's records: these are counts across all tenants, which is
 * a platform question.
 */
import { withPlatform, platformPool } from '../../db/platform-pool.ts';
import { pool } from '../../db/pool.ts';
import { authPool } from '../../db/auth-pool.ts';
import { healthPool } from '../../db/health-pool.ts';
import {
  webhookBacklog, outboxBacklog, schemaVersion, poolWaiting, poolInUse,
  gaugeSamplingOk,
} from './metrics.ts';
import { logger } from '../logger.ts';

const POOLS = [
  ['app', pool], ['auth', authPool], ['health', healthPool],
  ['platform', platformPool],
] as const;

export async function sampleGauges(): Promise<void> {
  for (const [role, p] of POOLS) {
    poolWaiting.set({ role }, p.waitingCount);
    poolInUse.set({ role }, p.totalCount - p.idleCount);
  }

  try {
    // One function, not three queries against three tables. The platform role
    // has no grant on any of them and must not gain one — see 0070.
    await withPlatform(async (db) => {
      const { rows } = await db.query<{
        webhooks: string; outbox: string; migrations: string;
      }>('SELECT webhooks::text, outbox::text, migrations::text FROM app_platform_backlogs()');
      const row = rows[0];
      if (!row) throw new Error('app_platform_backlogs returned no row');
      webhookBacklog.set(Number(row.webhooks));
      outboxBacklog.set(Number(row.outbox));
      schemaVersion.set(Number(row.migrations));
      gaugeSamplingOk.set(1);
    });
  } catch (err) {
    // A scrape must not 500 because the database is busy — that turns one
    // problem into two, and the alert that fires is "metrics endpoint down"
    // rather than the one that matters.
    //
    // But it must not leave a number behind either. Removing the series makes
    // Prometheus see them go stale; setting them to 0 would say "nothing is
    // stuck", which is the one answer that is certainly wrong. The first
    // version of this did exactly that, for a whole milestone, while its own
    // comment warned about a different route to the same lie.
    webhookBacklog.remove();
    outboxBacklog.remove();
    schemaVersion.remove();
    gaugeSamplingOk.set(0);
    logger.warn({ err: (err as Error).message }, 'gauge sampling failed');
  }
}
