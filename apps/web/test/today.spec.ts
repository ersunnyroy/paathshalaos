import { describe, it, expect } from 'vitest';
import {
  isoWeekday, lessonsOn, lessonStates, untilPhrase, registers, type Lesson,
} from '../src/lib/today.ts';

const lesson = (over: Partial<Lesson> = {}): Lesson => ({
  id: Math.random().toString(36).slice(2), day_of_week: 2, starts_at: '09:00:00', ends_at: '09:40:00',
  subject_name: 'Mathematics', class_name: 'Class IX', section_name: 'A', room_name: null, ...over,
});

describe('which weekday a date is', () => {
  it('counts from Monday as 1 to Sunday as 7', () => {
    expect(isoWeekday('2026-11-09')).toBe(1);   // a Monday
    expect(isoWeekday('2026-11-10')).toBe(2);
    expect(isoWeekday('2026-11-14')).toBe(6);
    expect(isoWeekday('2026-11-15')).toBe(7);   // Sunday is 7, not 0
  });
});

describe("today's lessons", () => {
  it('are the ones on this weekday, in the order they happen', () => {
    const week = [
      lesson({ subject_name: 'Physics', starts_at: '11:00:00', ends_at: '11:40:00' }),
      lesson({ day_of_week: 3, subject_name: 'Wednesday only' }),
      lesson({ subject_name: 'Mathematics' }),
    ];
    expect(lessonsOn(week, 2).map((l) => l.subject_name)).toEqual(['Mathematics', 'Physics']);
    expect(lessonsOn(week, 5)).toEqual([]);
  });
});

describe('where a lesson stands right now', () => {
  const day = [
    lesson({ starts_at: '09:00:00', ends_at: '09:40:00' }),
    lesson({ starts_at: '09:40:00', ends_at: '10:20:00' }),
    lesson({ starts_at: '11:00:00', ends_at: '11:40:00' }),
    lesson({ starts_at: '12:00:00', ends_at: '12:40:00' }),
  ];
  const at = (h: number, m: number) => lessonStates(day, h * 60 + m);

  it('has one next and the rest later before school', () => {
    expect(at(8, 0)).toEqual(['next', 'later', 'later', 'later']);
  });
  it('is now from the first minute', () => {
    expect(at(9, 0)).toEqual(['now', 'next', 'later', 'later']);
  });
  it('hands over on the minute a lesson ends and the next begins', () => {
    expect(at(9, 39)).toEqual(['now', 'next', 'later', 'later']);
    expect(at(9, 40)).toEqual(['done', 'now', 'next', 'later']);
  });
  it('has no "now" in a break, and still one "next"', () => {
    expect(at(10, 30)).toEqual(['done', 'done', 'next', 'later']);
  });
  it('is all done after the last one', () => {
    expect(at(12, 40)).toEqual(['done', 'done', 'done', 'done']);
  });
  it('is empty for a day with no lessons', () => {
    expect(lessonStates([], 600)).toEqual([]);
  });
});

describe('how long until a lesson', () => {
  it('speaks in minutes, then hours', () => {
    expect(untilPhrase('09:00:00', 8 * 60 + 35)).toBe('in 25 min');
    expect(untilPhrase('09:00:00', 8 * 60 + 1)).toBe('in 59 min');
    expect(untilPhrase('09:00:00', 8 * 60)).toBe('in 1 h');       // sixty minutes is an hour
    expect(untilPhrase('11:00:00', 9 * 60)).toBe('in 2 h');
    expect(untilPhrase('11:05:00', 9 * 60)).toBe('in 2 h 5 min');
    expect(untilPhrase('09:00:00', 9 * 60)).toBe('now');
    expect(untilPhrase('09:00:00', 10 * 60)).toBe('now');
  });
});

describe('registers', () => {
  const sections = [
    { id: 'a', section_name: 'A', class_name: 'Class IX', learners: 10 },
    { id: 'b', section_name: 'B', class_name: 'Class IX', learners: 12 },
    { id: 'c', section_name: 'C', class_name: 'Class IX', learners: 9 },
    { id: 'empty', section_name: 'D', class_name: 'Class IX', learners: 0 },
  ];

  it('tells not taken, started and taken apart', () => {
    const out = registers(sections, [
      { section_id: 'b', status: 'open', marked: 4, absent: 0 },
      { section_id: 'c', status: 'submitted', marked: 9, absent: 2 },
    ]);
    expect(out.map((r) => [r.section.id, r.state])).toEqual([
      ['a', 'not_taken'], ['b', 'in_progress'], ['c', 'taken'],
    ]);
    expect(out[2]).toMatchObject({ marked: 9, absent: 2 });
  });

  it('does not call a session with nobody marked taken, whatever its status says', () => {
    const [state] = registers(sections.slice(0, 1), [{ section_id: 'a', status: 'submitted', marked: 0, absent: 0 }]);
    expect(state!.state).toBe('in_progress');
  });

  it('leaves out a section with nobody in it', () => {
    expect(registers(sections, []).map((r) => r.section.id)).toEqual(['a', 'b', 'c']);
  });
});
