/**
 * Role-filtered navigation (M40).
 *
 * The rule worth testing hardest is the one that fails open. This filter is a
 * convenience over a database that already decides what each person sees, so
 * the dangerous mistake is not showing too much — it is hiding a screen from
 * somebody who needs it because their role was new, or because they hold two.
 */
import { describe, it, expect } from 'vitest';
import { GROUPS, navFor, screensFor, matchScreens, homeFor } from '../src/lib/nav.ts';

const hrefs = (roles: string[]) => navFor(roles).flatMap((g) => g.items.map((i) => i.href));
// Everything a member of staff can be shown: all screens bar the ones marked
// for a particular role.
const ALL = GROUPS.flatMap((g) => g.items.filter((i) => !i.only).map((i) => i.href));
const EVERY = GROUPS.flatMap((g) => g.items.map((i) => i.href));

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
      for (const href of screensFor([role]) ?? []) expect(EVERY, `${role} ${href}`).toContain(href);
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

describe('a parent', () => {
  it('is shown their children and consent, and none of the office screens', () => {
    const seen = hrefs(['GUARDIAN']);
    expect(seen).toEqual(['/family', '/consent']);
    for (const office of ['/dashboard', '/attendance', '/fees', '/students']) {
      expect(seen, office).not.toContain(office);
    }
  });

  it('lands on their children, not on the school dashboard', () => {
    expect(homeFor(['GUARDIAN'])).toBe('/family');
  });

  it('does not put "My children" in the navigation of somebody who is not a parent', () => {
    expect(hrefs(['ORG_OWNER'])).not.toContain('/family');
    expect(hrefs(['TEACHER'])).not.toContain('/family');
    expect(hrefs(['LIBRARIAN'])).not.toContain('/family');   // unknown role: everything, but not this
    expect(hrefs([])).not.toContain('/family');
  });

  it('who also teaches here gets both, and lands on the dashboard', () => {
    const seen = hrefs(['TEACHER', 'GUARDIAN']);
    expect(seen).toContain('/family');
    expect(seen).toContain('/attendance');
    expect(homeFor(['TEACHER', 'GUARDIAN'])).toBe('/dashboard');
  });

  it('who also owns the school sees everything, including their children', () => {
    expect(hrefs(['ORG_OWNER', 'GUARDIAN'])).toEqual(EVERY);
    expect(homeFor(['ORG_OWNER', 'GUARDIAN'])).toBe('/dashboard');
  });
});

describe('where staff land', () => {
  it('is the dashboard, including before roles are known and for a role nobody listed', () => {
    for (const roles of [['ORG_OWNER'], ['TEACHER'], ['ACCOUNTANT'], ['TRANSPORT'], [], ['LIBRARIAN']]) {
      expect(homeFor(roles), roles.join()).toBe('/dashboard');
    }
  });
});
