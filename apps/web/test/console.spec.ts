/**
 * The business console's arithmetic (M42.5).
 *
 * Money here is what a school is billed, so the tests that matter are the ones
 * a float would fail: a sum that must be exact, and a figure too large for a
 * double to hold to the paisa.
 */
import { describe, it, expect } from 'vitest';
import {
  rupeesDecimal, sumDecimals, groupTeam, grantable, versionAction, estate, CAPABILITIES,
  planCodeFrom, buildTerms, priceOrNull, FEATURES, buildSchool, campusCodeFrom,
} from '../src/lib/console.ts';

describe('showing a rupee amount', () => {
  it('groups the Indian way and always shows paise', () => {
    expect(rupeesDecimal('1500')).toBe('₹1,500.00');
    expect(rupeesDecimal('12500.5')).toBe('₹12,500.50');
    expect(rupeesDecimal('792000.00')).toBe('₹7,92,000.00');
    expect(rupeesDecimal('12345678.90')).toBe('₹1,23,45,678.90');
    expect(rupeesDecimal('0.00')).toBe('₹0.00');
    expect(rupeesDecimal('999')).toBe('₹999.00');
  });

  it('keeps a credit negative and a missing amount blank', () => {
    expect(rupeesDecimal('-250.00')).toBe('-₹250.00');
    expect(rupeesDecimal(null)).toBe('—');
    expect(rupeesDecimal('')).toBe('—');
  });

  it('does not round a figure a double cannot hold', () => {
    expect(rupeesDecimal('900719925474099312.34')).toBe('₹9,00,71,99,25,47,40,99,312.34');
  });
});

describe('adding amounts', () => {
  it('is exact where floats are not', () => {
    // 0.1 + 0.2 is 0.30000000000000004 in a double.
    expect(sumDecimals(['0.10', '0.20'])).toBe('0.30');
    expect(sumDecimals(['1180.00', '1180.00', '590.5'])).toBe('2950.50');
  });

  it('nets a credit note against an invoice', () => {
    expect(sumDecimals(['1180.00', '-180.00'])).toBe('1000.00');
    expect(sumDecimals(['100.00', '-250.00'])).toBe('-150.00');
  });

  it('is zero for nothing', () => {
    expect(sumDecimals([])).toBe('0.00');
  });
});

describe('the team list', () => {
  const row = (id: string, email: string, capability: string, revoked = false) => ({
    user_account_id: id, login_email: email, capability,
    granted_at: '2026-01-01T00:00:00Z', revoked_at: revoked ? '2026-02-01T00:00:00Z' : null,
  });

  it('is one row per person with what they hold now', () => {
    const team = groupTeam([
      row('a', 'asha@x.in', 'billing'), row('a', 'asha@x.in', 'provision'),
      row('b', 'bala@x.in', 'support'),
    ]);
    expect(team).toHaveLength(2);
    expect(team[0]).toMatchObject({ email: 'asha@x.in', capabilities: ['provision', 'billing'] });
  });

  it('does not count a revoked capability as held', () => {
    const [member] = groupTeam([row('a', 'asha@x.in', 'billing', true), row('a', 'asha@x.in', 'support')]);
    expect(member!.capabilities).toEqual(['support']);
    expect(member!.revoked).toEqual(['billing']);
  });

  it('counts a capability revoked and granted again as held', () => {
    const [member] = groupTeam([row('a', 'asha@x.in', 'billing', true), row('a', 'asha@x.in', 'billing')]);
    expect(member!.capabilities).toEqual(['billing']);
    expect(member!.revoked).toEqual([]);
  });

  it('puts former staff after current staff', () => {
    const team = groupTeam([row('a', 'aaa@x.in', 'billing', true), row('z', 'zzz@x.in', 'support')]);
    expect(team.map((m) => m.email)).toEqual(['zzz@x.in', 'aaa@x.in']);
  });

  it('offers only what the person does not already hold', () => {
    const [member] = groupTeam([row('a', 'asha@x.in', 'billing'), row('a', 'asha@x.in', 'support', true)]);
    const offered = grantable(member!);
    expect(offered).not.toContain('billing');
    expect(offered).toContain('support');   // revoked, so it can be given back
    expect(offered).toHaveLength(CAPABILITIES.length - 1);
  });
});

describe('what can be done to a plan version', () => {
  it('moves one way only', () => {
    expect(versionAction('draft')).toBe('publish');
    expect(versionAction('published')).toBe('retire');
    expect(versionAction('retired')).toBeNull();
    expect(versionAction('anything else')).toBeNull();
  });
});

describe('the estate at a glance', () => {
  it('counts schools by state and flags the ones nobody can administer', () => {
    const s = (status: string, owners: number, accounts: number) =>
      ({ id: status + owners, status, owners, accounts, live_sessions: 0 });
    expect(estate([s('active', 1, 10), s('active', 0, 4), s('suspended', 2, 7)])).toEqual({
      total: 3, active: 2, suspended: 1, ownerless: 1, accounts: 21,
    });
    expect(estate([])).toEqual({ total: 0, active: 0, suspended: 0, ownerless: 0, accounts: 0 });
  });
});

describe('building a plan', () => {
  const blank = () => ({
    limits: {} as Record<string, { included: string; hardCap: string }>,
    features: {} as Record<string, boolean>,
  });

  it('makes a code from a name, or refuses', () => {
    expect(planCodeFrom('Growth Plus')).toBe('growth_plus');
    expect(planCodeFrom('  Starter (2026) ')).toBe('starter_2026');
    expect(planCodeFrom('2026 Starter')).toBe('starter');
    expect(planCodeFrom('!!')).toBeNull();
    expect(planCodeFrom('a')).toBeNull();          // the API wants at least two characters
  });

  it('leaves a blank metric unlimited rather than limiting it to zero', () => {
    const form = blank();
    form.limits['learners'] = { included: '500', hardCap: '' };
    form.limits['staff'] = { included: '', hardCap: '' };
    const built = buildTerms(form);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.terms.limits).toEqual([{ metric: 'learners', included: 500, hardCap: null }]);
  });

  it('keeps an explicit zero as a limit of zero', () => {
    const form = blank();
    form.limits['campuses'] = { included: '0', hardCap: '0' };
    const built = buildTerms(form);
    expect(built.ok && built.terms.limits).toEqual([{ metric: 'campuses', included: 0, hardCap: 0 }]);
  });

  it('refuses a hard cap below what the plan includes', () => {
    const form = blank();
    form.limits['learners'] = { included: '500', hardCap: '400' };
    const built = buildTerms(form);
    expect(built.ok).toBe(false);
    expect(!built.ok && built.error).toMatch(/below what the plan includes/);
  });

  it('allows a hard cap equal to what the plan includes', () => {
    const form = blank();
    form.limits['learners'] = { included: '500', hardCap: '500' };
    expect(buildTerms(form).ok).toBe(true);
  });

  it('refuses a cap with no included amount, and anything that is not a whole number', () => {
    const a = blank(); a.limits['staff'] = { included: '', hardCap: '10' };
    expect(buildTerms(a).ok).toBe(false);
    const b = blank(); b.limits['staff'] = { included: '12.5', hardCap: '' };
    expect(buildTerms(b).ok).toBe(false);
    const c = blank(); c.limits['staff'] = { included: '-3', hardCap: '' };
    expect(buildTerms(c).ok).toBe(false);
  });

  it('states every feature, including the ones that are off', () => {
    const form = blank();
    form.features['transport'] = true;
    const built = buildTerms(form);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.terms.features).toHaveLength(FEATURES.length);
    expect(built.terms.features.filter((f) => f.enabled).map((f) => f.feature)).toEqual(['transport']);
  });

  it('accepts a price a person would type and nothing else', () => {
    expect(priceOrNull('1500')).toBe('1500');
    expect(priceOrNull(' 1,499.50 ')).toBe('1499.50');
    expect(priceOrNull('1499.505')).toBeNull();
    expect(priceOrNull('-5')).toBeNull();
    expect(priceOrNull('free')).toBeNull();
    expect(priceOrNull('')).toBeNull();
  });
});

describe('creating a school', () => {
  const form = (over = {}) => ({
    legalName: 'St Mary Education Trust', displayName: "St Mary's", ownerEmail: ' Principal@StMarys.in ',
    campusName: 'Main Campus', campusCode: 'MAIN', board: '', ...over,
  });
  const KEY = 'req-0123456789';

  it('sends what was typed, trimmed, with the email lowercased', () => {
    const built = buildSchool(form(), KEY);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.body).toEqual({
      requestKey: KEY, legalName: 'St Mary Education Trust', displayName: "St Mary's",
      ownerEmail: 'principal@stmarys.in', campusName: 'Main Campus', campusCode: 'MAIN',
    });
  });

  it('carries the same request key it was given, so a retry cannot create a second school', () => {
    const first = buildSchool(form(), KEY);
    const second = buildSchool(form(), KEY);
    expect(first.ok && second.ok && first.body['requestKey'] === second.body['requestKey']).toBe(true);
  });

  it('uses the legal name when no display name is given', () => {
    const built = buildSchool(form({ displayName: '  ' }), KEY);
    expect(built.ok && built.body['displayName']).toBe('St Mary Education Trust');
  });

  it('includes the board only when there is one', () => {
    const built = buildSchool(form({ board: ' CBSE ' }), KEY);
    expect(built.ok && built.body['boardOrAffiliation']).toBe('CBSE');
    const none = buildSchool(form(), KEY);
    expect(none.ok && 'boardOrAffiliation' in none.body).toBe(false);
  });

  it('refuses a bad email, a missing name and a campus code the receipts cannot carry', () => {
    expect(buildSchool(form({ ownerEmail: 'principal' }), KEY).ok).toBe(false);
    expect(buildSchool(form({ ownerEmail: 'a b@x.in' }), KEY).ok).toBe(false);
    expect(buildSchool(form({ legalName: ' ' }), KEY).ok).toBe(false);
    expect(buildSchool(form({ campusName: '' }), KEY).ok).toBe(false);
    expect(buildSchool(form({ campusCode: 'main' }), KEY).ok).toBe(false);
    expect(buildSchool(form({ campusCode: 'M' }), KEY).ok).toBe(false);
    expect(buildSchool(form({ campusCode: '-MAIN' }), KEY).ok).toBe(false);
  });

  it('makes a campus code the API accepts from a name', () => {
    expect(campusCodeFrom('Main Campus')).toBe('MAIN-CAMPUS');
    expect(campusCodeFrom(' north (junior) wing ')).toBe('NORTH-JUNIOR-WING');
    const built = buildSchool(form({ campusCode: campusCodeFrom('Main Campus') }), KEY);
    expect(built.ok).toBe(true);
  });
});
