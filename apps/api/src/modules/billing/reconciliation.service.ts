import { withTenant, type TenantScope } from '../../db/tenant.ts';
import { auditService } from '../audit/audit.service.ts';
import { ApiError } from '../../common/errors.ts';
import { Money, type Paise } from './money.ts';
import { ledgerService, Account } from './ledger.service.ts';

export interface UnmatchedLine {
  id: string;
  provider_payment_id: string;
  amount: string;
  settled_on: string;
  utr: string;
}

/**
 * Reconciliation.
 *
 * What the gateway pays into the bank is rarely what the day's payments add up
 * to: fees are deducted, some payments settle a day later, and refunds are
 * netted off. The unmatched queue is a first-class screen rather than an error
 * log, because a line nobody can match is money in the bank that has not been
 * attributed to a family — and somebody has to look at it before the month
 * closes.
 */
export const reconciliationService = {
  async importSettlement(
    scope: TenantScope,
    input: {
      provider: string; utr: string; settledOn: string;
      grossMinor: Paise; feeMinor: Paise; taxMinor: Paise;
      lines: Array<{ providerPaymentId: string; amountMinor: Paise; providerFeeMinor: Paise }>;
    },
  ): Promise<{ batchId: string; matched: number; unmatched: number }> {
    const result = await withTenant(scope, async (db) => {
      const net = input.grossMinor - input.feeMinor - input.taxMinor;

      const batchRows = await db.query<{ id: string }>(
        `INSERT INTO settlement_batch
           (tenant_id, provider, utr, settled_on, gross_amount, fee_amount, tax_amount, net_amount)
         VALUES (app_current_tenant_id(), $1, $2, $3::date, $4::numeric, $5::numeric,
                 $6::numeric, $7::numeric)
         ON CONFLICT (provider, utr) DO NOTHING
         RETURNING id`,
        [input.provider, input.utr, input.settledOn,
         Money.toDecimalString(input.grossMinor), Money.toDecimalString(input.feeMinor),
         Money.toDecimalString(input.taxMinor), Money.toDecimalString(net)],
      );
      if (!batchRows.rows[0]) {
        throw ApiError.make('conflict', 'settlement_already_imported',
          'That settlement has already been imported.');
      }
      const batchId = batchRows.rows[0].id;

      let matched = 0;
      let unmatched = 0;
      let matchedTotal = 0n;

      for (const line of input.lines) {
        const payment = await db.query<{ id: string }>(
          `SELECT id FROM payment
            WHERE provider_payment_id = $1 AND status = 'succeeded'`,
          [line.providerPaymentId],
        );
        const paymentId = payment.rows[0]?.id ?? null;

        await db.query(
          `INSERT INTO settlement_line
             (tenant_id, settlement_batch_id, payment_id, provider_payment_id, amount,
              provider_fee, match_state, matched_at)
           VALUES (app_current_tenant_id(), $1, $2, $3, $4::numeric, $5::numeric, $6,
                   CASE WHEN $2::uuid IS NULL THEN NULL ELSE now() END)`,
          [batchId, paymentId, line.providerPaymentId,
           Money.toDecimalString(line.amountMinor),
           Money.toDecimalString(line.providerFeeMinor),
           paymentId ? 'matched' : 'unmatched'],
        );

        if (paymentId) {
          matched += 1;
          matchedTotal += line.amountMinor;
        } else {
          unmatched += 1;
        }
      }

      // Money moves from the clearing account into the bank, with the gateway's
      // cut recognised as an expense. Only the matched portion is posted:
      // unattributed money does not belong in fee income.
      if (matchedTotal > 0n) {
        const feeShare = input.feeMinor + input.taxMinor;
        await ledgerService.post(db, {
          sourceType: 'settlement',
          sourceId: batchId,
          occurredOn: input.settledOn,
          lines: [
            { account: Account.BANK, debit: matchedTotal - feeShare, narration: `UTR ${input.utr}` },
            { account: Account.GATEWAY_FEE, debit: feeShare, narration: 'Gateway fee' },
            { account: Account.BANK_CLEARING, credit: matchedTotal, narration: `UTR ${input.utr}` },
          ],
        });
      }

      return { batchId, matched, unmatched };
    });

    await auditService.record({
      tenantId: scope.tenantId,
      actorUserId: scope.actorId,
      action: 'settlement.imported',
      resourceType: 'settlement_batch',
      resourceId: result.batchId,
      classification: 'INTERNAL',
      after: { utr: input.utr, matched: result.matched, unmatched: result.unmatched },
    });
    return result;
  },

  /** The screen an accountant opens every morning. */
  async unmatchedQueue(scope: TenantScope): Promise<UnmatchedLine[]> {
    return withTenant(scope, async (db) => {
      const { rows } = await db.query<UnmatchedLine>(
        `SELECT sl.id, sl.provider_payment_id, sl.amount::text,
                sb.settled_on::text, sb.utr
           FROM settlement_line sl
           JOIN settlement_batch sb ON sb.id = sl.settlement_batch_id
          WHERE sl.match_state = 'unmatched'
          ORDER BY sb.settled_on, sl.created_at`,
      );
      return rows;
    });
  },

  async matchManually(
    scope: TenantScope,
    input: { settlementLineId: string; paymentId: string; note: string },
  ): Promise<void> {
    await withTenant(scope, async (db) => {
      const { rows } = await db.query<{ id: string }>(
        `UPDATE settlement_line
            SET payment_id = $2, match_state = 'matched', matched_at = now(), note = $3
          WHERE id = $1 AND match_state = 'unmatched'
          RETURNING id`,
        [input.settlementLineId, input.paymentId, input.note],
      );
      if (!rows[0]) {
        throw ApiError.make('conflict', 'not_unmatched',
          'That settlement line is not awaiting a match.');
      }
    });

    await auditService.record({
      tenantId: scope.tenantId,
      actorUserId: scope.actorId,
      action: 'settlement.matched_manually',
      resourceType: 'settlement_line',
      resourceId: input.settlementLineId,
      classification: 'INTERNAL',
      reason: input.note,
    });
  },

  /**
   * The daily control total: what the ledger says is in the clearing account
   * versus what has settled. A non-zero balance is money in flight, which is
   * normal — a balance that does not clear within a few days is not.
   */
  async clearingBalance(scope: TenantScope): Promise<Paise> {
    return withTenant(scope, (db) => ledgerService.accountBalance(db, Account.BANK_CLEARING));
  },
};
