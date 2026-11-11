import { describe, expect, it } from 'vitest';
import { classOf, closing, NOBODY, type CollectionRow } from '../src/lib/collection';

let n = 0;
const row = (over: Partial<CollectionRow>): CollectionRow => {
  n += 1;
  return { receipt_id: `r${n}`, receipt_no: `RCP-${n}`, issued_on: '2026-11-11',
    invoice_id: `i${n}`, invoice_no: `INV-${n}`, learner: 'A', admission_no: '1',
    class_name: 'Class IX', section_name: 'A', method: 'cash', amount: '100.00',
    received_by: 'Anjali Menon', cancelled: false, ...over };
};

describe('closing the day', () => {
  it('adds up what stands and leaves cancelled receipts out of every figure', () => {
    const rows = [row({ amount: '500.00' }), row({ amount: '200.10' }),
      row({ amount: '9999.00', cancelled: true })];
    const c = closing(rows);
    expect(c.total).toBe('700.10');
    expect(c.receipts).toBe(2);
    expect(c.cash).toBe('700.10');
    expect(c.standing).toHaveLength(2);
    expect(c.cancelled.map((r) => r.amount)).toEqual(['9999.00']);
  });

  it('counts a receipt split over two invoices once, and adds both shares', () => {
    const c = closing([
      row({ receipt_id: 'same', amount: '500.00' }), row({ receipt_id: 'same', amount: '500.00' }),
      row({ amount: '50.00' })]);
    expect(c.receipts).toBe(2);
    expect(c.total).toBe('1050.00');
    expect(c.byMethod).toEqual([{ key: 'cash', label: 'Cash', receipts: 2, amount: '1050.00' }]);
  });

  it('splits by how it was paid, largest first, and says what should be in the drawer', () => {
    const c = closing([row({ method: 'cash', amount: '300.00' }),
      row({ method: 'cheque', amount: '5000.00' }), row({ method: 'neft', amount: '300.00' }),
      row({ method: 'cash', amount: '0.50' })]);
    expect(c.byMethod.map((m) => [m.label, m.receipts, m.amount])).toEqual([
      ['Cheque', 1, '5000.00'], ['Cash', 2, '300.50'], ['Bank transfer (NEFT)', 1, '300.00']]);
    expect(c.cash).toBe('300.50');
  });

  it('orders a tie by name', () => {
    const c = closing([row({ method: 'cheque' }), row({ method: 'neft' }), row({ method: 'cash' })]);
    expect(c.byMethod.map((m) => m.label)).toEqual(['Bank transfer (NEFT)', 'Cash', 'Cheque']);
  });

  it('splits by who took it, and does not lose money nobody is recorded against', () => {
    const c = closing([row({ received_by: 'Priya Desai', amount: '400.00' }),
      row({ received_by: null, amount: '150.00' }), row({ received_by: '  ', amount: '50.00' }),
      row({ received_by: 'Anjali Menon', amount: '100.00' })]);
    expect(c.byCashier.map((m) => [m.label, m.receipts, m.amount])).toEqual([
      ['Priya Desai', 1, '400.00'], [NOBODY, 2, '200.00'], ['Anjali Menon', 1, '100.00']]);
  });

  it('is all zeros for a day nothing was taken', () => {
    expect(closing([])).toEqual({ standing: [], cancelled: [], total: '0.00', receipts: 0,
      byMethod: [], byCashier: [], cash: '0.00' });
    expect(closing([row({ method: 'cheque' })]).cash).toBe('0.00');
  });

  it('names the class', () => {
    expect(classOf({ class_name: 'Class IX', section_name: 'A' })).toBe('Class IX A');
    expect(classOf({ class_name: null, section_name: 'A' })).toBe('A');
  });
});
