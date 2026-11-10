import { describe, expect, it } from 'vitest';
import {
  batches, changes, nextRow, paste, percent, readCell, recorded, refusal, summarise,
  type SheetRow,
} from '../src/lib/marks';

const row = (n: number, over: Partial<SheetRow> = {}): SheetRow => ({
  enrollment_id: `e${n}`, admission_no: `ADM-${n}`, roll_no: String(n),
  given_name: `Child${n}`, family_name: null,
  mark_id: null, marks_obtained: null, is_absent: null, is_exempt: null, ...over,
});
const rows = [row(1), row(2), row(3)];

describe('reading a cell', () => {
  it('reads blank, numbers, absent and exempt', () => {
    expect(readCell('  ', 20)).toEqual({ kind: 'blank' });
    expect(readCell(' 18 ', 20)).toEqual({ kind: 'mark', value: 18 });
    expect(readCell('17.5', 20)).toEqual({ kind: 'mark', value: 17.5 });
    expect(readCell('0', 20)).toEqual({ kind: 'mark', value: 0 });
    for (const t of ['a', 'A', 'AB', 'abs', 'Absent']) expect(readCell(t, 20).kind).toBe('absent');
    for (const t of ['e', 'E', 'ex', 'Exempt']) expect(readCell(t, 20).kind).toBe('exempt');
  });
  it('allows the full mark and refuses one above it', () => {
    expect(readCell('20', 20)).toEqual({ kind: 'mark', value: 20 });
    const over = readCell('20.5', 20);
    expect(over.kind).toBe('bad');
    expect(over.kind === 'bad' && over.why).toContain('20');
  });
  it('refuses what is not a mark', () => {
    for (const t of ['-1', '1e2', '12abc', '1.234', '.5', '1,5', 'NaN', '0x10']) {
      expect(readCell(t, 100).kind, t).toBe('bad');
    }
  });
});

describe('what is already saved', () => {
  it('shows nothing, A, E or the number without trailing zeros', () => {
    expect(recorded(row(1))).toBe('');
    expect(recorded(row(1, { mark_id: 'm', is_absent: true }))).toBe('A');
    expect(recorded(row(1, { mark_id: 'm', is_exempt: true }))).toBe('E');
    expect(recorded(row(1, { mark_id: 'm', marks_obtained: '18.00' }))).toBe('18');
    expect(recorded(row(1, { mark_id: 'm', marks_obtained: '17.50' }))).toBe('17.5');
  });
});

describe('what goes to the server', () => {
  it('sends only cells that changed', () => {
    const saved = [row(1, { mark_id: 'm', marks_obtained: '18.00' }),
      row(2, { mark_id: 'm', is_absent: true }), row(3)];
    const out = changes(saved, { e1: '18.0', e2: 'a', e3: '' }, 20);
    expect(out).toEqual({ send: [], problems: [] });
  });
  it('sends a mark, an absence and an exemption in their own shapes', () => {
    const out = changes(rows, { e1: '12', e2: 'A', e3: 'e' }, 20);
    expect(out.send).toEqual([
      { enrollmentId: 'e1', marks: 12 },
      { enrollmentId: 'e2', absent: true },
      { enrollmentId: 'e3', exempt: true },
    ]);
    expect(out.problems).toEqual([]);
  });
  it('sends a changed mark and a mark turned into an absence', () => {
    const saved = [row(1, { mark_id: 'm', marks_obtained: '18.00' }),
      row(2, { mark_id: 'm', marks_obtained: '5.00' })];
    expect(changes(saved, { e1: '19', e2: 'A' }, 20).send).toEqual([
      { enrollmentId: 'e1', marks: 19 }, { enrollmentId: 'e2', absent: true }]);
  });
  it('holds back a bad cell and names the learner', () => {
    const out = changes(rows, { e1: '25', e2: '10' }, 20);
    expect(out.send).toEqual([{ enrollmentId: 'e2', marks: 10 }]);
    expect(out.problems).toHaveLength(1);
    expect(out.problems[0]!.enrollmentId).toBe('e1');
  });
  it('does not let a saved mark be emptied silently', () => {
    const saved = [row(1, { mark_id: 'm', marks_obtained: '18.00' })];
    const out = changes(saved, { e1: ' ' }, 20);
    expect(out.send).toEqual([]);
    expect(out.problems[0]!.why).toContain('cannot be emptied');
  });
  it('a saved mark above a lowered maximum is not a change', () => {
    const saved = [row(1, { mark_id: 'm', marks_obtained: '18.00' })];
    expect(changes(saved, {}, 10)).toEqual({ send: [], problems: [] });
  });
  it('splits a long list into requests of the size the server takes', () => {
    const items = Array.from({ length: 401 }, (_, i) => i);
    expect(batches(items).map((b) => b.length)).toEqual([200, 200, 1]);
    expect(batches([])).toEqual([]);
    expect(batches([1, 2, 3], 2)).toEqual([[1, 2], [3]]);
  });
});

describe('pasting from a spreadsheet', () => {
  it('lays one column down from the cell pasted into', () => {
    const out = paste(rows, 1, '12\r\n A \r\n');
    expect(out).toEqual({ entry: { e2: '12', e3: 'A' }, unmatched: [], spare: 0 });
  });
  it('reads lines ended the old Mac way', () => {
    expect(paste(rows, 0, '4\r5').entry).toEqual({ e1: '4', e2: '5' });
  });
  it('counts lines that ran off the end of the class', () => {
    const out = paste(rows, 2, '1\n2\n3');
    expect(out.entry).toEqual({ e3: '1' });
    expect(out.spare).toBe(2);
  });
  it('keeps a blank line in the middle as a blank cell', () => {
    expect(paste(rows, 0, '5\n\n7').entry).toEqual({ e1: '5', e2: '', e3: '7' });
  });
  it('matches two columns by roll number whatever the order', () => {
    const out = paste(rows, 0, '3\t15\n1\t9');
    expect(out.entry).toEqual({ e3: '15', e1: '9' });
  });
  it('matches by admission number, takes the last column, reports strangers', () => {
    const out = paste(rows, 0, 'Adm No\tName\tMarks\n\t \t\nadm-2\tChild\t14\nADM-9\tX\t3\n');
    expect(out.entry).toEqual({ e2: '14' });
    expect(out.unmatched).toEqual(['Adm No', 'ADM-9']);
  });
  it('prefers the admission number when a roll number reads the same', () => {
    const odd = [row(1, { admission_no: '2' }), row(2, { admission_no: 'X' })];
    expect(paste(odd, 0, '2\t11').entry).toEqual({ e1: '11' });
  });
  it('does not match an empty roll number', () => {
    const odd = [row(1, { roll_no: null }), row(2, { roll_no: ' ' })];
    const out = paste(odd, 0, '\t11\n1\t4');
    expect(out.entry).toEqual({});
    expect(out.unmatched).toEqual(['', '1']);
  });
});

describe('how the class did', () => {
  it('counts each kind and leaves absences out of the average', () => {
    const saved = [row(1, { mark_id: 'm', marks_obtained: '10.00' }), row(2), row(3), row(4), row(5)];
    const s = summarise(saved, { e2: '15', e3: 'A', e4: 'E', e5: '99' }, 20);
    expect(s).toEqual({ learners: 5, marked: 2, absent: 1, exempt: 1, pending: 0, bad: 1,
      average: 12.5, highest: 15, lowest: 10 });
  });
  it('has no average before anybody is marked', () => {
    const s = summarise(rows, { e1: 'A' }, 20);
    expect(s.pending).toBe(2);
    expect([s.average, s.highest, s.lowest]).toEqual([null, null, null]);
  });
  it('rounds the average to one decimal and counts a zero as a mark', () => {
    const s = summarise(rows, { e1: '0', e2: '10', e3: '10' }, 20);
    expect(s.average).toBe(6.7);
    expect(s.lowest).toBe(0);
    expect(s.highest).toBe(10);
  });
  it('gives the share of the paper', () => {
    expect(percent(15, 20)).toBe(75);
    expect(percent(1, 3)).toBe(33);
    expect(percent(5, 0)).toBeNull();
  });
});

describe('moving and refusals', () => {
  it('moves down on Enter and ArrowDown, up on ArrowUp, and stops at the ends', () => {
    expect(nextRow(0, 'Enter', 3)).toBe(1);
    expect(nextRow(1, 'ArrowDown', 3)).toBe(2);
    expect(nextRow(2, 'Enter', 3)).toBe(2);
    expect(nextRow(1, 'ArrowUp', 3)).toBe(0);
    expect(nextRow(0, 'ArrowUp', 3)).toBe(0);
    expect(nextRow(1, 'Tab', 3)).toBe(1);
    expect(nextRow(0, 'Enter', 0)).toBe(0);
  });
  it('puts a refusal in plain words', () => {
    expect(refusal('exceeds_max_marks')).toBe('More than the paper is out of.');
    expect(refusal('assessment_locked')).toContain('correction');
    expect(refusal('unknown_enrollment')).toContain('no longer in the class');
    expect(refusal('duplicate')).toContain('Already saved');
    expect(refusal('rejected')).toBe('Not accepted.');
    expect(refusal('the mark is not a number')).toBe('the mark is not a number');
    expect(refusal(undefined)).toBe('Not accepted.');
    expect(refusal('  ')).toBe('Not accepted.');
  });
});
