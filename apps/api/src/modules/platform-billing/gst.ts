/**
 * The tax arithmetic, lifted out of the service so it can be tested (M25.1).
 *
 * Nothing here touches a database. It is the part that can be wrong in a way
 * that shows up on a legal document, and the part where being right is a
 * matter of arithmetic rather than of asking the database nicely.
 *
 * NOT VERIFIED BY AN ACCOUNTANT. The mechanics are implemented precisely and
 * tested against themselves; the RATE and the SAC code are passed in rather
 * than hard-coded here, because those are the parts a professional has to
 * confirm and a constant in this file would hide that they were assumed.
 */
import { Money, type Paise } from '../billing/money.ts';

export type SupplyType = 'intra_state' | 'inter_state';

export interface TaxLine {
  description: string;
  sacCode: string;
  /** Whole units, or a fraction of a month for a partial period. */
  quantity: string;
  unitPrice: Paise;
  taxRate: number;
}

export interface TaxedInvoice {
  supplyType: SupplyType;
  taxableValue: Paise;
  cgst: Paise;
  sgst: Paise;
  igst: Paise;
  total: Paise;
  lines: Array<TaxLine & { taxableValue: Paise }>;
}

/**
 * Which tax applies.
 *
 * The place of supply is the customer's state. Same state as ours means the
 * supply is intra-state and the tax splits into a central half and a state
 * half; a different state means inter-state and a single integrated tax.
 *
 * This is not a formatting choice. The two go to different places, and an
 * invoice with the wrong one is a return filed against the wrong government —
 * which is corrected by amending a filing, not by reissuing a document.
 */
export function supplyTypeFor(
  supplierState: string, customerState: string,
): SupplyType {
  return supplierState === customerState ? 'intra_state' : 'inter_state';
}

/**
 * A quantity as an exact hundredth, so a partial month does not become a float.
 *
 * "0.42" of a month is 42 hundredths. Parsed the same way money is, for the
 * same reason: `Number('0.42') * price` is a float multiplication in the
 * middle of a tax calculation.
 */
function hundredths(quantity: string): bigint {
  if (!/^\d+(\.\d{1,2})?$/.test(quantity.trim())) {
    throw new Error(`Not a quantity: ${quantity}`);
  }
  const [whole, frac = ''] = quantity.trim().split('.');
  return BigInt(whole!) * 100n + BigInt(frac.padEnd(2, '0'));
}

/**
 * Builds the invoice's numbers from its lines.
 *
 * Two decisions that matter more than they look:
 *
 * **Tax is computed on the invoice's taxable value, not per line and summed.**
 * With one line they agree. With three, per-line rounding can put the invoice
 * a paise away from 18% of its own subtotal — and the number a reader checks
 * is the one on the total row. Computing once and splitting means the document
 * is internally consistent, which is the property an auditor tests.
 *
 * **Each component is computed at its own rate, not by halving the total.**
 * This started as "compute 18%, then split it in two", and the first test run
 * caught it: 18% of 1234.51 is 222.21 paise, which does not halve evenly, so
 * the two halves differed by a paise — and the constraint `cgst = sgst` in
 * 0071 would have refused the insert.
 *
 * Halving the total is also not what the rule says. CGST and SGST are each
 * levied at half the rate; nine per cent of 1234.51 is 111.11, twice, and the
 * pair sums to 222.22 rather than 222.21. The one-paise difference from the
 * inter-state figure is a property of the tax, not an error in the
 * arithmetic — and the version that looked tidier was the wrong one.
 *
 * The schema and the code disagreed loudly, which is why the constraint is
 * there.
 */
export function taxInvoice(input: {
  supplyType: SupplyType;
  lines: TaxLine[];
}): TaxedInvoice {
  if (input.lines.length === 0) {
    throw new Error('An invoice with no lines is not an invoice.');
  }

  const lines = input.lines.map((line) => ({
    ...line,
    // quantity × unit price, in paise, with the quantity carried as hundredths
    // so the multiplication stays in bigint throughout.
    taxableValue: divideRoundHalfUp(hundredths(line.quantity) * line.unitPrice, 100n),
  }));

  const taxableValue = Money.sum(lines.map((l) => l.taxableValue));

  const rates = new Set(lines.map((l) => l.taxRate));
  if (rates.size > 1) {
    // Genuinely possible — a plan and a one-off service at different rates —
    // and genuinely not handled: it needs a tax breakdown per rate on the
    // document, which the schema does not have. Refused rather than averaged.
    throw new Error(
      'Lines at different tax rates need a per-rate breakdown on the invoice, '
      + 'which this schema does not carry. Issue them as separate invoices.');
  }
  const rate = lines[0]!.taxRate;

  let cgst = 0n, sgst = 0n, igst = 0n;
  if (input.supplyType === 'intra_state') {
    // Each at half the rate, separately rounded — so they are equal by
    // construction rather than by a remainder rule, and the pair is what the
    // document owes rather than a split of some other number.
    const half = Money.percentage(taxableValue, rate / 2);
    cgst = half;
    sgst = half;
  } else {
    igst = Money.percentage(taxableValue, rate);
  }

  return {
    supplyType: input.supplyType,
    taxableValue,
    cgst, sgst, igst,
    total: taxableValue + cgst + sgst + igst,
    lines,
  };
}

/** Half-up, in bigint. The same rounding a fee receipt shows. */
function divideRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
  const negative = (numerator < 0n) !== (denominator < 0n);
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  const quotient = n / d;
  const remainder = n % d;
  const rounded = remainder * 2n >= d ? quotient + 1n : quotient;
  return negative ? -rounded : rounded;
}

/**
 * The Indian financial year a date falls in, as "2026-27".
 *
 * 1 April to 31 March. The invoice series restarts each year, so getting this
 * wrong by a day at the boundary means either a duplicate number or a series
 * that restarts in the middle of a year — and both are visible to an auditor
 * before they are visible to us.
 */
export function financialYearOf(date: Date): string {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth(); // 0 = January
  const startYear = month >= 3 ? year : year - 1;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}

/** "PS/2627/000001" — fourteen characters, inside the statutory sixteen. */
export function documentNumber(
  prefix: string, financialYear: string, serial: number,
): string {
  const short = financialYear.replace('-', '').slice(2);
  const number = `${prefix}/${short}/${String(serial).padStart(6, '0')}`;
  if (number.length > 16) {
    throw new Error(
      `Document number "${number}" is ${number.length} characters; the `
      + 'statutory maximum is 16.');
  }
  return number;
}
