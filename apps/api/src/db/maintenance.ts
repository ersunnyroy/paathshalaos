/**
 * The connection a scheduled job runs on (M33.2).
 *
 * ## Why `withTenant` is wrong for a job, and how that was found
 *
 * The obvious way to run a job for a school is `withTenant({ tenantId })` — the
 * shape the webhook relay uses. That works for the relay because the tables it
 * touches have tenant-only policies. It is silently wrong for everything else,
 * and the tables a compliance job touches are exactly the wrong ones:
 *
 *   `file`                  staff_only:   tenant AND app_actor_has_staff_scope()
 *   `application_document`  staff_only:   tenant AND app_actor_has_staff_scope()
 *   `ledger_entry`          finance_only: tenant AND app_actor_has_finance_scope()
 *
 * A job has no actor. Every one of those predicates is therefore false, every
 * query returns nothing, and the job reports success having examined zero rows.
 * The retention purge would have run every night for years, deleted nothing,
 * and written "applicationsConsidered: 0" into its own evidence trail.
 *
 * That is the same failure `scope.ts` warns about — "an empty list looks like
 * 'no data yet', which is how an authorisation bug ships" — and it was found
 * here only because one test asserted that a deliberately broken ledger made
 * the job FAIL.
 *
 * ## What this does instead, and why it is not an escape hatch
 *
 * It runs on the owner connection with `app.tenant_id` set, so the SQL the jobs
 * already write — `WHERE tenant_id = app_current_tenant_id()`, or a policy-free
 * query inside one tenant's transaction — means what it says, while row-level
 * security no longer stands between a maintenance task and the rows it exists
 * to maintain.
 *
 * Three things keep that honest:
 *
 *   It is named. `withTenant`'s own comment says code that needs to cross a
 *     boundary "uses a different, explicitly named entry point so that it shows
 *     up in review". This is that entry point.
 *   It sets no actor. A job is not a person, and one that borrowed a person's
 *     id would put that id on audit rows for work they did not do.
 *   Only the scheduler may import it, and a test enforces that rather than a
 *     convention.
 */
import pg from 'pg';
import { loadEnv } from '../config/env.ts';
import type { TenantClient } from './tenant.ts';

let maintenancePool: pg.Pool | undefined;

function ownerPool(): pg.Pool {
  maintenancePool ??= new pg.Pool({
    connectionString: loadEnv().DATABASE_OWNER_URL,
    // Two. Scheduled work is sequential by design and must never be able to
    // starve anything else of connections — a purge that slowed the sign-in
    // path would be a worse outage than the data it was minimising.
    max: 2,
    application_name: 'paathshala/scheduler',
  });
  return maintenancePool;
}

/**
 * Runs `fn` inside one tenant's transaction, on the owner connection.
 *
 * `app.tenant_id` is set with `set_config(..., true)`, the transaction-local
 * form, so a pooled connection cannot carry one school's scope into the next
 * job that borrows it — the same guarantee `withTenant` gives and for the same
 * reason.
 */
export async function withMaintenance<T>(
  tenantId: string,
  fn: (client: TenantClient) => Promise<T>,
): Promise<T> {
  if (!tenantId) throw new Error('withMaintenance called without a tenantId.');

  const client = await ownerPool().connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('app.tenant_id', $1, true),
              set_config('app.actor_id', '', true),
              set_config('app.api_client_id', '', true)`,
      [tenantId]);

    const result = await fn({
      query: async (text, params) => {
        const r = await client.query(text, params ? [...params] : undefined);
        return { rows: r.rows, rowCount: r.rowCount ?? 0 };
      },
    });

    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function closeMaintenancePool(): Promise<void> {
  const p = maintenancePool;
  maintenancePool = undefined;
  await p?.end();
}
