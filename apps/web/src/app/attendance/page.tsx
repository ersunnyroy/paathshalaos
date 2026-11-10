'use client';

import { useCallback, useEffect, useState } from 'react';
import { Shell, PageHead } from '../shell';
import { Avatar, Empty, Icon, Panel, Pill, SkeletonRows, Tile, Toast } from '@/components/ui';
import { apiGet, apiPost } from '@/lib/api';
import { localIsoDate } from '@/lib/dates';
import { attendanceQueue, buildRecords, flushWhenOnline } from '@/lib/offline';

interface Section {
  id: string; section_name: string; class_name: string;
  academic_year_id: string; learners: number;
}
interface SessionRow {
  id: string; session_date: string; status: string;
  section_id: string; marked: number; absent: number;
}
interface Student {
  id: string; admission_no: string;
  given_name: string; family_name: string | null;
  enrollment_id: string | null;
}
type State = 'present' | 'absent' | 'late';

const STATES: Array<{ value: State; label: string; cls: string }> = [
  { value: 'present', label: 'Present', cls: 'is-present' },
  { value: 'absent', label: 'Absent', cls: 'is-absent' },
  { value: 'late', label: 'Late', cls: 'is-late' },
];

function today(): string {
  // Local, not UTC: before 5:30 a.m. in India the UTC date is still yesterday.
  return localIsoDate();
}

export default function AttendancePage() {
  const [date, setDate] = useState(today());
  const [sections, setSections] = useState<Section[]>([]);
  const [sectionId, setSectionId] = useState('');
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [students, setStudents] = useState<Student[] | null>(null);
  const [marks, setMarks] = useState<Record<string, State>>({});
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ message: string; tone?: 'bad' } | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(0);

  useEffect(() => {
    apiGet<Section[]>('/v1/sections')
      .then((rows) => {
        setSections(rows);
        setSectionId((current) => current || rows[0]?.id || '');
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  useEffect(() => {
    if (!toast) return;
    const handle = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(handle);
  }, [toast]);

  const refresh = useCallback(() => {
    setError(null);
    apiGet<SessionRow[]>(`/v1/attendance/sessions?date=${date}`)
      .then(setSessions)
      .catch((e: Error) => setError(e.message));
  }, [date]);

  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    if (!sectionId) return;
    setStudents(null);
    apiGet<Student[]>(`/v1/students?sectionId=${sectionId}`)
      .then((rows) => {
        setStudents(rows);
        // Present by default. A register where everybody starts unmarked is one
        // a teacher taps thirty-five times; the exceptions are what they
        // actually came to record.
        setMarks(Object.fromEntries(rows.map((s) => [s.id, 'present' as State])));
      })
      .catch((e: Error) => setError(e.message));
  }, [sectionId]);

  const section = sections.find((s) => s.id === sectionId);
  const existing = sessions.find((s) => s.section_id === sectionId);
  const roll = students ?? [];
  const counts = {
    present: roll.filter((s) => marks[s.id] === 'present').length,
    absent: roll.filter((s) => marks[s.id] === 'absent').length,
    late: roll.filter((s) => marks[s.id] === 'late').length,
  };

  function setAll(state: State) {
    setMarks(Object.fromEntries(roll.map((s) => [s.id, state])));
  }

  useEffect(() => {
    const queue = attendanceQueue((path, body) => apiPost(path, body));
    return flushWhenOnline(queue, setPending);
  }, []);

  async function submit() {
    if (!section) return;
    setBusy(true);
    setError(null);

    // Every record gets its client event id HERE, before anything touches the
    // network, and never gets another one. That is what makes a retry a replay:
    // the server has been idempotent on this key since M6, and until now the
    // web client never sent one, so a flaky connection double-marked the class.
    const records = buildRecords(
      roll.filter((s) => s.enrollment_id)
        .map((s) => ({ studentId: s.id, state: marks[s.id] ?? 'present' })),
    );

    try {
      let sessionId = existing?.id;
      if (!sessionId) {
        const opened = await apiPost<{ id: string }>('/v1/attendance/sessions', {
          sectionId: section.id,
          academicYearId: section.academic_year_id,
          sessionDate: date,
          mode: 'day',
        });
        sessionId = opened.id;
      }

      // Queue first, sync second. The teacher's job is done the moment the roll
      // is in the queue; whether the network was there is our problem.
      const queue = attendanceQueue((path, body) => apiPost(path, body));
      await queue.enqueue({
        localId: `${sessionId}:${date}`,
        serverSessionId: sessionId,
        sectionId: section.id,
        sessionDate: date,
        records,
      });

      const result = await queue.flush();
      const left = await queue.pendingCount();
      setPending(left);

      setToast(
        result.synced > 0 && left === 0
          ? { message: `${records.length} recorded.` }
          : result.conflicted > 0 || result.corrections > 0
            ? { message: 'Saved. Some marks need attention — another device got '
                + 'there first, or the date is past the correction bound.', tone: 'bad' }
            : { message: `Saved on this device. ${records.length} marks will sync `
                + 'when you are back online.' },
      );
      refresh();
    } catch (e) {
      // Opening the session is the only step that can still fail outright: the
      // marks themselves are in the queue by then and are never lost here.
      setToast({ message: e instanceof Error ? e.message : 'Could not save.', tone: 'bad' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Shell>
      <PageHead
        title="Attendance"
        lede="Everyone starts present. Mark the exceptions — that is what a register actually is."
      >
        {/* A teacher must never be unaware they are holding unsynced work.
            An invisible queue is how a day of attendance quietly disappears
            when a phone is replaced. */}
        {pending > 0 ? (
          <Pill tone="warning">
            {pending} {pending === 1 ? 'register' : 'registers'} waiting to sync
          </Pill>
        ) : null}
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)}
               aria-label="Date" />
        <select value={sectionId} onChange={(e) => setSectionId(e.target.value)}
                aria-label="Section">
          {sections.map((s) => (
            <option key={s.id} value={s.id}>
              {s.class_name} {s.section_name} · {s.learners}
            </option>
          ))}
        </select>
      </PageHead>

      {error ? <div className="note bad">{error}</div> : null}

      <div className="tiles">
        <Tile label="On the roll" loading={!students}
              describe={section ? `${section.class_name} ${section.section_name}` : 'This section'}
              value={String(roll.length)} />
        <Tile label="Present" loading={!students}
              describe={roll.length ? `${counts.late} marked late` : 'Nobody on the roll'}
              value={String(counts.present)}
              meter={roll.length ? counts.present / roll.length : 0} tone="good" />
        <Tile label="Absent" loading={!students}
              describe={counts.absent ? 'Guardians will be notified' : 'Nobody marked absent'}
              value={String(counts.absent)} />
        <Tile label="Session" loading={!students}
              describe={existing ? `${existing.marked} marked, ${existing.absent} absent` : 'Saving will start it'}
              value={existing ? 'Open' : 'Not started'} />
      </div>

      <Panel
        title="Register"
        hint={date}
        actions={
          <>
            <div className="seg" role="group" aria-label="Mark everyone">
              <button onClick={() => setAll('present')}>All present</button>
              <button onClick={() => setAll('absent')}>All absent</button>
            </div>
            <button className="primary" onClick={submit}
                    disabled={busy || roll.length === 0}>
              <Icon.check />
              {busy ? 'Saving…' : existing ? 'Update register' : 'Save register'}
            </button>
          </>
        }
      >
        {students && roll.length === 0 ? (
          <Empty title="No learners in this section">
            Pick another section, or enrol somebody first.
          </Empty>
        ) : (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Learner</th>
                  <th className="opt">Admission no.</th>
                  <th className="w">State</th>
                </tr>
              </thead>
              {students ? (
                <tbody>
                  {roll.map((s) => {
                    const name = [s.given_name, s.family_name].filter(Boolean).join(' ');
                    const state = marks[s.id] ?? 'present';
                    return (
                      <tr key={s.id}>
                        <td>
                          <span className="who2">
                            <Avatar name={name} />
                            <span>
                              <span className="nm">{name}</span>
                              <span className="sub" style={{ display: 'block' }}>
                                {s.admission_no}
                              </span>
                            </span>
                          </span>
                        </td>
                        <td className="opt">{s.admission_no}</td>
                        <td className="w">
                          <div className="seg" role="group"
                               aria-label={`Attendance for ${name}`}>
                            {STATES.map((option) => (
                              <button key={option.value}
                                      className={option.cls}
                                      aria-pressed={state === option.value}
                                      onClick={() =>
                                        setMarks((m) => ({ ...m, [s.id]: option.value }))}>
                                {option.label}
                              </button>
                            ))}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              ) : <SkeletonRows rows={8} cols={3} />}
            </table>
          </div>
        )}
      </Panel>

      <p className="sub" style={{ marginTop: 12 }}>
        Save twice: the second save reports the marks as already on record rather
        than double-recording them. That is the same idempotency the offline
        queue relies on — <Pill>same client event id, same outcome</Pill>
      </p>

      {toast ? <Toast message={toast.message} {...(toast.tone ? { tone: toast.tone } : {})} /> : null}
    </Shell>
  );
}
