'use client';

import { useEffect, useMemo, useState } from 'react';
import { Shell, PageHead } from '../shell';
import { Tile, Panel, Pill, SkeletonRows, Icon } from '@/components/ui';
import { Sparkline, AreaChart, type Point } from '@/components/chart';
import { localIsoDate } from '@/lib/dates';
import { apiGet, rupees, rupeesCompact } from '@/lib/api';

interface Campus {
  campus_id: string; campus_name: string;
  learners: number; staff: number;
  billed: string; collected: string; outstanding: string;
  present_today: number; absent_today: number;
}
interface Figures extends Omit<Campus, 'campus_id' | 'campus_name'> {
  campuses: Campus[];
}
interface Today {
  date: string;
  unmarked_sessions: number; pending_corrections: number;
  unreviewed_results: number; failed_messages: number;
  imports_awaiting_apply: number;
}
interface TrendPoint {
  day: string; collected: string;
  present: number; absent: number; invoices_issued: number;
}

/** Fraction, guarding the divide-by-zero that a brand-new school is. */
function share(part: string, whole: string): number {
  const total = BigInt(whole);
  if (total === 0n) return 0;
  return Number((BigInt(part) * 10000n) / total) / 10000;
}

/**
 * Percentage change of the last half of a window against the first half.
 *
 * Stated against a named period on screen, because "+20%" on its own is not a
 * fact. Returns null when the earlier half is empty — "up ∞%" from zero is not
 * information, and a school's first fortnight would show it on every tile.
 */
function change(values: number[]): number | null {
  if (values.length < 4) return null;
  const half = Math.floor(values.length / 2);
  const before = values.slice(0, half).reduce((a, b) => a + b, 0);
  const after = values.slice(half).reduce((a, b) => a + b, 0);
  if (before === 0) return null;
  return ((after - before) / before) * 100;
}

const dayLabel = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-IN',
    { day: 'numeric', month: 'short', timeZone: 'UTC' });

export default function DashboardPage() {
  const [figures, setFigures] = useState<Figures | null>(null);
  const [today, setToday] = useState<Today | null>(null);
  const [trend, setTrend] = useState<TrendPoint[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      apiGet<Figures>('/v1/dashboard'),
      // The date is sent, not left to the server, whose default is UTC: before
      // 5:30 a.m. in India that is yesterday's registers.
      apiGet<Today>(`/v1/dashboard/today?on=${localIsoDate()}`),
      apiGet<TrendPoint[]>('/v1/dashboard/trend?days=28'),
    ])
      .then(([f, t, tr]) => { setFigures(f); setToday(t); setTrend(tr); })
      .catch((e: Error) => setError(e.message));
  }, []);

  // AC-2 in the browser as well as in the suite: the group figures are the sum
  // of the campus rows, so if they ever disagree the screen says so rather than
  // quietly showing two different truths.
  const reconciles = figures
    ? figures.campuses.reduce((t, c) => t + BigInt(c.billed), 0n).toString() === figures.billed
    : true;

  const series = useMemo(() => {
    const rows = trend ?? [];

    /**
     * A rolling total over `window` days.
     *
     * The raw daily collection series is a sawtooth — a school takes fees on
     * the days families come in, and zero on the rest. That is the truth, and
     * the full chart below shows it. But a 44px sparkline of a sawtooth is
     * noise, and a tile's job is to answer "which way", so the tile smooths and
     * the label says it does.
     */
    const rolling = (values: number[], window = 7): number[] =>
      values.map((_, i) =>
        values.slice(Math.max(0, i - window + 1), i + 1).reduce((a, b) => a + b, 0));

    const daily = rows.map((r) => Number(BigInt(r.collected) / 100n));
    const smoothed = rolling(daily);

    return {
      collectedSmooth: rows.map<Point>((r, i) => ({
        label: dayLabel(r.day), value: smoothed[i] ?? 0,
      })),
      // Rupees, not paise, for the chart geometry only — the label is still
      // formatted from the exact string.
      collected: rows.map<Point>((r) => ({
        label: dayLabel(r.day), value: Number(BigInt(r.collected) / 100n),
      })),
      present: rows.map<Point>((r) => ({ label: dayLabel(r.day), value: r.present })),
      absent: rows.map<Point>((r) => ({ label: dayLabel(r.day), value: r.absent })),
    };
  }, [trend]);

  const collectedRate = figures ? share(figures.collected, figures.billed) : 0;
  const marked = figures ? figures.present_today + figures.absent_today : 0;
  const attendanceRate = marked > 0 ? figures!.present_today / marked : 0;

  const queue = today ? [
    ['Attendance sessions still open', today.unmarked_sessions],
    ['Attendance corrections awaiting approval', today.pending_corrections],
    ['Results computed but not reviewed', today.unreviewed_results],
    ['Messages that failed to send', today.failed_messages],
    ['Imports previewed but not applied', today.imports_awaiting_apply],
  ] as const : [];
  const openItems = queue.filter(([, n]) => n > 0).length;
  const loading = !figures || !trend;

  return (
    <Shell>
      <PageHead
        title="Dashboard"
        lede="Every figure is scoped to who you signed in as — the rows that come back, not what the page chooses to draw."
      />

      {error ? <div className="note bad">{error}</div> : null}

      <div className="tiles">
        <Tile
          loading={loading}
          label="Learners"
          describe="Enrolled and active this year"
          value={String(figures?.learners ?? '')}
        />
        <Tile
          loading={loading}
          label="Collected"
          describe="Rolling 7-day total, last 28 days"
          value={rupeesCompact(figures?.collected)}
          exact={rupees(figures?.collected)}
          trend={change(series.collected.map((p) => p.value))}
          spark={<Sparkline points={series.collectedSmooth} />}
        />
        <Tile
          loading={loading}
          label="Outstanding"
          describe="Billed and still owed"
          value={rupeesCompact(figures?.outstanding)}
          exact={rupees(figures?.outstanding)}
          meter={collectedRate}
          tone={collectedRate >= 0.75 ? 'good' : collectedRate >= 0.4 ? 'warning' : 'critical'}
        />
        <Tile
          loading={loading}
          label="Attendance"
          describe="Present today, of those marked"
          value={marked > 0 ? `${Math.round(attendanceRate * 100)}%` : '—'}
          trend={change(series.absent.map((p) => p.value))}
          trendGood={false}
          spark={<Sparkline points={series.present} tone="good" />}
        />
      </div>

      {!reconciles ? (
        <div className="note bad" style={{ marginTop: 12 }}>
          The group total does not equal the sum of its campuses. That is a bug,
          not a rounding difference — please report it.
        </div>
      ) : null}

      <Panel
        title="Fee collection"
        hint="Receipts issued per day over the last four weeks"
      >
        {trend ? (
          <>
            <AreaChart
              points={series.collected}
              label="Fee collection per day"
              format={(v) => rupees(String(BigInt(Math.round(v)) * 100n))}
            />
            <div className="caption">
              <Icon.check />
              Every point is a receipt row, not a projection.
              <span className="muted">
                Peak {rupees(String(BigInt(Math.max(...series.collected.map((p) => p.value), 0)) * 100n))}
              </span>
            </div>
          </>
        ) : (
          <div className="chartwrap"><div className="skel" style={{ height: 200 }} /></div>
        )}
      </Panel>

      <Panel title="By campus" hint="Group totals are the sum of these rows">
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>Campus</th>
                <th className="n">Learners</th>
                <th className="n opt">Staff</th>
                <th className="n opt">Billed</th>
                <th className="n opt">Collected</th>
                <th className="n">Outstanding</th>
              </tr>
            </thead>
            {figures ? (
              <tbody>
                {figures.campuses.map((c) => (
                  <tr key={c.campus_id}>
                    <td>{c.campus_name}</td>
                    <td className="n">{c.learners}</td>
                    <td className="n opt">{c.staff}</td>
                    <td className="n opt">{rupees(c.billed)}</td>
                    <td className="n opt">{rupees(c.collected)}</td>
                    <td className="n">{rupees(c.outstanding)}</td>
                  </tr>
                ))}
              </tbody>
            ) : <SkeletonRows rows={2} cols={6} />}
          </table>
        </div>
      </Panel>

      <Panel
        title="Needs attention"
        hint="Work the system is waiting on a person for"
        actions={today ? (
          openItems > 0
            ? <Pill tone="warning">{openItems} to look at</Pill>
            : <Pill tone="good">All clear</Pill>
        ) : null}
      >
        <div className="scroll">
          <table>
            {today ? (
              <tbody>
                {queue.map(([label, n]) => (
                  <tr key={label}>
                    <td>{label}</td>
                    <td className="n w">
                      {n > 0 ? <Pill tone="warning">{n}</Pill> : <Pill tone="good">0</Pill>}
                    </td>
                  </tr>
                ))}
              </tbody>
            ) : <SkeletonRows rows={5} cols={2} />}
          </table>
        </div>
      </Panel>
    </Shell>
  );
}
