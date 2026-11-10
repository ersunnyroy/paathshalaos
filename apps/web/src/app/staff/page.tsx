'use client';

/**
 * Staff (M32.1).
 *
 * M27 built leave, balances and relief cover, and shipped no way to use any of
 * it. This screen is the module's first surface, so it is built around the two
 * moments that actually happen in a school office rather than around the
 * tables: somebody rings in sick at eight in the morning, and somebody has to
 * decide a request before it becomes an argument.
 *
 * Cover is the part worth getting right. Marking a teacher absent leaves a
 * class with nobody who can take its register — M27's whole point — so the
 * absent list and the cover list are on screen together, and a teacher who is
 * away with nobody assigned is shown as a gap rather than as a row.
 */
import { useCallback, useEffect, useState } from 'react';
import { Shell, PageHead } from '../shell';
import { Empty, Panel, Pill, SkeletonRows, Tile } from '@/components/ui';
import { localIsoDate } from '@/lib/dates';
import { DataTable } from '@/components/data-table';
import { apiGet, apiPost } from '@/lib/api';

interface StaffRow {
  staff_id: string; employee_code: string; given_name: string;
  family_name: string | null; designation: string | null;
  joined_on: string; left_on: string | null; status: string;
  contract_kind: string | null; weekly_hours: string | null;
  entitlement_days: string | null; taken_days: string | null;
  away_today: boolean; pending_requests: number;
}
interface Absence {
  id: string; staff_id: string; given_name: string; family_name: string | null;
  leave_type: string | null; is_paid: boolean | null;
  starts_on: string; ends_on: string; half_day: boolean;
  status: string; reason: string | null; decision_note: string | null;
}
interface LeaveType { id: string; code: string; name: string; is_paid: boolean }
interface Cover {
  on: string;
  absent: Array<{
    staff_id: string; given_name: string; family_name: string | null;
    leave_type: string | null; half_day: boolean;
  }>;
  assigned: Array<{
    id: string; section_id: string; section_name: string;
    class_name: string | null; covering_staff_id: string; covering_name: string;
    absent_staff_id: string | null; period_no: number | null;
  }>;
}
interface Section { id: string; section_name: string; class_name: string | null }

const who = (r: { given_name: string; family_name: string | null }) =>
  `${r.given_name}${r.family_name ? ` ${r.family_name}` : ''}`;

const STATUS_TONE: Record<string, 'good' | 'warning' | 'critical' | undefined> = {
  approved: 'good', requested: 'warning', refused: 'critical', cancelled: undefined,
};

export default function StaffPage() {
  const [staff, setStaff] = useState<StaffRow[] | null>(null);
  const [absences, setAbsences] = useState<Absence[] | null>(null);
  const [types, setTypes] = useState<LeaveType[]>([]);
  const [sections, setSections] = useState<Section[]>([]);
  const [cover, setCover] = useState<Cover | null>(null);
  const [day, setDay] = useState(() => localIsoDate());
  const [error, setError] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [form, setForm] = useState({
    staffId: '', leaveTypeId: '', startsOn: '', endsOn: '', reason: '', halfDay: false,
  });
  // A refusal has to carry a reason, so the box lives on the row being refused.
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [coverForm, setCoverForm] = useState({ sectionId: '', coveringStaffId: '' });

  const load = useCallback(() => {
    setError(null);
    apiGet<StaffRow[]>('/v1/hr/staff').then(setStaff)
      .catch((e: Error) => { setStaff([]); setError(e.message); });
    apiGet<Absence[]>('/v1/hr/absences').then(setAbsences).catch(() => setAbsences([]));
    apiGet<LeaveType[]>('/v1/hr/leave-types').then(setTypes).catch(() => setTypes([]));
    apiGet<Section[]>('/v1/sections').then(setSections).catch(() => setSections([]));
  }, []);

  useEffect(() => { load(); }, [load]);

  const loadCover = useCallback(() => {
    setCover(null);
    apiGet<Cover>(`/v1/hr/cover?on=${day}`).then(setCover).catch(() => setCover(null));
  }, [day]);
  useEffect(() => { loadCover(); }, [loadCover]);

  async function act(fn: () => Promise<unknown>, done: string) {
    setBusy(true); setError(null); setSaid(null);
    try { await fn(); setSaid(done); load(); loadCover(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  const present = (staff ?? []).filter((s) => !s.away_today && !s.left_on).length;
  const away = (staff ?? []).filter((s) => s.away_today).length;
  const pending = (absences ?? []).filter((a) => a.status === 'requested').length;

  // Away with nothing assigned. The number this screen exists for.
  const uncovered = (cover?.absent ?? []).filter(
    (a) => !(cover?.assigned ?? []).some((c) => c.absent_staff_id === a.staff_id)).length;

  return (
    <Shell>
      <PageHead title="Staff"
                lede="Who is in, who is away, and who is taking their class." />

      {error ? <div className="note bad">{error}</div> : null}
      {said ? <div className="note ok">{said}</div> : null}

      <div className="tiles">
        <Tile label="In today" value={String(present)} describe="Not on leave"
              loading={staff === null} />
        <Tile label="Away today" value={String(away)} describe="Approved leave"
              tone={away > 0 ? 'warning' : 'good'} loading={staff === null} />
        <Tile label="Awaiting a decision" value={String(pending)}
              describe="Leave requests"
              tone={pending > 0 ? 'warning' : 'good'} loading={absences === null} />
        <Tile label="Classes with no cover" value={String(uncovered)}
              describe={`On ${day}`}
              tone={uncovered > 0 ? 'critical' : 'good'}
              meter={uncovered > 0 ? 1 : 0}
              loading={cover === null} />
      </div>

      {uncovered > 0 ? (
        <div className="note bad" style={{ marginTop: 16 }}>
          <strong>
            {uncovered === 1 ? 'A teacher is' : `${uncovered} teachers are`} away with
            nobody assigned to their class.
          </strong>{' '}
          Without cover nobody can mark that register — this is not a paperwork
          problem.
        </div>
      ) : null}

      <Panel title="Leave requests" hint="A refusal has to say why">
        <table>
          <thead>
            <tr><th>Who</th><th>Dates</th><th>Type</th><th>Status</th><th /></tr>
          </thead>
          {absences === null ? <SkeletonRows rows={3} cols={5} /> : (
            <tbody>
              {absences.map((a) => (
                <tr key={a.id}>
                  <td><strong>{who(a)}</strong></td>
                  <td>
                    {a.starts_on === a.ends_on
                      ? a.starts_on
                      : `${a.starts_on} → ${a.ends_on}`}
                    {a.half_day ? <span className="sub"> · half day</span> : null}
                    {a.reason
                      ? <span className="sub" style={{ display: 'block' }}>{a.reason}</span>
                      : null}
                  </td>
                  <td>
                    {a.leave_type ?? <span className="sub">Unclassified</span>}
                    {a.is_paid === false ? <span className="sub"> · unpaid</span> : null}
                  </td>
                  <td>
                    <Pill tone={STATUS_TONE[a.status]}>{a.status}</Pill>
                    {a.decision_note
                      ? <span className="sub" style={{ display: 'block' }}>{a.decision_note}</span>
                      : null}
                  </td>
                  <td className="num">
                    {a.status === 'requested' ? (
                      <div className="row-form" style={{ justifyContent: 'flex-end' }}>
                        <input type="text" placeholder="Reason, if refusing"
                               value={notes[a.id] ?? ''}
                               onChange={(e) =>
                                 setNotes((n) => ({ ...n, [a.id]: e.target.value }))} />
                        <button className="ghost" disabled={busy}
                                onClick={() => void act(
                                  () => apiPost('/v1/hr/absences/decide',
                                    { absenceId: a.id, approve: true }), 'Approved.')}>
                          Approve
                        </button>
                        <button className="ghost" disabled={busy}
                                onClick={() => void act(
                                  () => apiPost('/v1/hr/absences/decide',
                                    { absenceId: a.id, approve: false,
                                      note: notes[a.id] ?? '' }), 'Refused.')}>
                          Refuse
                        </button>
                      </div>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          )}
        </table>
        {absences?.length === 0 ? (
          <Empty title="Nothing filed this month">
            Leave can be filed here for somebody who rang in, as well as
            requested in advance.
          </Empty>
        ) : null}
      </Panel>

      <Panel title="File an absence"
             hint="For somebody who rang in this morning, as much as for a request">
        <div className="row-form">
          <select value={form.staffId}
                  onChange={(e) => setForm((f) => ({ ...f, staffId: e.target.value }))}>
            <option value="">Who…</option>
            {(staff ?? []).filter((s) => !s.left_on).map((s) => (
              <option key={s.staff_id} value={s.staff_id}>{who(s)}</option>
            ))}
          </select>
          <select value={form.leaveTypeId}
                  onChange={(e) => setForm((f) => ({ ...f, leaveTypeId: e.target.value }))}>
            <option value="">Type…</option>
            {types.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}{t.is_paid ? '' : ' (unpaid)'}
              </option>
            ))}
          </select>
          <input type="date" value={form.startsOn}
                 onChange={(e) => setForm((f) => ({
                   ...f,
                   startsOn: e.target.value,
                   // Most absences are one day. Defaulting the end saves a
                   // click and stops "the dates are reversed" being the most
                   // common thing this form says.
                   endsOn: f.endsOn || e.target.value,
                 }))} />
          <input type="date" value={form.endsOn}
                 onChange={(e) => setForm((f) => ({ ...f, endsOn: e.target.value }))} />
          <label className="sub">
            <input type="checkbox" checked={form.halfDay}
                   onChange={(e) => setForm((f) => ({ ...f, halfDay: e.target.checked }))} />
            Half day
          </label>
          <input type="text" placeholder="Reason" value={form.reason}
                 style={{ flex: 1 }}
                 onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))} />
          <button disabled={busy || !form.staffId || !form.startsOn || !form.endsOn}
                  onClick={() => void act(() => apiPost('/v1/hr/absences', {
                    staffId: form.staffId,
                    ...(form.leaveTypeId ? { leaveTypeId: form.leaveTypeId } : {}),
                    startsOn: form.startsOn,
                    endsOn: form.endsOn,
                    halfDay: form.halfDay,
                    ...(form.reason ? { reason: form.reason } : {}),
                  }), 'Filed.')}>
            File
          </button>
        </div>
      </Panel>

      <Panel
        title="Cover"
        hint="A class whose teacher is away needs somebody who can mark its register"
        actions={<input type="date" value={day}
                        onChange={(e) => setDay(e.target.value)} />}
      >
        <table>
          <thead><tr><th>Away</th><th>Leave</th><th>Covered by</th></tr></thead>
          {cover === null ? <SkeletonRows rows={2} cols={3} /> : (
            <tbody>
              {cover.absent.map((a) => {
                const c = cover.assigned.find((x) => x.absent_staff_id === a.staff_id);
                return (
                  <tr key={a.staff_id}>
                    <td><strong>{who(a)}</strong></td>
                    <td>{a.leave_type ?? '—'}{a.half_day ? ' · half day' : ''}</td>
                    <td>
                      {c ? (
                        <>
                          {c.covering_name}
                          <span className="sub">
                            {' '}— {c.class_name ? `${c.class_name} ` : ''}{c.section_name}
                          </span>
                        </>
                      ) : <Pill tone="critical">Nobody yet</Pill>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          )}
        </table>
        {cover?.absent.length === 0 ? (
          <Empty title="Everybody is in on this day">Nothing to cover.</Empty>
        ) : null}

        {(cover?.absent.length ?? 0) > 0 ? (
          <div className="row-form" style={{ marginTop: 12 }}>
            <select value={coverForm.coveringStaffId}
                    onChange={(e) => setCoverForm((f) => ({
                      ...f, coveringStaffId: e.target.value }))}>
              <option value="">Covering teacher…</option>
              {(staff ?? []).filter((s) => !s.left_on && !s.away_today).map((s) => (
                <option key={s.staff_id} value={s.staff_id}>{who(s)}</option>
              ))}
            </select>
            <select value={coverForm.sectionId}
                    onChange={(e) => setCoverForm((f) => ({
                      ...f, sectionId: e.target.value }))}>
              <option value="">Which class…</option>
              {sections.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.class_name ? `${s.class_name} ` : ''}{s.section_name}
                </option>
              ))}
            </select>
            <button disabled={busy || !coverForm.sectionId || !coverForm.coveringStaffId}
                    onClick={() => void act(() => apiPost('/v1/hr/cover', {
                      sectionId: coverForm.sectionId,
                      coveringStaffId: coverForm.coveringStaffId,
                      onDate: day,
                    }), 'Cover assigned.')}>
              Assign cover
            </button>
          </div>
        ) : null}
      </Panel>

      <DataTable<StaffRow>
        id="staff-roster"
        title="Roster"
        rows={staff}
        rowKey={(s) => s.staff_id}
        empty={(
          <Empty title="No staff recorded yet">
            Staff arrive with the roster import, or are added when an account is
            created for them.
          </Empty>
        )}
        columns={[
          {
            key: 'name', label: 'Name', required: true, text: who,
            render: (s) => (
              <>
                <strong>{who(s)}</strong>
                {s.designation
                  ? <span className="sub" style={{ display: 'block' }}>{s.designation}</span>
                  : null}
              </>
            ),
          },
          { key: 'designation', label: 'Designation', optional: true, text: (s) => s.designation ?? '' },
          { key: 'code', label: 'Code', text: (s) => s.employee_code },
          {
            key: 'contract', label: 'Contract',
            text: (s) => (s.contract_kind ? s.contract_kind.replace(/_/g, ' ') : ''),
            render: (s) => (s.contract_kind ? (
              <>
                {s.contract_kind.replace(/_/g, ' ')}
                {s.weekly_hours ? <span className="sub"> · {Number(s.weekly_hours)}h</span> : null}
              </>
            ) : <span className="sub">No contract recorded</span>),
          },
          { key: 'joined', label: 'Joined', optional: true, text: (s) => s.joined_on },
          {
            key: 'leave', label: 'Leave taken', align: 'right',
            // "3 / 10" as text, so the export says what the screen says.
            text: (s) => (s.entitlement_days
              ? `${Number(s.taken_days ?? 0)} / ${Number(s.entitlement_days)}` : ''),
          },
          {
            key: 'state', label: 'State',
            text: (s) => (s.left_on ? `Left ${s.left_on}` : s.away_today ? 'Away today' : 'In'),
            render: (s) => (s.left_on ? <Pill>Left {s.left_on}</Pill>
              : s.away_today ? <Pill tone="warning">Away today</Pill>
              : <Pill tone="good">In</Pill>),
          },
        ]}
      />
    </Shell>
  );
}
