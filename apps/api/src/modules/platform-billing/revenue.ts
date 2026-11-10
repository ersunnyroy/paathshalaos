/**
 * What the business is earning, worked out from the rows (M42.5).
 *
 * Pure: it takes subscriptions and invoice totals that have already been read
 * and does the arithmetic. No database, no clock — `today` is an argument —
 * so every rule here is tested without either.
 *
 * Three rules worth stating, because each is the kind that gets "simplified":
 *
 *   **Money is paise in a bigint from the moment it is read.** A monthly
 *   figure that has been through a float is not a figure anybody should put
 *   in front of an investor or a tax return.
 *
 *   **A trial is not revenue.** A school on a trial is counted as pipeline and
 *   kept out of MRR, because adding it in is how a dashboard shows growth in
 *   the month before the trials lapse. Read-only and ended are not revenue
 *   either: the school has stopped paying.
 *
 *   **Past due IS revenue, and is shown separately.** The school still owes
 *   it. Hiding it makes MRR look worse than it is; folding it in silently
 *   hides the thing somebody has to chase.
 */
import { Money, type Paise } from '../billing/money.ts';

export interface LiveSubscription {
  tenant_id: string;
  display_name: string;
  status: string;
  billing_period: string;
  price_monthly: string;
  price_annual: string;
  plan_code: string;
  plan_name: string;
  version: number;
  trial_ends_on: string | null;
}

const BILLED = new Set(['active', 'past_due']);
const DAY = 86_400_000;

/** Paise as a decimal string; a net can be negative, and this keeps the sign. */
export function signed(paise: Paise): string {
  return Money.toDecimalString(paise);
}

/**
 * What one subscription is worth per month, in paise.
 *
 * An annual plan is its annual price over twelve, rounded half up to the
 * paisa. It is NOT twelve monthly prices divided back down: annual plans are
 * discounted, and the discount is the point.
 */
export function monthlyValue(sub: Pick<LiveSubscription, 'billing_period' | 'price_monthly' | 'price_annual'>): Paise {
  if (sub.billing_period === 'annual') {
    return (Money.fromDecimalString(sub.price_annual) + 6n) / 12n;
  }
  return Money.fromDecimalString(sub.price_monthly);
}

export interface RevenueSummary {
  mrr: string;
  arr: string;
  pastDueMrr: string;
  trialPipeline: string;
  schools: {
    total: number; paying: number; pastDue: number; trialing: number;
    readOnly: number; unsubscribed: number;
  };
  byPlan: Array<{
    plan_code: string; plan_name: string; version: number;
    schools: number; paying: number; mrr: string;
  }>;
  trialsEnding: Array<{ tenant_id: string; display_name: string; trial_ends_on: string; days_left: number }>;
}

export function summarise(
  subscriptions: readonly LiveSubscription[], totalSchools: number, today: string,
): RevenueSummary {
  let mrr = 0n;
  let pastDue = 0n;
  let trial = 0n;
  const count = { paying: 0, pastDue: 0, trialing: 0, readOnly: 0 };
  const plans = new Map<string, { plan_code: string; plan_name: string; version: number; schools: number; paying: number; mrr: Paise }>();
  const subscribed = new Set<string>();
  const trialsEnding: RevenueSummary['trialsEnding'] = [];
  const todayMs = Date.parse(`${today}T00:00:00Z`);

  for (const sub of subscriptions) {
    // 'ended' rows should not arrive — the query asks for live ones — but a
    // subscription marked ended and not yet closed must not count as a school
    // that has a plan.
    if (sub.status === 'ended') continue;
    subscribed.add(sub.tenant_id);
    const value = monthlyValue(sub);
    const key = `${sub.plan_code}#${sub.version}`;
    const plan = plans.get(key) ?? {
      plan_code: sub.plan_code, plan_name: sub.plan_name, version: sub.version,
      schools: 0, paying: 0, mrr: 0n,
    };
    plan.schools += 1;

    if (BILLED.has(sub.status)) {
      mrr += value;
      plan.mrr += value;
      plan.paying += 1;
      count.paying += 1;
      if (sub.status === 'past_due') { pastDue += value; count.pastDue += 1; }
    } else if (sub.status === 'trialing') {
      trial += value;
      count.trialing += 1;
      if (sub.trial_ends_on) {
        const daysLeft = Math.round((Date.parse(`${sub.trial_ends_on.slice(0, 10)}T00:00:00Z`) - todayMs) / DAY);
        // Fourteen days ahead, and anything already past: a trial that ended
        // last week and is still 'trialing' is the one to act on first.
        if (daysLeft <= 14) {
          trialsEnding.push({
            tenant_id: sub.tenant_id, display_name: sub.display_name,
            trial_ends_on: sub.trial_ends_on.slice(0, 10), days_left: daysLeft,
          });
        }
      }
    } else if (sub.status === 'read_only') {
      count.readOnly += 1;
    }
    plans.set(key, plan);
  }

  return {
    mrr: Money.toDecimalString(mrr),
    arr: Money.toDecimalString(mrr * 12n),
    pastDueMrr: Money.toDecimalString(pastDue),
    trialPipeline: Money.toDecimalString(trial),
    schools: {
      total: totalSchools,
      paying: count.paying, pastDue: count.pastDue, trialing: count.trialing,
      readOnly: count.readOnly,
      // Never negative: a subscription for a school deleted since is still a
      // row, and "minus one schools without a plan" is not a number.
      unsubscribed: Math.max(0, totalSchools - subscribed.size),
    },
    byPlan: [...plans.values()]
      .sort((a, b) => (a.mrr === b.mrr ? b.schools - a.schools : a.mrr > b.mrr ? -1 : 1))
      .map((p) => ({ ...p, mrr: Money.toDecimalString(p.mrr) })),
    trialsEnding: trialsEnding.sort((a, b) => a.days_left - b.days_left),
  };
}

export interface MonthRow { month: string; documents: number; taxable: string; tax: string; total: string }
export interface MonthSummary {
  month: string; invoices: number; invoiced: string; tax: string; credited: string; net: string;
}

/**
 * The last `count` calendar months, oldest first, every month present.
 *
 * A month with no invoices is a row of zeros, not a missing row: a chart that
 * skips a quiet month draws a line straight across it and hides the dip.
 * Net is invoiced less credited, and can be negative in a month where a
 * credit note corrects an earlier month's invoice.
 */
export function combineMonths(
  invoices: readonly MonthRow[], credits: readonly MonthRow[], today: string, count = 6,
): MonthSummary[] {
  const [year, month] = today.split('-').map(Number) as [number, number];
  const out: MonthSummary[] = [];
  for (let back = count - 1; back >= 0; back -= 1) {
    const index = year * 12 + (month - 1) - back;
    const key = `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
    const inv = invoices.find((r) => r.month === key);
    const cr = credits.find((r) => r.month === key);
    const invoiced = inv ? Money.fromDecimalString(inv.total) : 0n;
    const credited = cr ? Money.fromDecimalString(cr.total) : 0n;
    out.push({
      month: key,
      invoices: inv?.documents ?? 0,
      invoiced: Money.toDecimalString(invoiced),
      tax: inv ? Money.toDecimalString(Money.fromDecimalString(inv.tax)) : '0.00',
      credited: Money.toDecimalString(credited),
      net: signed(invoiced - credited),
    });
  }
  return out;
}
