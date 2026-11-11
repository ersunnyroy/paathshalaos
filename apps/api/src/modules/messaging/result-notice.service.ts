/**
 * Telling families a result has been published (M43.4).
 *
 * Publishing is the moment a run becomes visible to a family (0068). Until
 * now the only way a parent found out was to go and look. This tells the
 * guardians who are allowed to see that child's marks — `can_view_academics`
 * — and nobody else, and it says only that the result is out: the marks stay
 * behind the same permission they were always behind.
 *
 * Best-effort and idempotent on the run, like the receipt notice: a result
 * that is published stays published whether or not the message could go. A
 * school with no approved `RESULT_PUBLISHED` template sends nothing.
 */
import { withTenant, type TenantScope } from '../../db/tenant.ts';
import { dispatchService, type Audience } from './dispatch.service.ts';
import { inAppOnlyProvider } from './providers.ts';
import { logger } from '../../common/logger.ts';

export const RESULT_TEMPLATE = 'RESULT_PUBLISHED';

export const resultNoticeService = {
  async published(scope: TenantScope, runId: string): Promise<{ told: number; reason?: string }> {
    try {
      const prepared = await withTenant(scope, async (db) => {
        const template = await db.query(
          `SELECT 1 FROM message_template t
            WHERE t.code = $1 AND t.deleted_at IS NULL
              AND EXISTS (SELECT 1 FROM message_template_version v
                           WHERE v.message_template_id = t.id AND v.channel = 'in_app'
                             AND v.approval_status = 'approved')`, [RESULT_TEMPLATE]);
        if (template.rows.length === 0) return { audience: [] as Audience[], reason: 'no_template' };

        const { rows } = await db.query<{
          guardian_person_id: string; subject_person_id: string;
          child_name: string; term: string | null;
        }>(
          `SELECT DISTINCT gl.guardian_person_id, p.id AS subject_person_id,
                  p.given_name AS child_name, t.label AS term
             FROM result_run r
             JOIN result_line l ON l.result_run_id = r.id
             JOIN enrollment e ON e.id = l.enrollment_id
             JOIN student st ON st.id = e.student_id
             JOIN person p ON p.id = st.person_id
             JOIN guardian_link gl ON gl.student_id = st.id
                                  AND gl.effective_to IS NULL
                                  AND gl.effective_from <= CURRENT_DATE
                                  AND gl.can_view_academics
                                  AND gl.can_receive_notifications
             LEFT JOIN term t ON t.id = r.term_id
            WHERE r.id = $1::uuid
              -- Only a run families can actually open. Asked of the row, not
              -- assumed from the caller having just published it.
              AND r.status = 'published'`, [runId]);
        return {
          reason: rows.length === 0 ? 'nobody_to_tell' : undefined,
          audience: rows.map<Audience>((r) => ({
            personId: r.guardian_person_id,
            subjectPersonId: r.subject_person_id,
            variables: { name: r.child_name, term: r.term ?? 'this term' },
          })),
        };
      });
      if (prepared.audience.length === 0) {
        return { told: 0, ...(prepared.reason ? { reason: prepared.reason } : {}) };
      }
      const queued = await dispatchService.queue(scope, {
        templateCode: RESULT_TEMPLATE,
        idempotencyKey: `result-published:${runId}`,
        sourceType: 'result_run', sourceId: runId,
      });
      const { outcomes } = await dispatchService.dispatch(scope, {
        requestId: queued.requestId, audience: prepared.audience,
        provider: inAppOnlyProvider,
      });
      return { told: outcomes.filter((o) => o.outcome === 'sent').length };
    } catch (error) {
      logger.warn({ err: error, result_run_id: runId },
        'result notice could not be sent; the run itself is published');
      return { told: 0, reason: 'failed' };
    }
  },
};
