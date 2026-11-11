import { authPool } from '../../db/auth-pool.ts';
import { getContext } from '../../common/request-context.ts';
import { logger } from '../../common/logger.ts';

export type Classification = 'PUBLIC' | 'INTERNAL' | 'SENSITIVE' | 'RESTRICTED';

export interface AuditEntry {
  tenantId: string;
  action: string;
  resourceType: string;
  resourceId?: string | undefined;
  actorUserId?: string | undefined;
  actorRole?: string | undefined;
  onBehalfOfUserId?: string | undefined;
  impersonationId?: string | undefined;
  classification?: Classification | undefined;
  before?: unknown;
  after?: unknown;
  reason?: string | undefined;
  ip?: string | undefined;
}

/** Actions that must carry a reason. Writing one without is a programming error. */
const REASON_REQUIRED = new Set([
  'impersonation.started',
  'export.bulk',
  'fee.adjusted',
  'result.corrected',
  'auth.refresh_reuse_detected',
]);

export const auditService = {
  /**
   * Writes one audit row.
   *
   * Uses the auth pool rather than a tenant transaction on purpose: audit rows
   * are written from paths that have no tenant scope yet (a login) and from
   * paths that are about to fail (a permission denial). Tying the write to the
   * caller's transaction would mean a rolled-back request loses its own audit
   * trail — which is exactly the request you most want a record of.
   */
  async record(entry: AuditEntry): Promise<void> {
    if (REASON_REQUIRED.has(entry.action) && !entry.reason?.trim()) {
      throw new Error(`Audit action "${entry.action}" requires a reason.`);
    }

    const ctx = getContext();

    // Attribution inside an impersonation session.
    //
    // `ctx.actorId` is whoever the request is acting AS — under an entry session
    // that is the school's own person, because every row-level security policy
    // decides by that id. Recording it as the actor would put a teacher's name
    // on a change a platform administrator made, which is the one outcome this
    // module exists to prevent. So the real hands go in actor_user_id and the
    // borrowed identity in on_behalf_of_user_id, and both are always present.
    const impersonating = ctx?.impersonationId !== undefined && ctx.impersonatedBy !== undefined;
    const defaultActor = impersonating ? ctx!.impersonatedBy : ctx?.actorId;
    const defaultOnBehalfOf = impersonating ? ctx!.actorId : undefined;

    try {
      await authPool.query(
        `INSERT INTO audit_log (
           tenant_id, actor_user_id, actor_role, on_behalf_of_user_id, impersonation_id,
           action, resource_type, resource_id, classification, before, after,
           request_id, ip, reason)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          entry.tenantId,
          entry.actorUserId ?? defaultActor ?? null,
          entry.actorRole ?? ctx?.actorRole ?? null,
          entry.onBehalfOfUserId ?? defaultOnBehalfOf ?? null,
          entry.impersonationId ?? ctx?.impersonationId ?? null,
          entry.action,
          entry.resourceType,
          entry.resourceId ?? null,
          entry.classification ?? 'INTERNAL',
          entry.before === undefined ? null : JSON.stringify(entry.before),
          entry.after === undefined ? null : JSON.stringify(entry.after),
          ctx?.requestId ?? null,
          entry.ip ?? null,
          entry.reason ?? null,
        ],
      );
    } catch (err) {
      // A missing partition is the one failure worth retrying inline: the
      // scheduled job creates them ahead of time, but a clock rollover or a
      // missed run should degrade into a slow write, never a lost record.
      if (err instanceof Error && /no partition of relation/i.test(err.message)) {
        await authPool.query('SELECT ensure_audit_partition(CURRENT_DATE)');
        return this.record(entry);
      }
      // Never fail the request because auditing failed, but make the gap loud.
      logger.error({ err, action: entry.action, tenant_id: entry.tenantId }, 'AUDIT WRITE FAILED');
    }
  },

  /**
   * Records a read of sensitive data. Separate from record() so that the
   * decision "is this a sensitive read" is made at the call site and is greppable.
   */
  async recordRead(
    entry: Omit<AuditEntry, 'action' | 'before' | 'after'> & { action: string },
  ): Promise<void> {
    return this.record({ ...entry, classification: entry.classification ?? 'SENSITIVE' });
  },
};
