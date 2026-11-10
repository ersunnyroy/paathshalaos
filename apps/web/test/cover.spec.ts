import { describe, expect, it } from 'vitest';
import {
  candidates, coveredBy, fullName, gaps, sectionsFor,
  type Assigned, type CoverLesson, type Person, type SectionRef,
} from '../src/lib/cover';

let n = 0;
const lesson = (over: Partial<CoverLesson> = {}): CoverLesson => ({
  id: `l${++n}`, day_of_week: 1, starts_at: '09:00:00', ends_at: '09:40:00',
  subject_name: 'Mathematics', class_name: 'Class IX', section_id: 'ixa',
  section_name: 'A', room_name: null, ...over,
});
const person = (id: string, given: string, over: Partial<Person> = {}): Person =>
  ({ staff_id: id, given_name: given, family_name: null, ...over });
const sections: SectionRef[] = [
  { id: 'ixa', section_name: 'A', class_name: 'Class IX' },
  { id: 'ixb', section_name: 'B', class_name: 'Class IX' },
  { id: 'xa', section_name: 'A', class_name: 'Class X' },
];
const cover = (over: Partial<Assigned> = {}): Assigned => ({
  section_id: 'ixa', covering_staff_id: 'c', covering_name: 'C', absent_staff_id: 'away', ...over });

describe('which sections a lesson belongs to', () => {
  it('is its own section, or every section of the class for a whole-class lesson', () => {
    expect(sectionsFor(lesson(), sections).map((s) => s.id)).toEqual(['ixa']);
    expect(sectionsFor(lesson({ section_id: null, section_name: null }), sections)
      .map((s) => s.id)).toEqual(['ixa', 'ixb']);
  });
  it('finds cover only for the same absent teacher and the same class', () => {
    expect(coveredBy(lesson(), 'away', [cover()], sections)?.covering_name).toBe('C');
    expect(coveredBy(lesson(), 'other', [cover()], sections)).toBeNull();
    expect(coveredBy(lesson(), 'away', [cover({ section_id: 'xa' })], sections)).toBeNull();
    expect(coveredBy(lesson(), 'away', [cover({ absent_staff_id: null })], sections)).toBeNull();
    expect(coveredBy(lesson({ section_id: null }), 'away', [cover({ section_id: 'ixb' })], sections))
      .not.toBeNull();
  });
  it('writes a name with or without a family name', () => {
    expect(fullName({ given_name: 'Meera', family_name: 'Nair' })).toBe('Meera Nair');
    expect(fullName({ given_name: 'Meera', family_name: null })).toBe('Meera');
  });
});

describe('who could take a lesson', () => {
  const target = lesson();
  const staff = [person('a', 'Asha'), person('b', 'Bala'), person('c', 'Chitra'),
    person('d', 'Dev'), person('e', 'Esha')];
  const names = (weeks: Record<string, CoverLesson[]>, away: string[] = [],
    assigned: Assigned[] = [], people = staff) =>
    candidates(target, 1, people, weeks, new Set(away), assigned).map((c) => c.name);

  it('leaves out anybody teaching at that time, but not one whose lesson only touches it', () => {
    const weeks = {
      a: [lesson({ starts_at: '09:20:00', ends_at: '10:00:00', class_name: 'Class X', section_id: 'xa', subject_name: 'Art' })],
      b: [lesson({ starts_at: '09:40:00', ends_at: '10:20:00', class_name: 'Class X', section_id: 'xa', subject_name: 'Art' })],
    };
    expect(names(weeks)).toEqual(['Bala']);
  });
  it('a clash on another weekday does not count', () => {
    const weeks = { a: [lesson({ day_of_week: 2, class_name: 'Class X', section_id: 'xa', subject_name: 'Art' })] };
    expect(names(weeks)).toEqual(['Asha']);
  });
  it('leaves out the away, the departed and people with no timetable', () => {
    const free = (id: string) => [lesson({ day_of_week: 3, class_name: 'Class X', section_id: 'xa', subject_name: 'Art' })];
    const weeks = { a: free('a'), b: free('b'), c: free('c'), d: [] };
    const people = [person('a', 'Asha'), person('b', 'Bala', { left_on: '2026-10-01' }),
      person('c', 'Chitra'), person('d', 'Dev'), person('e', 'Esha')];
    expect(names(weeks, ['a'], [], people)).toEqual(['Chitra']);
  });
  it('puts who knows the class first, then the subject, then the lightest day, then the name', () => {
    const other = { class_name: 'Class X', section_id: 'xa', subject_name: 'Art' };
    const weeks = {
      // Esha: nothing in common, empty day.
      e: [lesson({ day_of_week: 3, ...other })],
      // Dev: same subject elsewhere, on another day.
      d: [lesson({ day_of_week: 2, class_name: 'Class X', section_id: 'xa' })],
      // Chitra: teaches IX A something else on another day, two lessons that day.
      c: [lesson({ day_of_week: 2, subject_name: 'Art' }),
        lesson({ starts_at: '11:00:00', ends_at: '11:40:00', ...other }),
        lesson({ starts_at: '12:00:00', ends_at: '12:40:00', ...other })],
      // Asha and Bala: nothing in common, one lesson each that day.
      b: [lesson({ starts_at: '11:00:00', ends_at: '11:40:00', ...other })],
      a: [lesson({ starts_at: '11:00:00', ends_at: '11:40:00', ...other })],
    };
    expect(names(weeks)).toEqual(['Chitra', 'Dev', 'Esha', 'Asha', 'Bala']);
    expect(candidates(target, 1, staff, weeks, new Set(), []).map((c) => c.sameSubject))
      .toEqual([false, true, false, false, false]);
    expect(names(weeks, [], [], [...staff].reverse())).toEqual(['Chitra', 'Dev', 'Esha', 'Asha', 'Bala']);
  });
  it('counts cover already handed out as part of the day', () => {
    const other = { day_of_week: 3, class_name: 'Class X', section_id: 'xa', subject_name: 'Art' };
    const weeks = { a: [lesson(other)], b: [lesson(other)] };
    const out = candidates(target, 1, staff, weeks, new Set(),
      [cover({ covering_staff_id: 'a' }), cover({ covering_staff_id: 'a', section_id: 'xa' })]);
    expect(out.map((c) => [c.name, c.load])).toEqual([['Bala', 0], ['Asha', 2]]);
    expect(out[1]!.why).toBe('no lessons that day · already covering 2');
    expect(out[0]!.why).toBe('no lessons that day');
  });
  it('knows the class through a whole-class lesson, but not through another section', () => {
    const weeks = {
      a: [lesson({ day_of_week: 2, section_id: null, section_name: null, subject_name: 'Art' })],
      b: [lesson({ day_of_week: 2, section_id: 'ixb', section_name: 'B', subject_name: 'Art' })],
      c: [lesson({ day_of_week: 2, class_name: 'Class X', section_id: 'ixa', subject_name: 'Art' })],
    };
    const out = candidates(target, 1, staff, weeks, new Set(), []);
    expect(out.map((c) => [c.name, c.knowsClass])).toEqual(
      [['Asha', true], ['Bala', false], ['Chitra', false]]);
  });
  it('a whole-class lesson is known to whoever teaches any of its sections', () => {
    const whole = lesson({ section_id: null, section_name: null });
    const weeks = { b: [lesson({ day_of_week: 2, section_id: 'ixb', section_name: 'B', subject_name: 'Art' })] };
    expect(candidates(whole, 1, staff, weeks, new Set(), [])[0]!.knowsClass).toBe(true);
  });
  it('says why in words', () => {
    const weeks = { a: [lesson({ starts_at: '11:00:00', ends_at: '11:40:00' })],
      b: [lesson({ starts_at: '11:00:00', ends_at: '11:40:00' }), lesson({ starts_at: '12:00:00', ends_at: '12:40:00' })] };
    const out = candidates(target, 1, staff, weeks, new Set(), []);
    expect(out[0]!.why).toBe('teaches this class · teaches Mathematics · 1 lesson that day');
    expect(out[1]!.why).toBe('teaches this class · teaches Mathematics · 2 lessons that day');
  });
});

describe('the gaps on a day', () => {
  const away = person('away', 'Meera', { family_name: 'Nair' });
  const staff = [away, person('a', 'Asha'), person('b', 'Bala'), person('c', 'Chitra'), person('d', 'Dev')];
  const other = { class_name: 'Class X', section_id: 'xa', subject_name: 'Art', day_of_week: 3 };
  const weeks = {
    away: [lesson({ starts_at: '11:00:00', ends_at: '11:40:00', section_id: 'ixb', section_name: 'B' }),
      lesson(), lesson({ day_of_week: 2 })],
    a: [lesson(other)], b: [lesson(other)], c: [lesson(other)], d: [lesson(other)],
  };
  it('lists that day only, earliest first, labelled, with at most three suggestions', () => {
    const out = gaps({ weekday: 1, absent: [away], staff, weeks, assigned: [], sections });
    expect(out.map((g) => g.label)).toEqual([
      '9:00–9:40 · Mathematics · Class IX A',
      '11:00–11:40 · Mathematics · Class IX B']);
    expect(out[0]!.suggestions.map((c) => c.name)).toEqual(['Asha', 'Bala', 'Chitra']);
    expect(out[0]!.sections.map((s) => s.id)).toEqual(['ixa']);
    expect(gaps({ weekday: 1, absent: [away], staff, weeks, assigned: [], sections, limit: 1 })[0]!
      .suggestions).toHaveLength(1);
  });
  it('never suggests the absent teacher, and stops suggesting once covered', () => {
    const out = gaps({ weekday: 1, absent: [away], staff, weeks,
      assigned: [cover({ covering_staff_id: 'b', covering_name: 'Bala' })], sections });
    expect(out[0]!.cover?.covering_name).toBe('Bala');
    expect(out[0]!.suggestions).toEqual([]);
    expect(out[1]!.cover).toBeNull();
    expect(out[1]!.suggestions.map((c) => c.name)).toEqual(['Asha', 'Chitra', 'Dev']);
  });
  it('does not suggest one absent teacher to cover for another', () => {
    const also = person('a', 'Asha');
    const out = gaps({ weekday: 1, absent: [away, also], staff, weeks, assigned: [], sections });
    expect(out[0]!.suggestions.map((c) => c.name)).toEqual(['Bala', 'Chitra', 'Dev']);
  });
  it('is empty when the absent teacher has no timetable or nobody is away', () => {
    expect(gaps({ weekday: 1, absent: [person('x', 'X')], staff, weeks, assigned: [], sections })).toEqual([]);
    expect(gaps({ weekday: 1, absent: [], staff, weeks, assigned: [], sections })).toEqual([]);
  });
});
