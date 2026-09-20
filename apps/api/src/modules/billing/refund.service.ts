import { withTenant, type TenantScope } from '../../db/tenant.ts';
import { auditService } from '../audit/audit.service.ts';
import { outboxService } from '../events/outbox.service.ts';
import { ApiError } from '../../common/errors.ts';
import { Money, type Paise } from './money.ts';
import { ledgerService, Account } from './ledger.service.ts';

export interface Refund {
  id: string;
  payment_id: string;
  amount: string;
  status: string;
}

/**
 * AC-7 — a refund preserves the financial trail.
 *
 * Nothing about the original payment or receipt changes. The refund is a new
 * record with its own approval and its own reversing ledger entries, so the
 * ledger shows money in and money out rather than a payment that quietly became
 * smaller.
 *
 * Two people are required, because refund fraud is the insider risk in a fee
 * system: one person can otherwise refund a real payment to their own account
 * and the books still balance.
 */
export const refundService = {
  async request(
    scope: TenantScope,
    input: {
      paymentId: string; amountMinor: Paise; reason: string;
      requestedByStaffId: string; idempotencyKey: string;
    },
  ): Promise<Refund> {
    if (!input.reason.trim()) {
      throw ApiError.make('validation_error', 'reason_required', 'A refund must record why.');
    }
    if (input.amountMinor <= 0n) {
      throw ApiError.make('validation_error', 'amount_must_be_positive',
        'A refund must be for a positive amount.');
    }

    const created = await withTenant(scope, async (db) => {
      const existing = await db.query<Refund>(
        `SELECT id, payment_id, amount::text, status FROM refund WHERE idempotency_key = $1`,
        [input.idempotencyKey],
      );
      if (existing.rows[0]) return existing.rows[0];

      const paymentRows = await db.query<{ amount: string; status: string }>(
        'SELECT amount::text, status FROM payment WHERE id = $1', [input.paymentId],
      );
      const payment = paymentRows.rows[0];
      if (!payment) {
        throw ApiError.make('not_found', 'payment_not_found', 'Payment not found.');
      }
      if (payment.status !== 'succeeded') {
        throw ApiError.make('conflict', 'payment_not_settled',
          'Only a settled payment can be refunded.');
      }

      const alreadyRefunded = await db.query<{ total: string }>(
        `SELECT COALESCE(sum(amount), 0)::text AS total FROM refund
          WHERE payment_id = $1 AND status IN ('approved', 'processing', 'settled')`,
        [input.paymentId],
      );
      const remaining =
        Money.fromDecimalString(payment.amount) -
        Money.fromDecimalString(alreadyRefunded.rows[0]!.total);

      if (input.amountMinor > remaining) {
        // Refunding more than was received creates money.
        throw ApiError.make('conflict', 'refund_exceeds_payment',
          `Only ${Money.toDecimalString(remaining)} remains refundable on this payment.`);
      }

      const { rows } = await db.query<Refund>(
        `INSERT INTO refund
           (tenant_id, payment_id, amount, reason, requested_by, idempotency_key)
         VALUES (app_current_tenant_id(), $1, $2::numeric, $3, $4, $5)
         RETURNING id, payment_id, amount::text, status`,
        [input.paymentId, Money.toDecimalString(input.amountMinor), input.reason,
         input.requestedByStaffId, input.idempotencyKey],
      );
      if (!rows[0]) {
        throw ApiError.make('permission_error', 'staff_only', 'Only staff may request refunds.');
      }
      return rows[0];
    });

    await auditService.record({
      tenantId: scope.tenantId,
      actorUserId: scope.actorId,
      action: 'refund.requested',
      resourceType: 'refund',
      resourceId: created.id,
      classification: 'SENSITIVE',
      after: { amount: created.amount },
      reason: input.reason,
    });
    return created;
  },

  /**
   * Approval posts the reversing entries. The original payment row is not
   * touched — asserted by a test that hashes it before and after.
   */
  async approve(
    scope: TenantScope,
    input: { refundId: string; approverStaffId: string },
  ): Promise<Refund> {
    const approved = await withTenant(scope, async (db) => {
      const found = await db.query<{
        id: string; payment_id: string; amount: string; status: string;
        requested_by: string; campus_id: string;
      }>(
        `SELECT r.id, r.payment_id, r.amount::text, r.status, r.requested_by, p.campus_id
           FROM refund r JOIN payment p ON p.id = r.payment_id
          WHERE r.id = $1`,
        [input.refundId],
      );
      const refund = found.rows[0];
      if (!refund) {
        throw ApiError.make('not_found', 'refund_not_found', 'Refund not found.');
      }
      if (refund.status !== 'requested') {
        throw ApiError.make('conflict', 'not_pending', 'That refund is not awaiting approval.');
      }
      if (refund.requested_by === input.approverStaffId) {
        throw ApiError.make('permission_error', 'needs_a_second_person',
          'A refund must be approved by someone other than the person who requested it.');
      }

      const { rows } = await db.query<Refund>(
        `UPDATE refund
            SET status = 'approved', approved_by = $2, approved_at = now()
          WHERE id = $1
          RETURNING id, payment_id, amount::text, status`,
        [input.refundId, input.approverStaffId],
      );

      const amount = Money.fromDecimalString(refund.amount);

      // Reversing entries, not an edit. The ledger shows money in and money out.
      await ledgerService.post(db, {
        campusId: refund.campus_id,
        sourceType: 'refund',
        sourceId: refund.id,
        lines: [
          { account: Account.FEE_RECEIVABLE, debit: amount, narration: 'Refund approved' },
          { account: Account.REFUND_PAYABLE, credit: amount, narration: 'Refund approved' },
        ],
      });

      // The invoices this payment settled reopen by the refunded amount.
      const allocations = await db.query<{ invoice_id: string; amount: string }>(
        `SELECT invoice_id, amount::text FROM payment_allocation
          WHERE payment_id = $1 ORDER BY allocated_at DESC`,
        [refund.payment_id],
      );
      let toReverse = amount;
      for (const alloc of allocations.rows) {
        if (toReverse <= 0n) break;
        const allocated = Money.fromDecimalString(alloc.amount);
        const take = toReverse < allocated ? toReverse : allocated;
        await db.query(
          `UPDATE invoice
              SET amount_paid = amount_paid - $2::numeric,
                  status = CASE WHEN amount_paid - $2::numeric <= 0 THEN 'issued'
                                ELSE 'part_paid' END
            WHERE id = $1`,
          [alloc.invoice_id, Money.toDecimalString(take)],
        );
        toReverse -= take;
      }

      return rows[0]!;
    });

    await auditService.record({
      tenantId: scope.tenantId,
      actorUserId: scope.actorId,
      action: 'refund.approved',
      resourceType: 'refund',
      resourceId: approved.id,
      classification: 'SENSITIVE',
      after: { amount: approved.amount, approvedBy: input.approverStaffId },
    });
    return approved;
  },

  /** The provider confirms the money left. Completes the ledger picture. */
  async markSettled(
    scope: TenantScope,
    input: { refundId: string; providerRefundId: string;
             settledOn?: string | undefined },
  ): Promise<void> {
    await withTenant(scope, async (db) => {
      const found = await db.query<{
        id: string; amount: string; status: string; campus_id: string;
      }>(
        `SELECT r.id, r.amount::text, r.status, p.campus_id
           FROM refund r JOIN payment p ON p.id = r.payment_id WHERE r.id = $1`,
        [input.refundId],
      );
      const refund = found.rows[0];
      if (!refund) throw ApiError.make('not_found', 'refund_not_found', 'Refund not found.');
      if (refund.status === 'settled') return;
      if (refund.status !== 'approved' && refund.status !== 'processing') {
        throw ApiError.make('conflict', 'not_approved',
          'Only an approved refund can settle.');
      }

      await db.query(
        `UPDATE refund
            SET status = 'settled', provider_refund_id = $2,
                settled_on = COALESCE($3::date, CURRENT_DATE)
          WHERE id = $1`,
        [input.refundId, input.providerRefundId, input.settledOn ?? null],
      );

      const amount = Money.fromDecimalString(refund.amount);
      await ledgerService.post(db, {
        campusId: refund.campus_id,
        sourceType: 'refund_settlement',
        sourceId: refund.id,
        lines: [
          { account: Account.REFUND_PAYABLE, debit: amount, narration: 'Refund paid out' },
          { account: Account.BANK, credit: amount, narration: 'Refund paid out' },
        ],
      });

      await outboxService.emit(db, {
        eventType: 'refund.completed',
        aggregateType: 'refund',
        aggregateId: refund.id,
        payload: { refundId: refund.id, amount: refund.amount },
      });
    });

    await auditService.record({
      tenantId: scope.tenantId,
      actorUserId: scope.actorId,
      action: 'refund.settled',
      resourceType: 'refund',
      resourceId: input.refundId,
      classification: 'SENSITIVE',
    });
  },

  async reject(
    scope: TenantScope,
    input: { refundId: string; rejectedByStaffId: string; reason: string },
  ): Promise<void> {
    await withTenant(scope, async (db) => {
      const { rows } = await db.query<{ id: string }>(
        `UPDATE refund SET status = 'rejected', rejected_by = $2, rejected_at = now()
          WHERE id = $1 AND status = 'requested' RETURNING id`,
        [input.refundId, input.rejectedByStaffId],
      );
      if (!rows[0]) {
        throw ApiError.make('conflict', 'not_pending', 'That refund is not awaiting approval.');
      }
    });

    await auditService.record({
      tenantId: scope.tenantId,
      actorUserId: scope.actorId,
      action: 'refund.rejected',
      resourceType: 'refund',
      resourceId: input.refundId,
      classification: 'SENSITIVE',
      reason: input.reason,
    });
  },
};
