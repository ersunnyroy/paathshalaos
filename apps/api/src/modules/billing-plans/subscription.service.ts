/**
 * A school's subscription, and the ladder (M16.2, the read-only rung of M16.5).
 *
 * Every state change writes a `subscription_event`, which is append-only. That
 * table is what settles the argument that starts "we were never told we'd moved
 * to the new price", and a history somebody can tidy up settles nothing.
 *
 * The status values are a ladder, not a set of flags, and the bottom rung is
 * called `read_only` rather than `suspended` on purpose: the word people reach
 * for after "suspended" is "delete", and this state is emphatically not that.
 * A school here can read every record it has ever entered and export all of it.
 */
import { withPlatform } from '../../db/platform-pool.ts';
import { withTenant, type TenantScope } from '../../db/tenant.ts';
import { ApiError } from '../../common/errors.ts';
import { auditService } from '../audit/audit.service.ts';

export type SubscriptionStatus = 'trialing' | 'active' | 'past_due' | 'read_only' | 'ended';

/**
 * How long a school stays writable after a payment fails.
 *
 * Fourteen days because the failure is almost never a decision — it is an
 * expired card, a bank's fraud hold, a bursar on leave. The cost of being wrong
 * in one direction is two weeks of unpaid service; in the other it is a school
 * that cannot mark attendance on a Monday morning. Those are not comparable.
 */
export const GRACE_DAYS = 14;

export interface SubscriptionRow {
  id: string;
  tenant_id: string;
  plan_version_id: string;
  plan_code: string;
  plan_name: string;
  version: number;
  status: SubscriptionStatus;
  billing_period: string;
  trial_ends_on: string | null;
  period_start: string;
  period_end: string | null;
  past_due_since: string | null;
}

const SELECT_ROW = `
  s.id, s.tenant_id, s.plan_version_id, p.code AS plan_code, p.name AS plan_name,
  pv.version, s.status, s.billing_period, s.trial_ends_on,
  s.period_start, s.period_end, s.past_due_since`;

const FROM_ROW = `
  FROM subscription s
  JOIN plan_version pv ON pv.id = s.plan_version_id
  JOIN plan p ON p.id = pv.plan_id`;

export const subscriptionService = {
  /**
   * Puts a school on a plan version.
   *
   * Refuses a draft version outright. Subscribing somebody to terms that can
   * still be edited is the exact hole the freeze triggers exist to close — the
   * price they agreed to could change under them the next afternoon.
   */
  async subscribe(actorUserId: string, input: {
    tenantId: string; planVersionId: string;
    billingPeriod?: 'monthly' | 'annual' | undefined;
    trialDays?: number | undefined;
  }): Promise<SubscriptionRow> {
    const row = await withPlatform(async (db) => {
      const { rows: version } = await db.query<{ status: string }>(
        'SELECT status FROM plan_version WHERE id = $1', [input.planVersionId]);
      if (!version[0]) {
        throw ApiError.make('not_found', 'version_not_found', 'No such plan version.');
      }
      if (version[0].status === 'draft') {
        throw ApiError.make('conflict', 'version_is_draft',
          'That version is still a draft. Publish it before anybody is put on it — '
          + 'a draft can still be edited, and a school should not be on terms that move.');
      }
      if (version[0].status === 'retired') {
        throw ApiError.make('conflict', 'version_retired',
          'That version is retired and takes no new subscribers. Schools already '
          + 'on it stay on it.');
      }

      const trialDays = input.trialDays ?? 0;
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO subscription
           (tenant_id, plan_version_id, billing_period, status, trial_ends_on)
         VALUES ($1, $2, $3,
                 CASE WHEN $4::int > 0 THEN 'trialing' ELSE 'active' END,
                 CASE WHEN $4::int > 0 THEN CURRENT_DATE + $4::int ELSE NULL END)
         RETURNING id`,
        [input.tenantId, input.planVersionId, input.billingPeriod ?? 'monthly', trialDays]);

      const id = rows[0]!.id;
      await db.query(
        `INSERT INTO subscription_event
           (tenant_id, subscription_id, kind, after, actor_user_id, reason)
         VALUES ($1, $2, 'created', $3::jsonb, $4, $5)`,
        [input.tenantId, id,
         JSON.stringify({ plan_version_id: input.planVersionId, trial_days: trialDays }),
         actorUserId, 'Subscription opened.']);

      const { rows: made } = await db.query<SubscriptionRow>(
        `SELECT ${SELECT_ROW} ${FROM_ROW} WHERE s.id = $1`, [id]);
      return made[0]!;
    }).catch((err: unknown) => {
      // The partial unique index is the real guarantee; this turns it into a
      // sentence. Two live subscriptions would make "what may this school do" a
      // question with two answers.
      if (err instanceof Error && /subscription_one_live_per_tenant/.test(err.message)) {
        throw ApiError.make('conflict', 'already_subscribed',
          'This school already has a live subscription. Move it to another version '
          + 'rather than opening a second one.');
      }
      throw err;
    });

    await auditService.record({
      tenantId: input.tenantId, actorUserId, action: 'subscription.created',
      resourceType: 'subscription', resourceId: row.id, classification: 'INTERNAL',
      after: { plan: row.plan_code, version: row.version, status: row.status },
    });
    return row;
  },

  /**
   * Moves a school to a different version — the one operation that changes what
   * they pay, which is why it takes a reason and writes both sides of the move.
   */
  async moveToVersion(actorUserId: string, input: {
    tenantId: string; planVersionId: string; reason: string;
  }): Promise<SubscriptionRow> {
    if (input.reason.trim().length < 5) {
      throw ApiError.make('validation_error', 'reason_required',
        'Say why this school is moving. It is the line they will be shown.');
    }

    const row = await withPlatform(async (db) => {
      const { rows: current } = await db.query<{ id: string; plan_version_id: string }>(
        `SELECT id, plan_version_id FROM subscription
          WHERE tenant_id = $1 AND ended_at IS NULL FOR UPDATE`, [input.tenantId]);
      if (!current[0]) {
        throw ApiError.make('not_found', 'no_subscription',
          'This school has no live subscription.');
      }

      const { rows: version } = await db.query<{ status: string }>(
        'SELECT status FROM plan_version WHERE id = $1', [input.planVersionId]);
      if (!version[0] || version[0].status === 'draft') {
        throw ApiError.make('conflict', 'version_is_draft',
          'Publish the version before moving anybody onto it.');
      }

      await db.query('UPDATE subscription SET plan_version_id = $2 WHERE id = $1',
        [current[0].id, input.planVersionId]);
      await db.query(
        `INSERT INTO subscription_event
           (tenant_id, subscription_id, kind, before, after, actor_user_id, reason)
         VALUES ($1, $2, 'version_changed', $3::jsonb, $4::jsonb, $5, $6)`,
        [input.tenantId, current[0].id,
         JSON.stringify({ plan_version_id: current[0].plan_version_id }),
         JSON.stringify({ plan_version_id: input.planVersionId }),
         actorUserId, input.reason.trim()]);

      const { rows } = await db.query<SubscriptionRow>(
        `SELECT ${SELECT_ROW} ${FROM_ROW} WHERE s.id = $1`, [current[0].id]);
      return rows[0]!;
    });

    await auditService.record({
      tenantId: input.tenantId, actorUserId, action: 'subscription.version_changed',
      resourceType: 'subscription', resourceId: row.id, classification: 'INTERNAL',
      reason: input.reason.trim(),
      after: { plan: row.plan_code, version: row.version },
    });
    return row;
  },

  /**
   * Moves a school along the ladder.
   *
   * The transitions are enumerated rather than "set whatever status you like",
   * because the one that must never happen is a jump straight from `active` to
   * `read_only` — no missed payment recorded, no grace window, no warning. The
   * table below is where somebody would have to delete a line to make that
   * possible, and deleting a line is a thing a reviewer notices.
   */
  async setStatus(actorUserId: string, input: {
    tenantId: string; status: SubscriptionStatus; reason: string;
  }): Promise<SubscriptionRow> {
    const ALLOWED: Record<SubscriptionStatus, SubscriptionStatus[]> = {
      trialing: ['active', 'past_due', 'ended'],
      active: ['past_due', 'ended'],
      // Only from past_due, and only after the grace window — checked below.
      past_due: ['active', 'read_only', 'ended'],
      read_only: ['active', 'ended'],
      ended: [],
    };

    const row = await withPlatform(async (db) => {
      const { rows: current } = await db.query<{
        id: string; status: SubscriptionStatus; past_due_since: string | null;
      }>(
        `SELECT id, status, past_due_since FROM subscription
          WHERE tenant_id = $1 AND ended_at IS NULL FOR UPDATE`, [input.tenantId]);
      if (!current[0]) {
        throw ApiError.make('not_found', 'no_subscription',
          'This school has no live subscription.');
      }
      const from = current[0].status;
      if (from === input.status) return this.readCurrent(db, current[0].id);

      if (!ALLOWED[from].includes(input.status)) {
        throw ApiError.make('conflict', 'illegal_subscription_transition',
          `A subscription cannot go from ${from} to ${input.status}.`);
      }

      if (input.status === 'read_only') {
        // The grace window, enforced here rather than trusted to a scheduler.
        // A job that runs early, or runs twice, must not be able to take a
        // school read-only on the day its card failed.
        const { rows: due } = await db.query<{ elapsed: number }>(
          `SELECT (CURRENT_DATE - $1::date) AS elapsed`, [current[0].past_due_since]);
        if ((due[0]?.elapsed ?? 0) < GRACE_DAYS) {
          throw ApiError.make('conflict', 'grace_window_open',
            `This school has been past due for ${due[0]?.elapsed ?? 0} days. `
            + `The grace window is ${GRACE_DAYS}. They can still mark attendance.`);
        }
      }

      await db.query(
        `UPDATE subscription
            SET status = $2,
                past_due_since = CASE
                  WHEN $2 = 'past_due' AND past_due_since IS NULL THEN CURRENT_DATE
                  WHEN $2 IN ('active', 'trialing') THEN NULL
                  ELSE past_due_since END,
                ended_at = CASE WHEN $2 = 'ended' THEN now() ELSE ended_at END
          WHERE id = $1`, [current[0].id, input.status]);

      await db.query(
        `INSERT INTO subscription_event
           (tenant_id, subscription_id, kind, before, after, actor_user_id, reason)
         VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7)`,
        [input.tenantId, current[0].id,
         input.status === 'ended' ? 'ended' : 'status_changed',
         JSON.stringify({ status: from }), JSON.stringify({ status: input.status }),
         actorUserId, input.reason]);

      return this.readCurrent(db, current[0].id);
    });

    await auditService.record({
      tenantId: input.tenantId, actorUserId, action: 'subscription.status_changed',
      resourceType: 'subscription', resourceId: row.id, classification: 'INTERNAL',
      reason: input.reason, after: { status: row.status },
    });
    return row;
  },

  /**
   * Usage against the plan (M16.4), counted from the rows.
   *
   * Returned beside the limits rather than as a separate endpoint, because the
   * number on its own means nothing — "412 learners" is only useful next to
   * "500 included, 600 cap", and two round trips is how a UI ends up showing
   * one without the other.
   */
  async usageForTenant(scope: TenantScope): Promise<Array<{
    metric: string; used: number; included: number; hard_cap: number | null;
    state: 'ok' | 'over_allowance' | 'at_cap';
  }>> {
    return withTenant(scope, async (db) => {
      const { rows } = await db.query<{
        metric: string; used: number; included: number; hard_cap: number | null;
      }>('SELECT metric, included, hard_cap, used FROM app_tenant_plan_limits()');

      return rows.map((r) => ({
        ...r,
        // Three states, not a percentage. "83% of your plan" tells a bursar
        // nothing actionable; "over your allowance, not yet capped" does.
        state: r.hard_cap !== null && r.used >= r.hard_cap ? 'at_cap' as const
          : r.used > r.included ? 'over_allowance' as const
          : 'ok' as const,
      }));
    });
  },

  /**
   * What the school sees about itself.
   *
   * Through `app_tenant_plan()` and its siblings rather than a join, because
   * migration 0064 took the app role's grant on the catalogue away: those
   * tables have no tenant column and therefore no row-level security to catch
   * a query that forgets its filter, so the function is the boundary.
   */
  async forTenant(scope: TenantScope): Promise<(SubscriptionRow & {
    price_monthly: string;
    price_annual: string;
    limits: Array<{ metric: string; included: number; hard_cap: number | null }>;
    features: Array<{ feature: string; enabled: boolean }>;
  }) | null> {
    return withTenant(scope, async (db) => {
      const { rows } = await db.query<SubscriptionRow & {
        price_monthly: string; price_annual: string;
      }>(`SELECT subscription_id AS id, plan_version_id, plan_code, plan_name,
                 version, status, billing_period, trial_ends_on,
                 period_start, period_end, past_due_since,
                 price_monthly, price_annual
            FROM app_tenant_plan()`);
      const plan = rows[0];
      if (!plan) return null;

      const { rows: limits } = await db.query<{
        metric: string; included: number; hard_cap: number | null;
      }>('SELECT metric, included, hard_cap FROM app_tenant_plan_limits()');
      const { rows: features } = await db.query<{ feature: string; enabled: boolean }>(
        'SELECT feature, enabled FROM app_tenant_plan_features()');

      return { ...plan, tenant_id: scope.tenantId, limits, features };
    });
  },

  /**
   * The other plans a school could be on (M16.6).
   *
   * Read through the tenant pool against the catalogue tables, which the app
   * role may SELECT — plan pricing is public, and a school that has to ask a
   * salesperson what the next tier costs is a school that finds out it has
   * outgrown its plan by being refused.
   *
   * Only published, public, current versions: a retired version is not on offer
   * and a draft is not real.
   */
  async optionsForTenant(scope: TenantScope): Promise<Array<{
    plan_version_id: string; plan_code: string; plan_name: string;
    price_monthly: string; price_annual: string;
    limits: Array<{ metric: string; included: number; hard_cap: number | null }>;
    features: Array<{ feature: string; enabled: boolean }>;
  }>> {
    return withTenant(scope, async (db) => {
      const { rows } = await db.query<{
        plan_version_id: string; plan_code: string; plan_name: string;
        price_monthly: string; price_annual: string;
        limits: Array<{ metric: string; included: number; hard_cap: number | null }>;
        features: Array<{ feature: string; enabled: boolean }>;
      }>('SELECT * FROM app_plan_options()');
      return rows;
    });
  },

  /** The school's own billing history. Same rows the console sees. */
  async historyForTenant(scope: TenantScope): Promise<Array<{
    kind: string; before: unknown; after: unknown; reason: string | null;
    occurred_at: string;
  }>> {
    return withTenant(scope, async (db) => {
      const { rows } = await db.query<{
        kind: string; before: unknown; after: unknown; reason: string | null;
        occurred_at: string;
      }>(
        `SELECT kind, before, after, reason, occurred_at
           FROM subscription_event ORDER BY occurred_at DESC LIMIT 100`);
      return rows;
    });
  },

  /** @internal */
  async readCurrent(
    db: { query: <R>(t: string, p?: readonly unknown[]) => Promise<{ rows: R[] }> },
    id: string,
  ): Promise<SubscriptionRow> {
    const { rows } = await db.query<SubscriptionRow>(
      `SELECT ${SELECT_ROW} ${FROM_ROW} WHERE s.id = $1`, [id]);
    return rows[0]!;
  },
};
