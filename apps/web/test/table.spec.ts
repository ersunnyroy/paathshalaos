import { describe, it, expect } from 'vitest';
import {
  defaultView, restoreView, visibleColumns, nextSort, filterRows, sortRows,
  csvCell, toCsv, exportName, type Column,
} from '../src/lib/table.ts';

interface Row { name: string; adm: string; cls: string; owed: string }
const columns: Column<Row>[] = [
  { key: 'name', label: 'Learner', text: (r) => r.name, required: true },
  { key: 'adm', label: 'Admission no.', text: (r) => r.adm, optional: true },
  { key: 'cls', label: 'Class', text: (r) => r.cls },
  { key: 'owed', label: 'Owed', text: (r) => r.owed, align: 'right', numeric: true },
];
const rows: Row[] = [
  { name: 'Ishaan Sharma', adm: 'DEMO-0004', cls: 'Class 10', owed: '₹33,000.00' },
  { name: 'Anaya Rao', adm: 'DEMO-0005', cls: 'Class 9', owed: '₹4,500.00' },
  { name: 'Vihaan Banerjee', adm: 'DEMO-0006', cls: 'Class 9', owed: '' },
  { name: 'anaya nair', adm: 'DEMO-0017', cls: 'Class 9', owed: '₹0.00' },
];
const names = (list: Row[]) => list.map((r) => r.name);

describe('which columns are shown', () => {
  it('hides the optional ones until asked', () => {
    expect(visibleColumns(columns, defaultView(columns)).map((c) => c.key)).toEqual(['name', 'cls', 'owed']);
  });
  it('never hides a required column, whatever the view says', () => {
    const view = { hidden: ['name', 'cls'], sort: null };
    expect(visibleColumns(columns, view).map((c) => c.key)).toEqual(['name', 'adm', 'owed']);
  });
});

describe('a view read back from storage', () => {
  it('is used when it is sound', () => {
    expect(restoreView(columns, { hidden: ['cls'], sort: { key: 'owed', dir: 'desc' } }))
      .toEqual({ hidden: ['cls'], sort: { key: 'owed', dir: 'desc' } });
  });
  it('drops columns that no longer exist and required ones it claims to hide', () => {
    expect(restoreView(columns, { hidden: ['gone', 'name', 'cls', 'cls', 7], sort: null }).hidden).toEqual(['cls']);
  });
  it('drops a sort on a column that no longer exists, or in no direction', () => {
    expect(restoreView(columns, { hidden: [], sort: { key: 'gone', dir: 'asc' } }).sort).toBeNull();
    expect(restoreView(columns, { hidden: [], sort: { key: 'owed', dir: 'sideways' } }).sort).toBeNull();
  });
  it('falls back to the default for anything that is not a view', () => {
    for (const junk of [null, undefined, 'x', 42, []]) {
      expect(restoreView(columns, junk).sort).toBeNull();
    }
    expect(restoreView(columns, null)).toEqual(defaultView(columns));
    expect(restoreView(columns, { hidden: 'all' })).toEqual(defaultView(columns));
  });
});

describe('clicking a heading', () => {
  it('goes ascending, descending, then back to the original order', () => {
    const first = nextSort(null, 'owed');
    expect(first).toEqual({ key: 'owed', dir: 'asc' });
    const second = nextSort(first, 'owed');
    expect(second).toEqual({ key: 'owed', dir: 'desc' });
    expect(nextSort(second, 'owed')).toBeNull();
  });
  it('starts again on a different column', () => {
    expect(nextSort({ key: 'owed', dir: 'desc' }, 'name')).toEqual({ key: 'name', dir: 'asc' });
  });
});

describe('filtering', () => {
  it('needs every word, in any column, in any case', () => {
    expect(names(filterRows(rows, columns, 'ANAYA 9'))).toEqual(['Anaya Rao', 'anaya nair']);
    expect(names(filterRows(rows, columns, 'anaya rao'))).toEqual(['Anaya Rao']);
  });
  it('finds a row by a column that is hidden', () => {
    expect(names(filterRows(rows, columns, 'demo-0006'))).toEqual(['Vihaan Banerjee']);
  });
  it('does not join the end of one cell to the start of the next', () => {
    // "Sharma" then "DEMO-0004": "sharmademo" is in neither.
    expect(filterRows(rows, columns, 'sharmademo')).toEqual([]);
  });
  it('returns everything for an empty box, and treats the term as text', () => {
    expect(filterRows(rows, columns, '   ')).toHaveLength(4);
    expect(filterRows(rows, columns, '.*')).toEqual([]);
  });
});

describe('sorting', () => {
  it('reads text the way a person does', () => {
    expect(names(sortRows(rows, columns, { key: 'cls', dir: 'asc' }))[3]).toBe('Ishaan Sharma');   // 9, 9, 9, 10
    expect(names(sortRows(rows, columns, { key: 'name', dir: 'asc' })))
      .toEqual(['anaya nair', 'Anaya Rao', 'Ishaan Sharma', 'Vihaan Banerjee']);
  });
  it('sorts money as money', () => {
    // As text, "₹33,000.00" sorts before "₹4,500.00".
    expect(names(sortRows(rows, columns, { key: 'owed', dir: 'desc' })).slice(0, 3))
      .toEqual(['Ishaan Sharma', 'Anaya Rao', 'anaya nair']);
  });
  it('puts blanks last in both directions', () => {
    expect(names(sortRows(rows, columns, { key: 'owed', dir: 'asc' })).at(-1)).toBe('Vihaan Banerjee');
    expect(names(sortRows(rows, columns, { key: 'owed', dir: 'desc' })).at(-1)).toBe('Vihaan Banerjee');
  });
  it('keeps the arriving order for rows that tie', () => {
    expect(names(sortRows(rows, columns, { key: 'cls', dir: 'asc' })).slice(0, 3))
      .toEqual(['Anaya Rao', 'Vihaan Banerjee', 'anaya nair']);
    expect(names(sortRows(rows, columns, { key: 'cls', dir: 'desc' })).slice(1))
      .toEqual(['Anaya Rao', 'Vihaan Banerjee', 'anaya nair']);
  });
  it('leaves the rows alone with no sort, and never changes the list it was given', () => {
    const before = names(rows);
    expect(names(sortRows(rows, columns, null))).toEqual(before);
    sortRows(rows, columns, { key: 'name', dir: 'desc' });
    expect(names(rows)).toEqual(before);
  });
});

describe('exporting', () => {
  it('quotes a cell that would break the row', () => {
    expect(csvCell('Rao, Anaya')).toBe('"Rao, Anaya"');
    expect(csvCell('She said "hi"')).toBe('"She said ""hi"""');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
    expect(csvCell('plain')).toBe('plain');
  });

  it('stops a spreadsheet running a cell as a formula', () => {
    expect(csvCell('=HYPERLINK("http://evil","x")')).toBe(`"'=HYPERLINK(""http://evil"",""x"")"`);
    expect(csvCell('+91 80 4000 1234')).toBe("'+91 80 4000 1234");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell('-250.00')).toBe("'-250.00");
    expect(csvCell('\t=1+1')).toBe("'\t=1+1");
  });

  it('leaves an ordinary amount and an ordinary name alone', () => {
    expect(csvCell('₹33,000.00')).toBe('"₹33,000.00"');
    expect(csvCell('Anaya Rao')).toBe('Anaya Rao');
    expect(csvCell('A-1')).toBe('A-1');           // a hyphen inside is not a formula
  });

  it('writes a header, one line per row, and what Excel needs to read ₹', () => {
    const csv = toCsv(columns.slice(0, 2), rows.slice(0, 2));
    expect(csv.charCodeAt(0)).toBe(0xFEFF);
    expect(csv.slice(1)).toBe('Learner,Admission no.\r\nIshaan Sharma,DEMO-0004\r\nAnaya Rao,DEMO-0005\r\n');
  });

  it('writes just the header for no rows', () => {
    expect(toCsv(columns.slice(0, 1), []).slice(1)).toBe('Learner\r\n');
  });

  it('names the file after the list and the day', () => {
    expect(exportName('Learners', '2026-11-10')).toBe('Learners 2026-11-10.csv');
    expect(exportName('Fees: Class 9/A', '2026-11-10')).toBe('Fees Class 9A 2026-11-10.csv');
    expect(exportName('छात्र सूची', '2026-11-10')).toBe('छात्र सूची 2026-11-10.csv');
    expect(exportName('///', '2026-11-10')).toBe('Export 2026-11-10.csv');
  });
});
