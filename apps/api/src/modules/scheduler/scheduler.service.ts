/**
 * The runner (M33.1).
 *
 * Deliberately a service and not a loop inside a worker file. The worker is
 * twenty lines of `while (running)`; everything that can be wrong — claiming,
 * leasing, retrying, recording — is here, where a test can drive it one tick at
 * a time without spawning a process. The webhook relay made the same split and
 * for the same reason.
 *
 * ## Claiming, without a lock table
 *
 * A worker claims by UPDATE-ing `next_run_at` forward. Two workers racing for
 * the same row serialise on the row lock, and the loser's `WHERE next_run_at <=
 * now()` no longer matches, so it gets nothing. `FOR UPDATE SKIP LOCKED` in the
 * subquery means the loser moves on to a different task instead of waiting.
 *
 * The lease exists for the other failure: a worker that dies mid-run would
 * otherwise hold `running_since` forever and the task would never run again —
 * silently, which is the failure mode this entire milestone exists to end.
 */
import pg from 'pg';
import { jobs, type JobDetail } from './jobs.ts';
import { logger } from '../../common/logger.ts';
import { scheduledTaskRuns, scheduledTaskAge } from '../../common/telemetry/metrics.ts';

export interface TaskOutcome {
  key: string;
  status: 'ok' | 'partial' | 'failed' | 'skipped';
  tenants: number;
  failed: number;
  error?: string;
}

/**
 * A connection that can see every tenant.
 *
 * The scheduler's own bookkeeping is cross-tenant by nature — one row per task
 * for the whole fleet — so it runs on the owner connection, the same explicitly
 * named exception the webhook relay takes. The JOBS do not get this connection:
 * they are handed a tenant scope and go through the ordinary pooled path, where
 * every policy applies.
 */
export interface Admin {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string, params?: readonly unknown[],
  ): Promise<{ rows: R[]; rowCount: number }>;
}

interface Claim { key: string; description: string }

/**
 * Takes the single most overdue task, or nothing.
 *
 * One at a time rather than all due at once, so that two workers share the
 * work instead of one worker taking everything and the other idling.
 */
export async function claim(admin: Admin, now = 'now()'): Promise<Claim | null> {
  const { rows } = await admin.query<Claim>(
    `UPDATE scheduled_task t
        SET running_since   = ${now},
            last_started_at = ${now},
            next_run_at     = ${now} + make_interval(secs => t.interval_seconds)
      WHERE t.key = (
        SELECT key FROM scheduled_task
         WHERE enabled
           AND next_run_at <= ${now}
           AND (running_since IS NULL
                OR running_since < ${now} - make_interval(secs => lease_seconds))
         ORDER BY next_run_at
         FOR UPDATE SKIP LOCKED
         LIMIT 1)
      RETURNING t.key, t.description`);
  return rows[0] ?? null;
}

/** Every tenant this job should visit. The one cross-tenant read, named. */
async function tenantIds(admin: Admin): Promise<string[]> {
  const { rows } = await admin.query<{ id: string }>(
    'SELECT id FROM organization WHERE deleted_at IS NULL ORDER BY created_at');
  return rows.map((r) => r.id);
}

async function record(
  admin: Admin, tenantId: string, key: string,
  outcome: { status: 'ok' | 'failed'; detail?: JobDetail; error?: string },
): Promise<void> {
  await admin.query(
    `INSERT INTO task_run (tenant_id, task_key, finished_at, status, detail, error)
     VALUES ($1::uuid, $2, now(), $3, $4::jsonb, $5)`,
    [tenantId, key, outcome.status,
     outcome.detail ? JSON.stringify(outcome.detail) : null,
     outcome.error ?? null]);
}

/**
 * Runs one claimed task across every tenant.
 *
 * A tenant that throws does not stop the others. That is the difference
 * between "the purge failed for one school" and "the purge stopped running",
 * and the second is what happens when a loop has no try/catch inside it.
 */
export async function runClaimed(admin: Admin, key: string): Promise<TaskOutcome> {
  const job = jobs[key];
  if (!job) {
    // A task in the table that this build does not implement. Reported rather
    // than ignored: the safe direction is that a job removed from the registry
    // stops running and SAYS so, not that a deploy silently drops a compliance
    // job and the row sits there looking scheduled.
    const error = `no job registered for '${key}' in this build`;
    await admin.query(
      `UPDATE scheduled_task
          SET running_since = NULL, last_finished_at = now(),
              last_status = 'failed', last_error = $2,
              consecutive_failures = consecutive_failures + 1
        WHERE key = $1`, [key, error]);
    logger.error({ task: key }, error);
    scheduledTaskRuns.inc({ task: key, status: 'failed' });
    return { key, status: 'skipped', tenants: 0, failed: 0, error };
  }

  const tenants = await tenantIds(admin);
  let failed = 0;
  let firstError: string | undefined;

  for (const tenantId of tenants) {
    try {
      const detail = await job({ tenantId });
      await record(admin, tenantId, key, { status: 'ok', detail });
    } catch (err) {
      failed += 1;
      const message = err instanceof Error ? err.message : String(err);
      firstError ??= message;
      await record(admin, tenantId, key, { status: 'failed', error: message });
      logger.error({ task: key, tenantId, err }, 'scheduled task failed for tenant');
    }
  }

  const status: TaskOutcome['status'] =
    failed === 0 ? 'ok' : failed === tenants.length ? 'failed' : 'partial';

  await admin.query(
    `UPDATE scheduled_task
        SET running_since = NULL, last_finished_at = now(),
            last_status = $2, last_error = $3,
            -- Reset only on a clean run. A task failing for one school out of
            -- four hundred every night is a task that is failing.
            consecutive_failures = CASE WHEN $2 = 'ok' THEN 0
                                        ELSE consecutive_failures + 1 END
      WHERE key = $1`,
    [key, status, firstError ?? null]);

  scheduledTaskRuns.inc({ task: key, status });
  if (status === 'ok') scheduledTaskAge.set({ task: key }, 0);

  return { key, status, tenants: tenants.length, failed,
    ...(firstError ? { error: firstError } : {}) };
}

/**
 * One tick: claim what is due and run it. Returns what it did, or null.
 *
 * Separated from the loop so a test can advance the scheduler deterministically
 * instead of sleeping.
 */
export async function tick(admin: Admin): Promise<TaskOutcome | null> {
  const claimed = await claim(admin);
  if (!claimed) return null;
  logger.info({ task: claimed.key }, 'scheduled task started');
  return runClaimed(admin, claimed.key);
}

/**
 * How long since each task last finished cleanly, in seconds.
 *
 * Sampled rather than counted, because the number that matters is an ABSENCE:
 * a task that stopped running produces no events at all, so nothing
 * event-driven can alert on it. This is the gauge that would have caught the
 * whole of M33 years earlier.
 */
export async function sampleAges(admin: Admin): Promise<void> {
  const { rows } = await admin.query<{ key: string; age: string | null }>(
    `SELECT key,
            extract(epoch FROM now() - last_finished_at)::text AS age
       FROM scheduled_task WHERE enabled`);
  for (const row of rows) {
    if (row.age === null) {
      // Never run. Not zero — a gauge that cannot read must not report a
      // comfortable number, which is the lesson M23 already paid for.
      scheduledTaskAge.remove({ task: row.key });
      continue;
    }
    scheduledTaskAge.set({ task: row.key }, Number(row.age));
  }
}

export async function forceDue(admin: Admin, key: string): Promise<boolean> {
  const { rowCount } = await admin.query(
    `UPDATE scheduled_task SET next_run_at = now(), running_since = NULL
      WHERE key = $1 AND enabled`, [key]);
  return rowCount > 0;
}
