import { withTenant, type TenantScope, type TenantClient } from '../../db/tenant.ts';
import { auditService } from '../audit/audit.service.ts';
import { outboxService } from '../events/outbox.service.ts';
import { ApiError } from '../../common/errors.ts';
import { Money, type Paise } from './money.ts';
import { ledgerService, Account } from './ledger.service.ts';

export interface Invoice {
  id: string;
  invoice_no: string;
  financial_year: string;
  total: string;
  amount_paid: string;
  status: string;
  due_on: string;
}

/** The Indian financial year containing a date: 1 April to 31 March. */
export function financialYearOf(date: Date): string {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  const start = month >= 4 ? year : year - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

/**
 * Gapless numbering per campus per financial year, under a transaction-scoped
 * advisory lock.
 *
 * A sequence would be simpler and would leave gaps on every rolled-back
 * transaction. An auditor reads a gap in an invoice series as a deleted invoice
 * and will ask about it, so the lock is the cheaper option in practice.
 */
async function nextInvoiceNo(
  db: TenantClient,
  campusId: string,
  financialYear: string,
  prefix: string,
): Promise<string> {
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',
    [`invno:${campusId}:${financialYear}`]);
  const { rows } = await db.query<{ next: string }>(
    `SELECT COALESCE(max(substring(invoice_no from '[0-9]+$')::int), 0) + 1 AS next
       FROM invoice
      WHERE campus_id = $1 AND financial_year = $2 AND invoice_no LIKE $3 || '%'`,
    [campusId, financialYear, prefix],
  );
  return `${prefix}${String(rows[0]!.next).padStart(6, '0')}`;
}

export const invoiceService = {
  /**
   * Raises the invoice for one instalment.
   *
   * Ledger posting happens in the same transaction: debit receivable, credit
   * fee income, and credit concession to expense if any was applied. An invoice
   * without its ledger entries is a number on a screen that the accounts never
   * see.
   */
  async issueForInstallment(
    scope: TenantScope,
    input: { installmentId: string; campusId: string; numberPrefix?: string; dueOn?: string },
  ): Promise<Invoice> {
    const issued = await withTenant(scope, async (db) => {
      const found = await db.query<{
        id: string; sequence: number; due_on: string; gross_amount: string;
        concession_amount: string; net_amount: string; status: string;
        enrollment_id: string; fee_plan_id: string; fee_assignment_id: string;
      }>(
        `SELECT i.id, i.sequence, i.due_on::text, i.gross_amount::text,
                i.concession_amount::text, i.net_amount::text, i.status,
                fa.enrollment_id, fa.fee_plan_id, fa.id AS fee_assignment_id
           FROM installment i
           JOIN fee_assignment fa ON fa.id = i.fee_assignment_id
          WHERE i.id = $1`,
        [input.installmentId],
      );
      const inst = found.rows[0];
      if (!inst) {
        throw ApiError.make('not_found', 'installment_not_found', 'Instalment not found.');
      }
      if (inst.status !== 'scheduled') {
        throw ApiError.make('conflict', 'already_invoiced',
          'That instalment has already been invoiced.');
      }

      const financialYear = financialYearOf(new Date());
      const invoiceNo = await nextInvoiceNo(
        db, input.campusId, financialYear, input.numberPrefix ?? 'INV-',
      );

      const gross = Money.fromDecimalString(inst.gross_amount);
      const discount = Money.fromDecimalString(inst.concession_amount);
      const net = Money.fromDecimalString(inst.net_amount);

      const { rows } = await db.query<Invoice>(
        `INSERT INTO invoice
           (tenant_id, campus_id, installment_id, enrollment_id, invoice_no, financial_year,
            due_on, subtotal, discount_total, tax_total, total)
         VALUES (app_current_tenant_id(), $1, $2, $3, $4, $5, COALESCE($6::date, $7::date),
                 $8::numeric, $9::numeric, 0, $10::numeric)
         RETURNING id, invoice_no, financial_year, total::text, amount_paid::text, status,
                   due_on::text`,
        [input.campusId, inst.id, inst.enrollment_id, invoiceNo, financialYear,
         input.dueOn ?? null, inst.due_on,
         Money.toDecimalString(gross), Money.toDecimalString(discount),
         Money.toDecimalString(net)],
      );
      if (!rows[0]) {
        throw ApiError.make('permission_error', 'staff_only', 'Only staff may raise invoices.');
      }
      const invoice = rows[0];

      // One line per non-optional component, so the family sees what they are
      // paying for rather than a single total.
      await db.query(
        `INSERT INTO invoice_line
           (tenant_id, invoice_id, fee_component_id, description, quantity, unit_amount,
            discount_amount, tax_rate, tax_amount, line_total, gl_code)
         SELECT app_current_tenant_id(), $1, fc.id, fc.name, 1,
                round(fc.amount / $3::numeric, 2), 0, fc.tax_rate,
                round((fc.amount * fc.tax_rate / 100) / $3::numeric, 2),
                round(fc.amount / $3::numeric, 2)
                  + round((fc.amount * fc.tax_rate / 100) / $3::numeric, 2),
                fc.gl_code
           FROM fee_component fc
          WHERE fc.fee_plan_id = $2 AND fc.is_optional = false`,
        [invoice.id, inst.fee_plan_id,
         String((await db.query<{ n: string }>(
           'SELECT count(*)::text AS n FROM installment WHERE fee_assignment_id = $1',
           [inst.fee_assignment_id],
         )).rows[0]!.n)],
      );

      await db.query(`UPDATE installment SET status = 'invoiced' WHERE id = $1`, [inst.id]);

      await ledgerService.post(db, {
        campusId: input.campusId,
        sourceType: 'invoice',
        sourceId: invoice.id,
        lines: discount > 0n
          ? [
              { account: Account.FEE_RECEIVABLE, debit: net, narration: `Invoice ${invoiceNo}` },
              { account: Account.CONCESSION_EXPENSE, debit: discount, narration: 'Concession' },
              { account: Account.FEE_INCOME, credit: gross, narration: `Invoice ${invoiceNo}` },
            ]
          : [
              { account: Account.FEE_RECEIVABLE, debit: net, narration: `Invoice ${invoiceNo}` },
              { account: Account.FEE_INCOME, credit: net, narration: `Invoice ${invoiceNo}` },
            ],
      });

      await outboxService.emit(db, {
        eventType: 'invoice.issued',
        aggregateType: 'invoice',
        aggregateId: invoice.id,
        payload: {
          invoiceId: invoice.id,
          invoiceNo: invoice.invoice_no,
          enrollmentId: inst.enrollment_id,
          total: invoice.total,
          dueOn: invoice.due_on,
        },
      });

      return invoice;
    });

    await auditService.record({
      tenantId: scope.tenantId,
      actorUserId: scope.actorId,
      action: 'invoice.issued',
      resourceType: 'invoice',
      resourceId: issued.id,
      classification: 'INTERNAL',
      after: { invoiceNo: issued.invoice_no, total: issued.total },
    });
    return issued;
  },

  async void(
    scope: TenantScope,
    input: { invoiceId: string; reason: string; voidedByStaffId: string },
  ): Promise<void> {
    if (!input.reason.trim()) {
      throw ApiError.make('validation_error', 'reason_required', 'Voiding requires a reason.');
    }

    await withTenant(scope, async (db) => {
      const found = await db.query<{ total: string; amount_paid: string; campus_id: string }>(
        'SELECT total::text, amount_paid::text, campus_id FROM invoice WHERE id = $1 AND status <> $2',
        [input.invoiceId, 'void'],
      );
      const inv = found.rows[0];
      if (!inv) {
        throw ApiError.make('conflict', 'cannot_void', 'That invoice cannot be voided.');
      }
      if (Money.fromDecimalString(inv.amount_paid) > 0n) {
        // Money already received against it: the correction is a refund, not a
        // void that would make the receipt refer to nothing.
        throw ApiError.make('conflict', 'invoice_has_payments',
          'This invoice has payments against it. Refund them instead of voiding.');
      }

      await db.query(
        `UPDATE invoice
            SET status = 'void', voided_at = now(), voided_by = $2, void_reason = $3
          WHERE id = $1`,
        [input.invoiceId, input.voidedByStaffId, input.reason],
      );

      // The row stays; the ledger is corrected by a reversing group.
      const total = Money.fromDecimalString(inv.total);
      await ledgerService.post(db, {
        campusId: inv.campus_id,
        sourceType: 'invoice_void',
        sourceId: input.invoiceId,
        lines: [
          { account: Account.FEE_INCOME, debit: total, narration: 'Invoice voided' },
          { account: Account.FEE_RECEIVABLE, credit: total, narration: 'Invoice voided' },
        ],
      });
    });

    await auditService.record({
      tenantId: scope.tenantId,
      actorUserId: scope.actorId,
      action: 'invoice.voided',
      resourceType: 'invoice',
      resourceId: input.invoiceId,
      classification: 'INTERNAL',
      reason: input.reason,
    });
  },

  async outstandingFor(scope: TenantScope, enrollmentId: string): Promise<Paise> {
    return withTenant(scope, async (db) => {
      const { rows } = await db.query<{ due: string }>(
        `SELECT COALESCE(sum(total - amount_paid), 0)::text AS due
           FROM invoice
          WHERE enrollment_id = $1 AND status IN ('issued', 'part_paid')`,
        [enrollmentId],
      );
      return Money.fromDecimalString(rows[0]?.due ?? '0');
    });
  },

  async byId(scope: TenantScope, invoiceId: string): Promise<Invoice | undefined> {
    return withTenant(scope, async (db) => {
      const { rows } = await db.query<Invoice>(
        `SELECT id, invoice_no, financial_year, total::text, amount_paid::text, status,
                due_on::text
           FROM invoice WHERE id = $1`,
        [invoiceId],
      );
      return rows[0];
    });
  },
};
