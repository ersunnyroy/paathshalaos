import { describe, it, expect } from 'vitest';
import {
  minutes, clockLabel, timeProblem, overlaps, clashesWith, buildGrid, cellKey, suggestNext,
  DAYS, type Slot,
} from '../src/lib/timetable.ts';

const slot = (over: Partial<Slot> = {}): Slot => ({
  id: Math.random().toString(36).slice(2), course_offering_id: 'o', section_id: null,
  room_id: null, staff_id: null, day_of_week: 1, starts_at: '09:00:00', ends_at: '09:40:00',
  subject_name: 'Mathematics', room_name: null, ...over,
});

describe('reading a time', () => {
  it('takes what Postgres returns and what a time input gives', () => {
    expect(minutes('09:00:00')).toBe(540);
    expect(minutes('09:00')).toBe(540);
    expect(minutes('23:59')).toBe(1439);
  });
  it('refuses what is not a time', () => {
    for (const bad of ['', '9am', '24:00', '09:60', '9:00']) expect(minutes(bad), bad).toBeNaN();
  });
  it('labels morning and afternoon the way a printed timetable does', () => {
    expect(clockLabel('09:00:00')).toBe('9:00');
    expect(clockLabel('12:05')).toBe('12:05 pm');
    expect(clockLabel('14:30:00')).toBe('2:30 pm');
    expect(clockLabel('00:15')).toBe('12:15');
    expect(clockLabel('whenever')).toBe('whenever');
  });
});

describe('the days of the week', () => {
  it('starts on Monday as 1', () => {
    expect(DAYS[0]).toMatchObject({ n: 1, name: 'Monday' });
    expect(DAYS[6]).toMatchObject({ n: 7, name: 'Sunday' });
  });
});

describe("checking a lesson's times", () => {
  it('accepts an ordinary period', () => {
    expect(timeProblem('09:00', '09:40')).toBeNull();
  });
  it('refuses one that ends when or before it starts', () => {
    expect(timeProblem('09:00', '09:00')).toMatch(/end after it starts/);
    expect(timeProblem('09:40', '09:00')).toMatch(/end after it starts/);
  });
  it('refuses a missing time, and questions a very long one', () => {
    expect(timeProblem('', '09:40')).toMatch(/both times/);
    expect(timeProblem('09:00', '13:00')).toBeNull();          // exactly four hours
    expect(timeProblem('09:00', '13:01')).toMatch(/four hours/);
  });
});

describe('two periods sharing time', () => {
  it('clash when they overlap by a minute', () => {
    expect(overlaps('09:00', '09:40', '09:39', '10:20')).toBe(true);
  });
  it('do not clash when one starts as the other ends', () => {
    expect(overlaps('09:00', '09:40', '09:40', '10:20')).toBe(false);
    expect(overlaps('09:40', '10:20', '09:00', '09:40')).toBe(false);
  });
  it('clash when one sits inside the other', () => {
    expect(overlaps('09:00', '11:00', '09:30', '10:00')).toBe(true);
  });
});

describe("a clash with this class's own week", () => {
  const week = [slot({ day_of_week: 1 }), slot({ day_of_week: 3, starts_at: '10:00:00', ends_at: '10:40:00' })];

  it('finds the lesson already in that period on that day', () => {
    expect(clashesWith(week, [1], '09:20', '10:00')).toHaveLength(1);
  });
  it('ignores the same time on a different day', () => {
    expect(clashesWith(week, [2], '09:00', '09:40')).toEqual([]);
  });
  it('checks every day the new lesson is being added to', () => {
    expect(clashesWith(week, [1, 3], '09:00', '10:30')).toHaveLength(2);
  });
});

describe('the weekly grid', () => {
  it('has a row for each distinct period, in time order', () => {
    const grid = buildGrid([
      slot({ starts_at: '10:00:00', ends_at: '10:40:00' }),
      slot({ day_of_week: 2 }),
      slot({ day_of_week: 3 }),
    ]);
    expect(grid.bands).toEqual([
      { startsAt: '09:00:00', endsAt: '09:40:00' }, { startsAt: '10:00:00', endsAt: '10:40:00' },
    ]);
  });

  it('puts each lesson in its day and period', () => {
    const maths = slot({ day_of_week: 2 });
    const physics = slot({ day_of_week: 2, starts_at: '10:00:00', ends_at: '10:40:00', subject_name: 'Physics' });
    const grid = buildGrid([physics, maths]);
    expect(grid.cells.get(cellKey(2, 0))).toEqual([maths]);
    expect(grid.cells.get(cellKey(2, 1))).toEqual([physics]);
    expect(grid.cells.get(cellKey(1, 0))).toBeUndefined();
  });

  it('treats 09:00 and 09:00:00 as the same period', () => {
    const grid = buildGrid([slot({ starts_at: '09:00', ends_at: '09:40' }), slot({ day_of_week: 2 })]);
    expect(grid.bands).toHaveLength(1);
  });

  it('keeps two lessons in one cell rather than losing one', () => {
    // Electives: half the class in French, half in Sanskrit, same period.
    const grid = buildGrid([slot({ subject_name: 'French' }), slot({ subject_name: 'Sanskrit' })]);
    expect(grid.cells.get(cellKey(1, 0))!.map((s) => s.subject_name)).toEqual(['French', 'Sanskrit']);
  });

  it('shows Monday to Saturday, and Sunday only when something is on it', () => {
    expect(buildGrid([slot()]).days).toEqual([1, 2, 3, 4, 5, 6]);
    expect(buildGrid([slot({ day_of_week: 7 })]).days).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(buildGrid([]).days).toEqual([1, 2, 3, 4, 5, 6]);
    expect(buildGrid([]).bands).toEqual([]);
  });

  it('orders two periods that start together by when they end', () => {
    const grid = buildGrid([
      slot({ starts_at: '09:00:00', ends_at: '10:20:00' }), slot({ day_of_week: 2 }),
    ]);
    expect(grid.bands.map((b) => b.endsAt)).toEqual(['09:40:00', '10:20:00']);
  });
});

describe('suggesting the next period', () => {
  it('follows the last one on those days, at the same length', () => {
    const week = [slot(), slot({ starts_at: '09:40:00', ends_at: '10:20:00' })];
    expect(suggestNext(week, [1])).toEqual({ startsAt: '10:20', endsAt: '11:00' });
  });
  it('looks only at the days being added to', () => {
    const week = [slot({ day_of_week: 1 }), slot({ day_of_week: 2, starts_at: '14:00:00', ends_at: '14:45:00' })];
    expect(suggestNext(week, [1])).toEqual({ startsAt: '09:40', endsAt: '10:20' });
    expect(suggestNext(week, [1, 2])).toEqual({ startsAt: '14:45', endsAt: '15:30' });
  });
  it('suggests nothing for an empty day or past midnight', () => {
    expect(suggestNext([], [1])).toBeNull();
    expect(suggestNext([slot({ day_of_week: 2 })], [1])).toBeNull();
    expect(suggestNext([slot({ starts_at: '22:00:00', ends_at: '23:30:00' })], [1])).toBeNull();
  });
});
