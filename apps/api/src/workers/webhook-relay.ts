/**
 * The relay. Runs the outbox → delivery loop for every tenant, forever.
 *
 * A separate process from the API, not a setInterval inside it. Three reasons,
 * and the third is the one that matters:
 *
 *   It can be scaled and restarted independently of the request path.
 *   A slow receiver cannot consume the API's event loop.
 *   It can be STOPPED. When a receiver is melting down, "stop the relay" is a
 *   thing an on-call engineer can do without taking the school's app offline.
 *
 * Tenants are enumerated with the owner connection — the only cross-tenant read
 * in the product outside migrations, which is why it lives in a named file
 * rather than behind a flag on a shared helper. Each tenant's work then runs
 * under that tenant's scope, so every policy applies exactly as it does for a
 * request.
 */
import pg from 'pg';
import { loadDotenv } from '../config/load-dotenv.ts';

loadDotenv();

const { loadEnv } = await import('../config/env.ts');
const env = loadEnv();
const { logger } = await import('../common/logger.ts');
const { webhookService } = await import('../modules/webhooks/webhook.service.ts');
const { closePool } = await import('../db/pool.ts');

/** How long to sleep when there was nothing to do. */
const IDLE_MS = 5_000;
/** ...and when there was, so a backlog drains rather than trickles. */
const BUSY_MS = 250;

let running = true;

async function tenantIds(): Promise<string[]> {
  const client = new pg.Client({ connectionString: env.DATABASE_OWNER_URL });
  await client.connect();
  try {
    const { rows } = await client.query<{ id: string }>(
      `SELECT id FROM organization WHERE deleted_at IS NULL`);
    return rows.map((r) => r.id);
  } finally {
    await client.end();
  }
}

/**
 * One pass over one tenant.
 *
 * Errors are logged and swallowed per tenant, deliberately: one school's
 * misconfigured endpoint must not stop every other school's webhooks. The
 * failure is already visible where it belongs — in that tenant's own delivery
 * log, which is what AC-10's third clause is for.
 */
async function pass(tenantId: string): Promise<boolean> {
  try {
    const fanned = await webhookService.fanOut({ tenantId });
    const sent = await webhookService.deliverDue({ tenantId });
    if (fanned.deliveries > 0 || sent.attempted > 0) {
      logger.info({ tenantId, ...fanned, ...sent }, 'webhook relay pass');
      return true;
    }
    return false;
  } catch (err) {
    logger.error({ err, tenantId }, 'webhook relay pass failed');
    return false;
  }
}

async function main(): Promise<void> {
  logger.info('webhook relay started');
  while (running) {
    let busy = false;
    for (const tenantId of await tenantIds()) {
      if (!running) break;
      busy = (await pass(tenantId)) || busy;
    }
    await new Promise((r) => setTimeout(r, busy ? BUSY_MS : IDLE_MS));
  }
  await closePool();
  logger.info('webhook relay stopped');
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  // Finishes the pass in flight rather than abandoning a delivery mid-attempt,
  // which would leave a row claimed and silent until its backoff expires.
  process.on(signal, () => { logger.info({ signal }, 'draining'); running = false; });
}

await main();
