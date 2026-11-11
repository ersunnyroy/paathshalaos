/**
 * Everything a printed fee receipt has on it, for one invoice (M47.1).
 *
 * Paying has issued a receipt number since M7, and nothing could show one: the
 * counter got "Payment recorded, receipt issued" and the family got nothing to
 * hold. This is the read behind the page that prints.
 *
 * One call, because a receipt is one piece of paper: the school's name, whose
 * fee it is, what was billed, what was paid and when, and what is still owed.
 * Amounts are decimal strings exactly as stored — a receipt is the last place
 * a float should get a say.
 *
 * Row-level security decides who may ask. The office sees any invoice; a
 * guardian sees their own child's, and only the receipts for payments they
 * made themselves (`receipt_read` in 0027). Nothing here widens that.
 */
import { withTenant, type TenantScope } from '../../db/tenant.ts';

export interface ReceiptSheet {
  school: { name: string; legal_name: string; gstin: string | null; campus: string };
  learner: {
    name: string; admission_no: string;
    class_name: string | null; section_name: string; roll_no: string | null;
  };
  invoice: {
    id: string; invoice_no: string; financial_year: string;
    issued_on: string; due_on: string; status: string;
    subtotal: string; discount_total: string; tax_total: string;
    total: string; amount_paid: string;
  };
  lines: Array<{
    description: string; quantity: string; unit_amount: string;
    discount_amount: string; tax_amount: string; line_total: string;
  }>;
  receipts: Array<{
    id: string; receipt_no: string; issued_on: string;
    /** The whole payment the receipt is for. */
    amount: string;
    /** How much of that payment went to THIS invoice. */
    allocated: string;
    method: string; received_by: string | null; cancelled: boolean;
  }>;
}

export const receiptService = {
  async sheetFor(scope: TenantScope, invoiceId: string): Promise<ReceiptSheet | undefined> {
    return withTenant(scope, async (db) => {
      const head = await db.query<{
        id: string; invoice_no: string; financial_year: string;
        issued_on: string; due_on: string; status: string;
        subtotal: string; discount_total: string; tax_total: string;
        total: string; amount_paid: string;
        school_name: string; legal_name: string; gstin: string | null; campus: string;
        given_name: string; family_name: string | null; admission_no: string;
        class_name: string | null; section_name: string; roll_no: string | null;
      }>(
        `SELECT i.id, i.invoice_no, i.financial_year,
                i.issued_on::text, i.due_on::text, i.status,
                i.subtotal::text, i.discount_total::text, i.tax_total::text,
                i.total::text, i.amount_paid::text,
                o.display_name AS school_name, o.legal_name, o.gstin,
                c.name AS campus,
                p.given_name, p.family_name, st.admission_no,
                cg.name AS class_name, sec.name AS section_name, e.roll_no
           FROM invoice i
           JOIN organization o ON o.id = i.tenant_id
           JOIN campus c ON c.id = i.campus_id
           JOIN enrollment e ON e.id = i.enrollment_id
           JOIN student st ON st.id = e.student_id
           JOIN person p ON p.id = st.person_id
           JOIN section sec ON sec.id = e.section_id
           LEFT JOIN class_group cg ON cg.id = sec.class_group_id
          WHERE i.id = $1`, [invoiceId]);
      const row = head.rows[0];
      if (!row) return undefined;

      const lines = await db.query<ReceiptSheet['lines'][number]>(
        `SELECT description, quantity::text, unit_amount::text,
                discount_amount::text, tax_amount::text, line_total::text
           FROM invoice_line
          WHERE invoice_id = $1
          ORDER BY created_at, id`, [invoiceId]);

      const receipts = await db.query<ReceiptSheet['receipts'][number]>(
        `SELECT r.id, r.receipt_no, r.issued_on::text, r.amount::text,
                pa.amount::text AS allocated, pay.method,
                rp.given_name || COALESCE(' ' || rp.family_name, '') AS received_by,
                (r.cancelled_by_receipt_id IS NOT NULL) AS cancelled
           FROM payment_allocation pa
           JOIN payment pay ON pay.id = pa.payment_id
           JOIN receipt r ON r.payment_id = pay.id
           LEFT JOIN staff rs ON rs.id = pay.received_by
           LEFT JOIN person rp ON rp.id = rs.person_id
          WHERE pa.invoice_id = $1
            -- A receipt exists only for money that arrived, but say so here
            -- rather than lean on how payments happen to be written today.
            AND pay.status = 'succeeded'
          ORDER BY r.issued_on, r.receipt_no`, [invoiceId]);

      return {
        school: { name: row.school_name, legal_name: row.legal_name,
                  gstin: row.gstin, campus: row.campus },
        learner: {
          name: `${row.given_name}${row.family_name ? ` ${row.family_name}` : ''}`,
          admission_no: row.admission_no, class_name: row.class_name,
          section_name: row.section_name, roll_no: row.roll_no,
        },
        invoice: {
          id: row.id, invoice_no: row.invoice_no, financial_year: row.financial_year,
          issued_on: row.issued_on, due_on: row.due_on, status: row.status,
          subtotal: row.subtotal, discount_total: row.discount_total,
          tax_total: row.tax_total, total: row.total, amount_paid: row.amount_paid,
        },
        lines: lines.rows,
        receipts: receipts.rows,
      };
    });
  },
};
