'use client';

import { useMemo, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Shell, PageHead } from '../shell';
import { Panel, Empty, Pill, SkeletonRows } from '@/components/ui';
import { apiPost, ApiError } from '@/lib/api';
import { useApiQuery, apiKey } from '@/lib/query';
import { orderClasses } from '@/lib/structure';
import {
  DAYS, buildGrid, cellKey, clockLabel, timeProblem, clashesWith, suggestNext, type Slot,
} from '@/lib/timetable';

/**
 * A class's week (M42).
 *
 * Two things on one page because one is useless without the other: which
 * subjects the class takes this term and who teaches them, and when each one
 * meets. A lesson is a subject-for-a-class placed on a day; it cannot be
 * placed until the subject has been given to the class.
 *
 * The page checks only that a new lesson does not land on one of this class's
 * own lessons. A teacher or a room that is busy elsewhere is refused by the
 * database, and what it says is shown as it is.
 *
 * Lessons cannot be removed here yet: the API has no route for it.
 */

interface Year { id: string; label: string; status: string }
interface Term { id: string; label: string; sequence: number; starts_on: string; ends_on: string }
interface ClassGroup { id: string; name: string; level_sequence: number | null }
interface Section { id: string; name: string }
interface Offering {
  id: string; class_group_id: string; section_id: string | null; subject_id: string; term_id: string;
  primary_teacher_staff_id: string | null; subject_name: string; section_name: string | null;
}
interface Subject { id: string; code: string; name: string }
interface Staff { staff_id: string; given_name: string; family_name: string | null; status: string }
interface Room { id: string; code: string; name: string }

const staffName = (s: Staff) => [s.given_name, s.family_name].filter(Boolean).join(' ');

export default function TimetablePage() {
  const years = useApiQuery<Year[]>('/v1/structure/years');
  const year = years.data?.find((y) => y.status === 'active') ?? years.data?.[0] ?? null;
  const groups = useApiQuery<ClassGroup[]>(year ? `/v1/structure/class-groups?academicYearId=${year.id}` : null);
  const terms = useApiQuery<Term[]>(year ? `/v1/structure/years/${year.id}/terms` : null);
  const staff = useApiQuery<Staff[]>('/v1/hr/staff');
  const rooms = useApiQuery<Room[]>('/v1/structure/rooms');

  const [pickedGroup, setPickedGroup] = useState('');
  const ordered = useMemo(() => orderClasses(groups.data ?? []), [groups.data]);
  const groupId = pickedGroup || ordered[0]?.id || '';
  const group = ordered.find((g) => g.id === groupId) ?? null;

  const sections = useApiQuery<Section[]>(groupId ? `/v1/structure/class-groups/${groupId}/sections` : null);
  const [pickedSection, setPickedSection] = useState('');
  const sectionId = sections.data?.some((s) => s.id === pickedSection)
    ? pickedSection : sections.data?.[0]?.id ?? '';
  const section = sections.data?.find((s) => s.id === sectionId) ?? null;

  const offeringsPath = groupId ? `/v1/structure/course-offerings?classGroupId=${groupId}` : null;
  const offerings = useApiQuery<Offering[]>(offeringsPath);
  const weekPath = sectionId ? `/v1/timetable/sections/${sectionId}` : null;
  const week = useApiQuery<Slot[]>(weekPath);

  const [addingOffering, setAddingOffering] = useState(false);
  const [addingLesson, setAddingLesson] = useState(false);

  const teacherOf = (id: string | null) => {
    const found = (staff.data ?? []).find((s) => s.staff_id === id);
    return found ? staffName(found) : null;
  };
  const termOf = (id: string) => (terms.data ?? []).find((t) => t.id === id)?.label ?? '—';
  // What this section takes: offerings for the whole class, plus its own.
  const forSection = (offerings.data ?? []).filter((o) => o.section_id === null || o.section_id === sectionId);
  const grid = buildGrid(week.data ?? []);
  const offeringById = new Map((offerings.data ?? []).map((o) => [o.id, o]));

  return (
    <Shell>
      <PageHead title="Timetable"
                lede={year ? `Academic year ${year.label}. Choose a class to see its week.` : 'Add an academic year first, under School structure.'}>
        <select value={groupId} onChange={(e) => { setPickedGroup(e.target.value); setPickedSection(''); }}
                aria-label="Class">
          {ordered.length === 0 ? <option value="">No classes</option> : null}
          {ordered.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
        </select>
        <select value={sectionId} onChange={(e) => setPickedSection(e.target.value)} aria-label="Section">
          {(sections.data ?? []).length === 0 ? <option value="">No sections</option> : null}
          {(sections.data ?? []).map((s) => <option key={s.id} value={s.id}>Section {s.name}</option>)}
        </select>
      </PageHead>

      <Panel title={group && section ? `${group.name} ${section.name} — the week` : 'The week'}
             hint="Rows are the periods this class actually has. A teacher or room already booked elsewhere is refused when you save."
             actions={<button className="primary" disabled={!sectionId || forSection.length === 0}
                              onClick={() => setAddingLesson(true)}>Add lesson</button>}>
        {!sectionId ? <Empty title="This class has no section yet">Add one under School structure.</Empty>
          : week.isLoading ? <div className="body sub">Loading…</div>
          : grid.bands.length === 0 ? (
            <Empty title="Nothing on the timetable yet">
              {forSection.length === 0
                ? 'Give this class its subjects below, then place them in the week.'
                : 'Use Add lesson to place a subject on one or more days.'}
            </Empty>
          ) : (
            <div className="scroll">
              <table className="week">
                <thead>
                  <tr>
                    <th>Period</th>
                    {grid.days.map((d) => <th key={d}>{DAYS[d - 1]!.short}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {grid.bands.map((band, index) => (
                    <tr key={`${band.startsAt}-${band.endsAt}`}>
                      <th scope="row">
                        {clockLabel(band.startsAt)}
                        <span className="sub" style={{ display: 'block' }}>to {clockLabel(band.endsAt)}</span>
                      </th>
                      {grid.days.map((d) => {
                        const lessons = grid.cells.get(cellKey(d, index)) ?? [];
                        return (
                          <td key={d}>
                            {lessons.map((lesson) => {
                              const teacher = teacherOf(lesson.staff_id
                                ?? offeringById.get(lesson.course_offering_id)?.primary_teacher_staff_id ?? null);
                              return (
                                <div className="lesson" key={lesson.id}>
                                  <strong>{lesson.subject_name}</strong>
                                  {teacher ? <span>{teacher}</span> : null}
                                  {lesson.room_name ? <span>{lesson.room_name}</span> : null}
                                </div>
                              );
                            })}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </Panel>

      <Panel title={group ? `Subjects ${group.name} takes` : 'Subjects'}
             hint="A subject has to be given to the class for a term before it can go on the timetable."
             actions={<button disabled={!groupId} onClick={() => setAddingOffering(true)}>Add subject to class</button>}>
        <div className="scroll"><table>
          <thead><tr><th>Subject</th><th>Term</th><th>For</th><th>Teacher</th></tr></thead>
          {!offerings.data ? <SkeletonRows cols={4} rows={2} /> : offerings.data.length === 0 ? (
            <tbody><tr><td colSpan={4}><Empty title="No subjects given to this class yet" /></td></tr></tbody>
          ) : (
            <tbody>
              {offerings.data.map((o) => (
                <tr key={o.id}>
                  <td><strong>{o.subject_name}</strong></td>
                  <td>{termOf(o.term_id)}</td>
                  <td>{o.section_name ? <Pill>Section {o.section_name} only</Pill> : 'Whole class'}</td>
                  <td>{teacherOf(o.primary_teacher_staff_id) ?? <span className="sub">Not assigned</span>}</td>
                </tr>
              ))}
            </tbody>
          )}
        </table></div>
      </Panel>

      {addingOffering && offeringsPath && group ? (
        <AddOffering group={group} terms={terms.data ?? []} staff={staff.data ?? []}
                     existing={offerings.data ?? []} listPath={offeringsPath}
                     onClose={() => setAddingOffering(false)} />
      ) : null}
      {addingLesson && weekPath && section && group ? (
        <AddLesson title={`${group.name} ${section.name}`} sectionId={section.id}
                   offerings={forSection} termOf={termOf} week={week.data ?? []}
                   staff={staff.data ?? []} rooms={rooms.data ?? []} weekPath={weekPath}
                   onClose={() => setAddingLesson(false)} />
      ) : null}
    </Shell>
  );
}

function AddOffering({ group, terms, staff, existing, listPath, onClose }: {
  group: ClassGroup; terms: Term[]; staff: Staff[]; existing: Offering[]; listPath: string; onClose: () => void;
}) {
  const subjects = useApiQuery<Subject[]>('/v1/structure/subjects');
  const client = useQueryClient();
  const [subjectId, setSubjectId] = useState('');
  const [termId, setTermId] = useState(terms[0]?.id ?? '');
  const [teacherId, setTeacherId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (!subjectId || !termId) { setError('Choose a subject and a term.'); return; }
    if (existing.some((o) => o.subject_id === subjectId && o.term_id === termId && o.section_id === null)) {
      setError('This class already takes that subject in that term.'); return;
    }
    setBusy(true);
    try {
      await apiPost('/v1/structure/course-offerings', {
        classGroupId: group.id, subjectId, termId,
        ...(teacherId ? { primaryTeacherStaffId: teacherId } : {}),
      });
      await client.invalidateQueries({ queryKey: apiKey(listPath) });
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'That did not save.');
    } finally { setBusy(false); }
  }

  return (
    <div className="sheet-backdrop" onMouseDown={onClose}>
      <form className="sheet" onSubmit={submit} onMouseDown={(e) => e.stopPropagation()}>
        <h2>Add a subject to {group.name}</h2>
        <p className="lede">For the whole class. The teacher can be left for later.</p>
        <label htmlFor="off-subject">Subject</label>
        <select id="off-subject" value={subjectId} onChange={(e) => setSubjectId(e.target.value)} required>
          <option value="">Choose…</option>
          {(subjects.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <label htmlFor="off-term">Term</label>
        <select id="off-term" value={termId} onChange={(e) => setTermId(e.target.value)} required>
          {terms.length === 0 ? <option value="">This year has no terms</option> : null}
          {terms.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
        </select>
        <label htmlFor="off-teacher">Teacher (optional)</label>
        <select id="off-teacher" value={teacherId} onChange={(e) => setTeacherId(e.target.value)}>
          <option value="">Not assigned yet</option>
          {staff.filter((s) => s.status === 'active').map((s) => (
            <option key={s.staff_id} value={s.staff_id}>{staffName(s)}</option>
          ))}
        </select>
        {error ? <div className="note bad" style={{ marginTop: 12 }}>{error}</div> : null}
        <div className="row" style={{ marginTop: 16, justifyContent: 'flex-end' }}>
          <button type="button" className="ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="primary" disabled={busy}>{busy ? 'Saving…' : 'Add subject'}</button>
        </div>
      </form>
    </div>
  );
}

function AddLesson({ title, sectionId, offerings, termOf, week, staff, rooms, weekPath, onClose }: {
  title: string; sectionId: string; offerings: Offering[]; termOf: (id: string) => string;
  week: Slot[]; staff: Staff[]; rooms: Room[]; weekPath: string; onClose: () => void;
}) {
  const client = useQueryClient();
  const [offeringId, setOfferingId] = useState(offerings[0]?.id ?? '');
  const [days, setDays] = useState<number[]>([1]);
  const first = suggestNext(week, [1]);
  const [startsAt, setStartsAt] = useState(first?.startsAt ?? '09:00');
  const [endsAt, setEndsAt] = useState(first?.endsAt ?? '09:40');
  const [roomId, setRoomId] = useState('');
  const [teacherId, setTeacherId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const offering = offerings.find((o) => o.id === offeringId) ?? null;

  function toggle(day: number) {
    setDays((current) => (current.includes(day) ? current.filter((d) => d !== day) : [...current, day].sort()));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (!offering) { setError('Choose a subject.'); return; }
    if (days.length === 0) { setError('Choose at least one day.'); return; }
    const problem = timeProblem(startsAt, endsAt);
    if (problem) { setError(problem); return; }
    const clash = clashesWith(week, days, startsAt, endsAt)[0];
    if (clash) {
      setError(`${title} already has ${clash.subject_name} on ${DAYS[clash.day_of_week - 1]!.name} from ${clockLabel(clash.starts_at)} to ${clockLabel(clash.ends_at)}.`);
      return;
    }

    setBusy(true);
    const saved: string[] = [];
    try {
      // One request a day, in order, stopping at the first refusal. The days
      // that did save stay saved and are named, so nobody has to guess which
      // half of a five-day lesson went in.
      for (const day of days) {
        await apiPost('/v1/structure/schedule-slots', {
          courseOfferingId: offering.id,
          // A lesson for the whole class carries no section; one for this
          // section's own offering carries it.
          ...(offering.section_id ? { sectionId } : {}),
          ...(roomId ? { roomId } : {}),
          ...(teacherId || offering.primary_teacher_staff_id
            ? { staffId: teacherId || offering.primary_teacher_staff_id } : {}),
          dayOfWeek: day, startsAt, endsAt,
        });
        saved.push(DAYS[day - 1]!.name);
      }
      await client.invalidateQueries({ queryKey: apiKey(weekPath) });
      onClose();
    } catch (e) {
      const failedOn = DAYS[(days[saved.length] ?? 1) - 1]!.name;
      setDone(saved);
      setDays(days.slice(saved.length));
      setError(`${failedOn}: ${e instanceof ApiError ? e.message : 'that did not save.'}`);
      await client.invalidateQueries({ queryKey: apiKey(weekPath) });
    } finally { setBusy(false); }
  }

  return (
    <div className="sheet-backdrop" onMouseDown={onClose}>
      <form className="sheet wide" onSubmit={submit} onMouseDown={(e) => e.stopPropagation()}>
        <h2>Add a lesson for {title}</h2>
        <label htmlFor="lesson-offering">Subject</label>
        <select id="lesson-offering" value={offeringId} onChange={(e) => setOfferingId(e.target.value)}>
          {offerings.map((o) => (
            <option key={o.id} value={o.id}>{o.subject_name} — {termOf(o.term_id)}</option>
          ))}
        </select>

        <label>Days</label>
        <div className="chips">
          {DAYS.slice(0, 6).map((d) => (
            <label key={d.n} className="check chipcheck">
              <input type="checkbox" checked={days.includes(d.n)} onChange={() => toggle(d.n)} />
              {d.short}
            </label>
          ))}
        </div>

        <div className="grid2">
          <div>
            <label htmlFor="lesson-start">Starts</label>
            <input id="lesson-start" type="time" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} required />
          </div>
          <div>
            <label htmlFor="lesson-end">Ends</label>
            <input id="lesson-end" type="time" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} required />
          </div>
        </div>

        <div className="grid2">
          <div>
            <label htmlFor="lesson-teacher">Teacher</label>
            <select id="lesson-teacher" value={teacherId} onChange={(e) => setTeacherId(e.target.value)}>
              <option value="">
                {offering?.primary_teacher_staff_id ? "The subject's own teacher" : 'Not assigned'}
              </option>
              {staff.filter((s) => s.status === 'active').map((s) => (
                <option key={s.staff_id} value={s.staff_id}>{staffName(s)}</option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="lesson-room">Room</label>
            <select id="lesson-room" value={roomId} onChange={(e) => setRoomId(e.target.value)}>
              <option value="">No room</option>
              {rooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </div>
        </div>

        {done.length > 0 ? <div className="note" style={{ marginTop: 12 }}>Saved: {done.join(', ')}.</div> : null}
        {error ? <div className="note bad" style={{ marginTop: 12 }}>{error}</div> : null}
        <div className="row" style={{ marginTop: 16, justifyContent: 'flex-end' }}>
          <button type="button" className="ghost" onClick={onClose}>{done.length > 0 ? 'Close' : 'Cancel'}</button>
          <button type="submit" className="primary" disabled={busy}>
            {busy ? 'Saving…' : days.length > 1 ? `Add on ${days.length} days` : 'Add lesson'}
          </button>
        </div>
      </form>
    </div>
  );
}
