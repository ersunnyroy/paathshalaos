import { describe, it, expect } from 'vitest';
import {
  ageOn, attendanceRate, attendanceTone, feeStanding, invoiceIsOverdue,
  guardianCan, orderGuardians, guardianName, type FeeInvoice, type GuardianLink,
} from '../src/lib/learner.ts';

describe('how old a learner is', () => {
  it('does not count a birthday that has not happened yet this year', () => {
    expect(ageOn('2014-04-13', '2026-04-12')).toBe(11);
    expect(ageOn('2014-04-13', '2026-04-13')).toBe(12);   // the day itself counts
    expect(ageOn('2014-04-13', '2026-11-10')).toBe(12);
    expect(ageOn('2014-12-31', '2026-01-01')).toBe(11);
  });

  it('has no answer without a date of birth, or for a date in the future', () => {
    expect(ageOn(null, '2026-11-10')).toBeNull();
    expect(ageOn('2030-01-01', '2026-11-10')).toBeNull();
    expect(ageOn('not-a-date', '2026-11-10')).toBeNull();
  });
});

describe('attendance', () => {
  it('counts a late arrival as attended', () => {
    expect(attendanceRate({ present: 17, late: 1, absent: 2, recorded: 20 })).toBe(90);
  });

  it('is unknown, not zero, when no register was taken', () => {
    expect(attendanceRate({ present: 0, late: 0, absent: 0, recorded: 0 })).toBeNull();
    expect(attendanceTone(null)).toBeUndefined();
  });

  it('is zero for a child who was absent every day', () => {
    expect(attendanceRate({ present: 0, late: 0, absent: 5, recorded: 5 })).toBe(0);
  });

  it('warns below 90 and alarms below the 75 line', () => {
    expect(attendanceTone(95)).toBe('good');
    expect(attendanceTone(90)).toBe('good');
    expect(attendanceTone(89)).toBe('warning');
    expect(attendanceTone(75)).toBe('warning');
    expect(attendanceTone(74)).toBe('critical');
  });
});

describe('what a learner owes', () => {
  const inv = (over: Partial<FeeInvoice>): FeeInvoice => ({
    id: 'i', invoice_no: 'INV-1', status: 'issued', due_on: '2026-06-10',
    total_paise: '3300000', paid_paise: '0', outstanding_paise: '3300000', ...over,
  });
  const today = '2026-11-10';

  it('adds what is owed and separates what is late', () => {
    const standing = feeStanding([
      inv({ due_on: '2026-06-10' }),                                         // late
      inv({ due_on: '2026-12-10', outstanding_paise: '1100000' }),           // not yet due
    ], today);
    expect(standing).toEqual({ outstandingPaise: '4400000', overduePaise: '3300000', overdueCount: 1 });
  });

  it('does not add an invoice due today to the overdue total', () => {
    expect(feeStanding([inv({ due_on: today })], today))
      .toEqual({ outstandingPaise: '3300000', overduePaise: '0', overdueCount: 0 });
  });

  it('does not call an invoice due today late', () => {
    expect(invoiceIsOverdue(inv({ due_on: today }), today)).toBe(false);
    expect(invoiceIsOverdue(inv({ due_on: '2026-11-09' }), today)).toBe(true);
  });

  it('never counts a paid or void invoice, whatever its date', () => {
    const paid = inv({ status: 'paid', paid_paise: '3300000', outstanding_paise: '0' });
    const voided = inv({ status: 'void' });
    expect(feeStanding([paid, voided], today))
      .toEqual({ outstandingPaise: '0', overduePaise: '0', overdueCount: 0 });
    expect(invoiceIsOverdue(paid, today)).toBe(false);
    expect(invoiceIsOverdue(voided, today)).toBe(false);
  });

  it('counts only the unpaid part of a part-paid invoice', () => {
    const part = inv({ status: 'part_paid', paid_paise: '1000000', outstanding_paise: '2300000' });
    expect(feeStanding([part], today).overduePaise).toBe('2300000');
  });

  it('stays exact past what a double can hold', () => {
    const big = inv({ outstanding_paise: '9007199254740993' });
    expect(feeStanding([big, inv({ outstanding_paise: '1' })], today).outstandingPaise)
      .toBe('9007199254740994');
  });
});

describe('guardians', () => {
  const link = (over: Partial<GuardianLink>): GuardianLink => ({
    id: 'g', relationship: 'mother', is_primary: false,
    can_view_academics: false, can_view_finance: false, can_pay: false,
    can_authorise_pickup: false, can_receive_notifications: false, ...over,
  });

  it('lists only what this link allows', () => {
    expect(guardianCan(link({}))).toEqual([]);
    expect(guardianCan(link({ can_authorise_pickup: true, can_pay: true })))
      .toEqual(['Collect from school', 'Pay fees']);
  });

  it('does not let seeing fees imply paying them, or the reverse', () => {
    expect(guardianCan(link({ can_view_finance: true }))).toEqual(['See fees']);
    expect(guardianCan(link({ can_pay: true }))).toEqual(['Pay fees']);
  });

  it('shows a name when there is one and admits it when there is not', () => {
    expect(guardianName(link({ guardian_given_name: 'Priya', guardian_family_name: 'Sharma' }))).toBe('Priya Sharma');
    expect(guardianName(link({ guardian_given_name: ' Priya ', guardian_family_name: null }))).toBe('Priya');
    expect(guardianName(link({ guardian_given_name: null, guardian_family_name: null }))).toBeNull();
    expect(guardianName(link({}))).toBeNull();          // an older API that sends no name at all
    expect(guardianName(link({ guardian_given_name: '  ' }))).toBeNull();
  });

  it('puts the primary contact first', () => {
    const ordered = orderGuardians([
      link({ id: 'a', relationship: 'father' }),
      link({ id: 'b', relationship: 'uncle', is_primary: true }),
      link({ id: 'c', relationship: 'aunt' }),
    ]);
    expect(ordered.map((g) => g.id)).toEqual(['b', 'c', 'a']);
  });
});
