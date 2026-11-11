/**
 * The rules of a school's structure that a form can check before it asks (M41).
 *
 * The API and the database enforce all of these — a term outside its year is
 * refused there whatever a screen does. They are repeated here only so the
 * person filling in the form is told which field is wrong while they are
 * still looking at it, instead of after a round trip.
 */

const DAY = 86_400_000;
const toUtc = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
const toIso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const isIso = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(toUtc(value))
  && toIso(toUtc(value)) === value;   // rejects 2026-02-30, which Date would roll forward

export interface TermDraft { label: string; sequence: number; startsOn: string; endsOn: string }

/** "2026-27" from the year's dates; a year inside one calendar year is just "2026". */
export function yearLabel(startsOn: string, endsOn: string): string {
  if (!isIso(startsOn) || !isIso(endsOn)) return '';
  const from = startsOn.slice(0, 4);
  const to = endsOn.slice(0, 4);
  return from === to ? from : `${from}-${to.slice(2)}`;
}

/**
 * Splits a year into equal, back-to-back terms.
 *
 * Every day of the year lands in exactly one term: the first starts on the
 * year's first day, the last ends on its last day, and each term starts the
 * day after the one before it ends. Any leftover days go to the last term.
 */
export function suggestTerms(startsOn: string, endsOn: string, count: number): TermDraft[] {
  if (!isIso(startsOn) || !isIso(endsOn) || !Number.isInteger(count) || count < 1) return [];
  const first = toUtc(startsOn);
  const days = Math.round((toUtc(endsOn) - first) / DAY) + 1;
  if (days < count) return [];
  const each = Math.floor(days / count);
  return Array.from({ length: count }, (_, i) => ({
    label: `Term ${i + 1}`,
    sequence: i + 1,
    startsOn: toIso(first + i * each * DAY),
    endsOn: i === count - 1 ? endsOn : toIso(first + ((i + 1) * each - 1) * DAY),
  }));
}

/** The first thing wrong with a year and its terms, or null. */
export function yearProblem(year: { label: string; startsOn: string; endsOn: string; terms: TermDraft[] }): string | null {
  if (!year.label.trim()) return 'Give the year a label, like 2027-28.';
  if (!isIso(year.startsOn) || !isIso(year.endsOn)) return 'Both dates are needed, as real calendar dates.';
  if (year.endsOn <= year.startsOn) return 'The year must end after it starts.';
  const terms = [...year.terms].sort((a, b) => a.sequence - b.sequence);
  for (const [index, term] of terms.entries()) {
    if (!term.label.trim()) return `Term ${index + 1} needs a name.`;
    if (!isIso(term.startsOn) || !isIso(term.endsOn)) return `${term.label}: both dates are needed.`;
    if (term.endsOn < term.startsOn) return `${term.label} ends before it starts.`;
    if (term.startsOn < year.startsOn || term.endsOn > year.endsOn) {
      return `${term.label} falls outside the year (${year.startsOn} to ${year.endsOn}).`;
    }
    const previous = terms[index - 1];
    if (previous && term.startsOn <= previous.endsOn) {
      return `${term.label} overlaps ${previous.label}.`;
    }
  }
  return null;
}

/** A short code from a name: "Physical Education" → "PHYSICAL-EDUCATION", capped at 32. */
export function codeFrom(name: string): string {
  return name.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32)
    .replace(/-+$/, '');
}

/** Whether the API will accept this as a code. */
export function codeOk(code: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9 _-]{0,31}$/.test(code);
}

/** A positive whole number from a form field, undefined when blank, null when wrong. */
export function capacityFrom(text: string): number | undefined | null {
  const value = text.trim();
  if (value === '') return undefined;
  if (!/^\d{1,5}$/.test(value)) return null;
  const n = Number(value);
  return n >= 1 && n <= 10_000 ? n : null;
}

export interface ClassGroup { id: string; name: string; level_sequence: number | null }

/** Classes in school order: by level, then name; classes with no level last. */
export function orderClasses<T extends ClassGroup>(groups: readonly T[]): T[] {
  return [...groups].sort((a, b) =>
    (a.level_sequence ?? Number.MAX_SAFE_INTEGER) - (b.level_sequence ?? Number.MAX_SAFE_INTEGER)
    || a.name.localeCompare(b.name, 'en-IN', { numeric: true }));
}
