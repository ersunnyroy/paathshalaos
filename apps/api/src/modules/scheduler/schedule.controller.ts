/**
 * What ran, when, and what happened (M33.3).
 *
 * On the platform console rather than in a school's own screens, because this
 * is the operator's view: one row per task for the whole fleet, and the failure
 * it exists to surface — a task that has silently stopped — is invisible from
 * inside any one school.
 *
 * A school's own evidence ("your retention purge ran on the 3rd and removed 412
 * documents") is a different question with a different answer, and `task_run`
 * carries a tenant policy so that it can be asked later from the school's side.
 *
 * ## Read, and one write
 *
 * The one write is "run this now", and it does not run anything: it sets
 * `next_run_at` to now and lets the scheduler pick the task up on its next
 * pass, within fifteen seconds. An endpoint that executed the job inline would
 * put a fleet-wide purge on an HTTP request's timeout, and the first thing
 * anybody would do about a slow one is press it again.
 */
import { Controller, Get, Post, Param, UseGuards } from '@nestjs/common';
import { Public } from '../auth/public.decorator.ts';
import { PlatformGuard, RequiresCapability } from '../platform/platform.guard.ts';
import { withPlatform } from '../../db/platform-pool.ts';
import { ApiError } from '../../common/errors.ts';
import { jobs } from './jobs.ts';

@Public()
@UseGuards(PlatformGuard)
@Controller('platform/v1/schedule')
export class ScheduleController {
  /**
   * Every task, with the two numbers that matter.
   *
   * `seconds_since_success` is the one to read. A task that is failing is
   * loud — a failed run, a log line, a metric. A task that has stopped being
   * claimed at all produces nothing, and the only evidence is that this number
   * keeps growing. It was growing for the whole life of this product.
   */
  @Get()
  @RequiresCapability('support')
  async list() {
    const rows = await withPlatform(async (db) => {
      const { rows } = await db.query(
        `SELECT t.key, t.description, t.enabled, t.interval_seconds,
                t.next_run_at, t.running_since,
                t.last_started_at, t.last_finished_at, t.last_status, t.last_error,
                t.consecutive_failures,
                -- ::text, not ::bigint. node-postgres hands an int8 back as a
                -- JavaScript BigInt, which JSON.stringify cannot serialise --
                -- so this endpoint answered 500 while every query in it was
                -- correct. This codebase's convention for anything wider than a
                -- 32-bit integer is a decimal string, for exactly this reason.
                extract(epoch FROM now() - t.last_finished_at)::bigint::text
                  AS seconds_since_success,
                -- Overdue by more than two intervals is the shape of "stopped",
                -- computed here so the console and an alert cannot disagree
                -- about what the threshold is.
                (t.enabled AND t.next_run_at
                   < now() - make_interval(secs => t.interval_seconds * 2)) AS overdue,
                (SELECT count(*) FROM task_run r
                  WHERE r.task_key = t.key AND r.status = 'failed'
                    AND r.started_at > now() - interval '7 days')::int
                  AS failures_this_week
           FROM scheduled_task t
          ORDER BY t.key`);
      return rows;
    });

    // A task in the table that this build has no code for. Reported beside the
    // row rather than hidden, because a compliance job dropped by a deploy
    // otherwise sits here looking perfectly scheduled.
    return {
      data: rows.map((r) => ({ ...r, implemented: Object.hasOwn(jobs, String(r['key'])) })),
    };
  }

  /** The last runs of one task, newest first, across every school. */
  @Get(':key/runs')
  @RequiresCapability('support')
  async runs(@Param('key') key: string) {
    return {
      data: await withPlatform(async (db) => {
        const { rows } = await db.query(
          `SELECT r.id, r.tenant_id, o.display_name AS tenant_name,
                  r.started_at, r.finished_at, r.status, r.detail, r.error
             FROM task_run r
             JOIN organization o ON o.id = r.tenant_id
            WHERE r.task_key = $1
            ORDER BY r.started_at DESC
            LIMIT 100`, [key]);
        return rows;
      }),
    };
  }

  /**
   * Makes a task due now.
   *
   * `provision` rather than `support`: forcing the fleet-wide retention purge
   * is a destructive act on every school at once, and read access to the
   * console should not carry it.
   */
  @Post(':key/run-now')
  @RequiresCapability('provision')
  async runNow(@Param('key') key: string) {
    const ok = await withPlatform(async (db) => {
      const { rowCount } = await db.query(
        `UPDATE scheduled_task SET next_run_at = now(), running_since = NULL
          WHERE key = $1 AND enabled`, [key]);
      return (rowCount ?? 0) > 0;
    });
    if (!ok) {
      throw ApiError.make('not_found', 'task_not_found',
        'No such task, or it is disabled.');
    }
    return { data: { queued: true, key } };
  }
}
