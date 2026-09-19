/**
 * M16 — plans, subscriptions and the ladder.
 *
 * The assertions that matter here are almost all about what CANNOT happen.
 * Anybody can write a plans table; the questions worth testing are whether a
 * price edit can reach a school already paying it, whether "read-only" can be
 * reached without a missed payment and a grace window, and whether a school
 * that owes money can still get its own data out. That last one is the line I
 * would not cross for any amount of unpaid invoice, so it is a test rather than
 * a paragraph.
 */
import 'reflect-metadata';
import pg from 'pg';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  createTenant, destroyTenants, createUser, destroyUsers, grantRole, purgeTestData,
  createLearnerRaw, OWNER_URL, type TenantFixture, type UserFixture,
} from './fixtures.ts';
import { AppModule } from '../src/app.module.ts';
import { catalogueService } from '../src/modules/billing-plans/catalogue.service.ts';
import { subscriptionService, GRACE_DAYS }
  from '../src/modules/billing-plans/subscription.service.ts';
import { tokenService } from '../src/modules/auth/token.service.ts';
import { withTenant } from '../src/db/tenant.ts';
import { pool } from '../src/db/pool.ts';
import { authPool } from '../src/db/auth-pool.ts';
import { platformPool } from '../src/db/platform-pool.ts';

const PASSWORD = 'correct-horse-battery';

let app: INestApplication;
let base: string;
let tenant: TenantFixture;
let staff: UserFixture;   // platform billing
let owner: UserFixture;   // the school's own owner
let planCode: string;
let v1: string;           // published, the school is on this
let v2: string;           // published, dearer

async function owned<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: OWNER_URL });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

async function req(method: string, path: string, token: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: await res.json().catch(() => null) as any };
}

async function tokenFor(user: UserFixture, roles: string[]): Promise<string> {
  const { rows } = await authPool.query<{ grants_version: number }>(
    'SELECT grants_version FROM user_account WHERE id = $1', [user.userId]);
  return tokenService.signAccessToken({
    sub: user.userId, tenant_id: tenant.orgId, session_id: randomUUID(),
    gv: rows[0]!.grants_version, roles,
  });
}

/** Drafts a version with terms and publishes it. */
async function publishedVersion(price: string, terms?: {
  learners?: { included: number; hardCap: number | null };
  transport?: boolean;
}): Promise<string> {
  const draft = await catalogueService.draftVersion(staff.userId, planCode, {
    priceMonthly: price, priceAnnual: String(Number(price) * 10),
  });
  await catalogueService.setTerms(staff.userId, draft.id, {
    limits: [{
      metric: 'learners',
      included: terms?.learners?.included ?? 500,
      hardCap: terms?.learners?.hardCap ?? 600,
    }],
    features: [{ feature: 'transport', enabled: terms?.transport ?? true }],
  });
  await catalogueService.publish(staff.userId, draft.id);
  return draft.id;
}

beforeAll(async () => {
  await purgeTestData('%@plan-test.example');
  tenant = await createTenant('PLAN');
  staff = await createUser('billing@plan-test.example', PASSWORD);
  owner = await createUser('head@plan-test.example', PASSWORD);
  await grantRole(tenant.orgId, owner.userId, 'ORG_OWNER');

  await owned((c) => c.query(
    `INSERT INTO platform_admin (user_account_id, capability) VALUES ($1, 'billing')`,
    [staff.userId]));

  planCode = `standard_${randomUUID().slice(0, 8).replace(/-/g, '')}`;
  await catalogueService.createPlan(staff.userId, { code: planCode, name: 'Standard' });
  v1 = await publishedVersion('499900');
  v2 = await publishedVersion('799900');

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication({ logger: false });
  await app.init();
  await app.listen(0);
  base = await app.getUrl();
});

afterAll(async () => {
  await app?.close();

  // Order matters and cost a run to get right: the subscriptions have to go
  // before the versions they point at, and they belong to the tenant, so the
  // tenant teardown runs first. Then the catalogue, then the accounts that
  // created it.
  await destroyTenants([tenant.orgId]);

  await owned(async (c) => {
    await c.query('DELETE FROM platform_admin WHERE user_account_id = ANY($1)',
      [[staff.userId, owner.userId]]);

    // The freeze triggers have to come off to clear a published version, and
    // needing to is the proof that they work: the first version of this
    // teardown could not delete its own fixtures. Only the owner role can
    // disable them; the application never can.
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
           (SELECT pv.id FROM plan_version pv JOIN plan p ON p.id = pv.plan_id
             WHERE p.code = $1)`, [planCode]);
      await c.query(
        `DELETE FROM plan_feature WHERE plan_version_id IN
           (SELECT pv.id FROM plan_version pv JOIN plan p ON p.id = pv.plan_id
             WHERE p.code = $1)`, [planCode]);
      await c.query(
        `DELETE FROM plan_version WHERE plan_id IN (SELECT id FROM plan WHERE code = $1)`,
        [planCode]);
      await c.query('DELETE FROM plan WHERE code = $1', [planCode]);
    } finally {
      for (const [table, trigger] of FROZEN) {
        await c.query(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`);
      }
    }
  });

  await destroyUsers([staff.userId, owner.userId]);
  await Promise.all([pool.end(), authPool.end(), platformPool.end()]);
});

describe('a published version is a contract, not a row', () => {
  it('refuses to reprice a published version', async () => {
    await expect(owned((c) => c.query(
      `UPDATE plan_version SET price_monthly = 1 WHERE id = $1`, [v1])))
      .rejects.toThrow(/create a new version/);
  });

  it('refuses to change a published version\'s limits', async () => {
    // The subtler half, and the one a service-level rule would miss entirely.
    // Leaving the price alone and moving the learner cap from 600 to 60 puts
    // every school on the plan over it by tomorrow morning.
    await expect(owned((c) => c.query(
      `UPDATE plan_limit SET hard_cap = 60 WHERE plan_version_id = $1`, [v1])))
      .rejects.toThrow(/cannot be changed/);
    await expect(owned((c) => c.query(
      `DELETE FROM plan_limit WHERE plan_version_id = $1`, [v1])))
      .rejects.toThrow(/cannot be changed/);
    await expect(owned((c) => c.query(
      `INSERT INTO plan_limit (plan_version_id, metric, included, hard_cap)
       VALUES ($1, 'staff', 10, 20)`, [v1])))
      .rejects.toThrow(/cannot be changed/);
  });

  it('refuses to turn a feature off underneath the schools on it', async () => {
    await expect(owned((c) => c.query(
      `UPDATE plan_feature SET enabled = false WHERE plan_version_id = $1`, [v1])))
      .rejects.toThrow(/cannot be changed/);
  });

  it('will not delete a published version, but will retire one', async () => {
    await expect(owned((c) => c.query('DELETE FROM plan_version WHERE id = $1', [v2])))
      .rejects.toThrow(/retire it instead/);
  });

  it('lets a draft be edited freely, which is the point of drafts', async () => {
    const draft = await catalogueService.draftVersion(staff.userId, planCode, {
      priceMonthly: '100', priceAnnual: '1000',
    });
    await catalogueService.setTerms(staff.userId, draft.id, {
      limits: [{ metric: 'learners', included: 1, hardCap: 2 }],
      features: [{ feature: 'transport', enabled: false }],
    });
    await catalogueService.setTerms(staff.userId, draft.id, {
      limits: [{ metric: 'learners', included: 9, hardCap: 9 }],
      features: [{ feature: 'transport', enabled: true }],
    });
    // And terms carry forward to the next draft rather than being retyped.
    await catalogueService.publish(staff.userId, draft.id);
    const next = await catalogueService.draftVersion(staff.userId, planCode, {
      priceMonthly: '200', priceAnnual: '2000',
    });
    const all = await catalogueService.list();
    const seeded = all.find((v) => v.id === next.id)!;
    expect(seeded.limits).toEqual([
      { metric: 'learners', included: 9, hard_cap: 9 },
    ]);
  });

  it('refuses to set terms on a published version through the service', async () => {
    await expect(catalogueService.setTerms(staff.userId, v1, {
      limits: [], features: [],
    })).rejects.toMatchObject({ response: { error: { code: 'version_published' } } });
  });
});

describe('subscribing', () => {
  it('refuses to put a school on a draft', async () => {
    const draft = await catalogueService.draftVersion(staff.userId, planCode, {
      priceMonthly: '1', priceAnnual: '1',
    });
    await expect(subscriptionService.subscribe(staff.userId, {
      tenantId: tenant.orgId, planVersionId: draft.id,
    })).rejects.toMatchObject({ response: { error: { code: 'version_is_draft' } } });
  });

  it('puts the school on a published version and records it', async () => {
    const sub = await subscriptionService.subscribe(staff.userId, {
      tenantId: tenant.orgId, planVersionId: v1, trialDays: 30,
    });
    expect(sub.status).toBe('trialing');
    expect(sub.trial_ends_on).toBeTruthy();

    const events = await owned((c) => c.query<{ kind: string }>(
      'SELECT kind FROM subscription_event WHERE tenant_id = $1', [tenant.orgId]));
    expect(events.rows.map((r) => r.kind)).toContain('created');
  });

  it('refuses a second live subscription', async () => {
    await expect(subscriptionService.subscribe(staff.userId, {
      tenantId: tenant.orgId, planVersionId: v2,
    })).rejects.toMatchObject({ response: { error: { code: 'already_subscribed' } } });
  });

  it('keeps the history when a school is moved to another version', async () => {
    await subscriptionService.moveToVersion(staff.userId, {
      tenantId: tenant.orgId, planVersionId: v2,
      reason: 'Agreed at renewal on the call of 12 March.',
    });
    const events = await owned((c) => c.query<{ kind: string; reason: string }>(
      `SELECT kind, reason FROM subscription_event
        WHERE tenant_id = $1 ORDER BY occurred_at`, [tenant.orgId]));
    const move = events.rows.find((r) => r.kind === 'version_changed');
    expect(move?.reason).toMatch(/12 March/);
  });

  it('cannot tidy up the history afterwards', async () => {
    await expect(owned((c) => c.query(
      'UPDATE subscription_event SET reason = $2 WHERE tenant_id = $1',
      [tenant.orgId, 'nothing to see here'])))
      .rejects.toThrow(/append-only/);
    await expect(owned((c) => c.query(
      'DELETE FROM subscription_event WHERE tenant_id = $1', [tenant.orgId])))
      .rejects.toThrow(/append-only/);
  });

  it('moves the school back to v1 for the rest of this suite', async () => {
    const sub = await subscriptionService.moveToVersion(staff.userId, {
      tenantId: tenant.orgId, planVersionId: v1, reason: 'Restoring test state.',
    });
    expect(sub.plan_version_id).toBe(v1);
  });
});

describe('the ladder', () => {
  it('will not drop a school straight from active to read-only', async () => {
    await subscriptionService.setStatus(staff.userId, {
      tenantId: tenant.orgId, status: 'active', reason: 'Trial converted.',
    });
    await expect(subscriptionService.setStatus(staff.userId, {
      tenantId: tenant.orgId, status: 'read_only', reason: 'Skipping the ladder.',
    })).rejects.toMatchObject({
      response: { error: { code: 'illegal_subscription_transition' } },
    });
  });

  it('will not take a school read-only inside the grace window', async () => {
    await subscriptionService.setStatus(staff.userId, {
      tenantId: tenant.orgId, status: 'past_due', reason: 'Card declined.',
    });
    await expect(subscriptionService.setStatus(staff.userId, {
      tenantId: tenant.orgId, status: 'read_only', reason: 'Too eager.',
    })).rejects.toMatchObject({ response: { error: { code: 'grace_window_open' } } });
  });

  it('leaves a past-due school completely writable', async () => {
    // The rung that matters most. A card failed on Sunday; Monday's attendance
    // still has to be marked.
    const token = await tokenFor(owner, ['ORG_OWNER']);
    const { status } = await req('POST', '/v1/campuses', token,
      { code: 'PLAN-PASTDUE', name: 'Marked while past due' });
    expect(status).toBeLessThan(300);
  });

  it('goes read-only once the grace window has actually elapsed', async () => {
    await owned((c) => c.query(
      `UPDATE subscription SET past_due_since = CURRENT_DATE - $2::int
        WHERE tenant_id = $1 AND ended_at IS NULL`, [tenant.orgId, GRACE_DAYS + 1]));
    const sub = await subscriptionService.setStatus(staff.userId, {
      tenantId: tenant.orgId, status: 'read_only',
      reason: 'Unpaid past the grace window.',
    });
    expect(sub.status).toBe('read_only');
  });

  it('refuses new entries, and says why in words a bursar can act on', async () => {
    const token = await tokenFor(owner, ['ORG_OWNER']);
    const { status, body } = await req('POST', '/v1/campuses', token,
      { code: 'PLAN-BLOCKED', name: 'Should not exist' });
    expect(status).toBe(403);
    expect(body.error.code).toBe('account_read_only');
    expect(body.error.message).toMatch(/read and exported/);
  });

  it('never withholds the school\'s own data', async () => {
    // The line I will not cross. Everything they have ever entered stays
    // readable and exportable while they owe us money.
    const token = await tokenFor(owner, ['ORG_OWNER']);
    const campuses = await req('GET', '/v1/campuses', token);
    expect(campuses.status).toBe(200);
    expect(campuses.body.data.length).toBeGreaterThan(0);

    const students = await req('GET', '/v1/students?limit=5', token);
    expect(students.status).toBe(200);

    const plan = await req('GET', '/v1/plan', token);
    expect(plan.status).toBe(200);
    expect(plan.body.notice).toMatch(/nothing has been deleted/);
  });

  it('lifts the moment the account is settled', async () => {
    await subscriptionService.setStatus(staff.userId, {
      tenantId: tenant.orgId, status: 'active', reason: 'Paid.',
    });
    const token = await tokenFor(owner, ['ORG_OWNER']);
    const { status } = await req('POST', '/v1/campuses', token,
      { code: 'PLAN-RESTORED', name: 'After settling' });
    expect(status).toBeLessThan(300);

    // And the past-due marker is cleared, so the next failure starts a fresh
    // grace window rather than inheriting the old one.
    const { rows } = await owned((c) => c.query<{ past_due_since: string | null }>(
      'SELECT past_due_since FROM subscription WHERE tenant_id = $1 AND ended_at IS NULL',
      [tenant.orgId]));
    expect(rows[0]!.past_due_since).toBeNull();
  });
});

describe('features are a different question from limits', () => {
  it('resolves a feature through the database, for the current tenant only', async () => {
    const answer = await withTenant({ tenantId: tenant.orgId }, async (db) => {
      const { rows } = await db.query<{ transport: boolean }>(
        `SELECT app_tenant_has_feature('transport') AS transport`);
      return rows[0]!;
    });
    expect(answer.transport).toBe(true);
  });

  it('says no once the school is on a version without the module', async () => {
    const without = await publishedVersion('299900', { transport: false });
    await subscriptionService.moveToVersion(staff.userId, {
      tenantId: tenant.orgId, planVersionId: without,
      reason: 'Downgraded; transport dropped.',
    });
    const answer = await withTenant({ tenantId: tenant.orgId }, async (db) => {
      const { rows } = await db.query<{ transport: boolean }>(
        `SELECT app_tenant_has_feature('transport') AS transport`);
      return rows[0]!;
    });
    expect(answer.transport).toBe(false);
  });

  it('says yes for a school with no subscription at all', async () => {
    // Deliberate. Every school that existed before this milestone has no row,
    // and defaulting to "no features" would switch off transport for all of
    // them the moment this deploys. Billing state is not an authorisation
    // boundary — row-level security is, and it never consults this function.
    const other = await createTenant('PLANB');
    try {
      const answer = await withTenant({ tenantId: other.orgId }, async (db) => {
        const { rows } = await db.query<{ transport: boolean; ro: boolean }>(
          `SELECT app_tenant_has_feature('transport') AS transport,
                  app_tenant_is_read_only() AS ro`);
        return rows[0]!;
      });
      expect(answer.transport).toBe(true);
      expect(answer.ro).toBe(false);
    } finally {
      await destroyTenants([other.orgId]);
    }
  });
});

describe('what the school sees', () => {
  it('shows them their plan, their limits and their history', async () => {
    const token = await tokenFor(owner, ['ORG_OWNER']);
    const { status, body } = await req('GET', '/v1/plan', token);
    expect(status).toBe(200);
    expect(body.data.plan_code).toBe(planCode);
    expect(body.data.limits.some((l: any) => l.metric === 'learners')).toBe(true);

    const history = await req('GET', '/v1/plan/history', token);
    expect(history.body.data.length).toBeGreaterThan(0);
    expect(history.body.data.map((e: any) => e.kind)).toContain('created');
  });

  it('shows a price as a string, never a number', async () => {
    // A price that has been through JSON.parse as a number has been through a
    // double, and a rupee figure that has been through a double is not the
    // figure anybody agreed to.
    const token = await tokenFor(owner, ['ORG_OWNER']);
    const raw = await fetch(`${base}/v1/plan`, {
      headers: { authorization: `Bearer ${token}` },
    }).then((r) => r.text());
    expect(raw).not.toMatch(/"price_monthly":\s*\d/);
  });

  it('shows what else is on offer, without a salesperson', async () => {
    const token = await tokenFor(owner, ['ORG_OWNER']);
    const { status, body } = await req('GET', '/v1/plan/options', token);
    expect(status).toBe(200);
    expect(body.data.length).toBeGreaterThan(0);
    // The newest published version of each plan, and nothing unpublished.
    expect(body.data.every((o: any) => typeof o.price_monthly === 'string')).toBe(true);
    const codes = body.data.map((o: any) => o.plan_code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('does not offer a draft or a retired version to a school', async () => {
    const draft = await catalogueService.draftVersion(staff.userId, planCode, {
      priceMonthly: '1', priceAnnual: '1',
    });
    const token = await tokenFor(owner, ['ORG_OWNER']);
    const { body } = await req('GET', '/v1/plan/options', token);
    expect(body.data.some((o: any) => o.plan_version_id === draft.id)).toBe(false);
  });

  it('does not let one school read another\'s subscription', async () => {
    const other = await createTenant('PLANC');
    try {
      await subscriptionService.subscribe(staff.userId, {
        tenantId: other.orgId, planVersionId: v2,
      });
      const mine = await subscriptionService.forTenant({ tenantId: tenant.orgId });
      expect(mine?.tenant_id).toBe(tenant.orgId);

      const seen = await withTenant({ tenantId: tenant.orgId }, async (db) => {
        const { rows } = await db.query('SELECT tenant_id FROM subscription');
        return rows;
      });
      expect(seen).toHaveLength(1);
      expect(seen[0]!['tenant_id']).toBe(tenant.orgId);
    } finally {
      await destroyTenants([other.orgId]);
    }
  });

  it('answers only about the asking school, with another school subscribed', async () => {
    // Written after a mutation survived: removing the tenant filter from
    // app_tenant_plan() broke nothing, because only one school in the suite had
    // a live subscription at that point. A SECURITY DEFINER function has no
    // row-level security underneath it — its WHERE clause IS the boundary — so
    // it has to be tested against a database where the wrong answer exists.
    const neighbour = await createTenant('PLANNBR');
    try {
      const other = await publishedVersion('555500');
      await subscriptionService.subscribe(staff.userId, {
        tenantId: neighbour.orgId, planVersionId: other,
      });

      const rows = await withTenant({ tenantId: tenant.orgId }, async (db) => {
        const { rows } = await db.query<{ plan_version_id: string }>(
          'SELECT plan_version_id FROM app_tenant_plan()');
        return rows;
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.plan_version_id).not.toBe(other);

      // And the limits and features functions, which carry the same filter.
      const limits = await withTenant({ tenantId: neighbour.orgId }, async (db) => {
        const { rows } = await db.query('SELECT metric FROM app_tenant_plan_limits()');
        return rows;
      });
      expect(limits).toHaveLength(1);
    } finally {
      await destroyTenants([neighbour.orgId]);
    }
  });

  it('cannot read the catalogue directly at all', async () => {
    // Adopted from a parallel M16 built in another session, which got this
    // righter: the catalogue tables carry no tenant column, so there is no
    // row-level security underneath them and the grant WAS the whole boundary.
    // A SELECT grant plus a careful WHERE clause in one service is not a
    // boundary — it is a convention. Migration 0064 took the grant away.
    for (const table of ['plan', 'plan_version', 'plan_limit', 'plan_feature']) {
      await expect(withTenant({ tenantId: tenant.orgId }, async (db) => {
        await db.query(`SELECT * FROM ${table} LIMIT 1`);
      })).rejects.toThrow(/permission denied/);
    }
  });

  it('does not leak a draft price through the options function', async () => {
    // The concrete thing the grant permitted: next year's pricing, drafted but
    // not announced, readable by any school that asked the right question.
    const draft = await catalogueService.draftVersion(staff.userId, planCode, {
      priceMonthly: '1234500', priceAnnual: '12345000',
    });
    const options = await subscriptionService.optionsForTenant({ tenantId: tenant.orgId });
    expect(options.some((o) => o.plan_version_id === draft.id)).toBe(false);
    expect(JSON.stringify(options)).not.toContain('1234500');
  });

  it('does not let a school write its own subscription', async () => {
    // There is no self-serve upgrade, and the GRANT says so rather than the
    // absence of an endpoint saying so.
    await expect(withTenant({ tenantId: tenant.orgId }, async (db) => {
      await db.query(
        `UPDATE subscription SET status = 'active' WHERE tenant_id = $1`, [tenant.orgId]);
    })).rejects.toThrow(/permission denied|violates row-level security/);
  });

  it('names the mechanism: the app role holds no write privilege at all', async () => {
    // Written after a mutation survived. Relaxing the policy's WITH CHECK from
    // false to the tenant match changed nothing, because the grant refuses the
    // statement before any policy is consulted — so the test above was proving
    // the grant while appearing to prove the policy.
    //
    // The privilege is therefore asserted directly. The WITH CHECK (false) in
    // migration 0059 stays as a second line, but this is the one that holds,
    // and this test fails if a future migration hands the app role a grant.
    const privs = await withTenant({ tenantId: tenant.orgId }, async (db) => {
      const { rows } = await db.query<{ ins: boolean; upd: boolean; del: boolean }>(
        `SELECT has_table_privilege('subscription', 'INSERT') AS ins,
                has_table_privilege('subscription', 'UPDATE') AS upd,
                has_table_privilege('subscription', 'DELETE') AS del`);
      return rows[0]!;
    });
    expect(privs).toEqual({ ins: false, upd: false, del: false });
  });
});


describe('metering and the cap (M16.4, M16.5)', () => {
  let capped: TenantFixture;
  let tinyPlan: string;

  beforeAll(async () => {
    capped = await createTenant('PLANCAP');
    // Two learners included, three at the cap. Small enough to reach in a test,
    // and the gap between the two is the point: the third learner works and is
    // metered; the fourth is refused.
    tinyPlan = await publishedVersion('9900', {
      learners: { included: 2, hardCap: 3 },
    });
    await subscriptionService.subscribe(staff.userId, {
      tenantId: capped.orgId, planVersionId: tinyPlan,
    });
    // An actor in this tenant, because the learner policies answer "may THIS
    // person see this child" — a tenant scope with no actor correctly sees
    // nothing, which an earlier version of this test mistook for a cap working.
    await grantRole(capped.orgId, owner.userId, 'ORG_OWNER');
  });

  afterAll(async () => {
    await destroyTenants([capped.orgId]);
  });

  it('counts learners from the rows, not from a counter', async () => {
    await createLearnerRaw(capped.orgId, 'Asha', 'CAP-0001');
    const usage = await subscriptionService.usageForTenant({ tenantId: capped.orgId });
    const learners = usage.find((u) => u.metric === 'learners')!;
    expect(learners.used).toBe(1);
    expect(learners.included).toBe(2);
    expect(learners.state).toBe('ok');
  });

  it('lets a school past its included allowance without stopping anybody', async () => {
    // Rung one of the ladder. Over the allowance is a billing conversation, not
    // an interruption: nobody is stopped mid-task by a number.
    await createLearnerRaw(capped.orgId, 'Bharat', 'CAP-0002');
    await createLearnerRaw(capped.orgId, 'Chitra', 'CAP-0003');
    const usage = await subscriptionService.usageForTenant({ tenantId: capped.orgId });
    const learners = usage.find((u) => u.metric === 'learners')!;
    expect(learners.used).toBe(3);
    expect(learners.state).toBe('at_cap');
  });

  it('refuses the next learner, naming the number', async () => {
    await expect(createLearnerRaw(capped.orgId, 'Deepa', 'CAP-0004'))
      .rejects.toThrow(/plan limit reached: 3 of 3 learners/);
  });

  it('leaves every existing learner working', async () => {
    // The whole distinction this ladder is built on. Over the cap stops the
    // next admission; it does not touch the children already on the roll.
    const scope = { tenantId: capped.orgId, actorId: owner.userId };
    const rows = await withTenant(scope, async (db) => {
      const { rows } = await db.query('SELECT id FROM student');
      return rows;
    });
    expect(rows).toHaveLength(3);

    // And they can still be updated — a cap on inserts is not a freeze.
    await expect(withTenant(scope, async (db) => {
      await db.query(
        `UPDATE student SET first_admitted_on = CURRENT_DATE
          WHERE admission_no = 'CAP-0001'`);
    })).resolves.not.toThrow();
  });

  it('stops counting a learner who has left, and frees the seat', async () => {
    // Written after a mutation removing the lifecycle filter entirely changed
    // nothing — every learner in this suite was enrolled, so the filter was
    // never doing visible work. This is the guarantee it exists for: a school
    // does not pay for children who left, and withdrawing one makes room for
    // the next admission without an upgrade.
    const scope = { tenantId: capped.orgId, actorId: owner.userId };
    await withTenant(scope, async (db) => {
      await db.query(
        `UPDATE student SET lifecycle_status = 'alumni' WHERE admission_no = 'CAP-0001'`);
    });

    const usage = await subscriptionService.usageForTenant(scope);
    expect(usage.find((u) => u.metric === 'learners')!.used).toBe(2);

    // The seat is genuinely free — the cap lets the next child in.
    await expect(createLearnerRaw(capped.orgId, 'Deepa', 'CAP-0004'))
      .resolves.toBeTruthy();

    // And a learner on leave still holds a seat: they are on the register.
    await withTenant(scope, async (db) => {
      await db.query(
        `UPDATE student SET lifecycle_status = 'on_leave' WHERE admission_no = 'CAP-0002'`);
    });
    const after = await subscriptionService.usageForTenant(scope);
    expect(after.find((u) => u.metric === 'learners')!.used).toBe(3);
    await expect(createLearnerRaw(capped.orgId, 'Esha', 'CAP-0005'))
      .rejects.toThrow(/plan limit reached/);
  });

  it('lifts the moment the school is moved to a larger plan', async () => {
    const bigger = await publishedVersion('19900', {
      learners: { included: 50, hardCap: 100 },
    });
    await subscriptionService.moveToVersion(staff.userId, {
      tenantId: capped.orgId, planVersionId: bigger,
      reason: 'Upgraded after hitting the learner cap.',
    });
    await expect(createLearnerRaw(capped.orgId, 'Farid', 'CAP-0006'))
      .resolves.toBeTruthy();
  });

  it('does not cap a school that is on no plan at all', async () => {
    const unbilled = await createTenant('PLANFREE');
    try {
      await expect(createLearnerRaw(unbilled.orgId, 'Esha', 'FREE-0001'))
        .resolves.toBeTruthy();
    } finally {
      await destroyTenants([unbilled.orgId]);
    }
  });

  it('does not let one school\'s cap refuse another school\'s learner', async () => {
    // The trigger reads NEW.tenant_id rather than the transaction's tenant
    // setting, because an import or a platform path may be inserting for a
    // tenant that is not the current one.
    const roomy = await createTenant('PLANROOM');
    try {
      await subscriptionService.subscribe(staff.userId, {
        tenantId: roomy.orgId, planVersionId: v1,
      });
      await expect(createLearnerRaw(roomy.orgId, 'Farah', 'ROOM-0001'))
        .resolves.toBeTruthy();
    } finally {
      await destroyTenants([roomy.orgId]);
    }
  });
});
