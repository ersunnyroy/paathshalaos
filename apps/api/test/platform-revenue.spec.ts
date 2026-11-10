/**
 * M42.5 — the revenue query, against a real Postgres.
 *
 * `revenue.spec.ts` proves the arithmetic. This proves the things arithmetic
 * cannot: that the SQL names real columns, that the platform role is allowed
 * to read every table it joins, and that a subscription created through the
 * product actually arrives in the figure.
 *
 * Every assertion is a DIFFERENCE between two readings, never an absolute.
 * This database is shared — the demo school, other suites' leftovers — and a
 * test that expected MRR to equal 4999.00 would pass only on an empty one.
 */
import './fixtures.ts';
import pg from 'pg';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  createTenant, destroyTenants, createUser, destroyUsers, purgeTestData,
  OWNER_URL, type TenantFixture, type UserFixture,
} from './fixtures.ts';
import { catalogueService } from '../src/modules/billing-plans/catalogue.service.ts';
import { subscriptionService } from '../src/modules/billing-plans/subscription.service.ts';
import { revenueService } from '../src/modules/platform-billing/revenue.service.ts';
import { Money } from '../src/modules/billing/money.ts';
import { pool } from '../src/db/pool.ts';
import { authPool } from '../src/db/auth-pool.ts';
import { platformPool } from '../src/db/platform-pool.ts';

const PASSWORD = 'correct-horse-battery';
const paise = (value: string) => Money.fromDecimalString(value);

let paying: TenantFixture;
let trial: TenantFixture;
let staff: UserFixture;
let planCode: string;
let versionId: string;

async function owned<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: OWNER_URL });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

beforeAll(async () => {
  await purgeTestData('%@revenue-test.example');
  paying = await createTenant('REVPAY');
  trial = await createTenant('REVTRY');
  staff = await createUser('billing@revenue-test.example', PASSWORD);
  await owned((c) => c.query(
    `INSERT INTO platform_admin (user_account_id, capability) VALUES ($1, 'billing')`,
    [staff.userId]));

  planCode = `revenue_${randomUUID().slice(0, 8).replace(/-/g, '')}`;
  await catalogueService.createPlan(staff.userId, { code: planCode, name: 'Revenue Test' });
  const draft = await catalogueService.draftVersion(staff.userId, planCode, {
    priceMonthly: '4999.00', priceAnnual: '49990.00',
  });
  await catalogueService.setTerms(staff.userId, draft.id, { limits: [], features: [] });
  await catalogueService.publish(staff.userId, draft.id);
  versionId = draft.id;
});

afterAll(async () => {
  // Same order as plans.spec: subscriptions go with their tenants, then the
  // catalogue (whose freeze triggers only the owner can lift), then the
  // account that created it.
  await destroyTenants([paying.orgId, trial.orgId]);

  await owned(async (c) => {
    await c.query('DELETE FROM platform_admin WHERE user_account_id = $1', [staff.userId]);
    const FROZEN: ReadonlyArray<readonly [string, string]> = [
      ['plan_version', 'plan_version_frozen'],
      ['plan_limit', 'plan_limit_follows_version'],
      ['plan_feature', 'plan_feature_follows_version'],
    ];
    for (const [table, trigger] of FROZEN) {
      await c.query(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`);
    }
    try {
      await c.query(
        `DELETE FROM plan_limit WHERE plan_version_id IN
           (SELECT pv.id FROM plan_version pv JOIN plan p ON p.id = pv.plan_id WHERE p.code = $1)`,
        [planCode]);
      await c.query(
        `DELETE FROM plan_feature WHERE plan_version_id IN
           (SELECT pv.id FROM plan_version pv JOIN plan p ON p.id = pv.plan_id WHERE p.code = $1)`,
        [planCode]);
      await c.query(
        'DELETE FROM plan_version WHERE plan_id IN (SELECT id FROM plan WHERE code = $1)', [planCode]);
      await c.query('DELETE FROM plan WHERE code = $1', [planCode]);
    } finally {
      for (const [table, trigger] of FROZEN) {
        await c.query(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`);
      }
    }
  });

  await destroyUsers([staff.userId]);
  await Promise.all([pool.end(), authPool.end(), platformPool.end()]);
});

describe('the revenue overview, read from the rows', () => {
  it('runs as the platform role and returns every part', async () => {
    const overview = await revenueService.overview();
    expect(overview.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(overview.months).toHaveLength(6);
    expect(overview.financialYear.label).toMatch(/^\d{4}-\d{2}$/);
    expect(overview.mrr).toMatch(/^\d+\.\d{2}$/);
  });

  it('counts both test schools as schools with no plan before they subscribe', async () => {
    const before = await revenueService.overview();
    // Two schools exist that nobody has put on a plan. Whatever else is in the
    // database, the count of unsubscribed schools includes at least these.
    expect(before.schools.unsubscribed).toBeGreaterThanOrEqual(2);
  });

  it('puts a trial into the pipeline and not into MRR', async () => {
    const before = await revenueService.overview();
    await subscriptionService.subscribe(staff.userId, {
      tenantId: trial.orgId, planVersionId: versionId, billingPeriod: 'monthly', trialDays: 7,
    });
    const after = await revenueService.overview();

    expect(paise(after.mrr) - paise(before.mrr)).toBe(0n);
    expect(paise(after.trialPipeline) - paise(before.trialPipeline)).toBe(paise('4999.00'));
    expect(after.schools.trialing - before.schools.trialing).toBe(1);
    expect(after.schools.unsubscribed - before.schools.unsubscribed).toBe(-1);
    expect(after.trialsEnding.some((t) => t.tenant_id === trial.orgId)).toBe(true);
  });

  it('adds a twelfth of the annual price for an active annual school', async () => {
    const before = await revenueService.overview();
    await subscriptionService.subscribe(staff.userId, {
      tenantId: paying.orgId, planVersionId: versionId, billingPeriod: 'annual',
    });
    await subscriptionService.setStatus(staff.userId, {
      tenantId: paying.orgId, status: 'active', reason: 'revenue test: first payment taken',
    });
    const after = await revenueService.overview();

    // 49990.00 / 12 = 4165.8333… → 4165.83
    expect(paise(after.mrr) - paise(before.mrr)).toBe(paise('4165.83'));
    expect(after.schools.paying - before.schools.paying).toBe(1);

    const plan = after.byPlan.find((p) => p.plan_code === planCode);
    expect(plan).toMatchObject({ schools: 2, paying: 1, mrr: '4165.83' });
  });

  it('keeps past due in MRR and reports it separately', async () => {
    const before = await revenueService.overview();
    await subscriptionService.setStatus(staff.userId, {
      tenantId: paying.orgId, status: 'past_due', reason: 'revenue test: payment missed',
    });
    const after = await revenueService.overview();

    expect(paise(after.mrr) - paise(before.mrr)).toBe(0n);
    expect(paise(after.pastDueMrr) - paise(before.pastDueMrr)).toBe(paise('4165.83'));
    expect(after.schools.pastDue - before.schools.pastDue).toBe(1);
  });

  it('drops an ended school out of MRR and back into the schools with no plan', async () => {
    const before = await revenueService.overview();
    await subscriptionService.setStatus(staff.userId, {
      tenantId: paying.orgId, status: 'ended', reason: 'revenue test: school left',
    });
    const after = await revenueService.overview();

    expect(paise(before.mrr) - paise(after.mrr)).toBe(paise('4165.83'));
    expect(paise(before.pastDueMrr) - paise(after.pastDueMrr)).toBe(paise('4165.83'));
    expect(after.schools.paying - before.schools.paying).toBe(-1);
    expect(after.schools.unsubscribed - before.schools.unsubscribed).toBe(1);
  });
});
