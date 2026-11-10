/**
 * What every list in the product does the same way (M40): filter, sort,
 * choose columns, remember the choice, export.
 *
 * Pure, so each of those is tested without a browser. Two rules matter more
 * than the rest:
 *
 *   **An export is opened in a spreadsheet, and a spreadsheet runs formulas.**
 *   A learner named `=HYPERLINK(...)` is data in this product and a live
 *   formula in Excel. Every cell that begins with `=`, `+`, `-`, `@`, a tab or
 *   a carriage return is prefixed with an apostrophe, which spreadsheets show
 *   as text. That includes a negative amount, deliberately: `-250.00` in a
 *   column of rupees is rare, and a formula in a file an accountant opens is
 *   not a risk worth taking for it.
 *
 *   **A saved view is somebody's own, old, and possibly wrong.** It comes out
 *   of browser storage written by an earlier version of the page, so it is
 *   checked against the columns that exist today and anything unknown is
 *   dropped rather than trusted.
 */

export interface Column<T> {
  key: string;
  label: string;
  /** The cell as text: what is filtered on, sorted by and exported. */
  text: (row: T) => string;
  align?: 'right';
  /** Hidden until somebody turns it on. */
  optional?: boolean;
  /** Cannot be hidden — usually the column that says which row this is. */
  required?: boolean;
  /** Sort as a number rather than as text. */
  numeric?: boolean;
}

export interface View {
  hidden: string[];
  sort: { key: string; dir: 'asc' | 'desc' } | null;
}

export function defaultView<T>(columns: readonly Column<T>[]): View {
  return { hidden: columns.filter((c) => c.optional && !c.required).map((c) => c.key), sort: null };
}

/** A stored view made safe for today's columns; the default if it is not a view at all. */
export function restoreView<T>(columns: readonly Column<T>[], stored: unknown): View {
  const fallback = defaultView(columns);
  if (typeof stored !== 'object' || stored === null) return fallback;
  const raw = stored as { hidden?: unknown; sort?: unknown };
  const known = new Map(columns.map((c) => [c.key, c]));

  const hidden = Array.isArray(raw.hidden)
    ? raw.hidden.filter((k): k is string =>
        typeof k === 'string' && known.has(k) && !known.get(k)!.required)
    : fallback.hidden;

  let sort: View['sort'] = null;
  if (typeof raw.sort === 'object' && raw.sort !== null) {
    const s = raw.sort as { key?: unknown; dir?: unknown };
    if (typeof s.key === 'string' && known.has(s.key) && (s.dir === 'asc' || s.dir === 'desc')) {
      sort = { key: s.key, dir: s.dir };
    }
  }
  return { hidden: [...new Set(hidden)], sort };
}

export function visibleColumns<T>(columns: readonly Column<T>[], view: View): Column<T>[] {
  return columns.filter((c) => c.required || !view.hidden.includes(c.key));
}

/** Clicking a heading: ascending, then descending, then back to the order it arrived in. */
export function nextSort(current: View['sort'], key: string): View['sort'] {
  if (!current || current.key !== key) return { key, dir: 'asc' };
  return current.dir === 'asc' ? { key, dir: 'desc' } : null;
}

/**
 * Rows containing every word typed, in any column — shown or hidden.
 *
 * Hidden columns are searched on purpose: somebody who hid the admission
 * number still expects typing one to find the learner. The words are literals.
 */
export function filterRows<T>(rows: readonly T[], columns: readonly Column<T>[], typed: string): T[] {
  const words = typed.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...rows];
  return rows.filter((row) => {
    const haystack = columns.map((c) => c.text(row)).join('\u0000').toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

const amount = (text: string) => {
  const cleaned = text.replace(/[₹,\s%]/g, '');
  return /^-?\d+(\.\d+)?$/.test(cleaned) ? Number(cleaned) : Number.NaN;
};

/**
 * A sorted copy. Stable, so rows that tie keep the order the server sent.
 *
 * Text sorts the way a person reads it — "Class 9" before "Class 10" — and
 * blanks go last in both directions, because an empty cell is not "smallest",
 * it is unknown, and unknown rows should not lead the list.
 */
export function sortRows<T>(rows: readonly T[], columns: readonly Column<T>[], sort: View['sort']): T[] {
  const column = sort ? columns.find((c) => c.key === sort.key) : undefined;
  if (!sort || !column) return [...rows];
  const sign = sort.dir === 'asc' ? 1 : -1;
  const collator = new Intl.Collator('en-IN', { numeric: true, sensitivity: 'base' });
  return rows
    .map((row) => ({ row, text: column.text(row).trim() }))
    .sort((a, b) => {
      const aBlank = a.text === '' || a.text === '—';
      const bBlank = b.text === '' || b.text === '—';
      if (aBlank || bBlank) return aBlank === bBlank ? 0 : aBlank ? 1 : -1;
      let order: number;
      if (column.numeric) {
        const an = amount(a.text);
        const bn = amount(b.text);
        order = Number.isNaN(an) || Number.isNaN(bn) ? collator.compare(a.text, b.text) : an - bn;
      } else {
        order = collator.compare(a.text, b.text);
      }
      // No tie-break needed: Array.prototype.sort is stable, so returning 0
      // keeps the arriving order. An explicit one was here and a mutation
      // removing it changed nothing.
      return order * sign;
    })
    .map((entry) => entry.row);
}

const DANGEROUS = /^[=+\-@\t\r]/;

/** One CSV cell: neutralised if a spreadsheet would run it, quoted if it needs to be. */
export function csvCell(value: string): string {
  const safe = DANGEROUS.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/**
 * The rows as CSV, with a header line, CRLF line endings and a byte-order
 * mark — the three things Excel needs to open a file with ₹ and Devanagari in
 * it without turning them into mojibake.
 */
export function toCsv<T>(columns: readonly Column<T>[], rows: readonly T[]): string {
  const lines = [
    columns.map((c) => csvCell(c.label)).join(','),
    ...rows.map((row) => columns.map((c) => csvCell(c.text(row))).join(',')),
  ];
  return `﻿${lines.join('\r\n')}\r\n`;
}

/** "Learners 2026-11-10.csv" — the date somebody will be glad of in March. */
export function exportName(title: string, today: string): string {
  // \p{M} as well as letters and digits: Devanagari vowel signs are combining
  // marks, and stripping them turns "छात्र सूची" into "छतर सच".
  const base = title.trim().replace(/[^\p{L}\p{M}\p{N} _-]+/gu, '').replace(/\s+/g, ' ').slice(0, 60) || 'Export';
  return `${base} ${today}.csv`;
}
