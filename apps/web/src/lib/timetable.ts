/**
 * Laying out a week (M42).
 *
 * The database is what stops two classes being put in one room or one teacher
 * in two places — exclusion constraints, which no screen can get round. What
 * lives here is the drawing: turning a list of recurring lessons into a grid
 * whose rows are the times this class actually meets, and catching the one
 * clash a person can see coming, this class with itself, before the request.
 */

export interface Slot {
  id: string; course_offering_id: string; section_id: string | null;
  room_id: string | null; staff_id: string | null;
  day_of_week: number; starts_at: string; ends_at: string;
  subject_name: string; room_name: string | null;
}

/** ISO-8601: Monday is 1. A timetable that is one day out looks right on a screen. */
export const DAYS = [
  { n: 1, short: 'Mon', name: 'Monday' }, { n: 2, short: 'Tue', name: 'Tuesday' },
  { n: 3, short: 'Wed', name: 'Wednesday' }, { n: 4, short: 'Thu', name: 'Thursday' },
  { n: 5, short: 'Fri', name: 'Friday' }, { n: 6, short: 'Sat', name: 'Saturday' },
  { n: 7, short: 'Sun', name: 'Sunday' },
] as const;

/** "09:00:00" or "09:00" as minutes after midnight; NaN if it is neither. */
export function minutes(clock: string): number {
  const match = /^([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/.exec(clock.trim());
  return match ? Number(match[1]) * 60 + Number(match[2]) : Number.NaN;
}

/** "09:00:00" as "9:00" and "14:30" as "2:30 pm": mornings bare, afternoons marked, as a printed timetable has them. */
export function clockLabel(clock: string): string {
  const m = minutes(clock);
  if (Number.isNaN(m)) return clock;
  const hour = Math.floor(m / 60);
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return `${twelve}:${String(m % 60).padStart(2, '0')}${hour < 12 ? '' : ' pm'}`;
}

/** The first thing wrong with a lesson's times, or null. */
export function timeProblem(startsAt: string, endsAt: string): string | null {
  const from = minutes(startsAt);
  const to = minutes(endsAt);
  if (Number.isNaN(from) || Number.isNaN(to)) return 'Give both times, like 09:00 and 09:40.';
  if (to <= from) return 'A lesson has to end after it starts.';
  if (to - from > 240) return 'That is longer than four hours. Check the end time.';
  return null;
}

/** Two periods share time if each starts before the other ends. Touching ends do not clash. */
export function overlaps(aFrom: string, aTo: string, bFrom: string, bTo: string): boolean {
  return minutes(aFrom) < minutes(bTo) && minutes(bFrom) < minutes(aTo);
}

/**
 * Lessons this class already has that the new one would sit on top of.
 *
 * Only this section's own week: a clash with another class's room or teacher
 * is the database's to refuse, because this page has not loaded those weeks.
 */
export function clashesWith(
  existing: readonly Slot[], days: readonly number[], startsAt: string, endsAt: string,
): Slot[] {
  return existing.filter((slot) =>
    days.includes(slot.day_of_week) && overlaps(startsAt, endsAt, slot.starts_at, slot.ends_at));
}

export interface Band { startsAt: string; endsAt: string }
export interface Grid {
  bands: Band[];
  days: number[];
  /** `cell(day, bandIndex)` → the lessons there, usually one. */
  cells: Map<string, Slot[]>;
}

export const cellKey = (day: number, band: number) => `${day}:${band}`;

/**
 * A week as rows of time and columns of days.
 *
 * Rows are the distinct start-and-end pairs that occur, in time order — not a
 * fixed bell schedule, because the product does not know one and a school
 * with a 35-minute first period should not be drawn on a 40-minute grid.
 * Monday to Saturday are always shown; Sunday appears only if something is on it.
 */
export function buildGrid(slots: readonly Slot[]): Grid {
  const seen = new Map<string, Band>();
  for (const slot of slots) {
    const key = `${minutes(slot.starts_at)}-${minutes(slot.ends_at)}`;
    if (!seen.has(key)) seen.set(key, { startsAt: slot.starts_at, endsAt: slot.ends_at });
  }
  const bands = [...seen.values()].sort((a, b) =>
    minutes(a.startsAt) - minutes(b.startsAt) || minutes(a.endsAt) - minutes(b.endsAt));

  const cells = new Map<string, Slot[]>();
  for (const slot of slots) {
    const band = bands.findIndex((b) =>
      minutes(b.startsAt) === minutes(slot.starts_at) && minutes(b.endsAt) === minutes(slot.ends_at));
    const key = cellKey(slot.day_of_week, band);
    cells.set(key, [...(cells.get(key) ?? []), slot]);
  }
  const days = [1, 2, 3, 4, 5, 6];
  if (slots.some((s) => s.day_of_week === 7)) days.push(7);
  return { bands, days, cells };
}

/** The next period after the last one on these days: same length, starting when it ends. */
export function suggestNext(existing: readonly Slot[], days: readonly number[]): Band | null {
  const onDays = existing.filter((s) => days.includes(s.day_of_week));
  if (onDays.length === 0) return null;
  const last = onDays.reduce((a, b) => (minutes(b.ends_at) > minutes(a.ends_at) ? b : a));
  const length = minutes(last.ends_at) - minutes(last.starts_at);
  const start = minutes(last.ends_at);
  const end = start + length;
  if (end >= 24 * 60) return null;
  const clock = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  return { startsAt: clock(start), endsAt: clock(end) };
}
