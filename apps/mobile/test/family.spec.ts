/**
 * The parent app's logic — mostly money and dates, which is to say the two
 * things this app can get wrong in a way a parent would notice and be right
 * to be angry about.
 */
import { describe, it, expect } from 'vitest';
import {
  tabsFor, rupees, attendanceRate, feeState, childName, childClass,
  type Child, type Fees,
} from '../src/lib/family.ts';

const child = (over: Partial<Child> = {}): Child => ({
  id: 'c1', admission_no: 'D-1', given_name: 'Aarav', family_name: 'Kumar',
  section_name: 'A', class_name: 'Class IX',
  can_view_academics: true, can_view_finance: true, ...over,
});

describe('which tabs a parent gets', () => {
  it('gives a parent with full access all of them', () => {
    expect(tabsFor(child())).toEqual(['attendance', 'fees', 'work', 'results', 'bus']);
  });

  it('leaves out the fees tab rather than showing an empty one', () => {
    // An empty fees list reads as "you owe nothing", which is a different and
    // worse lie than "this is not yours to see".
    expect(tabsFor(child({ can_view_finance: false })))
      .toEqual(['attendance', 'work', 'results', 'bus']);
  });

  it('leaves out the results tab the same way', () => {
    expect(tabsFor(child({ can_view_academics: false })))
      .toEqual(['attendance', 'fees', 'bus']);
  });

  it('takes homework away with the same permission as results', () => {
    // Homework carries marks and feedback on a child. A parent barred from
    // academics being shown "17.5 / 20" through a different tab would make the
    // permission decorative.
    expect(tabsFor(child({ can_view_academics: false }))).not.toContain('work');
  });

  it('always keeps attendance and the bus', () => {
    // Whether a child got to school, and which bus they are on, are things
    // every adult the school has linked to a child may know.
    expect(tabsFor(child({ can_view_academics: false, can_view_finance: false })))
      .toEqual(['attendance', 'bus']);
  });
});

describe('money', () => {
  it('groups in lakhs, not thousands', () => {
    // ₹1,00,000 — not ₹100,000. A product that calls itself India-first and
    // prints Western grouping on a fee receipt is telling on itself.
    expect(rupees('10000000')).toBe('₹1,00,000.00');
    expect(rupees('100000000')).toBe('₹10,00,000.00');
    expect(rupees('1000000000')).toBe('₹1,00,00,000.00');
  });

  it('keeps the paise exactly', () => {
    // 12500.10, which as a JSON double is 12500.099999999999. A parent shown
    // ₹12,500.09 for a ₹12,500.10 bill will not pay it, and is right not to.
    expect(rupees('1250010')).toBe('₹12,500.10');
    expect(rupees('1')).toBe('₹0.01');
    expect(rupees('0')).toBe('₹0.00');
    expect(rupees('99')).toBe('₹0.99');
    expect(rupees('100')).toBe('₹1.00');
  });

  it('is exact past the point where a float stops being', () => {
    // 2^53 + 1 paise — about ₹90 trillion, which no school will ever bill.
    // It is here because it is where `Number(paise) / 100` starts giving a
    // different answer, and a boundary nobody has written down is a boundary
    // that gets crossed by a refactor rather than by a customer. The float
    // path returns ...409.92 for this.
    expect(rupees('9007199254740993')).toBe('₹9,00,71,99,25,47,409.93');
  });

  it('handles the boundaries of the grouping', () => {
    expect(rupees('99999')).toBe('₹999.99');
    expect(rupees('100000')).toBe('₹1,000.00');
    expect(rupees('999999')).toBe('₹9,999.99');
    expect(rupees('1000000')).toBe('₹10,000.00');
  });

  it('shows a credit as a credit', () => {
    expect(rupees('-50000')).toBe('-₹500.00');
  });
});

describe('the attendance number', () => {
  const summary = (over: Partial<{
    present: number; absent: number; late: number; recorded: number;
  }> = {}) => ({
    days: [], present: 0, absent: 0, late: 0, recorded: 0, ...over,
  });

  it('counts late as present', () => {
    // A child who was in school was in school. A rate that punishes a bus
    // running late is a rate parents learn to ignore.
    expect(attendanceRate(summary({ present: 8, late: 2, absent: 0, recorded: 10 })))
      .toBe(100);
  });

  it('is the share of recorded days', () => {
    expect(attendanceRate(summary({ present: 18, absent: 2, recorded: 20 })))
      .toBe(90);
  });

  it('says nothing rather than 0 or 100 when nothing is recorded', () => {
    // A child whose school has not marked a register yet has neither perfect
    // attendance nor none.
    expect(attendanceRate(summary())).toBeNull();
  });
});

describe('where the fees stand', () => {
  const fees = (over: Partial<Fees> = {}): Fees => ({
    outstanding_paise: '1000000', next_due_on: '2026-09-25',
    invoices: [], ...over,
  });
  const today = new Date('2026-09-20T09:00:00Z');

  it('is clear when nothing is owed', () => {
    expect(feeState(fees({ outstanding_paise: '0', next_due_on: null }), today))
      .toEqual({ kind: 'clear' });
  });

  it('is clear when the balance is zero even with a date on file', () => {
    expect(feeState(fees({ outstanding_paise: '0' }), today))
      .toEqual({ kind: 'clear' });
  });

  it('counts the days to the due date', () => {
    expect(feeState(fees(), today)).toEqual({ kind: 'due', days: 5 });
  });

  it('treats the due date itself as due, not overdue', () => {
    // A bill due today is not late today.
    expect(feeState(fees({ next_due_on: '2026-09-20' }), today))
      .toEqual({ kind: 'due', days: 0 });
  });

  it('counts the days past when it is late', () => {
    expect(feeState(fees({ next_due_on: '2026-09-15' }), today))
      .toEqual({ kind: 'overdue', days: 5 });
  });

  it('does not go overdue on a timezone', () => {
    // Both sides are pinned to a calendar day at UTC midnight. Comparing a
    // date string against a local Date is how a bill goes red overnight in
    // IST for a parent who owes nothing yet.
    const lateEvening = new Date('2026-09-20T23:30:00+05:30');
    expect(feeState(fees({ next_due_on: '2026-09-20' }), lateEvening).kind)
      .toBe('due');
  });
});

describe('names', () => {
  it('reads as a person, not a row', () => {
    expect(childName(child())).toBe('Aarav Kumar');
    expect(childName(child({ family_name: null }))).toBe('Aarav');
  });

  it('shows the class it knows about', () => {
    expect(childClass(child())).toBe('Class IX A');
    expect(childClass(child({ section_name: null }))).toBe('Class IX');
    expect(childClass(child({ class_name: null, section_name: null }))).toBeNull();
  });
});
