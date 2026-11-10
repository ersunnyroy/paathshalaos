'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Icon, Avatar } from './ui';
import { useApiQuery } from '@/lib/query';
import { matchScreens, type NavGroup } from '@/lib/nav';

interface Learner {
  id: string; admission_no: string;
  given_name: string; family_name: string | null;
  section_name: string | null; class_name: string | null;
}

type Row =
  | { kind: 'screen'; key: string; href: string; label: string; icon: keyof typeof Icon }
  | { kind: 'learner'; key: string; href: string; label: string; sub: string };

/**
 * The command palette: Ctrl/Cmd+K, type, Enter.
 *
 * Two kinds of result. Screens come from the navigation this person was
 * already shown, so the palette can never be a way round the role filter.
 * Learners come from `/v1/students?q=`, the same endpoint the roster uses —
 * which means the same row-level security: a teacher finds their own
 * sections, a guardian their own children, and nobody finds anyone else.
 */
export function Palette({ open, onClose, groups }: {
  open: boolean; onClose: () => void; groups: NavGroup[];
}) {
  const router = useRouter();
  const [typed, setTyped] = useState('');
  const [term, setTerm] = useState('');
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  const canSeeLearners = groups.some((g) => g.items.some((i) => i.href === '/students'));

  useEffect(() => {
    if (!open) return;
    setTyped(''); setTerm(''); setActive(0);
    // After paint, or the focus lands before the input exists.
    const handle = setTimeout(() => input.current?.focus(), 0);
    return () => clearTimeout(handle);
  }, [open]);

  useEffect(() => {
    // Debounced: a request per keystroke turns a search box into a load test.
    const handle = setTimeout(() => setTerm(typed.trim()), 200);
    return () => clearTimeout(handle);
  }, [typed]);

  const learners = useApiQuery<Learner[]>(
    open && canSeeLearners && term.length >= 2
      ? `/v1/students?q=${encodeURIComponent(term)}` : null);

  const rows = useMemo<Row[]>(() => {
    const screens: Row[] = matchScreens(groups, typed).map((i) => ({
      kind: 'screen', key: `s:${i.href}`, href: i.href, label: i.label, icon: i.icon,
    }));
    const people: Row[] = (learners.data ?? []).slice(0, 8).map((s) => {
      const name = [s.given_name, s.family_name].filter(Boolean).join(' ');
      const where = s.class_name ? `${s.class_name} ${s.section_name ?? ''}`.trim() : 'Not enrolled';
      return {
        kind: 'learner', key: `l:${s.id}`, label: name, sub: `${s.admission_no} · ${where}`,
        href: `/students/${s.id}`,
      };
    });
    return [...people, ...screens];
  }, [groups, typed, learners.data]);

  useEffect(() => { setActive(0); }, [rows.length, typed]);

  if (!open) return null;

  function go(row: Row | undefined) {
    if (!row) return;
    onClose();
    router.push(row.href);
  }

  function onKey(e: React.KeyboardEvent) {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, rows.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); go(rows[active]); }
  }

  const searching = canSeeLearners && term.length >= 2 && learners.isFetching;
  const firstScreen = rows.findIndex((r) => r.kind === 'screen');

  return (
    <div className="palette-backdrop" onMouseDown={onClose}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Search"
           onMouseDown={(e) => e.stopPropagation()} onKeyDown={onKey}>
        <div className="palette-input">
          <Icon.search />
          <input ref={input} value={typed} onChange={(e) => setTyped(e.target.value)}
                 placeholder={canSeeLearners ? 'Search learners, or jump to a screen' : 'Jump to a screen'}
                 aria-label="Search" role="combobox" aria-expanded="true"
                 aria-controls="palette-list"
                 aria-activedescendant={rows[active] ? `palette-${active}` : undefined} />
          <kbd>Esc</kbd>
        </div>

        <ul className="palette-list" id="palette-list" role="listbox">
          {rows.map((row, index) => (
            <li key={row.key} role="presentation">
              {index === 0 && row.kind === 'learner' ? <h4>Learners</h4> : null}
              {index === firstScreen ? <h4>Screens</h4> : null}
              <button type="button" id={`palette-${index}`} role="option"
                      aria-selected={index === active}
                      onMouseEnter={() => setActive(index)} onClick={() => go(row)}>
                {row.kind === 'learner'
                  ? <Avatar name={row.label} />
                  : (() => { const Glyph = Icon[row.icon]; return <span className="glyph"><Glyph /></span>; })()}
                <span className="nm">{row.label}</span>
                {row.kind === 'learner' ? <span className="sub">{row.sub}</span> : null}
              </button>
            </li>
          ))}
          {rows.length === 0 && !searching
            ? <li className="palette-empty">Nothing matches “{typed.trim()}”.</li> : null}
          {searching ? <li className="palette-empty">Searching learners…</li> : null}
        </ul>

        <div className="palette-foot">
          <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
          <span><kbd>Enter</kbd> open</span>
        </div>
      </div>
    </div>
  );
}
