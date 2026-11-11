/**
 * The school's letterhead as it is printed (M47.4): the lines under the
 * school's name on a receipt or a certificate.
 */

export interface Letterhead {
  address_line1: string | null; address_line2: string | null;
  city: string | null; state: string | null; pincode: string | null;
  phone: string | null; email: string | null; website: string | null;
  affiliation_body: string | null; affiliation_no: string | null;
  school_code: string | null; udise_code: string | null;
  signatory_name: string | null; signatory_title: string | null;
}

export const LETTERHEAD_FIELDS: Array<{
  key: keyof Letterhead; label: string; hint?: string; wide?: boolean;
}> = [
  { key: 'address_line1', label: 'Address', wide: true },
  { key: 'address_line2', label: 'Address, second line', wide: true },
  { key: 'city', label: 'Town or city' },
  { key: 'state', label: 'State' },
  { key: 'pincode', label: 'PIN code', hint: 'Six digits' },
  { key: 'phone', label: 'Telephone' },
  { key: 'email', label: 'Email' },
  { key: 'website', label: 'Website' },
  { key: 'affiliation_body', label: 'Affiliated to', hint: 'CBSE, ICSE, state board…' },
  { key: 'affiliation_no', label: 'Affiliation number' },
  { key: 'school_code', label: 'School code' },
  { key: 'udise_code', label: 'UDISE+ code', hint: 'Eleven digits' },
  { key: 'signatory_name', label: 'Who signs' },
  { key: 'signatory_title', label: 'Their title', hint: 'Principal, Head of school…' },
];

const has = (value: string | null | undefined): value is string =>
  typeof value === 'string' && value.trim() !== '';

/**
 * The lines printed under the school's name, top to bottom. A school that has
 * filled in nothing gets no lines, not a row of separators.
 */
export function headerLines(lh: Letterhead | null | undefined): string[] {
  if (!lh) return [];
  const place = [lh.city, lh.state].filter(has).map((s) => s.trim()).join(', ');
  const address = [lh.address_line1, lh.address_line2, [place, has(lh.pincode) ? lh.pincode.trim() : ''].filter(Boolean).join(' – ')]
    .filter(has).map((s) => s.trim()).join(', ');
  const contact = [
    has(lh.phone) ? `Tel: ${lh.phone.trim()}` : '',
    has(lh.email) ? lh.email.trim() : '',
    has(lh.website) ? lh.website.trim() : '',
  ].filter(Boolean).join(' · ');
  const affiliation = [
    has(lh.affiliation_body) || has(lh.affiliation_no)
      ? `Affiliated to ${has(lh.affiliation_body) ? lh.affiliation_body.trim() : 'the board'}${has(lh.affiliation_no) ? `, No. ${lh.affiliation_no.trim()}` : ''}`
      : '',
    has(lh.school_code) ? `School code ${lh.school_code.trim()}` : '',
    has(lh.udise_code) ? `UDISE+ ${lh.udise_code.trim()}` : '',
  ].filter(Boolean).join(' · ');
  return [address, contact, affiliation].filter(Boolean);
}

/** The words under the signature line. */
export function signatory(lh: Letterhead | null | undefined, fallbackTitle: string): string[] {
  const title = has(lh?.signatory_title) ? lh.signatory_title.trim() : fallbackTitle;
  return has(lh?.signatory_name) ? [lh.signatory_name.trim(), title] : [title];
}

/** What is wrong with the form as typed, by field. Empty when it can be saved. */
export function letterheadProblems(form: Partial<Record<keyof Letterhead, string>>): Partial<Record<keyof Letterhead, string>> {
  const out: Partial<Record<keyof Letterhead, string>> = {};
  const pin = (form.pincode ?? '').trim();
  if (pin !== '' && !/^[1-9][0-9]{5}$/.test(pin)) out.pincode = 'A PIN code is six digits and does not start with 0.';
  const udise = (form.udise_code ?? '').trim();
  if (udise !== '' && !/^[0-9]{11}$/.test(udise)) out.udise_code = 'A UDISE+ code is eleven digits.';
  const email = (form.email ?? '').trim();
  if (email !== '' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) out.email = 'That does not look like an email address.';
  return out;
}

/** How much of what other institutions look for is still blank. */
export function missingForPaper(lh: Letterhead | null | undefined): string[] {
  const out: string[] = [];
  if (!has(lh?.address_line1) || !has(lh?.city)) out.push('address');
  if (!has(lh?.phone)) out.push('telephone number');
  if (!has(lh?.affiliation_no)) out.push('affiliation number');
  return out;
}
