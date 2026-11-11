/**
 * A teacher's day (M45).
 *
 * The timetable is a week of recurring lessons; a day is the part of it that
 * falls on today's weekday, in the order it happens, with one question
 * answered for each lesson: is it over, is it now, is it next.
 */
import { minutes } from './timetable';

export interface Lesson {
  id: string; day_of_week: number; starts_at: string; ends_at: string;
  subject_name: string; class_name: string; section_name: string | null; room_name: string | null;
}

/** ISO weekday for a calendar date: Monday is 1, Sunday is 7. */
export function isoWeekday(isoDate: string): number {
  // Noon UTC, so no timezone can pull the date across midnight.
  const day = new Date(`${isoDate}T12:00:00Z`).getUTCDay();
  return day === 0 ? 7 : day;
}

/** Today's lessons, earliest first. */
export function lessonsOn<T extends Lesson>(week: readonly T[], weekday: number): T[] {
  return week
    .filter((l) => l.day_of_week === weekday)
    .sort((a, b) => minutes(a.starts_at) - minutes(b.starts_at) || minutes(a.ends_at) - minutes(b.ends_at));
}

export type LessonState = 'done' | 'now' | 'next' | 'later';

/**
 * Where each of today's lessons stands at `nowMinutes` past midnight.
 *
 * A lesson is "now" from its first minute up to, not including, its last —
 * at 9:40 a 9:00–9:40 lesson is over and the 9:40 one has begun. Exactly one
 * lesson is "next": the first that has not started. Given in the same order
 * as the lessons.
 */
export function lessonStates(today: readonly Lesson[], nowMinutes: number): LessonState[] {
  let nextGiven = false;
  return today.map((lesson) => {
    const from = minutes(lesson.starts_at);
    const to = minutes(lesson.ends_at);
    if (nowMinutes >= to) return 'done';
    if (nowMinutes >= from) return 'now';
    if (!nextGiven) { nextGiven = true; return 'next'; }
    return 'later';
  });
}

/** "in 25 min", "in 2 h 5 min" — how long until a lesson starts. */
export function untilPhrase(startsAt: string, nowMinutes: number): string {
  const gap = minutes(startsAt) - nowMinutes;
  if (Number.isNaN(gap) || gap <= 0) return 'now';
  if (gap < 60) return `in ${gap} min`;
  const hours = Math.floor(gap / 60);
  const rest = gap % 60;
  return rest === 0 ? `in ${hours} h` : `in ${hours} h ${rest} min`;
}

export interface SectionRow { id: string; section_name: string; class_name: string; learners: number }
export interface SessionRow { section_id: string; status: string; marked: number; absent: number }

export interface RegisterState {
  section: SectionRow;
  state: 'not_taken' | 'in_progress' | 'taken';
  marked: number; absent: number;
}

/**
 * Whether each of the teacher's sections has had its register taken today.
 *
 * "Taken" means a session exists and is no longer open; a session that is
 * open, or exists with nobody marked, is still in progress — the register a
 * teacher started and was called away from is the one that gets forgotten.
 * A section with no learners is left out: there is no register to take.
 */
export function registers(sections: readonly SectionRow[], sessions: readonly SessionRow[]): RegisterState[] {
  return sections
    .filter((s) => s.learners > 0)
    .map((section) => {
      const session = sessions.find((s) => s.section_id === section.id);
      if (!session) return { section, state: 'not_taken' as const, marked: 0, absent: 0 };
      const open = session.status === 'open' || session.status === 'draft' || session.marked === 0;
      return {
        section, state: open ? 'in_progress' as const : 'taken' as const,
        marked: session.marked, absent: session.absent,
      };
    });
}
