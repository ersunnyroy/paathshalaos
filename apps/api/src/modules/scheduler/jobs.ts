/**
 * The work each scheduled task does (M33.2).
 *
 * One file, one registry, one signature. A job is
 * `(scope) => Promise<detail>`: it runs inside one tenant, it returns what it
 * did, and it throws when it could not. Everything about *when* it runs, what
 * happened last time and who is allowed to see that lives in the scheduler and
 * not here.
 *
 * The signature is per TENANT rather than per fleet on purpose. Every one of
 * these reads or writes tenant data, so running them under a tenant scope means
 * every row-level policy applies exactly as it does to a request — the same
 * decision the webhook relay made, for the same reason. A job with the owner
 * connection in its hand is a job that can quietly cross a school boundary.
 */
import type { TenantScope } from '../../db/tenant.ts';
import { withTenant } from '../../db/tenant.ts';
import { withMaintenance } from '../../db/maintenance.ts';
import { retentionService } from '../admissions/retention.service.ts';
import { ledgerService } from '../billing/ledger.service.ts';
import { auditService } from '../audit/audit.service.ts';

export type JobDetail = Record<string, unknown>;
export type Job = (scope: TenantScope) => Promise<JobDetail>;

/**
 * How many days one run of the sealer will close.
 *
 * A database that has been running for two years without a sealer has seven
 * hundred open days. Sealing them all in one transaction is a long lock on the
 * audit table for no benefit — the chain is built in order either way, and
 * forty days a run catches up in under three weeks of hourly runs while never
 * holding anything for long.
 */
const SEAL_BATCH_DAYS = 40;

export const jobs: Record<string, Job> = {
  /**
   * Seals each closed day of the audit log.
   *
   * The digest covers a period's rows in a deterministic order plus the
   * previous checkpoint's digest, so altering any sealed row breaks every
   * checkpoint after it. 0007 built that and said "a scheduled job seals each
   * closed period"; this is the first thing that ever has.
   *
   * Only CLOSED days are sealed. Sealing today would checkpoint a period that
   * is still being written to, and every row added afterwards would look like
   * tampering — a tamper-evidence scheme that cries wolf is one people learn
   * to ignore.
   */
  'audit.seal': async (scope) => withTenant(scope, async (db) => {
    const { rows: [bounds] } = await db.query<{
      resume: string | null; latest: string | null;
    }>(
      `SELECT (SELECT max(period_end) FROM audit_checkpoint
                WHERE tenant_id = app_current_tenant_id())::text AS resume,
              (SELECT min(occurred_at) FROM audit_log
                WHERE tenant_id = app_current_tenant_id())::text AS latest`);

    // Where to start: after the last checkpoint, or at the first audit row
    // this tenant ever wrote. A tenant with no audit rows has nothing to seal
    // and must not seal an empty day, which would put a checkpoint with a
    // zero row count in front of its real history.
    const from = bounds?.resume ?? bounds?.latest;
    if (!from) return { sealed: 0, reason: 'no audit rows yet' };

    let start = new Date(`${from.slice(0, 10)}T00:00:00Z`);
    const firstOpenDay = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);

    const sealed: string[] = [];
    while (start < firstOpenDay && sealed.length < SEAL_BATCH_DAYS) {
      const end = new Date(start.getTime() + 86_400_000);
      await db.query('SELECT seal_audit_period(app_current_tenant_id(), $1, $2)',
        [start.toISOString(), end.toISOString()]);
      sealed.push(start.toISOString().slice(0, 10));
      start = end;
    }
    return {
      sealed: sealed.length,
      from: sealed[0] ?? null,
      to: sealed[sealed.length - 1] ?? null,
      // Says so rather than looking finished, because a run that stopped at its
      // batch limit has more to do and the next run is an hour away.
      caughtUp: start >= firstOpenDay,
    };
  }),

  /**
   * Deletes the documents of applicants who did not enrol.
   *
   * The service has existed since M18 and had no caller. What it removes is ID
   * proofs, birth certificates and report cards belonging to children whose
   * families applied to a school they never joined.
   */
  'retention.applicant_documents': async (scope) => {
    // `withMaintenance`, not `withTenant`, and the difference is the whole
    // job: `file` and `application_document` are both `staff_only`, a job has
    // no actor, and through the ordinary path this purge sees nothing and
    // reports success. See `db/maintenance.ts`.
    const result = await withMaintenance(scope.tenantId,
      (db) => retentionService.purgeWithin(db));

    if (result.documentsPurged > 0) {
      await auditService.record({
        tenantId: scope.tenantId,
        // No actor, deliberately. A job is not a person, and borrowing
        // somebody's id would put their name on a deletion they did not make.
        action: 'retention.applicant_documents_purged',
        resourceType: 'application_document',
        classification: 'RESTRICTED',
        after: { ...result },
        reason: 'Scheduled retention: one year after an unsuccessful decision.',
      });
    }
    return { ...result };
  },

  /**
   * Finds double-entry groups that do not sum to zero.
   *
   * A backstop, not a guard, and the difference is worth writing down because
   * the comment this job was named after ("the nightly integrity job's query")
   * reads like the opposite. `ledger_entry_group_balances` already refuses an
   * unbalanced group on every ordinary write. The only way one can exist is a
   * write that went round the trigger — a migration, a data fix, a restore,
   * anything run with `session_replication_role = replica` — which is exactly
   * the class of write nobody is watching and nobody writes a test for.
   *
   * Detection, never repair. A job that silently balanced the books would
   * destroy the only evidence of whatever wrote them wrong, and the imbalance
   * is the symptom rather than the disease. Throwing makes the task's status
   * `failed`, which is the point: an unbalanced ledger is not a normal outcome
   * to record and move on from.
   */
  'ledger.integrity': async (scope) => {
    // `ledger_entry` is `finance_only`, so through the ordinary path a job
    // finds no rows and every ledger looks perfect.
    const groups = await withMaintenance(scope.tenantId,
      (db) => ledgerService.unbalancedGroups(db));
    if (groups.length > 0) {
      throw new Error(
        `${groups.length} unbalanced ledger group(s): `
        + `${groups.slice(0, 5).map((g) => g.entry_group_id).join(', ')}`);
    }
    return { unbalancedGroups: 0 };
  },

  /**
   * Counts the bytes this product cannot delete.
   *
   * `retention.applicant_documents` sets `file.deleted_at`, and M18's comment
   * says the object itself is removed "by a separate sweeper". There is no
   * sweeper, and there could not be: **nothing in this system has ever opened a
   * connection to object storage.** `file.bucket` and `file.object_key` have
   * been written since M17 and never read by anything that could act on them.
   *
   * So this job does not pretend to erase. It counts what is waiting and how
   * long it has waited, because a number on a dashboard is the difference
   * between a known liability and a forgotten one — and under DPDP a file the
   * school has promised to delete and has not is exactly that. Closing it needs
   * an object-storage adapter, which belongs with M22's deployment work.
   */
  'files.pending_erasure': async (scope) => withMaintenance(scope.tenantId, async (db) => {
    const { rows: [row] } = await db.query<{
      pending: string; oldest_days: string | null; bytes: string;
    }>(
      `SELECT count(*)::text AS pending,
              floor(extract(epoch FROM now() - min(deleted_at)) / 86400)::text AS oldest_days,
              COALESCE(sum(size_bytes), 0)::text AS bytes
         FROM file
        WHERE tenant_id = app_current_tenant_id()
          AND deleted_at IS NOT NULL AND legal_hold = false`);
    return {
      pending: Number(row?.pending ?? 0),
      oldestDays: row?.oldest_days === null || row?.oldest_days === undefined
        ? null : Number(row.oldest_days),
      bytes: Number(row?.bytes ?? 0),
      // Not a status the job can improve. Stated in the record so that a
      // reader of the run history is not left wondering why the number never
      // goes down.
      note: 'counted only: this product has no object-storage client',
    };
  }),

  /**
   * Creates next month's audit partition before anything needs it.
   *
   * 0007 said this was "called by a scheduled job; also called defensively on
   * insert failure so a missed job degrades into a slow write". Only the
   * defensive half was ever built, so the first audit write of every month has
   * been paying for a CREATE TABLE — on whatever request happened to be first,
   * which is nobody's fault and everybody's latency.
   *
   * Not tenant-scoped work, but run per tenant anyway: it is idempotent, and a
   * job that needed a different shape would need a different runner.
   */
  'audit.partitions': async (scope) => withTenant(scope, async (db) => {
    const { rows } = await db.query<{ name: string }>(
      `SELECT ensure_audit_partition((date_trunc('month', CURRENT_DATE)
                                      + interval '1 month')::date) AS name`);
    return { ensured: rows[0]?.name ?? null };
  }),
};
