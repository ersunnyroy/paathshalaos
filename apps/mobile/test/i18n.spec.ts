/**
 * M29.2 — the parent app's words, and what happens when they are missing.
 *
 * The interesting assertions here are not "Hindi renders Hindi". They are the
 * three ways a half-finished translation goes wrong in production:
 *
 *   - a key missing from a catalogue blanking the screen instead of falling
 *     back,
 *   - a translator dropping a `{placeholder}`, so a parent reads "Due days ago"
 *     with no number in it,
 *   - a plural pair translated as a single string, so the app says "1 days".
 *
 * All three are silent. None of them throws. Each has a test below.
 */
import { describe, it, expect } from 'vitest';
import {
  translator, expand, auditCatalogue, EN, HI, CATALOGUES,
} from '../src/lib/i18n.ts';
import { ATTENDANCE_STATES } from '../src/lib/family.ts';

describe('resolution', () => {
  it('uses the reader’s language where it has the string', () => {
    const t = translator(['hi-IN']);
    expect(t('tab.attendance')).toBe('उपस्थिति');
    expect(t('fees.clear')).toBe('कुछ भी बकाया नहीं');
  });

  it('falls back per key, not per catalogue', () => {
    // The obvious implementation picks one catalogue up front, and a language
    // with five strings in it then renders five words and fifteen blanks.
    const t = translator(['hi-IN']);
    expect(HI['work.none']).toBeUndefined();
    expect(t('work.none')).toBe(EN['work.none']);
    // ...while the neighbouring key is still Hindi.
    expect(t('tab.work')).toBe('गृहकार्य');
  });

  it('honours the order of the chain', () => {
    expect(translator(['hi-IN', 'en-IN'])('tab.fees')).toBe('शुल्क');
    expect(translator(['en-IN', 'hi-IN'])('tab.fees')).toBe('Fees');
  });

  it('answers in English for a language the app has no words in', () => {
    // Bodo is a language a school may legitimately choose on the server. The
    // app having no catalogue for it is not an error and must not be a blank.
    const t = translator(['brx-IN']);
    expect(t('tab.results')).toBe('Results');
    expect(t('action.signOut')).toBe('Sign out');
  });

  it('never resolves to nothing, whatever it is handed', () => {
    for (const chain of [[], [''], ['  '], ['not-a-locale'], ['zz-ZZ', 'qq']]) {
      const t = translator(chain);
      expect(t('tab.attendance')).toBe('Attendance');
    }
  });
});

describe('widening a tag', () => {
  it('lets a phone reporting a bare language find the regional catalogue', () => {
    // A phone reports its locale in whatever form its OS likes. Matching only
    // the exact string is how a Hindi phone shows an English app with the
    // Hindi catalogue sitting unused in the bundle.
    expect(translator(['hi'])('tab.bus')).toBe('बस');
    expect(expand(['hi'])).toContain('hi-IN');
  });

  it('lets a regional tag fall to its bare language', () => {
    expect(expand(['hi-IN'])).toEqual(expect.arrayContaining(['hi-IN', 'hi']));
    expect(expand(['pa_IN'])).toEqual(expect.arrayContaining(['pa_IN', 'pa']));
  });

  it('puts English last and exactly once', () => {
    expect(expand(['hi-IN']).at(-1)).toBe('en-IN');
    expect(expand(['en-IN', 'hi-IN']).filter((l) => l === 'en-IN')).toHaveLength(1);
    // Last, not first: a reader who asked for Hindi does not get English
    // because English happens to be the fallback.
    expect(expand(['hi-IN'])[0]).toBe('hi-IN');
  });
});

describe('filling in the blanks', () => {
  const t = translator(['en-IN']);

  it('substitutes by name', () => {
    expect(t('attendance.daysInSchool', { inSchool: 42, recorded: 50 }))
      .toBe('42 of 50 days in school');
    expect(t('cache.stale', { when: 'on Tuesday' }))
      .toBe('No signal. This is what the school said on Tuesday.');
  });

  it('picks the singular only for exactly one', () => {
    expect(t('fees.overdue', { days: 1 })).toBe('Due 1 day ago');
    expect(t('fees.overdue', { days: 2 })).toBe('Due 2 days ago');
    expect(t('fees.dueIn', { days: 0 })).toBe('Due in 0 days');
  });

  it('leaves a missing value visible rather than leaving a gap', () => {
    // The API throws on a missing variable; a phone must not, because throwing
    // inside a render takes the screen down. "Due {days} days ago" is obviously
    // broken and gets reported. "Due  days ago" reads like a sentence.
    expect(t('fees.overdue', {})).toBe('Due {days} days ago');
    expect(t('attendance.daysInSchool', { recorded: 50 }))
      .toBe('{inSchool} of 50 days in school');
  });
});

describe('every catalogue is answerable to English', () => {
  const others = Object.entries(CATALOGUES).filter(([tag]) => tag !== 'en-IN');

  it('has at least one translation to check', () => {
    // Otherwise the check below passes by having nothing to look at, which is
    // the shape of test that survives the removal of the thing it guards.
    expect(others.length).toBeGreaterThan(0);
  });

  it('passes the audit', () => {
    for (const [tag, catalogue] of others) {
      expect(auditCatalogue(tag, catalogue), tag).toEqual([]);
    }
  });
});

/**
 * ...and the audit itself is worth having only if it fails on a bad
 * catalogue. The real ones are clean by construction, so a check written only
 * against them passes whether or not it works.
 */
describe('the audit catches what it claims to', () => {
  it('names a key English does not have', () => {
    const problems = auditCatalogue('xx-IN',
      { 'tab.attendnace': 'typo' } as unknown as typeof HI);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/not a key English has/);
  });

  it('names a dropped placeholder', () => {
    // "Due days ago" — a sentence with the number missing, in a language
    // nobody reviewing the diff reads.
    const problems = auditCatalogue('xx-IN', {
      'fees.overdue': { one: 'देय एक दिन पहले', other: 'देय कुछ दिन पहले' },
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/days/);
  });

  it('names a plural pair flattened to one string', () => {
    const problems = auditCatalogue('xx-IN', { 'fees.dueIn': 'Due in {days} days' });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/1 days/);
  });

  it('says nothing about a catalogue that is merely incomplete', () => {
    // Being late is allowed. Being wrong is not.
    expect(auditCatalogue('xx-IN', { 'tab.fees': 'शुल्क' })).toEqual([]);
  });
});

describe('the catalogue covers what the API can send', () => {
  it('has a word for every attendance state', () => {
    // The screen builds this key from the wire value. A state added to the API
    // with no string here reaches a parent as `half_day`, in a cell where they
    // expected to read whether their child was in school.
    for (const state of ATTENDANCE_STATES) {
      expect(Object.keys(EN), state).toContain(`attendance.${state}`);
    }
  });

  it('has a tab label for every tab', () => {
    for (const tab of ['attendance', 'fees', 'work', 'results', 'bus']) {
      expect(Object.keys(EN), tab).toContain(`tab.${tab}`);
    }
  });
});
