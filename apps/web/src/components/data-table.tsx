'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Empty, Icon, SkeletonRows } from './ui';
import {
  defaultView, restoreView, visibleColumns, nextSort, filterRows, sortRows, toCsv, exportName,
  type Column, type View,
} from '@/lib/table';
import { localIsoDate } from '@/lib/dates';

/**
 * A column as a screen draws it: the text rules from `lib/table`, plus how the
 * cell looks. `text` is still what is filtered, sorted and exported, so what
 * somebody finds and what they download always match what they see.
 */
export interface TableColumn<T> extends Column<T> {
  render?: (row: T) => ReactNode;
}

/**
 * The list every screen should have been using (M40).
 *
 * Filter, sort by clicking a heading, choose columns, export what is on
 * screen. The choice of columns and sort is remembered per table in this
 * browser — a convenience for one person on one machine, nothing more, and the
 * page works the same when storage is blocked.
 *
 * It sorts and filters the rows it was given. A list longer than the API
 * returns in one page needs the server to do both; nothing here pretends
 * otherwise, and `truncatedAt` says so on the screen when it applies.
 */
export function DataTable<T>({ id, title, columns, rows, rowKey, empty, truncatedAt, toolbar }: {
  /** Names the saved view. Change it and everybody's saved view is forgotten. */
  id: string;
  title: string;
  columns: TableColumn<T>[];
  rows: T[] | null;
  rowKey: (row: T) => string;
  empty?: ReactNode;
  /** The most rows the API returns for this list, if it has a ceiling. */
  truncatedAt?: number;
  toolbar?: ReactNode;
}) {
  const storageKey = `paathshala.view.${id}`;
  const [view, setView] = useState<View>(() => defaultView(columns));
  const [typed, setTyped] = useState('');
  const [choosing, setChoosing] = useState(false);

  useEffect(() => {
    // After mount, so the first render matches the server's and there is no
    // hydration mismatch for somebody with a saved view.
    try {
      const stored = localStorage.getItem(storageKey);
      if (stored) setView(restoreView(columns, JSON.parse(stored)));
    } catch { /* blocked or corrupt storage: the default view is fine */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey]);

  function change(next: View) {
    setView(next);
    try { localStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* fine */ }
  }

  // `visibleColumns` is typed on the text-only column; these are the same
  // objects, so the drawing half comes back with them.
  const shown = visibleColumns(columns, view) as TableColumn<T>[];
  const visible = useMemo(
    () => (rows ? sortRows(filterRows(rows, columns, typed), columns, view.sort) : null),
    [rows, columns, typed, view.sort]);

  function download() {
    if (!visible) return;
    const today = localIsoDate();
    const blob = new Blob([toCsv(shown, visible)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = exportName(title, today);
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  const atCeiling = truncatedAt !== undefined && rows !== null && rows.length >= truncatedAt;

  return (
    <section className="panel">
      <header>
        <div style={{ minWidth: 0 }}>
          <h2>{title}</h2>
          <span className="hint">
            {visible === null ? 'Loading…'
              : typed.trim() && rows ? `${visible.length} of ${rows.length} shown`
              : `${visible.length} ${visible.length === 1 ? 'row' : 'rows'}`}
          </span>
        </div>
        <div className="row">
          {toolbar}
          <label className="search">
            <Icon.search />
            <input value={typed} onChange={(e) => setTyped(e.target.value)}
                   placeholder="Filter these rows" aria-label={`Filter ${title}`} />
          </label>
          <div className="menu-anchor">
            <button type="button" onClick={() => setChoosing((open) => !open)}
                    aria-expanded={choosing} aria-haspopup="true">Columns</button>
            {choosing ? (
              <div className="menu" role="group" aria-label="Columns to show">
                {columns.filter((c) => !c.action).map((c) => (
                  <label key={c.key} className="check">
                    <input type="checkbox" disabled={c.required}
                           checked={c.required || !view.hidden.includes(c.key)}
                           onChange={(e) => change({
                             ...view,
                             hidden: e.target.checked
                               ? view.hidden.filter((k) => k !== c.key)
                               : [...view.hidden, c.key],
                           })} />
                    {c.label}
                  </label>
                ))}
                <button type="button" className="ghost"
                        onClick={() => change(defaultView(columns))}>Reset</button>
              </div>
            ) : null}
          </div>
          <button type="button" onClick={download} disabled={!visible || visible.length === 0}>
            <Icon.down /><span>Export</span>
          </button>
        </div>
      </header>

      {atCeiling ? (
        <div className="note" style={{ margin: '0 16px 12px' }}>
          Showing the first {truncatedAt} rows. Narrow the search above the table to see the rest.
        </div>
      ) : null}

      {visible !== null && visible.length === 0 ? (
        typed.trim() && rows && rows.length > 0
          ? <Empty title="Nothing here matches that filter" />
          : (empty ?? <Empty title="Nothing to show yet" />)
      ) : (
        <div className="scroll">
          <table>
            <thead>
              <tr>
                {shown.map((c) => {
                  const sorted = view.sort?.key === c.key ? view.sort.dir : null;
                  return (
                    <th key={c.key} className={c.align === 'right' ? 'n' : undefined}
                        aria-sort={c.action ? undefined : sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : 'none'}>
                      {c.action ? c.label : (
                        <button type="button" className="th-sort"
                                onClick={() => change({ ...view, sort: nextSort(view.sort, c.key) })}>
                          {c.label}
                          <span aria-hidden="true">{sorted === 'asc' ? ' ▲' : sorted === 'desc' ? ' ▼' : ''}</span>
                        </button>
                      )}
                    </th>
                  );
                })}
              </tr>
            </thead>
            {visible === null ? <SkeletonRows rows={8} cols={shown.length} /> : (
              <tbody>
                {visible.map((row) => (
                  <tr key={rowKey(row)}>
                    {shown.map((c) => (
                      <td key={c.key} className={c.align === 'right' ? 'n' : undefined}>
                        {c.render ? c.render(row) : c.text(row) || '—'}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            )}
          </table>
        </div>
      )}
    </section>
  );
}
