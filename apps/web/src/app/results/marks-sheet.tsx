'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Panel, Pill, SkeletonRows } from '@/components/ui';
import { apiPost } from '@/lib/api';
import {
  batches, changes, nextRow, paste, percent, readCell, recorded, refusal, summarise,
  type Entry, type MarkToSend, type SheetRow,
} from '@/lib/marks';

interface Outcome { enrollmentId: string; outcome: string; reason?: string }

/**
 * A class's marks for one paper, entered the way a register is filled in:
 * top to bottom with Enter, or pasted from a spreadsheet in one go.
 */
export function MarksSheet({ exam, rows, onSaved, onClose }: {
  exam: { id: string; name: string; status: string; max_marks: string };
  rows: SheetRow[] | null;
  onSaved: () => Promise<void>;
  onClose: () => void;
}) {
  const max = Number(exam.max_marks);
  const open = exam.status === 'open';
  const [entry, setEntry] = useState<Entry>({});
  const [refused, setRefused] = useState<Record<string, string>>({});
  const [note, setNote] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const cells = useRef<Array<HTMLInputElement | null>>([]);

  const list = rows ?? [];
  const pending = useMemo(() => changes(list, entry, max), [list, entry, max]);
  const stats = useMemo(() => summarise(list, entry, max), [list, entry, max]);
  const dirty = pending.send.length + pending.problems.length > 0;
  const why = useMemo(() => {
    const m: Record<string, string> = { ...refused };
    for (const p of pending.problems) m[p.enrollmentId] = p.why;
    return m;
  }, [pending, refused]);

  // Thirty typed marks lost to a stray refresh is an evening's work lost.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  function type(id: string, value: string) {
    setEntry((m) => ({ ...m, [id]: value }));
    setRefused((m) => {
      if (!(id in m)) return m;
      const { [id]: _gone, ...rest } = m;
      return rest;
    });
  }

  function onPaste(index: number, e: React.ClipboardEvent<HTMLInputElement>) {
    const text = e.clipboardData.getData('text');
    if (!/[\n\r\t]/.test(text)) return; // one value: let the box take it
    e.preventDefault();
    const out = paste(list, index, text);
    setEntry((m) => ({ ...m, ...out.entry }));
    const filled = Object.keys(out.entry).length;
    const extra = [
      out.spare > 0 ? `${out.spare} more than the class has places for` : '',
      out.unmatched.length > 0
        ? `${out.unmatched.length} not matched to a learner (${out.unmatched.slice(0, 3).map((u) => u || 'blank').join(', ')}${out.unmatched.length > 3 ? '…' : ''})`
        : '',
    ].filter(Boolean).join('; ');
    setNote({ tone: extra ? 'bad' : 'ok',
      text: `Pasted ${filled}. ${extra ? `Left out: ${extra}. ` : ''}Check, then save.` });
  }

  async function save() {
    if (pending.send.length === 0) {
      setNote({ tone: 'bad', text: pending.problems.length > 0
        ? 'Fix the cells marked in red first.' : 'Nothing has changed.' });
      return;
    }
    setBusy(true); setNote(null);
    try {
      const outcomes: Outcome[] = [];
      for (const part of batches<MarkToSend>(pending.send)) {
        const out = await apiPost<{ outcomes: Outcome[] }>(
          `/v1/assessments/${exam.id}/marks`, { marks: part });
        outcomes.push(...out.outcomes);
      }
      const bad = outcomes.filter((o) => o.outcome === 'rejected');
      const badIds = new Set(bad.map((o) => o.enrollmentId));
      const held = new Set(pending.problems.map((p) => p.enrollmentId));
      // What saved leaves the typed layer; what did not stays for fixing.
      setEntry((m) => Object.fromEntries(
        Object.entries(m).filter(([id]) => badIds.has(id) || held.has(id))));
      setRefused(Object.fromEntries(bad.map((o) => [o.enrollmentId, refusal(o.reason)])));
      const left = bad.length + pending.problems.length;
      setNote({ tone: left > 0 ? 'bad' : 'ok',
        text: `Saved ${outcomes.length - bad.length}.`
          + (left > 0 ? ` ${left} still need fixing — marked in red.` : '') });
      await onSaved();
    } catch (e) {
      setNote({ tone: 'bad', text: (e as Error).message });
    } finally { setBusy(false); }
  }

  function onKey(index: number, e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key !== 'Enter' && e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const to = nextRow(index, e.key, list.length);
    cells.current[to]?.focus();
    cells.current[to]?.select();
  }

  return (
    <Panel title={`Marks — ${exam.name}`}
           hint={`Out of ${max}. Type a mark, A for absent or E for exempt; Enter moves down.
                  Paste a column from a spreadsheet, or two columns (roll or admission
                  number, then mark). An absence is not a zero.`}
           actions={
             <>
               <button disabled={busy || !open || !dirty} onClick={() => void save()}>
                 {busy ? 'Saving…'
                   : pending.send.length > 0 ? `Save ${pending.send.length}` : 'Save marks'}
               </button>{' '}
               <button className="ghost" onClick={onClose}>
                 {dirty ? 'Discard and close' : 'Close'}
               </button>
             </>
           }>
      {!open ? (
        <div className="note">
          This paper is {exam.status}. Marks can be typed only while it is open.
        </div>
      ) : null}
      {note ? <div className={`note ${note.tone}`} role="status">{note.text}</div> : null}
      {rows !== null && rows.length > 0 ? (
        <div className="marks-summary" aria-label="How the class did">
          <span><strong>{stats.marked}</strong> marked</span>
          <span><strong>{stats.absent}</strong> absent</span>
          {stats.exempt > 0 ? <span><strong>{stats.exempt}</strong> exempt</span> : null}
          <span className={stats.pending > 0 ? 'warn' : undefined}>
            <strong>{stats.pending}</strong> to go
          </span>
          {stats.bad > 0
            ? <span className="bad"><strong>{stats.bad}</strong> to fix</span> : null}
          <span>Average <strong>{stats.average ?? '—'}</strong></span>
          <span>Highest <strong>{stats.highest ?? '—'}</strong></span>
          <span>Lowest <strong>{stats.lowest ?? '—'}</strong></span>
        </div>
      ) : null}
      <table>
        <thead>
          <tr>
            <th className="n">Roll</th><th>Learner</th>
            <th className="n">Mark</th><th className="n">%</th><th>Saved</th>
          </tr>
        </thead>
        {rows === null ? <SkeletonRows rows={5} cols={5} /> : (
          <tbody>
            {rows.map((r, i) => {
              const text = entry[r.enrollment_id] ?? recorded(r);
              const cell = readCell(text, max);
              const problem = why[r.enrollment_id];
              const name = `${r.given_name}${r.family_name ? ` ${r.family_name}` : ''}`;
              return (
                <tr key={r.enrollment_id}>
                  <td className="n">{r.roll_no ?? '—'}</td>
                  <td>
                    <strong>{name}</strong>
                    <span className="sub" style={{ display: 'block' }}>{r.admission_no}</span>
                  </td>
                  <td className="n">
                    <input type="text" inputMode="decimal" autoComplete="off"
                           className={`mark-cell${problem ? ' bad' : ''}`}
                           ref={(el) => { cells.current[i] = el; }}
                           aria-label={`Mark for ${name}`}
                           aria-invalid={problem ? true : undefined}
                           disabled={!open || busy}
                           value={text}
                           onChange={(e) => type(r.enrollment_id, e.target.value)}
                           onKeyDown={(e) => onKey(i, e)}
                           onPaste={(e) => onPaste(i, e)} />
                    {problem
                      ? <span className="sub mark-why" role="alert">{problem}</span> : null}
                  </td>
                  <td className="n">
                    {cell.kind === 'mark' ? `${percent(cell.value, max) ?? '—'}` : '—'}
                  </td>
                  <td>
                    {r.mark_id === null ? <span className="sub">Nothing yet</span>
                      : r.is_absent ? <Pill tone="warning">absent</Pill>
                      : r.is_exempt ? <Pill>exempt</Pill>
                      : <Pill tone="good">{Number(r.marks_obtained)}</Pill>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        )}
      </table>
    </Panel>
  );
}
