/**
 * M33 — the jobs nobody was running.
 *
 * Four functions in this codebase carried a comment saying a scheduled job
 * called them. None of them had a caller anywhere in `src/`:
 * `seal_audit_period`, the applicant-document purge, the nightly ledger
 * integrity check, and `ensure_audit_partition`'s scheduled half. The common
 * cause was that this system had one worker and no scheduler, so every job was
 * written as something somebody else would arrange later.
 *
 * The assertions split in two, and the second half is the one that matters.
 * Anybody can test that a job runs when asked. What this suite also has to show
 * is that a job which STOPS running is visible — because a job that quietly
 * stops produces no log line, no failed run and no exception, and that is
 * exactly what happened here for the life of the product.
 */
import './fixtures.ts';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  createTenant, destroyTenants, createUser, destroyUsers, grantRole, purgeTestData,
  createAcademicYear, createAcademicStructure,
  OWNER_URL, type TenantFixture, type UserFixture, type AcademicYearFixture,
} from './fixtures.ts';
import {
  claim, runClaimed, tick, sampleAges, forceDue, type Admin,
} from '../src/modules/scheduler/scheduler.service.ts';
import { jobs } from '../src/modules/scheduler/jobs.ts';
import { auditService } from '../src/modules/audit/audit.service.ts';
import { scheduledTaskAge, scheduledTaskRuns } from '../src/common/telemetry/metrics.ts';
import { withTenant } from '../src/db/tenant.ts';
import { pool } from '../src/db/pool.ts';
import { closeMaintenancePool } from '../src/db/maintenance.ts';
import { authPool } from '../src/db/auth-pool.ts';

const PASSWORD = 'correct-horse-battery';

let tenant: TenantFixture;
let user: UserFixture;
let admin: pg.Client;
let year: AcademicYearFixture;
let programmeId = '';

/**
 * A tenant scope with an actor — what a REQUEST looks like.
 *
 * Deliberately not what the jobs are given. `runClaimed` calls
 * `job({ tenantId })` and nothing else, because a scheduled task has no
 * person behind it. A test that hands a job an actor is testing a call the
 * product never makes: found by a surviving mutation, where putting the
 * retention purge back through `withTenant` broke nothing — the actor in this
 * scope is an ORG_OWNER, so `app_actor_has_staff_scope()` was true and the
 * policy that hides everything from a real job let this one through.
 */
const scope = () => ({ tenantId: tenant.orgId, actorId: user.userId });

/** What the scheduler actually passes. Every job assertion uses this. */
const asJob = () => ({ tenantId: tenant.orgId });

/** Every task key the migration seeds. */
const SEEDED = [
  'audit.seal', 'retention.applicant_documents', 'ledger.integrity',
  'files.pending_erasure', 'files.scan_backlog', 'audit.partitions',
];

/**
 * Tasks a test invents and must take away with it.
 *
 * `knows every job this build implements` compares the table against the
 * registry, so a leftover row makes it fail — and then every later mutation in
 * a pass looks "killed" by that test rather than by the guarantee it was
 * probing. Exactly the residue problem M30.1's partitions had, found the same
 * way and cleaned up at both ends for the same reason.
 */
const INVENTED_TASKS = ['ghost.job', 'ghost.console'];

async function forgetInventedTasks(): Promise<void> {
  await admin.query('DELETE FROM task_run WHERE task_key = ANY($1::text[])',
    [INVENTED_TASKS]);
  await admin.query('DELETE FROM scheduled_task WHERE key = ANY($1::text[])',
    [INVENTED_TASKS]);
}

/**
 * An applicant who was rejected thirteen months ago, with a birth
 * certificate on file.
 *
 * This fixture is the milestone. Without it every other assertion about the
 * purge passes against a job that examines nothing and reports success —
 * which is precisely what it did on the first run, when it went through
 * `withTenant` and `application_document`'s `staff_only` policy hid every row
 * from a caller with no actor.
 */
async function rejectedLongAgo(tenantId: string): Promise<{ fileId: string }> {
  return (async () => {
    const c = admin;
    const personId = (await c.query<{ id: string }>(
      `INSERT INTO person (tenant_id, given_name, family_name)
       VALUES ($1, 'Unsuccessful', 'Applicant') RETURNING id`, [tenantId])).rows[0]!.id;
    const staffId = (await c.query<{ id: string }>(
      `INSERT INTO staff (tenant_id, campus_id, person_id, employee_code, joined_on)
       VALUES ($1, $2, $3, $4, CURRENT_DATE - 500) RETURNING id`,
      [tenantId, tenant.campusId, personId,
       `RET-${randomUUID().slice(0, 6)}`])).rows[0]!.id;
    const app = (await c.query<{ id: string }>(
      `INSERT INTO application (tenant_id, applicant_person_id, programme_id,
                                academic_year_id, application_no)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [tenantId, personId, programmeId, year.yearId,
       `APP-${randomUUID().slice(0, 8)}`])).rows[0]!.id;
    await c.query(
      `INSERT INTO admission_decision (tenant_id, application_id, outcome,
                                       decided_by, decided_at, reason)
       VALUES ($1, $2, 'rejected', $3, now() - interval '400 days',
               'Places were full.')`,
      [tenantId, app, staffId]);
    const fileId = (await c.query<{ id: string }>(
      `INSERT INTO file (tenant_id, bucket, object_key, mime_type, size_bytes, sha256)
       VALUES ($1, 'b', $2, 'application/pdf', 900, repeat('d', 64)) RETURNING id`,
      [tenantId, `k-${randomUUID()}`])).rows[0]!.id;
    await c.query(
      `INSERT INTO application_document (tenant_id, application_id, document_type, file_id)
       VALUES ($1, $2, 'birth_certificate', $3)`, [tenantId, app, fileId]);
    return { fileId };
  })();
}

/** Parks every task far in the future, so a test owns the schedule. */
async function parkAll(): Promise<void> {
  await admin.query(
    `UPDATE scheduled_task SET next_run_at = now() + interval '1 year',
            running_since = NULL, last_finished_at = NULL, last_status = NULL,
            last_error = NULL, consecutive_failures = 0`);
}

async function taskRow(key: string) {
  const { rows } = await admin.query<{
    next_run_at: string; running_since: string | null; last_status: string | null;
    last_error: string | null; consecutive_failures: number;
  }>('SELECT next_run_at, running_since, last_status, last_error, consecutive_failures'
     + ' FROM scheduled_task WHERE key = $1', [key]);
  return rows[0]!;
}

async function ageOf(task: string): Promise<number | undefined> {
  const metric = await scheduledTaskAge.get();
  return metric.values.find((v) => v.labels['task'] === task)?.value;
}

beforeAll(async () => {
  await purgeTestData('%@sched-test.example');
  tenant = await createTenant('SCHED');
  user = await createUser('ops@sched-test.example', PASSWORD);
  await grantRole(tenant.orgId, user.userId, 'ORG_OWNER', 'organization', null);

  year = await createAcademicYear(tenant.orgId, tenant.unitId, '2026-27', 2026,
    { status: 'active' });
  programmeId = (await createAcademicStructure(
    tenant.orgId, tenant.unitId, tenant.campusId)).programmeId;

  admin = new pg.Client({ connectionString: OWNER_URL });
  await admin.connect();
  await forgetInventedTasks();
}, 120_000);

afterAll(async () => {
  await forgetInventedTasks();
  await admin.query('DELETE FROM task_run WHERE tenant_id = $1', [tenant.orgId]);
  await admin.query(
    `UPDATE scheduled_task SET next_run_at = now(), running_since = NULL`);
  await admin.end();
  await closeMaintenancePool();
  await destroyUsers([user.userId]);
  await destroyTenants([tenant.orgId]);
  await Promise.all([pool.end(), authPool.end()]);
}, 120_000);


/**
 * A group with a debit and no matching credit.
 *
 * The balance trigger has to be turned off to make one, and that is the whole
 * point of the job under test. `ledger_entry_group_balances` already refuses an
 * unbalanced group on every ordinary write, so the "nightly integrity job" is
 * not the guard — it is the BACKSTOP for a write that went round the guard: a
 * migration, a data fix, a restore, anything run with
 * `session_replication_role = replica`, which is exactly what this helper does.
 *
 * Creating the imbalance any other way would be impossible, and pretending
 * otherwise would make these tests describe a database this is not.
 */
async function halfAnEntry(tenantId: string): Promise<string> {
  const group = randomUUID();
  await admin.query('ALTER TABLE ledger_entry DISABLE TRIGGER ledger_entry_group_balances');
  try {
    await admin.query(
      `INSERT INTO ledger_entry (tenant_id, entry_group_id, account_code, debit,
                                 credit, currency, occurred_on, source_type, narration)
       VALUES ($1, $2, 'cash', 100.00, 0, 'INR', CURRENT_DATE, 'test', 'half an entry')`,
      [tenantId, group]);
  } finally {
    await admin.query('ALTER TABLE ledger_entry ENABLE TRIGGER ledger_entry_group_balances');
  }
  return group;
}

/** Puts it right the way the ledger's own append-only rule prescribes. */
async function rebalance(tenantId: string, group: string): Promise<void> {
  await admin.query(
    `INSERT INTO ledger_entry (tenant_id, entry_group_id, account_code, debit,
                               credit, currency, occurred_on, source_type, narration)
     VALUES ($1, $2, 'cash', 0, 100.00, 'INR', CURRENT_DATE, 'test', 'the other half')`,
    [tenantId, group]);
}

beforeEach(async () => { await parkAll(); });

describe('the schedule is a row, not a crontab', () => {
  it('knows every job this build implements', async () => {
    // A key in the table with no job in the code, or the reverse, is the shape
    // of a compliance task that silently stopped at a deploy. Asserted in both
    // directions because only one of them is the dangerous one and it is not
    // obvious which.
    const { rows } = await admin.query<{ key: string }>('SELECT key FROM scheduled_task');
    expect(rows.map((r) => r.key).sort()).toEqual([...SEEDED].sort());
    expect(Object.keys(jobs).sort()).toEqual([...SEEDED].sort());
  });

  it('claims the most overdue task and nothing else', async () => {
    await admin.query(
      `UPDATE scheduled_task SET next_run_at = now() - interval '2 hours'
        WHERE key = 'audit.seal'`);
    await admin.query(
      `UPDATE scheduled_task SET next_run_at = now() - interval '1 hour'
        WHERE key = 'ledger.integrity'`);

    expect((await claim(admin))?.key).toBe('audit.seal');
    expect((await claim(admin))?.key).toBe('ledger.integrity');
    expect(await claim(admin)).toBeNull();
  });

  it('two workers racing get different tasks, never the same one', async () => {
    // The claim is an UPDATE, which is what makes this safe without a lock
    // table: the loser's WHERE no longer matches. Run concurrently rather than
    // in sequence, because a sequential test proves only that the code runs
    // twice.
    await admin.query(
      `UPDATE scheduled_task SET next_run_at = now() - interval '1 hour'
        WHERE key IN ('audit.seal', 'ledger.integrity')`);

    const second = new pg.Client({ connectionString: OWNER_URL });
    await second.connect();
    try {
      const [a, b] = await Promise.all([claim(admin), claim(second)]);
      expect(a).not.toBeNull();
      expect(b).not.toBeNull();
      expect(a!.key).not.toBe(b!.key);
    } finally {
      await second.end();
    }
  });

  it('steps over a row another worker holds instead of queueing behind it', async () => {
    // `FOR UPDATE SKIP LOCKED` is a liveness property, and a test that just
    // calls claim() twice cannot see it: without SKIP LOCKED the loser blocks,
    // the winner commits, and the loser then finds the same nothing. The
    // difference is whether it WAITED, so the lock is held open deliberately
    // and the waiting is made fatal.
    await admin.query(
      `UPDATE scheduled_task SET next_run_at = now() - interval '1 hour'
        WHERE key = 'audit.seal'`);

    const holder = new pg.Client({ connectionString: OWNER_URL });
    await holder.connect();
    await holder.query('BEGIN');
    await holder.query(
      "SELECT key FROM scheduled_task WHERE key = 'audit.seal' FOR UPDATE");
    try {
      await admin.query("SET lock_timeout = '400ms'");
      // Skips the held row, finds nothing else due, and answers. Without SKIP
      // LOCKED this raises a lock timeout instead — a worker stuck behind
      // another worker's task rather than getting on with a different one.
      await expect(claim(admin)).resolves.toBeNull();
    } finally {
      await admin.query('SET lock_timeout = 0');
      await holder.query('ROLLBACK');
      await holder.end();
    }
  });

  it('does not hand out a task that is already running', async () => {
    await admin.query(
      `UPDATE scheduled_task SET next_run_at = now() - interval '1 hour'
        WHERE key = 'audit.seal'`);
    expect((await claim(admin))?.key).toBe('audit.seal');
    // The claim moved next_run_at forward AND set running_since. Either alone
    // would do here; both are asserted below where they differ.
    expect((await taskRow('audit.seal')).running_since).not.toBeNull();
    expect(await claim(admin)).toBeNull();
  });

  it('takes a task back from a worker that died holding it', async () => {
    // Without the lease this is the permanent silent stop: a crashed worker
    // holds `running_since` forever and the task never runs again, with no
    // error anywhere because nothing failed.
    await admin.query(
      `UPDATE scheduled_task
          SET next_run_at = now() - interval '1 hour',
              running_since = now() - interval '1 hour',
              lease_seconds = 60
        WHERE key = 'audit.seal'`);
    expect((await claim(admin))?.key).toBe('audit.seal');

    // ...and a worker that is merely slow keeps its task.
    await admin.query(
      `UPDATE scheduled_task
          SET next_run_at = now() - interval '1 hour', running_since = now(),
              lease_seconds = 900
        WHERE key = 'ledger.integrity'`);
    expect(await claim(admin)).toBeNull();
  });

  it('skips a disabled task', async () => {
    await admin.query(
      `UPDATE scheduled_task SET enabled = false, next_run_at = now() - interval '1 hour'
        WHERE key = 'audit.seal'`);
    try {
      expect(await claim(admin)).toBeNull();
    } finally {
      await admin.query("UPDATE scheduled_task SET enabled = true WHERE key = 'audit.seal'");
    }
  });
});

describe('what each job actually does', () => {
  it('seals yesterday, and leaves today open', async () => {
    // The audit log's tamper-evidence is this. 0007 built the digest and said
    // "a scheduled job seals each closed period"; until now nothing did, so
    // `audit_checkpoint` was empty in every database this product ever built.
    await admin.query(
      `INSERT INTO audit_log (tenant_id, action, resource_type, classification, occurred_at)
       VALUES ($1, 'test.event', 'thing', 'INTERNAL', now() - interval '2 days'),
              ($1, 'test.event', 'thing', 'INTERNAL', now())`,
      [tenant.orgId]);

    const detail = await jobs['audit.seal']!(asJob());
    expect(Number(detail['sealed'])).toBeGreaterThan(0);

    const { rows } = await admin.query<{ period_start: string; digest: string }>(
      `SELECT period_start::text, digest FROM audit_checkpoint
        WHERE tenant_id = $1 ORDER BY period_start`, [tenant.orgId]);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!.digest).toMatch(/^[0-9a-f]{64}$/);

    // Today must NOT be sealed: a checkpoint over a period still being written
    // to makes every later row look like tampering, and a tamper-evidence
    // scheme that cries wolf is one people learn to ignore.
    const today = new Date().toISOString().slice(0, 10);
    expect(rows.map((r) => r.period_start.slice(0, 10))).not.toContain(today);
  });

  it('seals in batches and says when it has not caught up', async () => {
    // A database two years behind has seven hundred open days. Sealing them in
    // one transaction is a long lock on the audit table for no benefit — the
    // chain is built in order either way. What matters is that a capped run
    // SAYS it stopped short, and that the next one carries on from the
    // checkpoint rather than starting again: found by two surviving mutations,
    // one removing the cap and one resuming from the first audit row.
    const fresh = await createTenant('SCHED9');
    try {
      // Backdated audit rows need the partitions they belong in. A real
      // install never writes one — audit rows are stamped `now()` — so this is
      // the fixture doing what the passage of time would have.
      for (const back of [1, 2, 3]) {
        await admin.query(
          `SELECT ensure_audit_partition((date_trunc('month', CURRENT_DATE)
                                          - make_interval(months => $1))::date)`, [back]);
      }
      await admin.query(
        `INSERT INTO audit_log (tenant_id, action, resource_type, classification,
                                occurred_at)
         SELECT $1, 'test.backlog', 'thing', 'INTERNAL',
                now() - make_interval(days => g)
           FROM generate_series(1, 60) AS g`,
        [fresh.orgId]);

      const first = await jobs['audit.seal']!({ tenantId: fresh.orgId });
      expect(first['sealed']).toBe(40);
      expect(first['caughtUp']).toBe(false);

      const second = await jobs['audit.seal']!({ tenantId: fresh.orgId });
      // Carries on rather than starting again. Resuming from the first audit
      // row would seal the same forty days forever and never reach today.
      expect(Number(second['sealed'])).toBeGreaterThan(0);
      expect(second['caughtUp']).toBe(true);
      expect(String(second['from']) > String(first['to'])).toBe(true);
    } finally {
      await admin.query('DELETE FROM audit_checkpoint WHERE tenant_id = $1', [fresh.orgId]);
      await destroyTenants([fresh.orgId]);
    }
  }, 60_000);

  it('chains each seal onto the one before it', async () => {
    await jobs['audit.seal']!(asJob());
    const { rows } = await admin.query<{ prev_digest: string | null; digest: string }>(
      `SELECT prev_digest, digest FROM audit_checkpoint
        WHERE tenant_id = $1 ORDER BY period_start`, [tenant.orgId]);
    for (let i = 1; i < rows.length; i += 1) {
      // Altering a sealed row has to break every checkpoint after it, which is
      // only true if each one carries the previous digest into its own.
      expect(rows[i]!.prev_digest).toBe(rows[i - 1]!.digest);
    }
  });

  it('is idempotent — a second run seals nothing twice', async () => {
    await jobs['audit.seal']!(asJob());
    const count = async () => (await admin.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM audit_checkpoint WHERE tenant_id = $1',
      [tenant.orgId])).rows[0]!.n;
    const after = await count();
    await jobs['audit.seal']!(asJob());
    expect(await count()).toBe(after);
  });

  it('seals nothing for a tenant with no audit rows', async () => {
    // Not a no-op for its own sake: a checkpoint with a zero row count in front
    // of a tenant's real history is a checkpoint that says nothing happened on
    // a day nobody was watching.
    const fresh = await createTenant('SCHED2');
    try {
      const detail = await jobs['audit.seal']!({ tenantId: fresh.orgId });
      expect(detail['sealed']).toBe(0);
      expect(detail['reason']).toMatch(/no audit rows/i);
    } finally {
      await destroyTenants([fresh.orgId]);
    }
  });

  it('reports the erasure backlog, and does nothing with no store configured',
    async () => {
      // This test used to assert the job's own confession — *"counted only:
      // this product has no object-storage client"* — because that was true
      // and the number could never go down. M37 gave it a client.
      //
      // This suite configures none, deliberately: the job must be safe in a
      // deployment that has no bucket. `eraseDeleted` returns zeros rather
      // than throwing, and the backlog is still counted, so the liability is
      // still visible. Erasing for real is asserted over HTTP against a live
      // S3 server in `write-surface-http.spec`.
      await admin.query(
        `INSERT INTO file (tenant_id, bucket, object_key, mime_type, size_bytes,
                           sha256, deleted_at)
         VALUES ($1, 'b', $2, 'image/png', 1024, repeat('a', 64),
                 now() - interval '30 days')`,
        [tenant.orgId, `k-${randomUUID()}`]);

      const detail = await jobs['files.pending_erasure']!(asJob());
      expect(Number(detail['pending'])).toBeGreaterThan(0);
      expect(Number(detail['oldestDays'])).toBeGreaterThanOrEqual(29);
      expect(Number(detail['erased'])).toBe(0);
      expect(Number(detail['failed'])).toBe(0);
    });

  it('counts a file held back by a legal hold separately from the backlog',
    async () => {
      // A held file is not a backlog; it is a file somebody has decided must
      // stay. Folding it into `pending` would make an operator chase a number
      // that is supposed to sit there.
      await admin.query(
        `INSERT INTO file (tenant_id, bucket, object_key, mime_type, size_bytes,
                           sha256, deleted_at, legal_hold)
         VALUES ($1, 'b', $2, 'image/png', 2048, repeat('b', 64),
                 now() - interval '400 days', true)`,
        [tenant.orgId, `k-${randomUUID()}`]);

      const detail = await jobs['files.pending_erasure']!(asJob());
      expect(Number(detail['legalHold'])).toBeGreaterThan(0);
      // ...and it does not drag the "oldest" figure with it, which would make
      // the backlog look four hundred days stale forever.
      expect(Number(detail['oldestDays'])).toBeLessThan(400);
    });

  it('counts uploads that are stored and not yet cleared', async () => {
    // 0017: nothing is served until a scan has cleared it. With no CLAMD_HOST
    // this climbs forever, and that is the point — a deployment without a
    // scanner should look like it is missing one.
    await admin.query(
      `INSERT INTO file (tenant_id, bucket, object_key, mime_type, size_bytes, sha256)
       VALUES ($1, 'b', $2, 'application/pdf', 512, repeat('c', 64))`,
      [tenant.orgId, `k-${randomUUID()}`]);

    const detail = await jobs['files.scan_backlog']!(asJob());
    expect(Number(detail['pending'])).toBeGreaterThan(0);
    expect(detail['scannerConfigured']).toBe(false);
  });

  it('catches an imbalance that went round the balance trigger', async () => {
    // Not a guard, a backstop. `ledger_entry_group_balances` refuses an
    // unbalanced group on every ordinary write, so the only way one exists is a
    // migration or a data fix run with triggers off — which is precisely the
    // kind of write nobody is watching.
    expect(await jobs['ledger.integrity']!(asJob())).toEqual({ unbalancedGroups: 0 });

    const group = await halfAnEntry(tenant.orgId);
    try {
      // Detection, never repair: a job that silently balanced the books would
      // destroy the only evidence of whatever wrote them wrong.
      await expect(jobs['ledger.integrity']!(asJob()))
        .rejects.toThrow(/unbalanced ledger group/i);
    } finally {
      await rebalance(tenant.orgId, group);
    }
    // ...and the reversing entry is what puts it right, which is the remedy
    // the ledger's own append-only rule prescribes.
    expect(await jobs['ledger.integrity']!(asJob())).toEqual({ unbalancedGroups: 0 });
  });

  it('creates next month’s audit partition before anything needs it', async () => {
    const detail = await jobs['audit.partitions']!(asJob());
    const name = String(detail['ensured']);
    expect(name).toMatch(/^audit_log_\d{4}_\d{2}$/);
    const { rows } = await admin.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM pg_class WHERE relname = $1', [name]);
    expect(rows[0]!.n).toBe('1');
  });
});

describe('a run leaves evidence the school can read', () => {
  it('records one row per tenant per run', async () => {
    await admin.query('DELETE FROM task_run WHERE tenant_id = $1', [tenant.orgId]);
    await admin.query(
      `UPDATE scheduled_task SET next_run_at = now() - interval '1 hour'
        WHERE key = 'files.pending_erasure'`);

    const outcome = await tick(admin);
    expect(outcome?.key).toBe('files.pending_erasure');
    expect(outcome?.status).toBe('ok');

    const { rows } = await admin.query<{ status: string; detail: unknown }>(
      `SELECT status, detail FROM task_run
        WHERE tenant_id = $1 AND task_key = 'files.pending_erasure'`, [tenant.orgId]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('ok');
    expect(rows[0]!.detail).toMatchObject({ pending: expect.any(Number) });
  });

  it('lets the school read its own history and nobody else’s', async () => {
    // "Your retention purge ran on the 3rd and removed 412 documents" is
    // evidence a school needs and could not produce. A log only the operator
    // can read is not a compliance record.
    await admin.query(
      `INSERT INTO task_run (tenant_id, task_key, finished_at, status, detail)
       VALUES ($1, 'files.pending_erasure', now(), 'ok', '{"pending":1}'::jsonb)`,
      [tenant.orgId]);

    const mine = await withTenant(scope(), async (db) => (await db.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM task_run')).rows[0]!.n);
    expect(Number(mine)).toBeGreaterThan(0);

    const other = await createTenant('SCHED3');
    try {
      const theirs = await withTenant({ tenantId: other.orgId, actorId: user.userId },
        async (db) => (await db.query<{ n: string }>(
          'SELECT count(*)::text AS n FROM task_run')).rows[0]!.n);
      expect(theirs).toBe('0');
    } finally {
      await destroyTenants([other.orgId]);
    }
  });

  it('refuses to let a school write its own evidence', async () => {
    // Read-only by grant, not by convention. A tenant that could insert here
    // could fabricate a purge it never ran.
    await expect(withTenant(scope(), (db) => db.query(
      `INSERT INTO task_run (tenant_id, task_key, finished_at, status)
       VALUES (app_current_tenant_id(), 'files.pending_erasure', now(), 'ok')`)))
      .rejects.toThrow(/permission denied|policy/i);
  });

  it('one tenant’s failure does not stop the others', async () => {
    // The difference between "the purge failed for one school" and "the purge
    // stopped running" is a try/catch inside the loop.
    const other = await createTenant('SCHED4');
    const group = await halfAnEntry(tenant.orgId);
    try {
      const outcome = await runClaimed(admin, 'ledger.integrity');
      expect(outcome.failed).toBeGreaterThan(0);
      expect(outcome.tenants).toBeGreaterThan(outcome.failed);
      expect(outcome.status).toBe('partial');

      // The healthy tenant still has its own successful run recorded.
      const { rows } = await admin.query<{ status: string }>(
        `SELECT status FROM task_run
          WHERE tenant_id = $1 AND task_key = 'ledger.integrity'
          ORDER BY started_at DESC LIMIT 1`, [other.orgId]);
      expect(rows[0]!.status).toBe('ok');
    } finally {
      await rebalance(tenant.orgId, group);
      await admin.query('DELETE FROM task_run WHERE tenant_id = $1', [other.orgId]);
      await destroyTenants([other.orgId]);
    }
  });

  it('releases the task whatever happened, and counts the failure', async () => {
    await admin.query(
      `UPDATE scheduled_task SET next_run_at = now() - interval '1 hour'
        WHERE key = 'ledger.integrity'`);
    const group = await halfAnEntry(tenant.orgId);
    try {
      await tick(admin);
      const row = await taskRow('ledger.integrity');
      // Released: a task still marked running after it finished is a task that
      // waits out its lease before running again.
      expect(row.running_since).toBeNull();
      expect(row.last_error).toMatch(/unbalanced/i);
      expect(Number(row.consecutive_failures)).toBeGreaterThan(0);
    } finally {
      await rebalance(tenant.orgId, group);
    }
  });

  it('only a clean run clears the failure count', async () => {
    // A task failing for one school out of four hundred every night is a task
    // that is failing, and a counter that resets on "partial" would say it is
    // fine.
    await admin.query(
      `UPDATE scheduled_task SET consecutive_failures = 3 WHERE key = 'files.pending_erasure'`);
    await runClaimed(admin, 'files.pending_erasure');
    expect(Number((await taskRow('files.pending_erasure')).consecutive_failures)).toBe(0);
  });

  it('reports a task the code does not implement rather than ignoring it', async () => {
    // The safe direction. A deploy that drops a compliance job must not leave a
    // row sitting there looking scheduled.
    await admin.query(
      `INSERT INTO scheduled_task (key, description, interval_seconds)
       VALUES ('ghost.job', 'A task no build implements', 3600)
       ON CONFLICT (key) DO NOTHING`);
    try {
      const outcome = await runClaimed(admin, 'ghost.job');
      expect(outcome.status).toBe('skipped');
      expect(outcome.error).toMatch(/no job registered/i);
      const row = await taskRow('ghost.job');
      expect(row.last_status).toBe('failed');
      expect(row.running_since).toBeNull();
    } finally {
      await admin.query("DELETE FROM scheduled_task WHERE key = 'ghost.job'");
    }
  });
});

describe('the maintenance connection is still a boundary', () => {
  it('sees one school\u2019s broken ledger as one school\u2019s', async () => {
    // The reason `withMaintenance` is dangerous, and the first thing it did.
    // Row-level security is bypassed there, so a query that leaned on a policy
    // for its tenant filter answers for the whole fleet — `unbalancedGroups`
    // had no WHERE clause at all, and the first run reported this tenant's
    // imbalance against every tenant in the database.
    const other = await createTenant('SCHED5');
    const group = await halfAnEntry(tenant.orgId);
    try {
      await expect(jobs['ledger.integrity']!(asJob()))
        .rejects.toThrow(/unbalanced/i);
      // ...and the school next door is fine, which is the whole assertion.
      expect(await jobs['ledger.integrity']!({ tenantId: other.orgId }))
        .toEqual({ unbalancedGroups: 0 });
    } finally {
      await rebalance(tenant.orgId, group);
      await destroyTenants([other.orgId]);
    }
  });

  it('counts only this school\u2019s files awaiting erasure', async () => {
    const other = await createTenant('SCHED6');
    try {
      await admin.query(
        `INSERT INTO file (tenant_id, bucket, object_key, mime_type, size_bytes,
                           sha256, deleted_at)
         VALUES ($1, 'b', $2, 'image/png', 4096, repeat('b', 64), now())`,
        [tenant.orgId, `k-${randomUUID()}`]);
      const theirs = await jobs['files.pending_erasure']!({ tenantId: other.orgId });
      expect(theirs['pending']).toBe(0);
    } finally {
      await destroyTenants([other.orgId]);
    }
  });

  it('purges only this school\u2019s applicant documents', async () => {
    // The worst version of the bug this whole section is about: without an
    // explicit tenant predicate the purge would have run once per school and
    // deleted every school's documents each time.
    //
    // The neighbour needs a document that IS purgeable — a rejected applicant
    // from thirteen months ago, exactly like this school's. A loose file
    // nothing points at proves nothing, because an unfiltered purge would not
    // have touched it either. Found by a surviving mutation.
    const other = await createTenant('SCHED8');
    try {
      const theirs = await rejectedLongAgo(other.orgId);
      const mine = await rejectedLongAgo(tenant.orgId);

      const detail = await jobs['retention.applicant_documents']!(asJob());
      expect(Number(detail['documentsPurged'])).toBeGreaterThan(0);

      // Counted, not just deleted. The candidate query is the first of three
      // tenant predicates and the only one a behaviour can distinguish — the
      // other two are unreachable while this one stands. Without it the job
      // CONSIDERS the neighbour's application even where the later filters stop
      // it acting, and this is the assertion that notices.
      const mineOnly = await admin.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM application a
           JOIN admission_decision d ON d.application_id = a.id
          WHERE a.tenant_id = $1 AND d.outcome = 'rejected'
            AND d.decided_at < now() - interval '365 days'`, [tenant.orgId]);
      expect(String(detail['applicationsConsidered'])).toBe(mineOnly.rows[0]!.n);

      const { rows } = await admin.query<{ id: string; deleted_at: string | null }>(
        'SELECT id, deleted_at FROM file WHERE id = ANY($1::uuid[])',
        [[theirs.fileId, mine.fileId]]);
      const byId = new Map(rows.map((r) => [r.id, r.deleted_at]));
      expect(byId.get(mine.fileId)).not.toBeNull();
      expect(byId.get(theirs.fileId)).toBeNull();
    } finally {
      await destroyTenants([other.orgId]);
    }
  }, 60_000);

  it('is imported by the scheduler and nothing else', async () => {
    // Containment by test rather than by convention. `withTenant`'s own comment
    // says code that crosses a boundary "uses a different, explicitly named
    // entry point so that it shows up in review"; this is what stops the entry
    // point quietly spreading into the request path, where a bypassed policy is
    // a data leak rather than a maintenance decision.
    const SRC = new URL('../src', import.meta.url).pathname;
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const full = join(dir, e.name);
        return e.isDirectory() ? walk(full) : (e.name.endsWith('.ts') ? [full] : []);
      });

    const importers = walk(SRC)
      .filter((f) => !f.endsWith('db/maintenance.ts'))
      .filter((f) => /from\s+'[^']*maintenance\.ts'/.test(readFileSync(f, 'utf8')))
      .map((f) => f.slice(SRC.length + 1));

    expect(importers).toEqual(['modules/scheduler/jobs.ts']);
  });
});

describe('a job that stops running is visible', () => {
  it('has no age at all until it has succeeded once', async () => {
    // The lesson M23 already paid for: a gauge that cannot read must remove its
    // series, not report a comfortable zero. "Never run" and "ran a second ago"
    // must not look the same on a dashboard.
    scheduledTaskAge.reset();
    await admin.query('UPDATE scheduled_task SET last_finished_at = NULL');
    await sampleAges(admin);
    expect(await ageOf('audit.seal')).toBeUndefined();
  });

  it('measures how long it has been since each task finished', async () => {
    // The number that matters, and the one nothing event-driven can produce: a
    // task that stopped running emits no events at all. This is the gauge that
    // would have caught the whole of M33 years earlier.
    await admin.query(
      `UPDATE scheduled_task SET last_finished_at = now() - interval '3 hours'
        WHERE key = 'audit.seal'`);
    await sampleAges(admin);
    const age = await ageOf('audit.seal');
    expect(age).toBeGreaterThan(3 * 3600 - 120);
    expect(age).toBeLessThan(3 * 3600 + 120);
  });

  it('counts every run by outcome', async () => {
    const before = (await scheduledTaskRuns.get()).values
      .filter((v) => v.labels['task'] === 'files.pending_erasure')
      .reduce((n, v) => n + v.value, 0);
    await runClaimed(admin, 'files.pending_erasure');
    const after = (await scheduledTaskRuns.get()).values
      .filter((v) => v.labels['task'] === 'files.pending_erasure')
      .reduce((n, v) => n + v.value, 0);
    expect(after).toBeGreaterThan(before);
  });

  it('can be told to run now', async () => {
    // Fifteen-second polling against hourly tasks means "run this now" from the
    // console happens within seconds rather than at the top of the hour.
    expect(await forceDue(admin, 'files.pending_erasure')).toBe(true);
    expect((await claim(admin))?.key).toBe('files.pending_erasure');
    expect(await forceDue(admin, 'no.such.task')).toBe(false);
  });
});

describe('the purge that had never run', () => {
  it('actually deletes a document, which is the whole milestone', async () => {
    // Through `withTenant` this job returns `applicationsConsidered: 0` and
    // calls it a success. It would have done that every night for years.
    const { fileId } = await rejectedLongAgo(tenant.orgId);

    const detail = await jobs['retention.applicant_documents']!(asJob());
    expect(Number(detail['applicationsConsidered'])).toBeGreaterThan(0);
    expect(Number(detail['documentsPurged'])).toBeGreaterThan(0);

    const { rows } = await admin.query<{ deleted_at: string | null }>(
      'SELECT deleted_at FROM file WHERE id = $1', [fileId]);
    expect(rows[0]!.deleted_at).not.toBeNull();
  }, 60_000);

  it('leaves an audit row naming no person', async () => {
    // A job is not a person. Borrowing somebody's id would put their name on a
    // deletion they did not make.
    await rejectedLongAgo(tenant.orgId);
    await jobs['retention.applicant_documents']!(asJob());
    const { rows } = await admin.query<{ actor_user_id: string | null }>(
      `SELECT actor_user_id FROM audit_log
        WHERE tenant_id = $1 AND action = 'retention.applicant_documents_purged'
        ORDER BY occurred_at DESC LIMIT 1`, [tenant.orgId]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor_user_id).toBeNull();
  }, 60_000);

  it('is reachable from the scheduler', async () => {
    // The point of the milestone rather than a test of the purge, which M18
    // already covers: what was missing was anything that CALLED it.
    await admin.query('DELETE FROM task_run WHERE tenant_id = $1', [tenant.orgId]);
    await admin.query(
      `UPDATE scheduled_task SET next_run_at = now() - interval '1 hour'
        WHERE key = 'retention.applicant_documents'`);

    const outcome = await tick(admin);
    expect(outcome?.key).toBe('retention.applicant_documents');
    expect(outcome?.status).toBe('ok');

    const { rows } = await admin.query<{ detail: { applicationsConsidered: number } }>(
      `SELECT detail FROM task_run
        WHERE tenant_id = $1 AND task_key = 'retention.applicant_documents'`,
      [tenant.orgId]);
    expect(rows[0]!.detail).toHaveProperty('applicationsConsidered');
  });
});
