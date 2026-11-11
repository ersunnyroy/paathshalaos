'use client';

import { useEffect, useMemo, useState } from 'react';
import { ConfirmButton } from '@/components/confirm';
import { Pill } from '@/components/ui';
import { apiGet } from '@/lib/api';
import { isoWeekday } from '@/lib/today';
import {
  fullName, gaps, type Assigned, type CoverLesson, type Person, type SectionRef,
} from '@/lib/cover';

type Weeks = Record<string, CoverLesson[]>;

/**
 * The lessons an absent teacher leaves behind on a day, and who is free to
 * take each. One click (and a second to confirm) assigns the cover.
 */
export function CoverGaps({ day, absent, assigned, staff, sections, busy, onAssign }: {
  day: string;
  absent: Person[]; assigned: Assigned[];
  staff: Person[]; sections: SectionRef[]; busy: boolean;
  onAssign: (body: {
    sectionId: string; coveringStaffId: string; absentStaffId: string;
  }, done: string) => Promise<void>;
}) {
  const [weeks, setWeeks] = useState<Weeks | null>(null);
  const [failed, setFailed] = useState(false);
  const [picked, setPicked] = useState<Record<string, string>>({});
  const ids = useMemo(
    () => staff.filter((s) => !s.left_on).map((s) => s.staff_id).sort().join(','), [staff]);

  // A week does not change with the day picked, so it is read once per roster.
  useEffect(() => {
    if (ids === '') return;
    let live = true;
    setWeeks(null); setFailed(false);
    (async () => {
      const out: Weeks = {};
      const all = ids.split(',');
      // A few at a time: a school of eighty staff should not open eighty requests at once.
      for (let i = 0; i < all.length; i += 6) {
        await Promise.all(all.slice(i, i + 6).map(async (id) => {
          out[id] = await apiGet<CoverLesson[]>(`/v1/timetable/staff/${id}`);
        }));
      }
      if (live) setWeeks(out);
    })().catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [ids]);

  const list = useMemo(() => weeks === null ? [] : gaps({
    weekday: isoWeekday(day), absent, staff, weeks, assigned, sections,
  }), [weeks, day, absent, staff, assigned, sections]);

  if (absent.length === 0) return null;
  if (failed) {
    return <p className="sub cover-gaps-note">The timetable could not be read, so
      nobody is suggested. Cover can still be assigned below.</p>;
  }
  if (weeks === null) return <p className="sub cover-gaps-note">Reading the timetable…</p>;
  if (list.length === 0) {
    return <p className="sub cover-gaps-note">Nobody who is away has a lesson on the
      timetable for this day.</p>;
  }

  return (
    <div className="cover-gaps">
      <h3>Lessons left without a teacher</h3>
      <ul>
        {list.map((g) => {
          const key = `${g.absent.staff_id}:${g.lesson.id}`;
          const sectionId = g.sections.length === 1 ? g.sections[0]!.id : (picked[key] ?? '');
          return (
            <li key={key}>
              <div className="what">
                <strong>{g.label}</strong>
                <span className="sub">for {fullName(g.absent)}</span>
              </div>
              {g.cover ? (
                <Pill tone="good">Covered by {g.cover.covering_name}</Pill>
              ) : g.sections.length === 0 ? (
                <span className="sub">This class has no section to assign cover to.</span>
              ) : (
                <div className="who">
                  {g.sections.length > 1 ? (
                    <select value={sectionId} aria-label="Which section"
                            onChange={(e) => setPicked((m) => ({ ...m, [key]: e.target.value }))}>
                      <option value="">Which section…</option>
                      {g.sections.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.class_name ? `${s.class_name} ` : ''}{s.section_name}
                        </option>
                      ))}
                    </select>
                  ) : null}
                  {g.suggestions.length === 0 ? (
                    <span className="sub">Nobody on the timetable is free then.</span>
                  ) : g.suggestions.map((c) => (
                    <span key={c.staff_id} className="pick">
                      <ConfirmButton label={c.name} confirmLabel={`Assign ${c.name}?`}
                                     disabled={busy || sectionId === ''}
                                     onConfirm={() => onAssign({
                                       sectionId, coveringStaffId: c.staff_id,
                                       absentStaffId: g.absent.staff_id,
                                     }, `${c.name} covers ${g.lesson.class_name}.`)} />
                      <span className="sub">{c.why}</span>
                    </span>
                  ))}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
