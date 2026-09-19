'use client';

/**
 * Two chart forms, hand-drawn in SVG.
 *
 * No charting library: these are a sparkline and a single-series area, both
 * about forty lines of geometry, and a library would cost more kilobytes on
 * first load than the rest of the app puts together.
 *
 * The rules they follow, none of them cosmetic:
 *
 *   ONE axis. Never two y-scales on one chart — two measures of different
 *   magnitude become two charts, or one indexed to a common base.
 *
 *   ONE hue per series, 2px lines, a recessive grid. The area fill is the same
 *   hue at low alpha, so the line stays the thing you read.
 *
 *   A hover layer by default. An SVG chart in a browser is interactive; a
 *   static one is a picture of a chart. The only form that skips it is the
 *   sparkline, which has no axis to read against anyway.
 *
 *   Text wears text tokens, never the series colour. A coloured mark beside a
 *   label carries the identity; colouring the label too is how a chart stops
 *   being readable in greyscale.
 */
import { useId, useMemo, useState } from 'react';

export interface Point { label: string; value: number }

/** A path through the points, smoothed just enough to not look like a graph. */
function linePath(points: Point[], w: number, h: number, pad: number): {
  line: string; area: string; xy: Array<{ x: number; y: number; p: Point }>;
} {
  const max = Math.max(...points.map((p) => p.value), 1);
  const step = points.length > 1 ? (w - pad * 2) / (points.length - 1) : 0;
  const xy = points.map((p, i) => ({
    x: pad + i * step,
    // A floor of 1px so a zero day is still a visible point on the baseline
    // rather than vanishing into the axis.
    y: h - pad - (p.value / max) * (h - pad * 2 - 1),
    p,
  }));

  const line = xy.map((c, i) => (i === 0 ? `M${c.x} ${c.y}` : `L${c.x} ${c.y}`)).join(' ');
  const area = `${line} L${xy[xy.length - 1]!.x} ${h - pad} L${xy[0]!.x} ${h - pad} Z`;
  return { line, area, xy };
}

/**
 * The tile sparkline. No axis, no hover — it answers "which way" and nothing
 * else, which is the only question a 40px-tall chart can honestly answer.
 */
export function Sparkline({ points, tone = 'brand' }: {
  points: Point[]; tone?: 'brand' | 'good' | 'critical';
}) {
  const id = useId();
  const W = 240, H = 44, PAD = 3;
  if (points.length < 2) return <div style={{ height: H }} />;
  const { line, area } = linePath(points, W, H, PAD);
  const stroke = `var(--${tone === 'brand' ? 'brand' : tone})`;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true"
         style={{ width: '100%', height: H, display: 'block' }}>
      <defs>
        <linearGradient id={`g${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={stroke} stopOpacity="0.22" />
          <stop offset="1" stopColor={stroke} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#g${id})`} />
      <path d={line} fill="none" stroke={stroke} strokeWidth="2"
            strokeLinecap="round" strokeLinejoin="round"
            vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/**
 * The full-width area chart, with a crosshair and a tooltip.
 *
 * `format` turns a raw value into what the tooltip shows, so money stays a
 * string all the way through and never becomes a float on its way to a label.
 */
export function AreaChart({ points, format, label, tone = 'brand' }: {
  points: Point[];
  format: (value: number) => string;
  label: string;
  tone?: 'brand' | 'good';
}) {
  const id = useId();
  const [hover, setHover] = useState<number | null>(null);
  const W = 1000, H = 170, PAD = 24;

  const { line, area, xy } = useMemo(
    () => linePath(points, W, H, PAD), [points]);

  if (points.length < 2) {
    return <div className="empty">Not enough history yet to draw a trend.</div>;
  }

  const stroke = `var(--${tone})`;
  const max = Math.max(...points.map((p) => p.value), 1);
  // Four gridlines, not ten. A grid dense enough to read values off is a table
  // with extra steps.
  const ticks = [0, 0.5, 1].map((f) => ({
    y: H - PAD - f * (H - PAD * 2 - 1),
    v: max * f,
  }));
  const every = Math.max(1, Math.ceil(points.length / 6));
  const active = hover === null ? null : xy[hover];

  return (
    <div className="chartwrap">
      <svg viewBox={`0 0 ${W} ${H}`} role="img"
           aria-label={`${label}. ${points.length} days, peak ${format(max)}.`}
           onMouseLeave={() => setHover(null)}>
        <defs>
          <linearGradient id={`a${id}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={stroke} stopOpacity="0.20" />
            <stop offset="1" stopColor={stroke} stopOpacity="0.01" />
          </linearGradient>
        </defs>

        {ticks.map((t) => (
          <line key={t.y} className="gridline" x1={PAD} x2={W - PAD} y1={t.y} y2={t.y} />
        ))}

        <path d={area} fill={`url(#a${id})`} />
        <path d={line} fill="none" stroke={stroke} strokeWidth="2"
              strokeLinecap="round" strokeLinejoin="round" />

        {xy.map((c, i) => (
          i % every === 0 ? (
            <text key={`x${i}`} className="axis" y={H - 6}
                  x={c.x}
                  textAnchor={i === 0 ? 'start' : i >= points.length - every ? 'end' : 'middle'}>
              {c.p.label}
            </text>
          ) : null
        ))}

        {active ? (
          <>
            <line className="gridline" x1={active.x} x2={active.x} y1={PAD} y2={H - PAD}
                  stroke={stroke} strokeOpacity="0.45" />
            {/* A ring in the surface colour so the marker reads against the
                area fill rather than dissolving into it. */}
            <circle cx={active.x} cy={active.y} r="5" fill="var(--surface)"
                    stroke={stroke} strokeWidth="2.5" />
          </>
        ) : null}

        {/* Hit targets wider than the marks: a 2px line is not a click target. */}
        {xy.map((c, i) => (
          <rect key={`h${i}`} x={c.x - (W - PAD * 2) / points.length / 2} y={0}
                width={(W - PAD * 2) / points.length} height={H}
                fill="transparent"
                onMouseEnter={() => setHover(i)} />
        ))}
      </svg>

      {active ? (
        <div className="tip" style={{
          left: `${(active.x / W) * 100}%`,
          top: `${(active.y / H) * 100}%`,
          marginTop: -10,
        }}>
          <div className="d">{active.p.label}</div>
          <div className="v">{format(active.p.value)}</div>
        </div>
      ) : null}
    </div>
  );
}
