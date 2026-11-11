import { describe, expect, it } from 'vitest';
import { certificate, certificateFile, longDate, type CertificateInput } from '../src/lib/certificate';

const base: CertificateInput = {
  kind: 'bonafide', learnerName: 'Aarav  Kumar', admissionNo: 'DEMO-0001',
  className: 'Class IX', sectionName: 'A', dateOfBirth: '2012-03-14',
  guardianName: 'Sunita Kumar', yearLabel: '2026-27', schoolName: 'Demo Vidyalaya',
  purpose: '', issuedOn: '2026-11-11', enrolled: true,
};

describe('a date written out', () => {
  it('writes a real date and refuses anything else', () => {
    expect(longDate('2012-03-14')).toBe('14 March 2012');
    expect(longDate('2012-01-01')).toBe('1 January 2012');
    expect(longDate('2012-12-31T10:00:00Z')).toBe('31 December 2012');
    expect(longDate('2012-02-30')).toBeNull();
    expect(longDate('2012-03-00')).toBeNull();
    expect(longDate('2012-00-10')).toBeNull();
    expect(longDate('2012-13-01')).toBeNull();
    expect(longDate('soon')).toBeNull();
    expect(longDate(null)).toBeNull();
  });
});

describe('a bonafide certificate', () => {
  it('names the learner, guardian, class and year from the record', () => {
    const c = certificate(base);
    expect(c.title).toBe('Bonafide certificate');
    expect(c.problems).toEqual([]);
    expect(c.paragraphs).toEqual([
      'This is to certify that Aarav Kumar, ward of Sunita Kumar, (admission number DEMO-0001) is a bona fide student of Demo Vidyalaya, studying in Class IX A during the academic year 2026-27.',
      "As per the school's records, the student's date of birth is 14 March 2012.",
      "This certificate is issued at the request of the student's family.",
    ]);
  });
  it('is written without what the record does not hold', () => {
    const c = certificate({ ...base, guardianName: null, dateOfBirth: null, yearLabel: null, sectionName: null });
    expect(c.problems).toEqual([]);
    expect(c.paragraphs).toEqual([
      'This is to certify that Aarav Kumar (admission number DEMO-0001) is a bona fide student of Demo Vidyalaya, studying in Class IX.',
      "This certificate is issued at the request of the student's family.",
    ]);
  });
  it('says what it is for, without a doubled full stop', () => {
    expect(certificate({ ...base, purpose: '  a passport   application. ' }).paragraphs.at(-1))
      .toBe("This certificate is issued at the request of the student's family for the purpose of a passport application.");
  });
  it('says "was" for a learner who has left', () => {
    expect(certificate({ ...base, enrolled: false }).paragraphs[0])
      .toContain('was a bona fide student of Demo Vidyalaya, and studied in Class IX A');
  });
  it('cannot be issued for a learner in no class, or with no name', () => {
    expect(certificate({ ...base, className: null, sectionName: null }).problems)
      .toEqual(['The learner is not placed in a class, so there is nothing to certify.']);
    expect(certificate({ ...base, learnerName: '  ' }).problems)
      .toContain('The learner has no name on record.');
  });
});

describe('the other kinds', () => {
  it('a study certificate speaks of conduct, in the right tense', () => {
    const now = certificate({ ...base, kind: 'study' });
    expect(now.title).toBe('Study certificate');
    expect(now.paragraphs[0]).toBe('This is to certify that Aarav Kumar, ward of Sunita Kumar, (admission number DEMO-0001) is studying in Class IX A at Demo Vidyalaya during the academic year 2026-27.');
    expect(now.paragraphs[1]).toContain('conduct at school is satisfactory');
    const then = certificate({ ...base, kind: 'study', enrolled: false });
    expect(then.paragraphs[0]).toContain('studied in Class IX A');
    expect(then.paragraphs[1]).toContain('conduct at school was satisfactory');
  });
  it('a date of birth certificate states the date and needs one', () => {
    const c = certificate({ ...base, kind: 'dob', className: null, sectionName: null });
    expect(c.problems).toEqual([]);
    expect(c.paragraphs[0]).toBe('This is to certify that, as per the admission register of Demo Vidyalaya, the date of birth of Aarav Kumar, ward of Sunita Kumar, (admission number DEMO-0001) is 14 March 2012.');
    expect(certificate({ ...base, kind: 'dob', dateOfBirth: null }).problems)
      .toEqual(['No date of birth is on record, so this certificate cannot be issued. Add it to the learner first.']);
    expect(certificate({ ...base, kind: 'dob', dateOfBirth: '2012-02-30' }).problems).toHaveLength(1);
  });
});

describe('the saved file', () => {
  it('is named for the kind, the learner and the day', () => {
    expect(certificateFile('bonafide', 'DEMO-0001', '2026-11-11')).toBe('bonafide-DEMO-0001-2026-11-11');
    expect(certificateFile('dob', 'A/12 34', '2026-11-11')).toBe('dob-A-12-34-2026-11-11');
    expect(certificateFile('study', '///', '2026-11-11')).toBe('study-learner-2026-11-11');
  });
});
