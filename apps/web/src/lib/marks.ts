/**
 * Entering a class's marks.
 *
 * A teacher types thirty or forty numbers from a pile of answer scripts, or
 * pastes them from a spreadsheet. Everything that decides what a cell means,
 * what goes to the server and what the class did is here, away from React.
 */

export interface SheetRow {
  enrollment_id: string; admission_no: string; roll_no: string | null;
  given_name: string; family_name: string | null;
  mark_id: string | null; marks_obtained: string | null;
  is_absent: boolean | null; is_exempt: boolean | null;
}

export type Cell =
  | { kind: 'blank' }
  | { kind: 'mark'; value: number }
  | { kind: 'absent' }
  | { kind: 'exempt' }
  | { kind: 'bad'; why: string };

const ABSENT = new Set(['a', 'ab', 'abs', 'absent']);
const EXEMPT = new Set(['e', 'ex', 'exempt']);

/** The column holds two decimals, so a third is a typing slip, not precision. */
const NUMBER = /^\d+(\.\d{1,2})?$/;

/** What a typed cell means against a paper marked out of `max`. */
export function readCell(text: string, max: number): Cell {
  const t = text.trim();
  if (t === '') return { kind: 'blank' };
  const lower = t.toLowerCase();
  if (ABSENT.has(lower)) return { kind: 'absent' };
  if (EXEMPT.has(lower)) return { kind: 'exempt' };
  if (!NUMBER.test(t)) return { kind: 'bad', why: 'Not a mark. Type a number, A for absent or E for exempt.' };
  const value = Number(t);
  if (value > max) return { kind: 'bad', why: `More than the ${max} this paper is out of.` };
  return { kind: 'mark', value };
}

/** What is already saved for a learner, as the cell would show it. */
export function recorded(row: SheetRow): string {
  if (row.mark_id === null) return '';
  if (row.is_absent) return 'A';
  if (row.is_exempt) return 'E';
  return row.marks_obtained === null ? '' : String(Number(row.marks_obtained));
}

function same(a: Cell, b: Cell): boolean {
  if (a.kind !== b.kind) return false;
  return a.kind === 'mark' && b.kind === 'mark' ? a.value === b.value : true;
}

export type Entry = Record<string, string>;

export interface MarkToSend {
  enrollmentId: string; marks?: number; absent?: true; exempt?: true;
}
export interface Changes {
  send: MarkToSend[];
  problems: Array<{ enrollmentId: string; why: string }>;
}

/**
 * Only what the teacher changed goes to the server: resending thirty-eight
 * untouched marks to save two would write thirty-eight audit rows for nothing.
 */
export function changes(rows: SheetRow[], entry: Entry, max: number): Changes {
  const out: Changes = { send: [], problems: [] };
  for (const row of rows) {
    const typed = entry[row.enrollment_id];
    if (typed === undefined) continue;
    const cell = readCell(typed, max);
    const before = readCell(recorded(row), max);
    if (same(cell, before)) continue;
    const enrollmentId = row.enrollment_id;
    if (cell.kind === 'bad') out.problems.push({ enrollmentId, why: cell.why });
    else if (cell.kind === 'blank') {
      out.problems.push({ enrollmentId,
        why: 'A saved mark cannot be emptied. Type the right mark, A or E.' });
    }
    else if (cell.kind === 'absent') out.send.push({ enrollmentId, absent: true });
    else if (cell.kind === 'exempt') out.send.push({ enrollmentId, exempt: true });
    else out.send.push({ enrollmentId, marks: cell.value });
  }
  return out;
}

/** The server takes at most this many rows in one request. */
export const BATCH = 200;

export function batches<T>(items: T[], size = BATCH): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export interface Pasted { entry: Entry; unmatched: string[]; spare: number }

const key = (s: string) => s.trim().toLowerCase();

/**
 * Text copied from a spreadsheet, laid onto the sheet.
 *
 * One column is taken as marks in the order shown, starting at the cell the
 * teacher pasted into. Two or more columns are taken as "who, …, mark": the
 * first cell is a roll or admission number and the last is the mark, so a
 * spreadsheet sorted differently from the register still lands on the right
 * children. A line that names nobody (a header row) is reported, not guessed.
 */
export function paste(rows: SheetRow[], startIndex: number, text: string): Pasted {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop();
  const out: Pasted = { entry: {}, unmatched: [], spare: 0 };
  const table = lines.map((l) => l.split('\t'));
  const wide = table.some((cells) => cells.length > 1);

  if (!wide) {
    table.forEach((cells, i) => {
      const row = rows[startIndex + i];
      if (!row) { out.spare += 1; return; }
      out.entry[row.enrollment_id] = cells[0]!.trim();
    });
    return out;
  }

  const byAdmission = new Map(rows.map((r) => [key(r.admission_no), r]));
  const byRoll = new Map(
    rows.filter((r) => r.roll_no !== null && r.roll_no.trim() !== '')
      .map((r) => [key(r.roll_no!), r]));
  for (const cells of table) {
    const who = key(cells[0] ?? '');
    if (cells.every((c) => c.trim() === '')) continue;
    // Admission numbers are unique in a school; roll numbers only in a section.
    const row = byAdmission.get(who) ?? byRoll.get(who);
    if (!row) { out.unmatched.push((cells[0] ?? '').trim()); continue; }
    out.entry[row.enrollment_id] = cells[cells.length - 1]!.trim();
  }
  return out;
}

export interface Summary {
  learners: number; marked: number; absent: number; exempt: number;
  pending: number; bad: number;
  average: number | null; highest: number | null; lowest: number | null;
}

/**
 * How the class did, as typed so far. An absent or exempt learner is left out
 * of the average: an absence is not a zero.
 */
export function summarise(rows: SheetRow[], entry: Entry, max: number): Summary {
  const s: Summary = { learners: rows.length, marked: 0, absent: 0, exempt: 0,
    pending: 0, bad: 0, average: null, highest: null, lowest: null };
  let total = 0;
  for (const row of rows) {
    const cell = readCell(entry[row.enrollment_id] ?? recorded(row), max);
    if (cell.kind === 'blank') s.pending += 1;
    else if (cell.kind === 'bad') s.bad += 1;
    else if (cell.kind === 'absent') s.absent += 1;
    else if (cell.kind === 'exempt') s.exempt += 1;
    else {
      s.marked += 1; total += cell.value;
      s.highest = s.highest === null ? cell.value : Math.max(s.highest, cell.value);
      s.lowest = s.lowest === null ? cell.value : Math.min(s.lowest, cell.value);
    }
  }
  if (s.marked > 0) s.average = Math.round((total / s.marked) * 10) / 10;
  return s;
}

/** A mark as a share of the paper, to the nearest whole percent. */
export function percent(value: number, max: number): number | null {
  return max > 0 ? Math.round((value / max) * 100) : null;
}

/** Where Enter and the arrow keys take the cursor; it stops at the ends. */
export function nextRow(index: number, keyName: string, count: number): number {
  const step = keyName === 'Enter' || keyName === 'ArrowDown' ? 1
    : keyName === 'ArrowUp' ? -1 : 0;
  return Math.min(Math.max(index + step, 0), Math.max(count - 1, 0));
}

const REFUSALS: Record<string, string> = {
  exceeds_max_marks: 'More than the paper is out of.',
  assessment_locked: 'The paper is locked. Ask for a correction instead.',
  unknown_enrollment: 'This learner is no longer in the class. Reload the sheet.',
  duplicate: 'Already saved a moment ago. Reload the sheet.',
  client_event_id_belongs_to_another_learner: 'Sent twice by mistake. Reload the sheet.',
};

/** What the server said about a refused row, in words a teacher can act on. */
export function refusal(reason: string | undefined): string {
  const r = (reason ?? '').trim();
  if (r === '' || r === 'rejected') return 'Not accepted.';
  return REFUSALS[r] ?? r;
}
