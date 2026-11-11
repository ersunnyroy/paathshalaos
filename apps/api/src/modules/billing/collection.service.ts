/**
 * What the counter took on a day (M47.5).
 *
 * At closing, a cashier counts the drawer and somebody signs for it. The
 * ledger's day book answers that in debits and credits; this answers it the
 * way the drawer is counted: every receipt issued that day, who it was for,
 * how it was paid and who took it.
 *
 * One row per (receipt, invoice): a payment split across two invoices is two
 * rows that share a receipt number, each with the amount that went to its own
 * invoice, so the rows add up to the money and no payment is counted twice.
 * Cancelled receipts are listed and marked rather than hidden — a number
 * missing from the day's run is the first thing an auditor asks about.
 *
 * Finance only, by the policies already on `receipt` and `payment`: a teacher
 * who asks gets an empty day, not a refusal that confirms there is something
 * to see.
 */
import { withTenant, type TenantScope } from '../../db/tenant.ts';

export interface CollectionRow {
  receipt_id: string; receipt_no: string; issued_on: string;
  invoice_id: string; invoice_no: string;
  learner: string; admission_no: string;
  class_name: string | null; section_name: string;
  method: string;
  /** The share of the payment that went to this invoice. */
  amount: string;
  received_by: string | null; cancelled: boolean;
}

export const collectionService = {
  async on(scope: TenantScope, input: { on: string; campusId?: string | undefined }):
  Promise<CollectionRow[]> {
    return withTenant(scope, async (db) => {
      const { rows } = await db.query<CollectionRow>(
        `SELECT r.id AS receipt_id, r.receipt_no, r.issued_on::text,
                i.id AS invoice_id, i.invoice_no,
                p.given_name || COALESCE(' ' || p.family_name, '') AS learner,
                st.admission_no, cg.name AS class_name, sec.name AS section_name,
                pay.method, pa.amount::text AS amount,
                rp.given_name || COALESCE(' ' || rp.family_name, '') AS received_by,
                (r.cancelled_by_receipt_id IS NOT NULL) AS cancelled
           FROM receipt r
           JOIN payment pay ON pay.id = r.payment_id
           JOIN payment_allocation pa ON pa.payment_id = pay.id
           JOIN invoice i ON i.id = pa.invoice_id
           JOIN enrollment e ON e.id = i.enrollment_id
           JOIN student st ON st.id = e.student_id
           JOIN person p ON p.id = st.person_id
           JOIN section sec ON sec.id = e.section_id
           LEFT JOIN class_group cg ON cg.id = sec.class_group_id
           LEFT JOIN staff rs ON rs.id = pay.received_by
           LEFT JOIN person rp ON rp.id = rs.person_id
          WHERE r.issued_on = $1::date
            AND pay.status = 'succeeded'
            AND ($2::uuid IS NULL OR r.campus_id = $2::uuid)
          ORDER BY r.receipt_no, i.invoice_no`,
        [input.on, input.campusId ?? null]);
      return rows;
    });
  },
};
