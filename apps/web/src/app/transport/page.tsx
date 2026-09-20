'use client';

import { useCallback, useEffect, useState } from 'react';
import { Shell, PageHead } from '../shell';
import { Empty, Panel, Pill, SkeletonRows, Tile } from '@/components/ui';
import { apiGet } from '@/lib/api';

interface Route {
  id: string; code: string; name: string; direction: string; status: string;
  stop_count: number; child_count: number;
  vehicle_registration: string | null; driver_name: string | null;
}
interface ManifestRow {
  student_id: string; admission_no: string;
  given_name: string; family_name: string | null;
  stop_id: string; stop_name: string; sequence_no: number;
  pickup_time: string | null; drop_time: string | null;
  guardian_phone: string | null;
  boarded_today: 'boarded' | 'alighted' | 'absent' | 'no_show' | null;
}
interface ComplianceRow {
  kind: string; subject: string; expires_on: string; days_left: number;
}

const KIND_LABEL: Record<string, string> = {
  vehicle_fitness: 'Fitness certificate',
  vehicle_insurance: 'Insurance',
  vehicle_permit: 'Permit',
  driver_licence: 'Driving licence',
};

const BOARDING_LABEL: Record<string, { text: string; tone?: 'good' | 'warning' | 'critical' }> = {
  boarded: { text: 'On board', tone: 'good' },
  alighted: { text: 'Got off', tone: 'good' },
  absent: { text: 'Absent', tone: 'warning' },
  // Not the same as absent, and the difference is the whole point of recording
  // it: the school was expecting this child at this corner and they were not
  // there. Somebody rings the house.
  no_show: { text: 'Not at stop', tone: 'critical' },
};

/** 07:10:00 → 07:10. Seconds on a pickup time are noise. */
function hhmm(t: string | null): string {
  return t ? t.slice(0, 5) : '—';
}

export default function TransportPage() {
  const [routes, setRoutes] = useState<Route[] | null>(null);
  const [routeId, setRouteId] = useState('');
  const [direction, setDirection] = useState<'pickup' | 'drop'>('pickup');
  const [manifest, setManifest] = useState<ManifestRow[] | null>(null);
  const [manifestError, setManifestError] = useState<string | null>(null);
  const [compliance, setCompliance] = useState<ComplianceRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiGet<Route[]>('/v1/transport/routes')
      .then((rows) => {
        setRoutes(rows);
        setRouteId((current) => current || rows[0]?.id || '');
      })
      .catch((e: Error) => setError(e.message));
    apiGet<ComplianceRow[]>('/v1/transport/compliance?withinDays=45')
      .then(setCompliance)
      .catch(() => setCompliance([]));
  }, []);

  const loadManifest = useCallback(() => {
    if (!routeId) return;
    setManifest(null);
    setManifestError(null);
    apiGet<ManifestRow[]>(
      `/v1/transport/routes/${routeId}/manifest?direction=${direction}`)
      .then(setManifest)
      // The API refuses rather than returning an empty list when the caller is
      // not running this route, and that distinction has to survive to the
      // screen: "nobody is booked" and "this is not your route" are different
      // sentences and only one of them means drive off.
      .catch((e: Error) => { setManifest([]); setManifestError(e.message); });
  }, [routeId, direction]);

  useEffect(() => { loadManifest(); }, [loadManifest]);

  const lapsed = (compliance ?? []).filter((c) => c.days_left < 0);
  const soon = (compliance ?? []).filter((c) => c.days_left >= 0);
  const onBoard = (manifest ?? []).filter((m) => m.boarded_today === 'boarded').length;
  const missing = (manifest ?? []).filter((m) => m.boarded_today === 'no_show').length;

  return (
    <Shell>
      <PageHead title="Transport"
                lede="Routes, who is on them, and the papers that expire." />

      {error ? <div className="note bad">{error}</div> : null}

      <div className="tiles">
        <Tile label="Routes running" value={String(routes?.filter((r) => r.status === 'active').length ?? 0)}
              describe="Active today" loading={routes === null} />
        <Tile label="Children carried"
              value={String((routes ?? []).reduce((n, r) => n + Number(r.child_count), 0))}
              describe="Across every route" loading={routes === null} />
        <Tile label="Papers lapsed" value={String(lapsed.length)}
              describe="Already expired"
              tone={lapsed.length > 0 ? 'critical' : 'good'}
              meter={lapsed.length > 0 ? 1 : 0}
              loading={compliance === null} />
        <Tile label="Expiring soon" value={String(soon.length)}
              describe="Within 45 days"
              tone={soon.length > 0 ? 'warning' : 'good'}
              loading={compliance === null} />
      </div>

      {lapsed.length > 0 ? (
        <div className="note bad" style={{ marginTop: 16 }}>
          <strong>
            {lapsed.length === 1 ? 'A vehicle or driver is' : `${lapsed.length} vehicles or drivers are`}
            {' '}carrying children on lapsed papers.
          </strong>{' '}
          This is not a record-keeping problem. The list is below.
        </div>
      ) : null}

      <Panel title="Routes" hint="What is running, and who is running it">
        <table>
          <thead>
            <tr>
              <th>Route</th><th>Bus</th><th>Driver</th>
              <th className="num">Stops</th><th className="num">Children</th>
            </tr>
          </thead>
          {routes === null ? <SkeletonRows rows={4} cols={5} /> : (
            <tbody>
              {routes.map((r) => (
                <tr key={r.id} onClick={() => setRouteId(r.id)}
                    className={r.id === routeId ? 'on' : undefined}
                    style={{ cursor: 'pointer' }}>
                  <td>
                    <strong>{r.code}</strong>
                    <span className="sub" style={{ display: 'block' }}>{r.name}</span>
                  </td>
                  <td>{r.vehicle_registration ?? <span className="sub">No bus assigned</span>}</td>
                  <td>{r.driver_name ?? <span className="sub">No driver assigned</span>}</td>
                  <td className="num">{r.stop_count}</td>
                  <td className="num">{r.child_count}</td>
                </tr>
              ))}
            </tbody>
          )}
        </table>
        {routes?.length === 0 ? (
          <Empty title="No routes yet">
            A route is a code, a campus and an ordered list of stops. Children
            are put on one from their own record.
          </Empty>
        ) : null}
      </Panel>

      <Panel
        title="Manifest"
        hint="In the order the bus meets them, not alphabetically"
        actions={
          <>
            <select value={routeId} onChange={(e) => setRouteId(e.target.value)}>
              {(routes ?? []).map((r) => (
                <option key={r.id} value={r.id}>{r.code} — {r.name}</option>
              ))}
            </select>
            <select value={direction}
                    onChange={(e) => setDirection(e.target.value as 'pickup' | 'drop')}>
              <option value="pickup">Morning pickup</option>
              <option value="drop">Afternoon drop</option>
            </select>
          </>
        }
      >
        {manifestError ? (
          <div className="note bad" style={{ margin: '0 0 12px' }}>{manifestError}</div>
        ) : null}

        {manifest && manifest.length > 0 ? (
          <div className="sub" style={{ margin: '0 0 10px' }}>
            {onBoard} of {manifest.length} on board
            {missing > 0 ? ` · ${missing} not at their stop` : ''}
          </div>
        ) : null}

        <table>
          <thead>
            {/* Today sits second, not last. On a phone the last column is
                the one that scrolls off, and the boarding state is what a
                driver glances at — the column order is the reading order. */}
            <tr>
              <th className="num">#</th><th>Child</th><th>Today</th>
              <th>Stop and time</th><th>Guardian</th>
            </tr>
          </thead>
          {manifest === null ? <SkeletonRows rows={6} cols={5} /> : (
            <tbody>
              {manifest.map((m) => {
                const state = m.boarded_today ? BOARDING_LABEL[m.boarded_today] : null;
                return (
                  <tr key={m.student_id}>
                    <td className="num">{m.sequence_no}</td>
                    <td>
                      <strong>{m.given_name} {m.family_name ?? ''}</strong>
                      <span className="sub" style={{ display: 'block' }}>{m.admission_no}</span>
                    </td>
                    <td>
                      {state
                        ? <Pill {...(state.tone ? { tone: state.tone } : {})}>{state.text}</Pill>
                        : <span className="sub">Not yet</span>}
                    </td>
                    <td>
                      {m.stop_name}
                      <span className="sub" style={{ display: 'block' }}>
                        {hhmm(direction === 'pickup' ? m.pickup_time : m.drop_time)}
                      </span>
                    </td>
                    <td>
                      {m.guardian_phone
                        ? <a href={`tel:${m.guardian_phone}`}>{m.guardian_phone}</a>
                        : <span className="sub">No number on file</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          )}
        </table>
        {manifest?.length === 0 && !manifestError ? (
          <Empty title="Nobody on this run">
            No child is on this route in this direction today.
          </Empty>
        ) : null}
      </Panel>

      <Panel title="Papers that expire"
             hint="Expired first, because a report that only warns about the future is no use on the day">
        <table>
          <thead>
            <tr><th>What</th><th>Whose</th><th>Expires</th><th className="num">Days</th></tr>
          </thead>
          {compliance === null ? <SkeletonRows rows={3} cols={4} /> : (
            <tbody>
              {compliance.map((c, i) => (
                <tr key={`${c.kind}-${c.subject}-${i}`}>
                  <td>{KIND_LABEL[c.kind] ?? c.kind}</td>
                  <td>{c.subject.trim()}</td>
                  <td>{c.expires_on}</td>
                  <td className="num">
                    {c.days_left < 0
                      ? <Pill tone="critical">{Math.abs(c.days_left)} days ago</Pill>
                      : <Pill tone={c.days_left <= 14 ? 'warning' : undefined}>{c.days_left}</Pill>}
                  </td>
                </tr>
              ))}
            </tbody>
          )}
        </table>
        {compliance?.length === 0 ? (
          <Empty title="Nothing expiring">
            No fitness certificate, insurance, permit or licence falls due in the
            next 45 days.
          </Empty>
        ) : null}
      </Panel>
    </Shell>
  );
}
