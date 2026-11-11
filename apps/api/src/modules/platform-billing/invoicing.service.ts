/**
 * Issuing an invoice to a school (M25.2).
 *
 * Runs on the platform pool. Our revenue is not the school's data, and an
 * invoice raised on the tenant pool would be scoped by whichever school's
 * request happened to trigger it.
 */
import { withPlatform } from '../../db/platform-pool.ts';
import { ApiError } from '../../common/errors.ts';
import { Money, type Paise } from '../billing/money.ts';
import {
  taxInvoice, supplyTypeFor, financialYearOf, documentNumber,
  type SupplyType,
} from './gst.ts';

/** Configuration, not law. See the note at the top of gst.ts. */
export const DEFAULT_TAX_RATE = 18;
export const DEFAULT_SAC_CODE = '997331';
const INVOICE_PREFIX = 'PS';
const CREDIT_PREFIX = 'CN';

/** How long a school has to pay us. */
const PAYMENT_TERMS_DAYS = 14;

export interface IssuedInvoice {
  id: string;
  invoice_no: string;
  financial_year: string;
  serial: number;
  supply_type: SupplyType;
  taxable_value: string;
  cgst: string;
  sgst: string;
  igst: string;
  total: string;
  issued_on: string;
  due_on: string;
}

export const invoicingService = {
  /**
   * Raises the invoice for one subscription period.
   *
   * Everything happens in one transaction, and that is the whole design. The
   * serial is allocated by locking a counter row rather than from a sequence,
   * because a sequence does not roll back and a failed insert would leave a
   * hole in a statutory series — see 0071. Locking inside the transaction
   * means a rollback takes the number back with it.
   */
  async issueForPeriod(input: {
    tenantId: string;
    subscriptionId: string;
    periodStart: string;
    periodEnd: string;
    /** Whole or partial months. "1" for a full month, "0.42" for part of one. */
    quantity?: string | undefined;
    taxRate?: number | undefined;
    sacCode?: string | undefined;
    issuedOn?: Date | undefined;
  }): Promise<IssuedInvoice> {
    const issuedOn = input.issuedOn ?? new Date();
    const financialYear = financialYearOf(issuedOn);

    return withPlatform(async (db) => {
      const { rows: supplier } = await db.query<{
        legal_name: string; gstin: string; state_code: string; address: string;
      }>('SELECT legal_name, gstin, state_code, address FROM platform_tax_identity');
      if (!supplier[0]) {
        throw ApiError.make('conflict', 'no_tax_identity',
          'No supplier tax identity is on file, so no invoice can carry one.');
      }

      const { rows: customer } = await db.query<{
        billing_name: string; gstin: string | null; state_code: string;
        address: string;
      }>(
        `SELECT billing_name, gstin, state_code, address
           FROM tenant_billing_profile WHERE tenant_id = $1`, [input.tenantId]);
      if (!customer[0]) {
        throw ApiError.make('conflict', 'no_billing_profile',
          'This school has no billing profile, so there is no address or '
          + 'place of supply to put on an invoice.');
      }

      const { rows: subscription } = await db.query<{
        billing_period: string; price_monthly: string; price_annual: string;
        plan_name: string; plan_code: string;
      }>(
        `SELECT s.billing_period, pv.price_monthly::text, pv.price_annual::text,
                p.name AS plan_name, p.code AS plan_code
           FROM subscription s
           JOIN plan_version pv ON pv.id = s.plan_version_id
           JOIN plan p ON p.id = pv.plan_id
          WHERE s.id = $1 AND s.tenant_id = $2 AND s.ended_at IS NULL`,
        [input.subscriptionId, input.tenantId]);
      if (!subscription[0]) {
        throw ApiError.make('not_found', 'subscription_not_found',
          'No live subscription with that id for this school.');
      }
      const sub = subscription[0];

      // Rupees and paise, not paise — see the correction in 0071.
      const unitPrice: Paise = Money.fromDecimalString(
        sub.billing_period === 'annual' ? sub.price_annual : sub.price_monthly);

      const supplyType = supplyTypeFor(
        supplier[0].state_code, customer[0].state_code);

      const taxed = taxInvoice({
        supplyType,
        lines: [{
          description:
            `${sub.plan_name} (${sub.billing_period}) — `
            + `${input.periodStart} to ${input.periodEnd}`,
          sacCode: input.sacCode ?? DEFAULT_SAC_CODE,
          quantity: input.quantity ?? '1',
          unitPrice,
          taxRate: input.taxRate ?? DEFAULT_TAX_RATE,
        }],
      });

      const serial = await nextSerial(db, 'invoice', financialYear);
      const invoiceNo = documentNumber(INVOICE_PREFIX, financialYear, serial);

      const dueOn = new Date(issuedOn.getTime() + PAYMENT_TERMS_DAYS * 86_400_000);

      const { rows: created } = await db.query<IssuedInvoice>(
        `INSERT INTO platform_invoice
           (tenant_id, subscription_id, invoice_no, financial_year, serial,
            issued_on, due_on, period_start, period_end,
            supplier_gstin, supplier_state, customer_gstin, customer_state,
            customer_name, customer_address, supply_type,
            taxable_value, cgst, sgst, igst, total)
         VALUES ($1, $2, $3, $4, $5, $6::date, $7::date, $8::date, $9::date,
                 $10, $11, $12, $13, $14, $15, $16,
                 $17, $18, $19, $20, $21)
         RETURNING id, invoice_no, financial_year, serial, supply_type,
                   taxable_value::text, cgst::text, sgst::text, igst::text,
                   total::text, issued_on::text, due_on::text`,
        [input.tenantId, input.subscriptionId, invoiceNo, financialYear, serial,
         iso(issuedOn), iso(dueOn), input.periodStart, input.periodEnd,
         supplier[0].gstin, supplier[0].state_code,
         customer[0].gstin, customer[0].state_code,
         customer[0].billing_name, customer[0].address, supplyType,
         Money.toDecimalString(taxed.taxableValue),
         Money.toDecimalString(taxed.cgst),
         Money.toDecimalString(taxed.sgst),
         Money.toDecimalString(taxed.igst),
         Money.toDecimalString(taxed.total)]);

      for (const [index, line] of taxed.lines.entries()) {
        await db.query(
          `INSERT INTO platform_invoice_line
             (platform_invoice_id, line_no, description, sac_code, quantity,
              unit_price, taxable_value, tax_rate)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [created[0]!.id, index + 1, line.description, line.sacCode,
           line.quantity, Money.toDecimalString(line.unitPrice),
           Money.toDecimalString(line.taxableValue), line.taxRate]);
      }

      return created[0]!;
    });
  },

  /**
   * Credits an invoice, wholly or in part.
   *
   * There is no "edit the invoice" here and there will not be. A tax invoice
   * that has been issued is a document somebody else may already have filed
   * against; changing it makes two different documents share a number.
   */
  async creditNote(input: {
    invoiceId: string;
    reason: string;
    /** Omitted credits the whole invoice. */
    amount?: Paise | undefined;
    issuedOn?: Date | undefined;
  }): Promise<{ note_no: string; total: string }> {
    if (input.reason.trim().length < 10) {
      throw ApiError.make('validation_error', 'reason_too_short',
        'Say why, in a sentence that would satisfy somebody reading the '
        + 'ledger a year from now.');
    }
    const issuedOn = input.issuedOn ?? new Date();
    const financialYear = financialYearOf(issuedOn);

    return withPlatform(async (db) => {
      const { rows } = await db.query<{
        tenant_id: string; supply_type: SupplyType; taxable_value: string;
        cgst: string; sgst: string; igst: string; total: string; status: string;
      }>(
        `SELECT tenant_id, supply_type, taxable_value::text, cgst::text,
                sgst::text, igst::text, total::text, status
           FROM platform_invoice WHERE id = $1`, [input.invoiceId]);
      const invoice = rows[0];
      if (!invoice) {
        throw ApiError.make('not_found', 'invoice_not_found', 'No such invoice.');
      }

      const invoiceTotal = Money.fromDecimalString(invoice.total);
      const credited = input.amount ?? invoiceTotal;
      if (credited <= 0n) {
        throw ApiError.make('validation_error', 'credit_not_positive',
          'A credit note for nothing is not a credit note.');
      }

      // The credit keeps the invoice's tax regime and its proportions. A
      // partial credit that taxed itself afresh could land on a different
      // rounding than the invoice it corrects, and the two documents would
      // disagree about a paise in a filing.
      const share = (part: string): Paise => {
        const whole = Money.fromDecimalString(part);
        if (invoiceTotal === 0n) return 0n;
        return (whole * credited) / invoiceTotal;
      };
      const cgst = share(invoice.cgst);
      const sgst = share(invoice.sgst);
      const igst = share(invoice.igst);
      // Whatever the proportional split did not account for stays in the
      // taxable value, so the note adds up exactly — the schema's
      // `platform_credit_note_adds_up` refuses anything else.
      const taxableValue = credited - cgst - sgst - igst;

      const serial = await nextSerial(db, 'credit_note', financialYear);
      const noteNo = documentNumber(CREDIT_PREFIX, financialYear, serial);

      const { rows: note } = await db.query<{ note_no: string; total: string }>(
        `INSERT INTO platform_credit_note
           (tenant_id, platform_invoice_id, note_no, financial_year, serial,
            issued_on, reason, taxable_value, cgst, sgst, igst, total)
         VALUES ($1, $2, $3, $4, $5, $6::date, $7, $8, $9, $10, $11, $12)
         RETURNING note_no, total::text`,
        [invoice.tenant_id, input.invoiceId, noteNo, financialYear, serial,
         iso(issuedOn), input.reason.trim(),
         Money.toDecimalString(taxableValue), Money.toDecimalString(cgst),
         Money.toDecimalString(sgst), Money.toDecimalString(igst),
         Money.toDecimalString(credited)]);
      return note[0]!;
    });
  },

  /** What a school owes us, and what it has been sent. */
  async invoicesFor(tenantId: string): Promise<IssuedInvoice[]> {
    return withPlatform(async (db) => {
      const { rows } = await db.query<IssuedInvoice>(
        `SELECT id, invoice_no, financial_year, serial, supply_type,
                taxable_value::text, cgst::text, sgst::text, igst::text,
                total::text, issued_on::text, due_on::text
           FROM platform_invoice
          WHERE tenant_id = $1
          ORDER BY financial_year DESC, serial DESC
          LIMIT 200`, [tenantId]);
      return rows;
    });
  },
};

/**
 * The next number in a series, allocated under a row lock.
 *
 * `INSERT ... ON CONFLICT DO UPDATE` both creates the counter on first use and
 * takes the lock, in one statement. Reading then updating would be two, with a
 * window between them wide enough for two invoices to take the same number —
 * which the unique constraint would catch, as a 500 on the second school's
 * bill rather than as a correct answer.
 */
async function nextSerial(
  db: { query: (text: string, params?: readonly unknown[]) =>
    Promise<{ rows: Array<Record<string, unknown>>; rowCount: number }> },
  kind: 'invoice' | 'credit_note',
  financialYear: string,
): Promise<number> {
  const { rows } = await db.query(
    `INSERT INTO platform_document_series (kind, financial_year, last_serial)
     VALUES ($1, $2, 1)
     ON CONFLICT (kind, financial_year)
       DO UPDATE SET last_serial = platform_document_series.last_serial + 1
     RETURNING last_serial`,
    [kind, financialYear]);
  return Number(rows[0]!['last_serial']);
}

function iso(date: Date): string {
  return date.toISOString().slice(0, 10);
}
