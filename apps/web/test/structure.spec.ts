import { describe, it, expect } from 'vitest';
import {
  yearLabel, suggestTerms, yearProblem, codeFrom, codeOk, capacityFrom, orderClasses,
} from '../src/lib/structure.ts';

describe('naming a year', () => {
  it('spans two calendar years the way Indian schools write it', () => {
    expect(yearLabel('2027-04-01', '2028-03-31')).toBe('2027-28');
    expect(yearLabel('2099-06-01', '2100-05-31')).toBe('2099-00');
  });
  it('is a single year when it does not cross one', () => {
    expect(yearLabel('2027-01-10', '2027-11-30')).toBe('2027');
  });
  it('is empty until both dates are real', () => {
    expect(yearLabel('', '2028-03-31')).toBe('');
    expect(yearLabel('2027-02-30', '2028-03-31')).toBe('');
  });
});

describe('suggesting terms', () => {
  it('covers every day of the year exactly once', () => {
    const terms = suggestTerms('2027-04-01', '2028-03-31', 2);
    expect(terms).toHaveLength(2);
    expect(terms[0]!.startsOn).toBe('2027-04-01');
    expect(terms[1]!.endsOn).toBe('2028-03-31');
    // Back to back: the second starts the day after the first ends.
    expect(terms[0]!.endsOn).toBe('2027-09-30');
    expect(terms[1]!.startsOn).toBe('2027-10-01');
  });

  it('gives leftover days to the last term', () => {
    const terms = suggestTerms('2027-01-01', '2027-01-10', 3);   // 10 days into 3
    expect(terms.map((t) => [t.startsOn, t.endsOn])).toEqual([
      ['2027-01-01', '2027-01-03'], ['2027-01-04', '2027-01-06'], ['2027-01-07', '2027-01-10'],
    ]);
  });

  it('produces terms its own check accepts, for one to four terms', () => {
    for (const count of [1, 2, 3, 4]) {
      const terms = suggestTerms('2027-04-01', '2028-03-31', count);
      expect(terms).toHaveLength(count);
      expect(yearProblem({ label: '2027-28', startsOn: '2027-04-01', endsOn: '2028-03-31', terms })).toBeNull();
    }
  });

  it('suggests nothing it cannot do', () => {
    expect(suggestTerms('2027-01-01', '2027-01-02', 3)).toEqual([]);   // fewer days than terms
    expect(suggestTerms('bad', '2028-03-31', 2)).toEqual([]);
    expect(suggestTerms('2027-04-01', '2028-03-31', 0)).toEqual([]);
  });
});

describe('checking a year', () => {
  const year = (over = {}) => ({
    label: '2027-28', startsOn: '2027-04-01', endsOn: '2028-03-31',
    terms: suggestTerms('2027-04-01', '2028-03-31', 2), ...over,
  });

  it('accepts a year with no terms yet', () => {
    expect(yearProblem(year({ terms: [] }))).toBeNull();
  });
  it('refuses a year that ends on or before the day it starts', () => {
    expect(yearProblem(year({ endsOn: '2027-04-01', terms: [] }))).toMatch(/end after it starts/);
    expect(yearProblem(year({ endsOn: '2027-03-31', terms: [] }))).toMatch(/end after it starts/);
  });
  it('refuses a term that leaves the year at either end', () => {
    const early = year(); early.terms[0]!.startsOn = '2027-03-31';
    expect(yearProblem(early)).toMatch(/outside the year/);
    const late = year(); late.terms[1]!.endsOn = '2028-04-01';
    expect(yearProblem(late)).toMatch(/outside the year/);
  });
  it('refuses terms that share a day', () => {
    const y = year(); y.terms[1]!.startsOn = y.terms[0]!.endsOn;
    expect(yearProblem(y)).toMatch(/overlaps/);
  });
  it('allows a holiday gap between terms', () => {
    const y = year(); y.terms[1]!.startsOn = '2027-10-15';
    expect(yearProblem(y)).toBeNull();
  });
  it('refuses a date that does not exist', () => {
    expect(yearProblem(year({ startsOn: '2027-02-30', terms: [] }))).toMatch(/real calendar dates/);
  });
});

describe('codes and capacities', () => {
  it('makes a code the API accepts', () => {
    expect(codeFrom('Physical Education')).toBe('PHYSICAL-EDUCATION');
    expect(codeFrom('  Maths (Std.) ')).toBe('MATHS-STD');
    expect(codeOk(codeFrom('Physical Education'))).toBe(true);
    expect(codeOk(codeFrom('A very long subject name that goes on past the limit'))).toBe(true);
  });
  it('knows a bad code', () => {
    expect(codeOk('')).toBe(false);
    expect(codeOk('-LEADING')).toBe(false);
    expect(codeOk('HAS/SLASH')).toBe(false);
    expect(codeOk('R 101')).toBe(true);
  });
  it('tells blank from wrong', () => {
    expect(capacityFrom('')).toBeUndefined();
    expect(capacityFrom(' 40 ')).toBe(40);
    expect(capacityFrom('0')).toBeNull();
    expect(capacityFrom('10001')).toBeNull();
    expect(capacityFrom('forty')).toBeNull();
    expect(capacityFrom('4.5')).toBeNull();
  });
});

describe('class order', () => {
  it('goes by level, not by the alphabet', () => {
    const groups = [
      { id: 'x', name: 'Class X', level_sequence: 10 },
      { id: 'ix', name: 'Class IX', level_sequence: 9 },
      { id: 'n', name: 'Nursery', level_sequence: 0 },
    ];
    expect(orderClasses(groups).map((g) => g.id)).toEqual(['n', 'ix', 'x']);
  });
  it('puts a class with no level last, and breaks ties by name with numbers in order', () => {
    const groups = [
      { id: 'b', name: 'Batch 10', level_sequence: null },
      { id: 'a', name: 'Batch 2', level_sequence: null },
      { id: 'c', name: 'Class I', level_sequence: 1 },
    ];
    expect(orderClasses(groups).map((g) => g.id)).toEqual(['c', 'a', 'b']);
  });
});
