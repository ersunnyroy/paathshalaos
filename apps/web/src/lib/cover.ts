/**
 * Who can stand in for a teacher who is away.
 *
 * The office knows who is absent; what it does not have in its head at 7:40 in
 * the morning is who is free in third period and already knows the class. This
 * works that out from the timetable. It suggests; a person assigns.
 */
import { clockLabel, overlaps } from './timetable';
import { lessonsOn } from './today';

export interface CoverLesson {
  id: string; day_of_week: number; starts_at: string; ends_at: string;
  subject_name: string; class_name: string; section_id: string | null;
  section_name: string | null; room_name: string | null;
}
export interface Person { staff_id: string; given_name: string; family_name: string | null; left_on?: string | null }
export interface Assigned {
  section_id: string; covering_staff_id: string; covering_name: string;
  absent_staff_id: string | null;
}
export interface SectionRef { id: string; section_name: string; class_name: string | null }

export const fullName = (p: { given_name: string; family_name: string | null }) =>
  `${p.given_name}${p.family_name ? ` ${p.family_name}` : ''}`;

/**
 * The sections a lesson's cover could be assigned to.
 *
 * Cover is granted on a section, never on "a class": a lesson the whole class
 * takes together has no section of its own, so every section of that class is
 * offered and the office picks.
 */
export function sectionsFor(lesson: CoverLesson, sections: readonly SectionRef[]): SectionRef[] {
  if (lesson.section_id !== null) return sections.filter((s) => s.id === lesson.section_id);
  return sections.filter((s) => s.class_name === lesson.class_name);
}

/** Who already covers this lesson's class for the absent teacher, if anybody. */
export function coveredBy(
  lesson: CoverLesson, absentStaffId: string,
  assigned: readonly Assigned[], sections: readonly SectionRef[],
): Assigned | null {
  const ids = new Set(sectionsFor(lesson, sections).map((s) => s.id));
  return assigned.find(
    (a) => a.absent_staff_id === absentStaffId && ids.has(a.section_id)) ?? null;
}

export interface Candidate {
  staff_id: string; name: string;
  knowsClass: boolean; sameSubject: boolean;
  /** Lessons of their own that day, plus classes they already cover. */
  load: number;
  why: string;
}

function sameClass(a: CoverLesson, b: CoverLesson): boolean {
  if (a.class_name !== b.class_name) return false;
  // A whole-class lesson on either side means they meet the same children.
  return a.section_id === null || b.section_id === null || a.section_id === b.section_id;
}

/**
 * Teachers who could take `lesson`, best first.
 *
 * Left out: anybody away that day, anybody who has left, anybody teaching at
 * that time, and anybody with no lessons at all on the timetable — the
 * accountant is always "free", and is not who a class needs.
 *
 * Order: somebody who already teaches these children, then somebody who
 * teaches the subject, then whoever has the lightest day, so the same willing
 * person is not handed every gap.
 */
export function candidates(
  lesson: CoverLesson, weekday: number,
  staff: readonly Person[], weeks: Readonly<Record<string, readonly CoverLesson[]>>,
  awayIds: ReadonlySet<string>, assigned: readonly Assigned[],
): Candidate[] {
  const out: Candidate[] = [];
  for (const person of staff) {
    if (awayIds.has(person.staff_id) || person.left_on) continue;
    const week = weeks[person.staff_id] ?? [];
    if (week.length === 0) continue;
    const day = lessonsOn(week, weekday);
    if (day.some((l) => overlaps(lesson.starts_at, lesson.ends_at, l.starts_at, l.ends_at))) continue;
    const covering = assigned.filter((a) => a.covering_staff_id === person.staff_id).length;
    const knowsClass = week.some((l) => sameClass(l, lesson));
    const sameSubject = week.some((l) => l.subject_name === lesson.subject_name);
    const load = day.length + covering;
    const parts = [
      knowsClass ? 'teaches this class' : '',
      sameSubject ? `teaches ${lesson.subject_name}` : '',
      day.length === 0 ? 'no lessons that day'
        : `${day.length} ${day.length === 1 ? 'lesson' : 'lessons'} that day`,
      covering > 0 ? `already covering ${covering}` : '',
    ].filter(Boolean);
    out.push({ staff_id: person.staff_id, name: fullName(person),
      knowsClass, sameSubject, load, why: parts.join(' · ') });
  }
  return out.sort((a, b) =>
    Number(b.knowsClass) - Number(a.knowsClass)
    || Number(b.sameSubject) - Number(a.sameSubject)
    || a.load - b.load
    || a.name.localeCompare(b.name));
}

export interface Gap {
  absent: Person; lesson: CoverLesson; label: string;
  cover: Assigned | null; sections: SectionRef[]; suggestions: Candidate[];
}

/** Every lesson left without its teacher on a day, earliest first, with who could take it. */
export function gaps(input: {
  weekday: number; absent: readonly Person[]; staff: readonly Person[];
  weeks: Readonly<Record<string, readonly CoverLesson[]>>;
  assigned: readonly Assigned[]; sections: readonly SectionRef[]; limit?: number;
}): Gap[] {
  const away = new Set(input.absent.map((a) => a.staff_id));
  const out: Gap[] = [];
  for (const absent of input.absent) {
    for (const lesson of lessonsOn(input.weeks[absent.staff_id] ?? [], input.weekday)) {
      const cover = coveredBy(lesson, absent.staff_id, input.assigned, input.sections);
      out.push({
        absent, lesson, cover,
        label: `${clockLabel(lesson.starts_at)}–${clockLabel(lesson.ends_at)} · ${lesson.subject_name} · `
          + `${lesson.class_name}${lesson.section_name ? ` ${lesson.section_name}` : ''}`,
        sections: sectionsFor(lesson, input.sections),
        suggestions: cover ? [] : candidates(lesson, input.weekday, input.staff,
          input.weeks, away, input.assigned).slice(0, input.limit ?? 3),
      });
    }
  }
  return out;
}
