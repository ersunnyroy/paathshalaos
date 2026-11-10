'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useApiQuery } from '@/lib/query';
import { localIsoDate } from '@/lib/dates';
import { attentionItems, attentionBadge, type TodayCounts } from '@/lib/attention';

/**
 * The bell: what is waiting on this person, on every screen.
 *
 * It asks once a minute, and again when the tab comes back into view. It is
 * silent when there is nothing — no "0", no "all caught up" — because a bell
 * that always has something to say is one nobody looks at.
 *
 * `allowed` is the set of screens this person is shown (null for all), so an
 * item never points somewhere they cannot act.
 */
export function Bell({ allowed }: { allowed: ReadonlySet<string> | null }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);
  const counts = useApiQuery<TodayCounts>(`/v1/dashboard/today?on=${localIsoDate()}`, {
    refetchInterval: 60_000,
  });

  useEffect(() => {
    if (!open) return;
    function away(event: MouseEvent | KeyboardEvent) {
      if (event instanceof KeyboardEvent ? event.key === 'Escape'
        : !anchor.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', away);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', away);
    };
  }, [open]);

  const items = attentionItems(counts.data, allowed);
  const badge = attentionBadge(items);

  return (
    <div className="menu-anchor" ref={anchor}>
      <button type="button" className="bell" aria-haspopup="true" aria-expanded={open}
              aria-label={badge ? `${badge} things need attention` : 'Nothing needs attention'}
              onClick={() => setOpen((o) => !o)}>
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
             strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M6 9.5a6 6 0 0 1 12 0c0 4.5 1.8 6 1.8 6H4.2S6 14 6 9.5Z" />
          <path d="M10 19a2.2 2.2 0 0 0 4 0" />
        </svg>
        {badge ? <span className="badge">{badge}</span> : null}
      </button>
      {open ? (
        <div className="menu wide" role="menu">
          {items.length === 0
            ? <span className="sub" style={{ padding: '4px 2px' }}>Nothing is waiting on you.</span>
            : items.map((item) => (
              <Link key={item.key} href={item.href} role="menuitem" onClick={() => setOpen(false)}>
                {item.label}
              </Link>
            ))}
        </div>
      ) : null}
    </div>
  );
}
