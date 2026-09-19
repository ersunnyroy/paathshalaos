import { withTenant, type TenantScope } from '../../db/tenant.ts';
import { auditService } from '../audit/audit.service.ts';

export interface PurgeResult {
  applicationsConsidered: number;
  documentsPurged: number;
  filesMarkedDeleted: number;
}

/**
 * Data minimisation for unsuccessful applicants.
 *
 * An admissions cycle accumulates ID proofs, birth certificates and report cards
 * for every family that applied and did not join. That is the single largest
 * pile of needless personal data an institute holds, and it belongs to children.
 * Keeping it costs nothing until the day it leaks.
 *
 * Retention is one year from the decision, per the plan. Three things are
 * deliberately preserved:
 *
 *   the application and its decision — the institute must be able to say what it
 *     decided and why, and a family can ask years later;
 *   anything under legal hold — litigation outranks a retention schedule;
 *   the audit trail of the purge itself.
 *
 * Only the document rows and their file metadata go. The object-storage delete
 * is driven off `file.deleted_at` by a separate sweeper, so this function is
 * safe to run repeatedly and never blocks on a network call.
 */
export const retentionService = {
  async purgeUnsuccessfulApplicantDocuments(
    scope: TenantScope,
    opts: { retentionDays?: number; dryRun?: boolean } = {},
  ): Promise<PurgeResult> {
    const retentionDays = opts.retentionDays ?? 365;

    const result = await withTenant(scope, async (db) => {
      const candidates = await db.query<{ id: string }>(
        `SELECT a.id
           FROM application a
           JOIN admission_decision d ON d.application_id = a.id AND d.superseded_at IS NULL
          WHERE d.decided_at < now() - make_interval(days => $1::int)
            -- Unsuccessful: rejected, or an offer that was declined or lapsed.
            AND (
              d.outcome = 'rejected'
              OR d.declined_at IS NOT NULL
              OR (d.outcome IN ('offered', 'waitlisted') AND d.accepted_at IS NULL)
            )
            -- And the applicant never actually enrolled anywhere.
            AND NOT EXISTS (
              SELECT 1 FROM enrollment e
                JOIN student s ON s.id = e.student_id
               WHERE s.person_id = a.applicant_person_id
            )`,
        [retentionDays],
      );

      if (opts.dryRun || candidates.rows.length === 0) {
        return {
          applicationsConsidered: candidates.rows.length,
          documentsPurged: 0,
          filesMarkedDeleted: 0,
        };
      }

      const ids = candidates.rows.map((r) => r.id);

      const files = await db.query<{ id: string }>(
        `UPDATE file SET deleted_at = now()
          WHERE legal_hold = false
            AND deleted_at IS NULL
            AND id IN (
              SELECT ad.file_id FROM application_document ad
               WHERE ad.application_id = ANY($1::uuid[]) AND ad.file_id IS NOT NULL
            )
          RETURNING id`,
        [ids],
      );

      // Document rows for held files are kept, so the hold is not defeated by
      // deleting the row that points at the held object.
      const docs = await db.query(
        `DELETE FROM application_document
          WHERE application_id = ANY($1::uuid[])
            AND (file_id IS NULL OR file_id IN (SELECT id FROM file WHERE deleted_at IS NOT NULL))`,
        [ids],
      );

      return {
        applicationsConsidered: ids.length,
        documentsPurged: docs.rowCount,
        filesMarkedDeleted: files.rows.length,
      };
    });

    if (!opts.dryRun && result.documentsPurged > 0) {
      await auditService.record({
        tenantId: scope.tenantId,
        actorUserId: scope.actorId,
        action: 'retention.applicant_documents_purged',
        resourceType: 'application_document',
        classification: 'RESTRICTED',
        after: result,
        reason: `Retention policy: ${retentionDays} days after an unsuccessful decision.`,
      });
    }
    return result;
  },
};
