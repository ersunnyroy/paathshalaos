/**
 * Reads what `revenue.ts` adds up (M42.5).
 *
 * Everything here is the platform's own relationship with a school: which
 * plan it is on and what we have invoiced it. Nothing reads inside a school —
 * no learner, no fee invoice — and the platform role could not if this tried.
 *
 * **There is no "collected" figure, deliberately.** `platform_invoice` records
 * what was billed; nothing in this schema records a school paying it, because
 * M25's payment provider is still unbuilt. A collections number derived from
 * invoices would be the invoiced number under another name.
 */
import { withPlatform } from '../../db/platform-pool.ts';
import { Money } from '../billing/money.ts';
import { financialYearOf } from './gst.ts';
import {
  summarise, combineMonths, signed,
  type LiveSubscription, type MonthRow, type RevenueSummary, type MonthSummary,
} from './revenue.ts';

export interface RevenueOverview extends RevenueSummary {
  asOf: string;
  months: MonthSummary[];
  financialYear: { label: string; invoices: number; invoiced: string; credited: string; net: string };
}

export const revenueService = {
  async overview(now: Date = new Date()): Promise<RevenueOverview> {
    const today = now.toISOString().slice(0, 10);
    const financialYear = financialYearOf(now);

    return withPlatform(async (db) => {
      const { rows: subscriptions } = await db.query<LiveSubscription>(
        `SELECT s.tenant_id, o.display_name, s.status, s.billing_period,
                pv.price_monthly::text, pv.price_annual::text,
                p.code AS plan_code, p.name AS plan_name, pv.version,
                s.trial_ends_on::text AS trial_ends_on
           FROM subscription s
           JOIN organization o ON o.id = s.tenant_id AND o.deleted_at IS NULL
           JOIN plan_version pv ON pv.id = s.plan_version_id
           JOIN plan p ON p.id = pv.plan_id
          WHERE s.ended_at IS NULL`);

      const { rows: schools } = await db.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM organization WHERE deleted_at IS NULL');

      // Seven months back from the first of this month is always enough for
      // the six the summary shows, whatever day of the month it is.
      const { rows: invoiced } = await db.query<MonthRow>(
        `SELECT to_char(issued_on, 'YYYY-MM') AS month, count(*)::int AS documents,
                sum(taxable_value)::text AS taxable,
                sum(cgst + sgst + igst)::text AS tax, sum(total)::text AS total
           FROM platform_invoice
          WHERE issued_on >= (date_trunc('month', $1::date) - interval '7 months')
          GROUP BY 1`, [today]);

      const { rows: credited } = await db.query<MonthRow>(
        `SELECT to_char(issued_on, 'YYYY-MM') AS month, count(*)::int AS documents,
                sum(taxable_value)::text AS taxable,
                sum(cgst + sgst + igst)::text AS tax, sum(total)::text AS total
           FROM platform_credit_note
          WHERE issued_on >= (date_trunc('month', $1::date) - interval '7 months')
          GROUP BY 1`, [today]);

      const { rows: year } = await db.query<{ invoices: number; invoiced: string; credited: string }>(
        `SELECT (SELECT count(*)::int FROM platform_invoice WHERE financial_year = $1) AS invoices,
                (SELECT COALESCE(sum(total), 0)::text FROM platform_invoice WHERE financial_year = $1) AS invoiced,
                (SELECT COALESCE(sum(total), 0)::text FROM platform_credit_note WHERE financial_year = $1) AS credited`,
        [financialYear]);

      const fy = year[0]!;
      const fyInvoiced = Money.fromDecimalString(fy.invoiced);
      const fyCredited = Money.fromDecimalString(fy.credited);

      return {
        asOf: today,
        ...summarise(subscriptions, schools[0]?.n ?? 0, today),
        months: combineMonths(invoiced, credited, today),
        financialYear: {
          label: financialYear,
          invoices: fy.invoices,
          invoiced: Money.toDecimalString(fyInvoiced),
          credited: Money.toDecimalString(fyCredited),
          net: signed(fyInvoiced - fyCredited),
        },
      };
    });
  },
};
