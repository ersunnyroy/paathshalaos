/**
 * A fee receipt as it is printed (M47.1).
 *
 * Money arrives as exact decimal rupee strings and stays that way: sums are
 * done in paise as integers, and the amount in words is built from the digits,
 * never from a float.
 */
import { sumDecimals } from './console';

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
    id: string; receipt_no: string; issued_on: string; amount: string;
    allocated: string; method: string; received_by: string | null; cancelled: boolean;
  }>;
}

/** A decimal rupee string as whole paise. */
export function toPaise(value: string): bigint {
  const negative = value.startsWith('-');
  const [whole = '0', fraction = ''] = (negative ? value.slice(1) : value).split('.');
  const paise = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0').slice(0, 2));
  return negative ? -paise : paise;
}

/** `a - b`, exactly, as a decimal string. */
export function minus(a: string, b: string): string {
  const paise = toPaise(a) - toPaise(b);
  const digits = (paise < 0n ? -paise : paise).toString().padStart(3, '0');
  return `${paise < 0n ? '-' : ''}${digits.slice(0, -2)}.${digits.slice(-2)}`;
}

const ONES = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
  'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen',
  'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

function belowHundred(n: number): string {
  if (n < 20) return ONES[n]!;
  const one = n % 10;
  return `${TENS[Math.floor(n / 10)]!}${one ? `-${ONES[one]!}` : ''}`;
}

function belowThousand(n: number): string {
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  return [hundreds ? `${ONES[hundreds]!} hundred` : '', belowHundred(rest)]
    .filter(Boolean).join(' ');
}

/** A whole number in the Indian system: thousand, lakh, crore. */
export function numberInWords(value: bigint): string {
  if (value === 0n) return 'zero';
  const crore = value / 10_000_000n;
  const rest = Number(value % 10_000_000n);
  const parts = [
    // Above 99 crore the crores are themselves a number in words.
    crore > 0n ? `${numberInWords(crore)} crore` : '',
    Math.floor(rest / 100_000) ? `${belowHundred(Math.floor(rest / 100_000))} lakh` : '',
    Math.floor((rest % 100_000) / 1000) ? `${belowHundred(Math.floor((rest % 100_000) / 1000))} thousand` : '',
    belowThousand(rest % 1000),
  ];
  return parts.filter(Boolean).join(' ');
}

/**
 * The amount as a receipt writes it out: "Rupees four thousand five hundred
 * only". The words are what a bank or an auditor reads when a digit is smudged.
 */
export function rupeesInWords(value: string): string {
  const paise = toPaise(value);
  if (paise < 0n) return `Minus ${rupeesInWords(value.slice(1)).replace(/^R/, 'r')}`;
  const rupees = paise / 100n;
  const odd = paise % 100n;
  const words = [
    rupees > 0n || odd === 0n ? `Rupees ${numberInWords(rupees)}` : '',
    odd > 0n ? `${numberInWords(odd)} paise` : '',
  ].filter(Boolean).join(' and ');
  return `${words.charAt(0).toUpperCase()}${words.slice(1)} only`;
}

const METHODS: Record<string, string> = {
  cash: 'Cash', cheque: 'Cheque', dd: 'Demand draft', neft: 'Bank transfer (NEFT)',
  upi: 'UPI', card: 'Card', netbanking: 'Net banking', wallet: 'Wallet', mandate: 'Auto-debit',
};
export const methodLabel = (method: string) => METHODS[method] ?? method;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-11-10" as "10 Nov 2026", read from the text so no timezone moves it. */
export function dateLabel(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  const month = match ? MONTHS[Number(match[2]) - 1] : undefined;
  return match && month ? `${Number(match[3])} ${month} ${match[1]}` : iso;
}

export interface ReceiptTotals {
  /** Received against this invoice on receipts that still stand. */
  received: string;
  balance: string;
  settled: boolean;
  /** The receipts worth printing: cancelled ones are history, not proof. */
  standing: ReceiptSheet['receipts'];
}

/**
 * What the receipt says was paid and what is left.
 *
 * "Received" is added up from the receipts printed on the page, so the paper
 * agrees with itself. The balance comes from the invoice, which is the
 * school's own figure for what is owed; a void invoice owes nothing.
 */
export function totals(sheet: ReceiptSheet): ReceiptTotals {
  const standing = sheet.receipts.filter((r) => !r.cancelled);
  const received = sumDecimals(standing.map((r) => r.allocated));
  const owed = sheet.invoice.status === 'void'
    ? '0.00' : minus(sheet.invoice.total, sheet.invoice.amount_paid);
  const balance = toPaise(owed) < 0n ? '0.00' : owed;
  return { received, balance, settled: toPaise(balance) === 0n, standing };
}

/** Where on the timetable of a school year this child sits, in one line. */
export function classLine(learner: ReceiptSheet['learner']): string {
  const cls = [learner.class_name, learner.section_name].filter(Boolean).join(' ');
  return [cls, learner.roll_no ? `Roll ${learner.roll_no}` : ''].filter(Boolean).join(' · ');
}
