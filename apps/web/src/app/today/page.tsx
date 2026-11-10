'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Shell, PageHead } from '../shell';
import { Panel, Empty, Pill } from '@/components/ui';
import { useApiQuery } from '@/lib/query';
import { localIsoDate } from '@/lib/dates';
import { DAYS, clockLabel } from '@/lib/timetable';
import {
  isoWeekday, lessonsOn, lessonStates, untilPhrase, registers,
  type Lesson, type SectionRow, type SessionRow,
} from '@/lib/today';

/**
 * A teacher's day (M45, web).
 *
 * What a teacher needs at 8:50 a.m.: where am I next, whose register have I
 * not taken, and am I covering for anybody. The school's dashboard answers
 * none of those — it is about collections and campuses — and it is what a
 * teacher used to land on.
 *
 * The timetable comes from `timetable/mine`, which finds the teacher from who
 * is signed in. Nothing here takes a staff id, so this page cannot be pointed
 * at somebody else's week.
 */

interface Mine { staff_id: string | null; slots: Lesson[] }
interface Cover {
  section_id: string; section_name: string; class_name: string | null;
  starts_on?: string; ends_on?: string; reason?: string | null;
}

const STATE_LABEL = { done: 'done', now: 'now', next: 'next', later: '' } as const;

export default function TodayPage() {
  const today = localIsoDate();
  const weekday = isoWeekday(today);
  const mine = useApiQuery<Mine>('/v1/timetable/mine');
  const sections = useApiQuery<SectionRow[]>('/v1/sections');
  const sessions = useApiQuery<SessionRow[]>(`/v1/attendance/sessions?date=${today}`);
  const cover = useApiQuery<Cover[]>('/v1/hr/cover/mine');

  // Minutes past midnight, refreshed each half minute so "now" and "next"
  // move on their own while the page sits open on a staff-room screen.
  const [now, setNow] = useState(() => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); });
  useEffect(() => {
    const handle = setInterval(() => {
      const d = new Date();
      setNow(d.getHours() * 60 + d.getMinutes());
    }, 30_000);
    return () => clearInterval(handle);
  }, []);

  const lessons = lessonsOn(mine.data?.slots ?? [], weekday);
  const states = lessonStates(lessons, now);
  const taken = registers(sections.data ?? [], sessions.data ?? []);
  const waiting = taken.filter((r) => r.state !== 'taken').length;
  const dayName = DAYS[weekday - 1]!.name;
  const restOfWeek = DAYS.filter((d) => d.n !== weekday)
    .map((d) => ({ day: d, lessons: lessonsOn(mine.data?.slots ?? [], d.n) }))
    .filter((entry) => entry.lessons.length > 0);

  return (
    <Shell>
      <PageHead title="My day"
                lede={`${dayName}, ${new Date(`${today}T00:00:00`).toLocaleDateString('en-IN', { dateStyle: 'long' })}.`} />

      {(cover.data ?? []).length > 0 ? (
        <div className="note" role="status">
          <strong>You are covering today:</strong>{' '}
          {(cover.data ?? []).map((c) => `${c.class_name ?? ''} ${c.section_name}`.trim()).join(', ')}.
          Those registers are yours to take as well.
        </div>
      ) : null}

      <Panel title="Lessons today"
             hint={mine.data && mine.data.staff_id === null
               ? 'Your account is not linked to a staff record, so there is no timetable to show.'
               : lessons.length > 0 ? `${lessons.length} on your timetable` : undefined}>
        {mine.isLoading ? <div className="body sub">Loading…</div>
          : mine.isError ? <div className="note bad" style={{ margin: 16 }}>{mine.error.message}</div>
          : lessons.length === 0 ? (
            <Empty title={`No lessons on your timetable for ${dayName}`}>
              {restOfWeek.length > 0 ? 'The rest of your week is below.' : 'The office adds lessons under Timetable.'}
            </Empty>
          ) : (
            <ol className="day">
              {lessons.map((lesson, index) => {
                const state = states[index]!;
                return (
                  <li key={lesson.id} className={`is-${state}`}>
                    <span className="time">
                      {clockLabel(lesson.starts_at)}
                      <span className="sub">to {clockLabel(lesson.ends_at)}</span>
                    </span>
                    <span className="what">
                      <strong>{lesson.subject_name}</strong>
                      <span className="sub">
                        {`${lesson.class_name} ${lesson.section_name ?? ''}`.trim()}
                        {lesson.room_name ? ` · ${lesson.room_name}` : ''}
                      </span>
                    </span>
                    {state === 'now' ? <Pill tone="good">now</Pill>
                      : state === 'next' ? <Pill tone="warning">next, {untilPhrase(lesson.starts_at, now)}</Pill>
                      : STATE_LABEL[state] ? <span className="sub">{STATE_LABEL[state]}</span> : null}
                  </li>
                );
              })}
            </ol>
          )}
      </Panel>

      <Panel title="Registers"
             hint={sections.data
               ? waiting === 0 && taken.length > 0 ? 'All taken for today.' : `${waiting} still to take`
               : undefined}
             actions={<Link className="btn primary" href="/attendance">Take a register</Link>}>
        {!sections.data || !sessions.data ? <div className="body sub">Loading…</div>
          : taken.length === 0 ? <Empty title="No class is yours to mark" />
          : (
            <div className="scroll"><table>
              <thead><tr><th>Class</th><th className="num">Learners</th><th>Today</th></tr></thead>
              <tbody>
                {taken.map((r) => (
                  <tr key={r.section.id}>
                    <td><strong>{r.section.class_name} {r.section.section_name}</strong></td>
                    <td className="num">{r.section.learners}</td>
                    <td>
                      {r.state === 'taken'
                        ? <Pill tone="good">taken · {r.absent} absent</Pill>
                        : r.state === 'in_progress'
                          ? <Pill tone="warning">started, not finished · {r.marked} marked</Pill>
                          : <Pill tone="critical">not taken</Pill>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          )}
      </Panel>

      {restOfWeek.length > 0 ? (
        <Panel title="The rest of your week">
          <div className="scroll"><table>
            <thead><tr><th>Day</th><th>Lessons</th></tr></thead>
            <tbody>
              {restOfWeek.map(({ day, lessons: list }) => (
                <tr key={day.n}>
                  <td><strong>{day.name}</strong></td>
                  <td>
                    <span className="chips">
                      {list.map((l) => (
                        <span className="chip" key={l.id}>
                          {clockLabel(l.starts_at)} {l.subject_name} · {`${l.class_name} ${l.section_name ?? ''}`.trim()}
                        </span>
                      ))}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table></div>
        </Panel>
      ) : null}
    </Shell>
  );
}
