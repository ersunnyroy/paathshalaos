import type { CertificateKind } from './certificate-text.ts';

const PREFIX: Record<CertificateKind, string> = { bonafide: 'BON', study: 'STU', dob: 'DOB' };

/** "BON/2026-27/0007". Four digits, because a school issues hundreds a year. */
export function certificateNo(kind: CertificateKind, yearLabel: string, serial: number): string {
  return `${PREFIX[kind]}/${yearLabel}/${String(serial).padStart(4, '0')}`;
}
