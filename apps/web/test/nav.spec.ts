/**
 * Role-filtered navigation (M40).
 *
 * The rule worth testing hardest is the one that fails open. This filter is a
 * convenience over a database that already decides what each person sees, so
 * the dangerous mistake is not showing too much — it is hiding a screen from
 * somebody who needs it because their role was new, or because they hold two.
 */
import { describe, it, expect } from 'vitest';
import { GROUPS, navFor, screensFor, matchScreens } from '../src/lib/nav.ts';

const hrefs = (roles: string[]) => navFor(roles).flatMap((g) => g.items.map((i) => i.href));
const ALL = GROUPS.flatMap((g) => g.items.map((i) => i.href));

describe('who sees which screens', () => {
  it('shows an owner everything', () => {
    expect(hrefs(['ORG_OWNER'])).toEqual(ALL);
    expect(hrefs(['CAMPUS_ADMIN'])).toEqual(ALL);
  });

  it('shows a teacher the classroom and not the money', () => {
    const seen = hrefs(['TEACHER']);
    expect(seen).toContain('/attendance');
    expect(seen).toContain('/results');
    expect(seen).not.toContain('/fees');
    expect(seen).not.toContain('/access');
    expect(seen.length).toBeLessThan(ALL.length);
  });

  it('shows an accountant the money and not the register', () => {
    const seen = hrefs(['ACCOUNTANT']);
    expect(seen).toContain('/fees');
    expect(seen).not.toContain('/attendance');
  });

  it('gives somebody with two roles the union of both', () => {
    const seen = hrefs(['TEACHER', 'ACCOUNTANT']);
    expect(seen).toContain('/attendance');
    expect(seen).toContain('/fees');
    expect(seen).not.toContain('/access');
  });

  it('lets one unrestricted role win over a restricted one', () => {
    expect(hrefs(['TEACHER', 'ORG_OWNER'])).toEqual(ALL);
  });

  it('fails open for a role it has never heard of, and before roles load', () => {
    expect(screensFor(['LIBRARIAN'])).toBeNull();
    expect(hrefs(['LIBRARIAN'])).toEqual(ALL);
    expect(hrefs([])).toEqual(ALL);
  });

  it('drops a group once nothing in it is left', () => {
    const titles = navFor(['TRANSPORT']).map((g) => g.title);
    expect(titles).not.toContain('Money');
    expect(titles).not.toContain('Academics');
    for (const group of navFor(['TRANSPORT'])) expect(group.items.length).toBeGreaterThan(0);
  });

  it('only ever names screens that exist', () => {
    for (const role of ['TEACHER', 'ACCOUNTANT', 'ADMISSIONS', 'TRANSPORT', 'GUARDIAN', 'STUDENT']) {
      for (const href of screensFor([role]) ?? []) expect(ALL, `${role} ${href}`).toContain(href);
    }
  });
});

describe('finding a screen by typing', () => {
  it('returns every visible screen for an empty box', () => {
    expect(matchScreens(navFor(['TEACHER']), '  ').map((i) => i.href)).toEqual(hrefs(['TEACHER']));
  });

  it('matches the label before the synonyms', () => {
    const found = matchScreens(GROUPS, 'in').map((i) => i.label);
    expect(found[0]).toBe('Getting started');   // "in" is in a label…
    expect(found).toContain('Fees');            // …and in "invoice", a synonym
    expect(found.indexOf('Integrations')).toBeLessThan(found.indexOf('Fees'));
  });

  it('lists a screen once when both its name and a synonym match', () => {
    // "Getting started" has "in" in the label and in "onboarding".
    const found = matchScreens(GROUPS, 'in').map((i) => i.href);
    expect(new Set(found).size).toBe(found.length);
  });

  it('finds a screen by a word that is not in its name', () => {
    expect(matchScreens(GROUPS, 'homework').map((i) => i.href)).toEqual(['/learning']);
  });

  it('never offers a screen the role was not shown', () => {
    expect(matchScreens(navFor(['TEACHER']), 'invoice')).toEqual([]);
  });

  it('treats what was typed as text, not as a pattern', () => {
    expect(matchScreens(GROUPS, '.*')).toEqual([]);
    expect(matchScreens(GROUPS, '%')).toEqual([]);
  });
});
