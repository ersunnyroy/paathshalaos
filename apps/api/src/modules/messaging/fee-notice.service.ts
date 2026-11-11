/**
 * Telling families about money (M43.3): "we have received your payment", and
 * "this is overdue".
 *
 * ## The receipt notice
 *
 * Sent the moment a payment is recorded, to the guardians the school shares
 * that child's fees with — and only to them: a notice about money to a
 * guardian whose `can_view_finance` is off would tell them something the
 * school has decided they are not told.
 *
 * It goes under the purpose `core_education_service`. A receipt is part of the
 * service, not something a family opts into; `may_message` never suppresses
 * that purpose for want of a consent record.
 *
 * It is best-effort by design. The payment has been taken and the receipt
 * issued by the time this runs; a message that cannot go must never turn that
 * into an error at the counter. It is idempotent on the payment, so a retried
 * request does not tell anybody twice.
 *
 * A school that has not written and approved a template with the code
 * `FEE_RECEIPT` sends nothing. Words go out under the school's name only once
 * the school has agreed them.
 *
 * ## The overdue reminder
 *
 * Asked for by a person, never automatic: reminding a family about money is a
 * decision. Purpose `fee_notifications`, which IS consent-based. One reminder
 * per guardian per child per day, however many invoices are overdue and
 * however many times the button is pressed.
 */
import { withTenant, type TenantClient, type TenantScope } from '../../db/tenant.ts';
import { dispatchService, type Audience } from './dispatch.service.ts';
import { inAppOnlyProvider } from './providers.ts';
import { logger } from '../../common/logger.ts';
import { inr } from './inr.ts';

export const RECEIPT_TEMPLATE = 'FEE_RECEIPT';
export const REMINDER_SOURCE = 'fee_reminder';
export const REMINDER_PURPOSE = 'fee_notifications';

/** Guardians a child's fees are shared with, as of today. */
const FINANCE_GUARDIANS = `
  JOIN guardian_link gl ON gl.student_id = st.id
                       AND gl.effective_to IS NULL
                       AND gl.effective_from <= CURRENT_DATE
                       AND gl.can_view_finance
                       AND gl.can_receive_notifications`;

async function hasApprovedInApp(db: TenantClient, templateId: string): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT 1 FROM message_template_version
      WHERE message_template_id = $1 AND channel = 'in_app'
        AND approval_status = 'approved' LIMIT 1`, [templateId]);
  return rows.length > 0;
}

export interface ReminderStatus {
  /** Children with at least one overdue invoice. */
  overdue: number;
  /** Of those, how many have a guardian not yet reminded today. */
  toRemind: number;
  /** Of those still to remind, how many nobody has given fee-notice consent for. */
  noConsent: number;
  /** Children with overdue fees and no guardian the fees are shared with. */
  noGuardian: number;
  /** Reminders that would go if sent now. */
  notices: number;
  /** The template that would be used, or null when none is approved. */
  templateCode: string | null;
}

/** One row per (guardian, child with overdue fees) not yet reminded today. */
const PENDING_REMINDERS = `
  WITH owing AS (
    SELECT e.student_id,
           sum(i.total - i.amount_paid) AS outstanding,
           min(i.due_on) AS oldest_due
      FROM invoice i
      JOIN enrollment e ON e.id = i.enrollment_id
     WHERE i.status IN ('issued', 'part_paid')
       AND i.due_on < CURRENT_DATE
       AND i.total > i.amount_paid
     GROUP BY e.student_id
  )
  SELECT gl.guardian_person_id, p.id AS subject_person_id, p.given_name AS child_name,
         o.outstanding::text AS outstanding,
         to_char(o.oldest_due, 'FMDD Mon YYYY') AS oldest_due,
         may_message(p.id, gl.guardian_person_id, '${REMINDER_PURPOSE}') AS permission
    FROM owing o
    JOIN student st ON st.id = o.student_id
    JOIN person p ON p.id = st.person_id
    ${FINANCE_GUARDIANS}
   WHERE NOT EXISTS (
     SELECT 1
       FROM message_recipient mr
       JOIN message_request mq ON mq.id = mr.message_request_id
      WHERE mq.source_type = '${REMINDER_SOURCE}'
        AND mq.created_at >= CURRENT_DATE
        AND mr.person_id = gl.guardian_person_id
        AND mr.subject_person_id = p.id
        AND (mr.status IN ('sent', 'delivered', 'read')
             OR (mr.status = 'suppressed'
                 AND mr.suppression_reason IN ('muted', 'consent_withdrawn')))
   )`;

export const feeNoticeService = {
  /**
   * Tells the family a payment was received. Never throws: returns how many
   * guardians were told, or why nobody was.
   */
  async receiptReceived(scope: TenantScope, input: {
    invoiceId: string; paymentId: string; receiptNo: string;
  }): Promise<{ told: number; reason?: string }> {
    try {
      const prepared = await withTenant(scope, async (db) => {
        const template = await db.query<{ id: string }>(
          `SELECT id FROM message_template WHERE code = $1 AND deleted_at IS NULL`,
          [RECEIPT_TEMPLATE]);
        const templateId = template.rows[0]?.id;
        if (!templateId || !(await hasApprovedInApp(db, templateId))) {
          return { audience: [] as Audience[], reason: 'no_template' };
        }
        const { rows } = await db.query<{
          guardian_person_id: string; subject_person_id: string; child_name: string;
          amount: string; invoice_no: string; balance: string;
        }>(
          `SELECT gl.guardian_person_id, p.id AS subject_person_id,
                  p.given_name AS child_name,
                  pa.amount::text AS amount, i.invoice_no,
                  (i.total - i.amount_paid)::text AS balance
             FROM payment_allocation pa
             JOIN invoice i ON i.id = pa.invoice_id
             JOIN enrollment e ON e.id = i.enrollment_id
             JOIN student st ON st.id = e.student_id
             JOIN person p ON p.id = st.person_id
             ${FINANCE_GUARDIANS}
            WHERE pa.payment_id = $1::uuid AND pa.invoice_id = $2::uuid`,
          [input.paymentId, input.invoiceId]);
        return {
          reason: rows.length === 0 ? 'no_guardian' : undefined,
          audience: rows.map<Audience>((r) => ({
            personId: r.guardian_person_id,
            subjectPersonId: r.subject_person_id,
            variables: {
              name: r.child_name, amount: inr(r.amount), receipt: input.receiptNo,
              invoice: r.invoice_no, balance: inr(r.balance),
            },
          })),
        };
      });
      if (prepared.audience.length === 0) {
        return { told: 0, ...(prepared.reason ? { reason: prepared.reason } : {}) };
      }

      const queued = await dispatchService.queue(scope, {
        templateCode: RECEIPT_TEMPLATE,
        // The payment, not the request: a retried call is the same notice.
        idempotencyKey: `fee-receipt:${input.paymentId}`,
        sourceType: 'payment', sourceId: input.paymentId,
      });
      const { outcomes } = await dispatchService.dispatch(scope, {
        requestId: queued.requestId, audience: prepared.audience,
        provider: inAppOnlyProvider,
      });
      return { told: outcomes.filter((o) => o.outcome === 'sent').length };
    } catch (error) {
      logger.warn({ err: error, payment_id: input.paymentId },
        'receipt notice could not be sent; the payment itself is recorded');
      return { told: 0, reason: 'failed' };
    }
  },

  async reminderStatus(scope: TenantScope): Promise<ReminderStatus> {
    return withTenant(scope, async (db) => {
      const template = await db.query<{ code: string }>(
        `SELECT t.code FROM message_template t
          WHERE t.purpose = $1 AND t.deleted_at IS NULL
            AND EXISTS (SELECT 1 FROM message_template_version v
                         WHERE v.message_template_id = t.id AND v.channel = 'in_app'
                           AND v.approval_status = 'approved')
          ORDER BY t.created_at LIMIT 1`, [REMINDER_PURPOSE]);
      const { rows } = await db.query<Omit<ReminderStatus, 'templateCode'>>(
        `WITH pending AS (${PENDING_REMINDERS}),
              owing_children AS (
                SELECT DISTINCT e.student_id
                  FROM invoice i JOIN enrollment e ON e.id = i.enrollment_id
                 WHERE i.status IN ('issued', 'part_paid')
                   AND i.due_on < CURRENT_DATE AND i.total > i.amount_paid)
         SELECT (SELECT count(*)::int FROM owing_children) AS overdue,
                (SELECT count(DISTINCT subject_person_id)::int FROM pending) AS "toRemind",
                (SELECT count(DISTINCT subject_person_id)::int FROM pending p1
                  WHERE permission = 'no_consent'
                    AND NOT EXISTS (SELECT 1 FROM pending p2
                                     WHERE p2.subject_person_id = p1.subject_person_id
                                       AND p2.permission = 'ok')) AS "noConsent",
                (SELECT count(*)::int FROM owing_children oc
                  WHERE NOT EXISTS (
                    SELECT 1 FROM guardian_link gl
                     WHERE gl.student_id = oc.student_id
                       AND gl.effective_to IS NULL
                       AND gl.effective_from <= CURRENT_DATE
                       AND gl.can_view_finance
                       AND gl.can_receive_notifications)) AS "noGuardian",
                (SELECT count(*)::int FROM pending WHERE permission = 'ok') AS notices`);
      const counts = rows[0] ?? { overdue: 0, toRemind: 0, noConsent: 0, noGuardian: 0, notices: 0 };
      return { ...counts, templateCode: template.rows[0]?.code ?? null };
    });
  },

  /** Who would be reminded now, each about their own child. */
  async reminderAudience(db: TenantClient): Promise<Audience[]> {
    const { rows } = await db.query<{
      guardian_person_id: string; subject_person_id: string; child_name: string;
      outstanding: string; oldest_due: string;
    }>(`${PENDING_REMINDERS} ORDER BY p.given_name, gl.guardian_person_id`);
    return rows.map((r) => ({
      personId: r.guardian_person_id,
      subjectPersonId: r.subject_person_id,
      variables: { name: r.child_name, amount: inr(r.outstanding), due: r.oldest_due },
    }));
  },
};
