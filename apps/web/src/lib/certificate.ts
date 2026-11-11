/**
 * The wording of the certificates a school office is asked for most days.
 *
 * The office picks the kind and may say what it is for; everything else comes
 * from the learner's record, so the paper cannot disagree with the register.
 * Where the record does not hold something, the sentence is written without
 * it rather than with a blank to be filled in by hand.
 */

export type CertificateKind = 'bonafide' | 'study' | 'dob';

export const KINDS: Array<{ value: CertificateKind; label: string }> = [
  { value: 'bonafide', label: 'Bonafide certificate' },
  { value: 'study', label: 'Study certificate' },
  { value: 'dob', label: 'Date of birth certificate' },
];

export interface CertificateInput {
  kind: CertificateKind;
  learnerName: string; admissionNo: string;
  className: string | null; sectionName: string | null;
  dateOfBirth: string | null;
  /** The primary guardian, when the office may see who that is. */
  guardianName: string | null;
  /** "2026-27". */
  yearLabel: string | null;
  schoolName: string;
  /** What it is for, in the office's words. Optional. */
  purpose: string;
  /** ISO date it is issued on. */
  issuedOn: string;
  /** Whether the learner is on the roll now. A certificate for one who has left says "was". */
  enrolled: boolean;
}

export interface Certificate { title: string; paragraphs: string[]; problems: string[] }

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
  'September', 'October', 'November', 'December'];

/** "2012-03-14" as "14 March 2012"; null for anything that is not a real date. */
export function longDate(iso: string | null): string | null {
  const match = iso ? /^(\d{4})-(\d{2})-(\d{2})/.exec(iso) : null;
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const real = new Date(Date.UTC(year, month - 1, day));
  // A day that does not exist rolls into another month: 30 February is 1 March.
  if (day < 1 || real.getUTCMonth() !== month - 1) return null;
  return `${day} ${MONTHS[month - 1]} ${year}`;
}

const tidy = (text: string) => text.replace(/\s+/g, ' ').trim();

/**
 * The certificate's words, and anything that stops it being issued.
 *
 * `problems` is not advice: a date-of-birth certificate with no date of birth
 * on record is not a certificate, and the page refuses to print it.
 */
export function certificate(input: CertificateInput): Certificate {
  const kind = KINDS.find((k) => k.value === input.kind) ?? KINDS[0]!;
  const problems: string[] = [];
  const name = tidy(input.learnerName);
  const guardian = input.guardianName ? tidy(input.guardianName) : '';
  const cls = tidy([input.className, input.sectionName].filter(Boolean).join(' '));
  const born = longDate(input.dateOfBirth);
  const purpose = tidy(input.purpose).replace(/[.]+$/, '');

  if (name === '') problems.push('The learner has no name on record.');
  if (input.kind === 'dob' && !born) {
    problems.push('No date of birth is on record, so this certificate cannot be issued. Add it to the learner first.');
  }
  if (input.kind !== 'dob' && cls === '') {
    problems.push('The learner is not placed in a class, so there is nothing to certify.');
  }

  const who = `${name}${guardian ? `, ward of ${guardian},` : ''}`;
  const admission = `(admission number ${input.admissionNo})`;
  const verb = input.enrolled ? 'is' : 'was';
  const year = input.yearLabel ? ` during the academic year ${input.yearLabel}` : '';
  const paragraphs: string[] = [];

  if (input.kind === 'bonafide') {
    paragraphs.push(tidy(`This is to certify that ${who} ${admission} ${verb} a bona fide student of ${input.schoolName}, ${input.enrolled ? 'studying' : 'and studied'} in ${cls}${year}.`));
    if (born) paragraphs.push(`As per the school's records, the student's date of birth is ${born}.`);
  } else if (input.kind === 'study') {
    paragraphs.push(tidy(`This is to certify that ${who} ${admission} ${input.enrolled ? 'is studying' : 'studied'} in ${cls} at ${input.schoolName}${year}.`));
    paragraphs.push(`The student's conduct at school ${input.enrolled ? 'is' : 'was'} satisfactory, as far as is known to the school.`);
  } else {
    paragraphs.push(tidy(`This is to certify that, as per the admission register of ${input.schoolName}, the date of birth of ${who} ${admission} is ${born ?? ''}.`));
  }
  paragraphs.push(purpose
    ? `This certificate is issued at the request of the student's family for the purpose of ${purpose}.`
    : `This certificate is issued at the request of the student's family.`);

  return { title: kind.label, paragraphs, problems };
}

/** A name for the saved PDF: "bonafide-DEMO-0001-2026-11-11". */
export function certificateFile(kind: CertificateKind, admissionNo: string, issuedOn: string): string {
  const safe = admissionNo.replace(/[^A-Za-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  return `${kind}-${safe || 'learner'}-${issuedOn}`;
}
