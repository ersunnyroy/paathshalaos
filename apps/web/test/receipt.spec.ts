import { describe, expect, it } from 'vitest';
import {
  classLine, dateLabel, methodLabel, minus, numberInWords, rupeesInWords, toPaise, totals,
  type ReceiptSheet,
} from '../src/lib/receipt';

describe('money as integers', () => {
  it('reads a decimal string as paise', () => {
    expect(toPaise('4500')).toBe(450000n);
    expect(toPaise('4500.5')).toBe(450050n);
    expect(toPaise('0.05')).toBe(5n);
    expect(toPaise('-12.34')).toBe(-1234n);
    expect(toPaise('.50')).toBe(50n);
    expect(toPaise('1.999')).toBe(199n);
  });
  it('subtracts exactly', () => {
    expect(minus('4500.00', '100.00')).toBe('4400.00');
    expect(minus('0.30', '0.10')).toBe('0.20');
    expect(minus('100.00', '250.50')).toBe('-150.50');
    expect(minus('100.00', '-50.00')).toBe('150.00');
    expect(minus('1.00', '0.95')).toBe('0.05');
    expect(minus('5', '5')).toBe('0.00');
  });
});

describe('a number in words, the Indian way', () => {
  it.each([
    [0n, 'zero'], [7n, 'seven'], [13n, 'thirteen'], [20n, 'twenty'], [21n, 'twenty-one'],
    [99n, 'ninety-nine'], [100n, 'one hundred'], [101n, 'one hundred one'],
    [110n, 'one hundred ten'], [999n, 'nine hundred ninety-nine'],
    [1000n, 'one thousand'], [4500n, 'four thousand five hundred'],
    [19_999n, 'nineteen thousand nine hundred ninety-nine'],
    [100_000n, 'one lakh'], [123_456n, 'one lakh twenty-three thousand four hundred fifty-six'],
    [9_900_000n, 'ninety-nine lakh'], [10_000_000n, 'one crore'],
    [10_000_001n, 'one crore one'],
    [123_456_789n, 'twelve crore thirty-four lakh fifty-six thousand seven hundred eighty-nine'],
    [1_000_000_000n, 'one hundred crore'],
  ])('%s', (n, words) => { expect(numberInWords(n)).toBe(words); });
});

describe('the amount written out', () => {
  it('writes rupees, and paise only when there are some', () => {
    expect(rupeesInWords('4500.00')).toBe('Rupees four thousand five hundred only');
    expect(rupeesInWords('100')).toBe('Rupees one hundred only');
    expect(rupeesInWords('1250.50')).toBe('Rupees one thousand two hundred fifty and fifty paise only');
    expect(rupeesInWords('0.05')).toBe('Five paise only');
    expect(rupeesInWords('0.00')).toBe('Rupees zero only');
    expect(rupeesInWords('1.01')).toBe('Rupees one and one paise only');
  });
  it('says minus for a negative amount', () => {
    expect(rupeesInWords('-100.00')).toBe('Minus rupees one hundred only');
  });
});

describe('labels', () => {
  it('names the method, and passes through one it does not know', () => {
    expect(methodLabel('cash')).toBe('Cash');
    expect(methodLabel('neft')).toBe('Bank transfer (NEFT)');
    expect(methodLabel('barter')).toBe('barter');
  });
  it('writes a date without moving it', () => {
    expect(dateLabel('2026-11-10')).toBe('10 Nov 2026');
    expect(dateLabel('2026-01-01')).toBe('1 Jan 2026');
    expect(dateLabel('2026-12-31T23:30:00Z')).toBe('31 Dec 2026');
    expect(dateLabel('2026-13-01')).toBe('2026-13-01');
    expect(dateLabel('soon')).toBe('soon');
  });
  it('puts class, section and roll on one line', () => {
    const base = { name: 'A', admission_no: '1' };
    expect(classLine({ ...base, class_name: 'Class IX', section_name: 'A', roll_no: '12' }))
      .toBe('Class IX A · Roll 12');
    expect(classLine({ ...base, class_name: null, section_name: 'A', roll_no: null })).toBe('A');
  });
});

describe('what was paid and what is left', () => {
  const receipt = (no: string, allocated: string, cancelled = false) => ({
    // The payment was bigger than the share that went to this invoice.
    id: no, receipt_no: no, issued_on: '2026-11-10', amount: '9999.00', allocated,
    method: 'cash', received_by: null, cancelled });
  const sheet = (over: Partial<ReceiptSheet['invoice']>, receipts: ReceiptSheet['receipts']): ReceiptSheet => ({
    school: { name: 'S', legal_name: 'S', gstin: null, campus: 'C' },
    learner: { name: 'A', admission_no: '1', class_name: 'IX', section_name: 'A', roll_no: null },
    invoice: { id: 'i', invoice_no: 'INV-1', financial_year: '2026-27', issued_on: '2026-11-01',
      due_on: '2026-11-15', status: 'part_paid', subtotal: '4500.00', discount_total: '0.00',
      tax_total: '0.00', total: '4500.00', amount_paid: '1500.00', ...over },
    lines: [], receipts,
  });

  it('adds up the standing receipts and takes the balance from the invoice', () => {
    const t = totals(sheet({}, [receipt('R1', '1000.00'), receipt('R2', '500.00')]));
    expect(t).toMatchObject({ received: '1500.00', balance: '3000.00', settled: false });
    expect(t.standing.map((r) => r.receipt_no)).toEqual(['R1', 'R2']);
  });
  it('leaves a cancelled receipt out of what was received', () => {
    const t = totals(sheet({ amount_paid: '500.00' }, [receipt('R1', '1000.00', true), receipt('R2', '500.00')]));
    expect(t.received).toBe('500.00');
    expect(t.balance).toBe('4000.00');
    expect(t.standing.map((r) => r.receipt_no)).toEqual(['R2']);
  });
  it('is settled at exactly nothing owed', () => {
    expect(totals(sheet({ amount_paid: '4500.00', status: 'paid' }, [receipt('R1', '4500.00')])))
      .toMatchObject({ balance: '0.00', settled: true });
    expect(totals(sheet({ amount_paid: '4499.99' }, [])).settled).toBe(false);
  });
  it('never prints a negative balance, and a void invoice owes nothing', () => {
    expect(totals(sheet({ amount_paid: '5000.00' }, [])).balance).toBe('0.00');
    expect(totals(sheet({ status: 'void', amount_paid: '0.00' }, []))).toMatchObject(
      { balance: '0.00', settled: true, received: '0.00' });
  });
});
