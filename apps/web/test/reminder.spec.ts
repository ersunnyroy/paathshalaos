import { describe, expect, it } from 'vitest';
import { paymentLine, remindedLine, reminderLine, type ReminderStatus } from '../src/lib/reminder';

const s = (over: Partial<ReminderStatus>): ReminderStatus => ({
  overdue: 3, toRemind: 3, noConsent: 0, noGuardian: 0, notices: 3, templateCode: 'FEE_DUE', ...over });

describe('the reminder line on the fee desk', () => {
  it('says nothing when nothing is overdue or nothing is known', () => {
    expect(reminderLine(s({ overdue: 0, toRemind: 0 }))).toBeNull();
    expect(reminderLine(null)).toBeNull();
    expect(reminderLine(undefined)).toBeNull();
  });
  it('offers to remind everybody who can be', () => {
    expect(reminderLine(s({}))).toEqual({ canSend: true,
      text: '3 children have overdue fees. The guardians of 3 can be reminded now.' });
    expect(reminderLine(s({ overdue: 1, toRemind: 1 }))!.text)
      .toBe('1 child has overdue fees. The guardians of 1 can be reminded now.');
  });
  it('does not offer again once they were reminded today', () => {
    expect(reminderLine(s({ toRemind: 0 }))).toEqual({ canSend: false,
      text: '3 children have overdue fees. Their guardians have been reminded today.' });
  });
  it('does not claim a reminder went when no guardian could get one', () => {
    expect(reminderLine(s({ overdue: 2, toRemind: 0, noGuardian: 2 }))).toEqual({ canSend: false,
      text: '2 children have overdue fees. For 2 children the fees are not shared with any guardian, so nobody can be reminded.' });
    expect(reminderLine(s({ overdue: 3, toRemind: 0, noGuardian: 1 }))!.text)
      .toBe('3 children have overdue fees. Their guardians have been reminded today. '
        + 'For 1 child the fees are not shared with any guardian, so nobody can be reminded.');
  });
  it('asks for the words to be written before anything can go', () => {
    const line = reminderLine(s({ templateCode: null }))!;
    expect(line.canSend).toBe(false);
    expect(line.text).toContain('No fee reminder has been written and approved yet');
  });
  it('does not offer a button that would send nothing for want of consent', () => {
    expect(reminderLine(s({ noConsent: 3 }))).toEqual({ canSend: false,
      text: '3 children have overdue fees. No consent for fee messages is on record for 3 children; record it under Consent first.' });
  });
  it('offers the ones it can and names the ones it cannot', () => {
    expect(reminderLine(s({ noConsent: 1, noGuardian: 1 }))).toEqual({ canSend: true,
      text: '3 children have overdue fees. The guardians of 2 can be reminded now. '
        + 'No consent for fee messages is on record for 1 child; record it under Consent first. '
        + 'For 1 child the fees are not shared with any guardian, so nobody can be reminded.' });
  });
});

describe('after pressing it', () => {
  it('counts what went and why the rest did not', () => {
    expect(remindedLine({ sent: 1, suppressed: 0, failed: 0 })).toBe('1 reminder sent.');
    expect(remindedLine({ sent: 4, suppressed: 3, failed: 1, outcomes: [
      { outcome: 'suppressed', reason: 'no_consent' }, { outcome: 'suppressed', reason: 'no_consent' },
      { outcome: 'suppressed', reason: 'muted' }, { outcome: 'failed', reason: 'no_consent' },
    ] })).toBe('4 reminders sent. 2 not sent: no consent on record. '
      + '1 not sent: they have asked not to get these. 1 could not be sent — try again.');
    expect(remindedLine({ sent: 0, suppressed: 2, failed: 0 }))
      .toBe('0 reminders sent. 2 not sent: they have asked not to get these.');
  });
});

describe('what the counter is told after a payment', () => {
  it('names the receipt, and the guardians only when some were told', () => {
    expect(paymentLine({ receiptNo: 'RCP-000026', guardiansTold: 2 }))
      .toBe('Receipt RCP-000026 issued. 2 guardians told.');
    expect(paymentLine({ receiptNo: 'RCP-000026', guardiansTold: 1 }))
      .toBe('Receipt RCP-000026 issued. 1 guardian told.');
    expect(paymentLine({ receiptNo: 'RCP-000026', guardiansTold: 0 })).toBe('Receipt RCP-000026 issued.');
    expect(paymentLine({ receiptNo: 'RCP-000026' })).toBe('Receipt RCP-000026 issued.');
    expect(paymentLine({})).toBe('Payment recorded.');
  });
});
