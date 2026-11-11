/**
 * M42.5 — the revenue figures, as arithmetic.
 *
 * No database here on purpose. What a dashboard gets wrong is never the SQL
 * that fetches the rows; it is the three decisions made about them afterwards:
 * whether a trial counts, what an annual plan is worth per month, and what a
 * month with nothing in it looks like. `platform-revenue.spec.ts` covers the
 * query against a real Postgres.
 */
import { describe, it, expect } from 'vitest';
import {
  summarise, monthlyValue, combineMonths, signed, type LiveSubscription,
} from '../src/modules/platform-billing/revenue.ts';

const sub = (over: Partial<LiveSubscription> = {}): LiveSubscription => ({
  tenant_id: 't1', display_name: 'School One', status: 'active', billing_period: 'monthly',
  price_monthly: '1500.00', price_annual: '15000.00',
  plan_code: 'starter', plan_name: 'Starter', version: 1, trial_ends_on: null, ...over,
});
const TODAY = '2026-11-10';

describe('what a subscription is worth per month', () => {
  it('is the monthly price on a monthly plan', () => {
    expect(monthlyValue(sub())).toBe(150000n);
  });

  it('is a twelfth of the annual price on an annual plan, not the monthly price', () => {
    // 15000 / 12 = 1250.00 — the discount is real revenue not earned.
    expect(monthlyValue(sub({ billing_period: 'annual' }))).toBe(125000n);
  });

  it('rounds a twelfth half up to the paisa', () => {
    // 10000.00 / 12 = 833.3333… → 833.33
    expect(monthlyValue(sub({ billing_period: 'annual', price_annual: '10000.00' }))).toBe(83333n);
    // 10000.06 / 12 = 833.338333… → 833.34
    expect(monthlyValue(sub({ billing_period: 'annual', price_annual: '10000.06' }))).toBe(83334n);
    // 0.06 / 12 = 0.005 exactly → rounds up to one paisa
    expect(monthlyValue(sub({ billing_period: 'annual', price_annual: '0.06' }))).toBe(1n);
  });
});

describe('monthly recurring revenue', () => {
  it('adds the schools that are being billed', () => {
    const s = summarise([
      sub({ tenant_id: 'a' }),
      sub({ tenant_id: 'b', billing_period: 'annual' }),
    ], 2, TODAY);
    expect(s.mrr).toBe('2750.00');
    expect(s.arr).toBe('33000.00');
    expect(s.schools.paying).toBe(2);
  });

  it('keeps a trial out of MRR and shows it as pipeline', () => {
    const s = summarise([
      sub({ tenant_id: 'a' }),
      sub({ tenant_id: 'b', status: 'trialing' }),
    ], 2, TODAY);
    expect(s.mrr).toBe('1500.00');
    expect(s.trialPipeline).toBe('1500.00');
    expect(s.schools).toMatchObject({ paying: 1, trialing: 1 });
  });

  it('counts past due as revenue and says how much of it is late', () => {
    const s = summarise([
      sub({ tenant_id: 'a' }),
      sub({ tenant_id: 'b', status: 'past_due' }),
    ], 2, TODAY);
    expect(s.mrr).toBe('3000.00');
    expect(s.pastDueMrr).toBe('1500.00');
    expect(s.schools).toMatchObject({ paying: 2, pastDue: 1 });
  });

  it('does not count a read-only or ended school as revenue', () => {
    const s = summarise([
      sub({ tenant_id: 'a', status: 'read_only' }),
      sub({ tenant_id: 'b', status: 'ended' }),
    ], 2, TODAY);
    expect(s.mrr).toBe('0.00');
    expect(s.schools.readOnly).toBe(1);
    // The ended one has no plan; the read-only one still has.
    expect(s.schools.unsubscribed).toBe(1);
  });

  it('is zero, not empty, with no subscriptions at all', () => {
    const s = summarise([], 3, TODAY);
    expect(s).toMatchObject({ mrr: '0.00', arr: '0.00', pastDueMrr: '0.00', trialPipeline: '0.00' });
    expect(s.schools.unsubscribed).toBe(3);
    expect(s.byPlan).toEqual([]);
  });

  it('stays exact where a float would not', () => {
    const many = Array.from({ length: 3 }, (_, i) => sub({ tenant_id: `t${i}`, price_monthly: '0.10' }));
    expect(summarise(many, 3, TODAY).mrr).toBe('0.30');
  });

  it('never reports a negative number of schools without a plan', () => {
    expect(summarise([sub({ tenant_id: 'a' }), sub({ tenant_id: 'b' })], 1, TODAY).schools.unsubscribed).toBe(0);
  });
});

describe('revenue by plan', () => {
  it('groups by version and puts the biggest earner first', () => {
    const s = summarise([
      sub({ tenant_id: 'a' }),
      sub({ tenant_id: 'b', plan_code: 'growth', plan_name: 'Growth', price_monthly: '4000.00' }),
      sub({ tenant_id: 'c', version: 2, price_monthly: '1800.00' }),
      sub({ tenant_id: 'd', status: 'trialing' }),
    ], 4, TODAY);
    expect(s.byPlan.map((p) => `${p.plan_code} v${p.version}`)).toEqual(['growth v1', 'starter v2', 'starter v1']);
    const starter1 = s.byPlan.find((p) => p.plan_code === 'starter' && p.version === 1)!;
    // Two schools on it, one of them paying: the trial counts as a school, not as money.
    expect(starter1).toMatchObject({ schools: 2, paying: 1, mrr: '1500.00' });
  });

  it('adds up to the headline figure', () => {
    const subs = [
      sub({ tenant_id: 'a' }), sub({ tenant_id: 'b', billing_period: 'annual' }),
      sub({ tenant_id: 'c', plan_code: 'growth', price_monthly: '4000.00', status: 'past_due' }),
      sub({ tenant_id: 'd', status: 'trialing' }),
    ];
    const s = summarise(subs, 4, TODAY);
    const paise = (v: string) => BigInt(v.replace('.', ''));
    expect(s.byPlan.reduce((n, p) => n + paise(p.mrr), 0n)).toBe(paise(s.mrr));
  });
});

describe('trials about to end', () => {
  it('lists trials ending within fourteen days, soonest first', () => {
    const s = summarise([
      sub({ tenant_id: 'a', status: 'trialing', trial_ends_on: '2026-11-24' }),   // 14 days
      sub({ tenant_id: 'b', status: 'trialing', trial_ends_on: '2026-11-12' }),   // 2 days
      sub({ tenant_id: 'c', status: 'trialing', trial_ends_on: '2026-11-25' }),   // 15 days: not yet
    ], 3, TODAY);
    expect(s.trialsEnding.map((t) => [t.tenant_id, t.days_left])).toEqual([['b', 2], ['a', 14]]);
  });

  it('puts a trial that has already lapsed at the top', () => {
    const s = summarise([
      sub({ tenant_id: 'a', status: 'trialing', trial_ends_on: '2026-11-12' }),
      sub({ tenant_id: 'b', status: 'trialing', trial_ends_on: '2026-11-03' }),
    ], 2, TODAY);
    expect(s.trialsEnding[0]).toMatchObject({ tenant_id: 'b', days_left: -7 });
  });

  it('ignores the trial date of a school that is already paying', () => {
    const s = summarise([sub({ status: 'active', trial_ends_on: '2026-11-12' })], 1, TODAY);
    expect(s.trialsEnding).toEqual([]);
  });
});

describe('month by month', () => {
  const row = (month: string, total: string, tax = '0.00', documents = 1) =>
    ({ month, documents, taxable: total, tax, total });

  it('shows six months, oldest first, ending with this one', () => {
    const months = combineMonths([], [], TODAY);
    expect(months.map((m) => m.month)).toEqual(
      ['2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11']);
  });

  it('crosses a year boundary', () => {
    expect(combineMonths([], [], '2027-02-03').map((m) => m.month)).toEqual(
      ['2026-09', '2026-10', '2026-11', '2026-12', '2027-01', '2027-02']);
  });

  it('keeps a month with nothing in it as zeros', () => {
    const months = combineMonths([row('2026-11', '1770.00', '270.00')], [], TODAY);
    expect(months.find((m) => m.month === '2026-10')).toEqual({
      month: '2026-10', invoices: 0, invoiced: '0.00', tax: '0.00', credited: '0.00', net: '0.00',
    });
    expect(months.find((m) => m.month === '2026-11')).toMatchObject({
      invoices: 1, invoiced: '1770.00', tax: '270.00', net: '1770.00',
    });
  });

  it('takes credit notes off in the month they were raised', () => {
    const months = combineMonths(
      [row('2026-10', '5900.00')], [row('2026-10', '900.00'), row('2026-11', '1000.00')], TODAY);
    expect(months.find((m) => m.month === '2026-10')).toMatchObject({ credited: '900.00', net: '5000.00' });
    // Nothing invoiced in November and a credit raised: the month is negative.
    expect(months.find((m) => m.month === '2026-11')).toMatchObject({ invoiced: '0.00', net: '-1000.00' });
  });

  it('ignores rows outside the window', () => {
    const months = combineMonths([row('2026-05', '999.00'), row('2026-12', '999.00')], [], TODAY);
    expect(months.every((m) => m.invoiced === '0.00')).toBe(true);
  });
});

describe('a signed amount', () => {
  it('keeps the sign and the paise', () => {
    expect(signed(0n)).toBe('0.00');
    expect(signed(150050n)).toBe('1500.50');
    expect(signed(-5n)).toBe('-0.05');
  });
});
