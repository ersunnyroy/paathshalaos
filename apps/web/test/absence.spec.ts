import { describe, expect, it } from 'vitest';
import { noticeLine, noticeTemplate, sentLine } from '../src/lib/absence';

const v = (channel: string, approval_status: string) => ({ channel, approval_status });

describe('which template an absence notice uses', () => {
  it('takes the first attendance template with approved in-app words', () => {
    expect(noticeTemplate([
      { code: 'general', purpose: 'core_education_service', versions: [v('in_app', 'approved')] },
      { code: 'draft', purpose: 'attendance_notifications', versions: [v('in_app', 'pending')] },
      { code: 'sms-only', purpose: 'attendance_notifications', versions: [v('sms', 'approved')] },
      { code: 'absent', purpose: 'attendance_notifications', versions: [v('sms', 'approved'), v('in_app', 'approved')] },
      { code: 'later', purpose: 'attendance_notifications', versions: [v('in_app', 'approved')] },
    ])).toBe('absent');
  });
  it('is null when the school has approved no wording', () => {
    expect(noticeTemplate([])).toBeNull();
    expect(noticeTemplate([{ code: 'a', purpose: 'attendance_notifications', versions: [] }])).toBeNull();
  });
});

describe('what the register says', () => {
  const s = (absent: number, toTell: number, noGuardian = 0, noConsent = 0) =>
    noticeLine({ absent, toTell, noGuardian, notices: toTell, noConsent });
  it('says nothing when nobody is absent or nothing is known', () => {
    expect(s(0, 0)).toBeNull();
    expect(noticeLine(null)).toBeNull();
    expect(noticeLine(undefined)).toBeNull();
  });
  it('offers to tell everybody who has not been told', () => {
    expect(s(1, 1)).toEqual({ canSend: true, tone: 'warning',
      text: '1 child marked absent. The guardians of that child have not been told yet.' });
    expect(s(3, 3)!.text).toBe('3 children marked absent. The guardians of all of them have not been told yet.');
    expect(s(3, 1)!.text).toBe('3 children marked absent. The guardians of 1 have not been told yet.');
  });
  it('says so once they have been told, and does not offer again', () => {
    expect(s(2, 0)).toEqual({ canSend: false, tone: 'good',
      text: '2 children marked absent. Their guardians have been told.' });
  });
  it('names the children nobody can be told about', () => {
    expect(s(3, 2, 1)!.text).toBe('3 children marked absent. The guardians of 2 have not been told yet. '
      + '1 child has no guardian on file and cannot be told.');
    expect(s(3, 0, 2)).toEqual({ canSend: false, tone: 'good',
      text: '3 children marked absent. Their guardians have been told. 2 children have no guardian on file and cannot be told.' });
  });
  it('does not claim anybody was told when nobody could be', () => {
    expect(s(2, 0, 2)).toEqual({ canSend: false, tone: 'warning',
      text: '2 children marked absent. 2 children have no guardian on file and cannot be told.' });
  });
});

describe('when nobody has been asked for consent', () => {
  const s = (absent: number, toTell: number, noConsent: number) =>
    noticeLine({ absent, toTell, noGuardian: 0, notices: toTell - noConsent, noConsent });
  it('does not offer a button that would send nothing', () => {
    expect(s(2, 2, 2)).toEqual({ canSend: false, tone: 'warning',
      text: '2 children marked absent. No consent for attendance notices is on record for 2 children; record it under Consent first.' });
  });
  it('still offers it when some can be told, and says who cannot', () => {
    expect(s(3, 3, 1)).toEqual({ canSend: true, tone: 'warning',
      text: '3 children marked absent. The guardians of all of them have not been told yet. '
        + 'No consent for attendance notices is on record for 1 child; record it under Consent first.' });
  });
});

describe('what happened when it was sent', () => {
  it('counts what went and what did not', () => {
    expect(sentLine({ sent: 1, suppressed: 0, failed: 0 })).toBe('1 guardian told.');
    expect(sentLine({ sent: 4, suppressed: 0, failed: 0 })).toBe('4 guardians told.');
    expect(sentLine({ sent: 3, suppressed: 1, failed: 2 }))
      .toBe('3 guardians told. 1 not sent: they have asked not to get these. 2 could not be sent — try again.');
    expect(sentLine({ sent: 0, suppressed: 0, failed: 1 })).toBe('0 guardians told. 1 could not be sent — try again.');
  });
  it('does not say somebody refused when they were never asked', () => {
    expect(sentLine({ sent: 1, suppressed: 3, failed: 0, outcomes: [
      { outcome: 'sent' }, { outcome: 'suppressed', reason: 'no_consent' },
      { outcome: 'suppressed', reason: 'no_consent' }, { outcome: 'suppressed', reason: 'muted' },
      { outcome: 'failed', reason: 'no_consent' },
    ] })).toBe('1 guardian told. 2 not sent: no consent on record. 1 not sent: they have asked not to get these.');
    expect(sentLine({ sent: 0, suppressed: 1, failed: 0,
      outcomes: [{ outcome: 'suppressed', reason: 'no_consent' }] }))
      .toBe('0 guardians told. 1 not sent: no consent on record.');
  });
});
