/**
 * The certificate wording exists twice: the web builds the preview with it and
 * the API builds what is stored and printed. They are the same file, and this
 * is what keeps them the same — a preview that differs from the paper by one
 * word is a preview that cannot be trusted.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { certificate } from '../src/modules/people/certificate-text.ts';
import { certificateNo } from '../src/modules/people/certificate-number.ts';

const here = dirname(fileURLToPath(import.meta.url));

describe('the certificate wording', () => {
  it('is byte for byte the web copy', () => {
    const api = readFileSync(join(here, '../src/modules/people/certificate-text.ts'), 'utf8');
    const web = readFileSync(join(here, '../../web/src/lib/certificate.ts'), 'utf8');
    expect(api).toBe(web);
  });

  it('composes on the server as it does in the browser', () => {
    const doc = certificate({
      kind: 'bonafide', learnerName: 'Aarav Kumar', admissionNo: 'DEMO-0001',
      className: 'Class IX', sectionName: 'A', dateOfBirth: '2011-01-10',
      guardianName: 'Sunita Kumar', yearLabel: '2026-27', schoolName: 'Demo Vidyalaya',
      purpose: 'a passport application', issuedOn: '2026-11-11', enrolled: true,
    });
    expect(doc.problems).toEqual([]);
    expect(doc.paragraphs[0]).toContain('is a bona fide student of Demo Vidyalaya');
    expect(doc.paragraphs.at(-1)).toContain('for the purpose of a passport application.');
  });
});

describe('the certificate number', () => {
  it('carries the kind, the year and a four-digit serial', () => {
    expect(certificateNo('bonafide', '2026-27', 7)).toBe('BON/2026-27/0007');
    expect(certificateNo('study', '2026-27', 123)).toBe('STU/2026-27/0123');
    expect(certificateNo('dob', '2026', 12345)).toBe('DOB/2026/12345');
  });
});
