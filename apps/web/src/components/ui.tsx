/**
 * The small pieces every screen is made of.
 *
 * They exist so the density, the number formatting and the empty states are
 * decided once. A table that sets its own padding drifts from the one next to
 * it within a week, and "compact" stops being a property of the product and
 * becomes a property of whoever wrote that page.
 */
import type { ReactNode } from 'react';

/* ------------------------------------------------------------------ icons */
/* Inline, 1.5px stroke, currentColor — an icon font or an image would be one
   more thing to load before the first screen paints. */

type IconProps = { className?: string };
const base = {
  viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
  strokeWidth: 1.6, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const,
  // An intrinsic size on the element itself. Relying on a CSS rule per context
  // (`button svg`, `.nav a svg`) means the first icon used somewhere new renders
  // at its natural 24px — or, inside a flex column, stretches to fill the box.
  width: 16, height: 16,
};

export const Icon = {
  dashboard: (p: IconProps) => (
    <svg {...base} {...p}><rect x="3" y="3" width="7" height="9" rx="1.5" /><rect x="14" y="3" width="7" height="5" rx="1.5" /><rect x="14" y="12" width="7" height="9" rx="1.5" /><rect x="3" y="16" width="7" height="5" rx="1.5" /></svg>
  ),
  learners: (p: IconProps) => (
    <svg {...base} {...p}><path d="M16 19a4 4 0 0 0-8 0" /><circle cx="12" cy="9" r="3.2" /><path d="M20.5 18.5a3.4 3.4 0 0 0-3-2.3M3.5 18.5a3.4 3.4 0 0 1 3-2.3" /></svg>
  ),
  attendance: (p: IconProps) => (
    <svg {...base} {...p}><rect x="3" y="5" width="18" height="16" rx="2.5" /><path d="M8 3v4M16 3v4M3 10h18M9 15.5l2 2 4-4" /></svg>
  ),
  fees: (p: IconProps) => (
    <svg {...base} {...p}><rect x="2.5" y="5.5" width="19" height="13" rx="2.5" /><path d="M2.5 10h19M6 15h4" /></svg>
  ),
  search: (p: IconProps) => (
    <svg {...base} {...p}><circle cx="11" cy="11" r="6.5" /><path d="M20 20l-3.6-3.6" /></svg>
  ),
  sun: (p: IconProps) => (
    <svg {...base} {...p}><circle cx="12" cy="12" r="4" /><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.2 5.2l1.4 1.4M17.4 17.4l1.4 1.4M18.8 5.2l-1.4 1.4M6.6 17.4l-1.4 1.4" /></svg>
  ),
  moon: (p: IconProps) => (
    <svg {...base} {...p}><path d="M20 13.5A8 8 0 1 1 10.5 4a6.5 6.5 0 0 0 9.5 9.5Z" /></svg>
  ),
  out: (p: IconProps) => (
    <svg {...base} {...p}><path d="M15 4.5h3A2.5 2.5 0 0 1 20.5 7v10a2.5 2.5 0 0 1-2.5 2.5h-3M10 8l-4 4 4 4M6 12h10" /></svg>
  ),
  check: (p: IconProps) => (
    <svg {...base} {...p}><path d="M4.5 12.5l5 5 10-11" /></svg>
  ),
  chevron: (p: IconProps) => (
    <svg {...base} {...p}><path d="M8 9.5 12 5.5l4 4M8 14.5l4 4 4-4" /></svg>
  ),
  slash: (p: IconProps) => (
    <svg {...base} {...p}><path d="M14.5 4.5 9.5 19.5" /></svg>
  ),
  home: (p: IconProps) => (
    <svg {...base} {...p}><path d="M3.5 10.5 12 3.5l8.5 7M5.5 9.5v9a1.5 1.5 0 0 0 1.5 1.5h10a1.5 1.5 0 0 0 1.5-1.5v-9" /></svg>
  ),
  up: (p: IconProps) => (
    <svg {...base} {...p}><path d="M5 15.5 12 8.5l7 7" /></svg>
  ),
  help: (p: IconProps) => (
    <svg {...base} {...p}><circle cx="12" cy="12" r="8.5" /><path d="M9.6 9.5a2.5 2.5 0 1 1 3.3 2.4c-.6.2-.9.7-.9 1.3v.4" /><circle cx="12" cy="16.6" r=".9" fill="currentColor" stroke="none" /></svg>
  ),
  award: (p: IconProps) => (
    <svg {...base} {...p}><circle cx="12" cy="9" r="5.5" /><path d="M8.6 13.6 7.5 20.5l4.5-2.4 4.5 2.4-1.1-6.9" /></svg>
  ),
  send: (p: IconProps) => (
    <svg {...base} {...p}><path d="M20.5 3.5 10.5 13.5M20.5 3.5l-6.4 17-3.6-7-7-3.6Z" /></svg>
  ),
  upload: (p: IconProps) => (
    <svg {...base} {...p}><path d="M12 15.5V4M8 7.5 12 3.5l4 4M4.5 15.5v3a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-3" /></svg>
  ),
  code: (p: IconProps) => (
    <svg {...base} {...p}><path d="M9 7.5 4.5 12 9 16.5M15 7.5 19.5 12 15 16.5" /></svg>
  ),
  shield: (p: IconProps) => (
    <svg {...base} {...p}><path d="M12 3.2 19.5 6v6c0 4-3.2 7.2-7.5 8.8C7.7 19.2 4.5 16 4.5 12V6Z" /><path d="M9.2 12.2l2 2 3.6-4" /></svg>
  ),
  plug: (p: IconProps) => (
    <svg {...base} {...p}><path d="M9 3v5M15 3v5M6.5 8h11v3a5.5 5.5 0 0 1-11 0ZM12 16.5V21" /></svg>
  ),
  down: (p: IconProps) => (
    <svg {...base} {...p}><path d="M5 8.5 12 15.5l7-7" /></svg>
  ),
};

/**
 * The supplied lockup, as artwork rather than as geometry.
 *
 * Two files, not one recoloured file: the navy half of the mark disappears into
 * a dark surface, so the dark variant carries its own near-white ink. Which one
 * shows is decided in CSS by the same rules that pick the palette, because the
 * theme toggle has to beat the OS preference both ways and an <img> chosen in
 * JavaScript would flash the wrong one on first paint.
 *
 * `height` drives the box and the width follows the artwork's own ratio, so a
 * caller can never squash it.
 */
export function Lockup({ height = 28, className }: { height?: number; className?: string }) {
  const common = { alt: 'paathshalaOS', height, style: { height, width: 'auto' } };
  return (
    <span className={`lockup${className ? ` ${className}` : ''}`}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/brand/logo-800.png" className="on-light" {...common} />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/brand/logo-dark-800.png" className="on-dark" {...common} aria-hidden="true" />
    </span>
  );
}

/** The mark alone, for the places a full lockup will not fit. */
export function Mark({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <span className={`lockup${className ? ` ${className}` : ''}`}>
      {/* The mark is taller than it is wide; the height drives the box and the
          width follows, so it is never squashed into a square it is not. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/brand/mark-256.png" alt="paathshalaOS" className="on-light"
           style={{ height: size, width: 'auto' }} />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/brand/mark-dark-256.png" alt="" aria-hidden="true" className="on-dark"
           style={{ height: size, width: 'auto' }} />
    </span>
  );
}

/* ------------------------------------------------------------------ tiles */

/**
 * A stat tile: name, one line of what it means, the figure, then a sparkline.
 *
 * The description line is not decoration. "Collected" alone invites three
 * readings — this month, this year, ever — and a dashboard whose numbers have to
 * be explained in a meeting is a dashboard nobody opens between meetings.
 *
 * `trend` is signed and always stated against a named period, because "+20%" on
 * its own is not a fact.
 */
export function Tile({
  label, describe, value, exact, meter, tone, trend, trendGood = true,
  spark, sparkTone, loading,
}: {
  label: string;
  describe?: string;
  value?: string;
  /** The full figure behind a compacted value, one hover away. */
  exact?: string;
  meter?: number;
  tone?: 'good' | 'warning' | 'critical';
  /** Percentage change against the previous window of the same length. */
  trend?: number | null;
  /** Whether up is the good direction — collections yes, absences no. */
  trendGood?: boolean;
  spark?: ReactNode;
  sparkTone?: 'brand' | 'good' | 'critical';
  loading?: boolean;
}) {
  void sparkTone;
  if (loading) {
    return (
      <div className="tile">
        <div className="skel" style={{ width: '46%', height: 11 }} />
        <div className="skel" style={{ width: '70%', height: 9, marginTop: 7 }} />
        <div className="skel" style={{ width: '58%', height: 22, marginTop: 10 }} />
        <div className="skel" style={{ height: 40, marginTop: 12 }} />
      </div>
    );
  }

  const up = typeof trend === 'number' && trend > 0;
  const down = typeof trend === 'number' && trend < 0;
  const positive = up === trendGood;

  return (
    <div className="tile">
      <div className="top">
        <span className="k">{label}</span>
        {typeof trend === 'number' && trend !== 0 ? (
          <span className={`trend ${positive ? 'up' : 'down'}`}>
            {up ? <Icon.up /> : <Icon.down />}
            {Math.abs(Math.round(trend))}%
          </span>
        ) : null}
      </div>
      {describe ? <div className="d">{describe}</div> : null}
      <div className="v" {...(exact ? { title: exact } : {})}>{value}</div>
      {meter !== undefined ? (
        <div className={`meter${tone ? ` ${tone}` : ''}`}
             role="img" aria-label={`${Math.round(meter * 100)} percent`}>
          <i style={{ width: `${Math.max(0, Math.min(1, meter)) * 100}%` }} />
        </div>
      ) : null}
      {spark ? <div className="spark">{spark}</div> : null}
    </div>
  );
}

/* ----------------------------------------------------------------- panels */

export function Panel({ title, hint, actions, children }: {
  title: string; hint?: string; actions?: ReactNode; children: ReactNode;
}) {
  return (
    <section className="panel">
      <header>
        <div style={{ minWidth: 0 }}>
          <h2>{title}</h2>
          {hint ? <span className="hint">{hint}</span> : null}
        </div>
        {actions ? <div className="row">{actions}</div> : null}
      </header>
      {children}
    </section>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {children}
    </div>
  );
}

/** Rows of the right shape, so the page does not jump when the data lands. */
export function SkeletonRows({ rows = 6, cols = 4 }: { rows?: number; cols?: number }) {
  return (
    <tbody>
      {Array.from({ length: rows }).map((_, r) => (
        <tr key={r}>
          {Array.from({ length: cols }).map((__, c) => (
            <td key={c}>
              <div className="skel" style={{ height: 11, width: c === 0 ? '55%' : '75%' }} />
            </td>
          ))}
        </tr>
      ))}
    </tbody>
  );
}

/* ------------------------------------------------------------------- bits */

export function Pill({ tone, children }: {
  tone?: 'good' | 'warning' | 'critical'; children: ReactNode;
}) {
  return (
    <span className={`pill${tone ? ` ${tone}` : ''}`}>
      {tone ? <span className="dot" /> : null}
      {children}
    </span>
  );
}

/** Initials, so a list of names is scannable without loading any photographs. */
export function Avatar({ name }: { name: string }) {
  const initials = name.trim().split(/\s+/).slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '').join('');
  return <span className="avatar" aria-hidden="true">{initials || '?'}</span>;
}

export function Toast({ message, tone }: { message: string; tone?: 'bad' }) {
  return (
    <div className={`toast${tone ? ` ${tone}` : ''}`} role="status" aria-live="polite">
      {message}
    </div>
  );
}
