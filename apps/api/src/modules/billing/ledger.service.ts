import { randomUUID } from 'node:crypto';
import type { TenantClient } from '../../db/tenant.ts';
import { Money, type Paise } from './money.ts';

/**
 * The chart of accounts, as a closed set.
 *
 * Deliberately small and deliberately code, not data. These are the accounts the
 * product itself posts to; an institute's own chart of accounts lives in their
 * accounting system and is reached through the Tally export. Letting tenants
 * define posting accounts would mean the ledger's own invariants depend on
 * configuration.
 */
export const Account = {
  FEE_RECEIVABLE: '1100_fee_receivable',
  BANK_CLEARING: '1200_bank_clearing',
  BANK: '1210_bank',
  CASH: '1220_cash',
  FEE_INCOME: '4100_fee_income',
  CONCESSION_EXPENSE: '5100_concession',
  GATEWAY_FEE: '5200_gateway_fee',
  REFUND_PAYABLE: '2100_refund_payable',
  WAIVER_EXPENSE: '5300_waiver',
} as const;

export type AccountCode = (typeof Account)[keyof typeof Account];

export interface LedgerLine {
  account: AccountCode;
  debit?: Paise;
  credit?: Paise;
  narration?: string;
}

/**
 * Posts a balanced group.
 *
 * The balance is asserted here as well as by the deferred database constraint —
 * not because the database check is unreliable, but because a failure at commit
 * reports a transaction that is already unwindable, while a failure here names
 * the caller that built the bad group. Two checks, two different diagnostics.
 */
export const ledgerService = {
  async post(
    db: TenantClient,
    input: {
      campusId?: string;
      lines: LedgerLine[];
      sourceType: string;
      sourceId?: string;
      occurredOn?: string;
    },
  ): Promise<string> {
    const debits = Money.sum(input.lines.map((l) => l.debit ?? 0n));
    const credits = Money.sum(input.lines.map((l) => l.credit ?? 0n));

    if (debits !== credits) {
      throw new Error(
        `Ledger group does not balance: debits ${Money.toDecimalString(debits)}, ` +
        `credits ${Money.toDecimalString(credits)} (source ${input.sourceType})`,
      );
    }
    if (debits === 0n) {
      throw new Error(`Refusing to post an empty ledger group for ${input.sourceType}.`);
    }

    const entryGroupId = randomUUID();
    for (const line of input.lines) {
      await db.query(
        `INSERT INTO ledger_entry
           (tenant_id, campus_id, entry_group_id, account_code, debit, credit,
            occurred_on, source_type, source_id, narration)
         VALUES (app_current_tenant_id(), $1, $2, $3, $4::numeric, $5::numeric,
                 COALESCE($6::date, CURRENT_DATE), $7, $8, $9)`,
        [
          input.campusId ?? null,
          entryGroupId,
          line.account,
          Money.toDecimalString(line.debit ?? 0n),
          Money.toDecimalString(line.credit ?? 0n),
          input.occurredOn ?? null,
          input.sourceType,
          input.sourceId ?? null,
          line.narration ?? null,
        ],
      );
    }
    return entryGroupId;
  },

  /**
   * Any group that does not sum to zero — the integrity job's query (M33.2).
   *
   * The `WHERE` clause is not redundant. This used to have none, on the
   * reasonable assumption that `ledger_entry`'s `finance_only` policy would
   * supply the tenant filter. It does, for a request. The scheduled job runs on
   * the maintenance connection, where row-level security is bypassed — and
   * without this line the first run reported one school's broken ledger as
   * every school's.
   *
   * Every query that can run under `db/maintenance.ts` has to name its tenant
   * itself. A query that leans on a policy for correctness is a query that is
   * wrong the moment anything runs it with the policy off.
   */
  async unbalancedGroups(db: TenantClient): Promise<Array<{ entry_group_id: string }>> {
    const { rows } = await db.query<{ entry_group_id: string }>(
      `SELECT entry_group_id
         FROM ledger_entry
        WHERE tenant_id = app_current_tenant_id()
        GROUP BY entry_group_id
       HAVING sum(debit) <> sum(credit)`,
    );
    return rows;
  },

  async accountBalance(db: TenantClient, account: AccountCode): Promise<Paise> {
    const { rows } = await db.query<{ balance: string }>(
      `SELECT COALESCE(sum(debit) - sum(credit), 0)::text AS balance
         FROM ledger_entry WHERE account_code = $1`,
      [account],
    );
    return Money.fromDecimalString(rows[0]?.balance ?? '0');
  },

  async entriesFor(
    db: TenantClient,
    sourceType: string,
    sourceId: string,
  ): Promise<Array<{ account_code: string; debit: string; credit: string; entry_group_id: string }>> {
    const { rows } = await db.query<{
      account_code: string; debit: string; credit: string; entry_group_id: string;
    }>(
      `SELECT account_code, debit::text, credit::text, entry_group_id
         FROM ledger_entry
        WHERE source_type = $1 AND source_id = $2
        ORDER BY created_at, account_code`,
      [sourceType, sourceId],
    );
    return rows;
  },
};
