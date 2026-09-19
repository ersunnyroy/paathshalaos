/**
 * The plan catalogue (M16.1).
 *
 * The only operation that changes what a school pays is moving that school to a
 * different version. Editing a plan does not do it, cannot do it, and the
 * database refuses the attempt — see the freeze triggers in migration 0059.
 *
 * So the shape here is: draft a version, set its terms, publish it, and from
 * that moment the terms are a historical fact. A price change is a new version
 * plus a deliberate migration of whichever schools should move, one at a time,
 * each leaving a row in `subscription_event`.
 */
import pg from 'pg';
import { withPlatform } from '../../db/platform-pool.ts';
import { ApiError } from '../../common/errors.ts';
import { auditService } from '../audit/audit.service.ts';
import { PLATFORM_TENANT } from '../platform/platform-admin.service.ts';

export type Metric = 'learners' | 'staff' | 'campuses' | 'messages_per_month' | 'storage_mb';
export type Feature = 'transport' | 'hr' | 'lms' | 'public_api' | 'whatsapp' | 'advanced_reports';

export interface Terms {
  limits: Array<{ metric: Metric; included: number; hardCap: number | null }>;
  features: Array<{ feature: Feature; enabled: boolean }>;
}

export interface PlanVersionRow {
  id: string;
  plan_id: string;
  plan_code: string;
  plan_name: string;
  version: number;
  price_monthly: string;
  price_annual: string;
  currency: string;
  status: string;
  published_at: string | null;
}

export const catalogueService = {
  async createPlan(actorUserId: string, input: {
    code: string; name: string; isPublic?: boolean | undefined;
  }): Promise<{ id: string; code: string }> {
    const row = await withPlatform(async (db) => {
      const { rows } = await db.query<{ id: string; code: string }>(
        `INSERT INTO plan (code, name, is_public) VALUES ($1, $2, $3)
         ON CONFLICT (code) DO NOTHING
         RETURNING id, code`,
        [input.code, input.name, input.isPublic ?? true]);
      if (!rows[0]) {
        throw ApiError.make('conflict', 'plan_exists',
          `There is already a plan with the code ${input.code}.`);
      }
      return rows[0];
    });

    await auditService.record({
      tenantId: PLATFORM_TENANT, actorUserId, action: 'plan.created',
      resourceType: 'plan', resourceId: row.id, classification: 'INTERNAL',
      after: { code: input.code, name: input.name },
    });
    return row;
  },

  /**
   * Opens a new draft version, seeded from the current published one.
   *
   * Seeding matters more than it looks. A new version written from scratch is a
   * new version where somebody forgot to carry over the storage limit, and the
   * schools moved onto it discover that at the worst moment. Copying then
   * editing means every term is deliberate — the ones that changed and the ones
   * that did not.
   */
  async draftVersion(actorUserId: string, planCode: string, input: {
    priceMonthly: string; priceAnnual: string; note?: string | undefined;
  }): Promise<PlanVersionRow> {
    const row = await withPlatform(async (db) => {
      const { rows: plans } = await db.query<{ id: string }>(
        'SELECT id FROM plan WHERE code = $1', [planCode]);
      const plan = plans[0];
      if (!plan) throw ApiError.make('not_found', 'plan_not_found', 'No such plan.');

      // Locked, because two people drafting at once would otherwise both compute
      // version = max + 1 and one insert would fail on the unique constraint —
      // which is safe, but produces a confusing error instead of a queue.
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',
        [`plan-version:${plan.id}`]);

      const { rows: latest } = await db.query<{ id: string; version: number }>(
        `SELECT id, version FROM plan_version
          WHERE plan_id = $1 ORDER BY version DESC LIMIT 1`, [plan.id]);

      const next = (latest[0]?.version ?? 0) + 1;
      const { rows: made } = await db.query<{ id: string }>(
        `INSERT INTO plan_version
           (plan_id, version, price_monthly, price_annual, note, created_by)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [plan.id, next, input.priceMonthly, input.priceAnnual,
         input.note ?? null, actorUserId]);
      const versionId = made[0]!.id;

      if (latest[0]) {
        await db.query(
          `INSERT INTO plan_limit (plan_version_id, metric, included, hard_cap)
           SELECT $1, metric, included, hard_cap FROM plan_limit WHERE plan_version_id = $2`,
          [versionId, latest[0].id]);
        await db.query(
          `INSERT INTO plan_feature (plan_version_id, feature, enabled)
           SELECT $1, feature, enabled FROM plan_feature WHERE plan_version_id = $2`,
          [versionId, latest[0].id]);
      }

      return this.readVersion(db, versionId);
    });

    await auditService.record({
      tenantId: PLATFORM_TENANT, actorUserId, action: 'plan.version_drafted',
      resourceType: 'plan_version', resourceId: row.id, classification: 'INTERNAL',
      after: { plan: planCode, version: row.version },
    });
    return row;
  },

  /** Replaces the terms of a DRAFT version. The database refuses anything else. */
  async setTerms(actorUserId: string, versionId: string, terms: Terms): Promise<void> {
    await withPlatform(async (db) => {
      const { rows } = await db.query<{ status: string }>(
        'SELECT status FROM plan_version WHERE id = $1', [versionId]);
      if (!rows[0]) throw ApiError.make('not_found', 'version_not_found', 'No such version.');
      if (rows[0].status !== 'draft') {
        // The trigger would refuse this too. Saying it here turns a database
        // error into an explanation of the rule.
        throw ApiError.make('conflict', 'version_published',
          'This version is published, so its terms are what the schools on it '
          + 'agreed to. Draft a new version instead.');
      }

      await db.query('DELETE FROM plan_limit WHERE plan_version_id = $1', [versionId]);
      await db.query('DELETE FROM plan_feature WHERE plan_version_id = $1', [versionId]);

      for (const limit of terms.limits) {
        await db.query(
          `INSERT INTO plan_limit (plan_version_id, metric, included, hard_cap)
           VALUES ($1, $2, $3, $4)`,
          [versionId, limit.metric, limit.included, limit.hardCap]);
      }
      for (const feature of terms.features) {
        await db.query(
          'INSERT INTO plan_feature (plan_version_id, feature, enabled) VALUES ($1, $2, $3)',
          [versionId, feature.feature, feature.enabled]);
      }
    });

    await auditService.record({
      tenantId: PLATFORM_TENANT, actorUserId, action: 'plan.terms_set',
      resourceType: 'plan_version', resourceId: versionId, classification: 'INTERNAL',
      after: terms,
    });
  },

  /** Publishes a draft. From here the terms are a historical fact. */
  async publish(actorUserId: string, versionId: string): Promise<void> {
    await withPlatform(async (db) => {
      const { rowCount } = await db.query(
        `UPDATE plan_version SET status = 'published', published_at = now()
          WHERE id = $1 AND status = 'draft'`, [versionId]);
      if (rowCount === 0) {
        throw ApiError.make('conflict', 'not_a_draft',
          'Only a draft can be published.');
      }
    });
    await auditService.record({
      tenantId: PLATFORM_TENANT, actorUserId, action: 'plan.version_published',
      resourceType: 'plan_version', resourceId: versionId, classification: 'INTERNAL',
    });
  },

  /**
   * Retires a version: no new subscribers, everybody already on it stays.
   *
   * The distinction the word "retired" is carrying: this is not a deletion and
   * not a migration. Schools on a retired version keep their price until
   * somebody moves them deliberately, which is a separate decision with its own
   * audit row.
   */
  async retire(actorUserId: string, versionId: string): Promise<void> {
    await withPlatform(async (db) => {
      const { rowCount } = await db.query(
        `UPDATE plan_version SET status = 'retired', retired_at = now()
          WHERE id = $1 AND status = 'published'`, [versionId]);
      if (rowCount === 0) {
        throw ApiError.make('conflict', 'not_published',
          'Only a published version can be retired.');
      }
    });
    await auditService.record({
      tenantId: PLATFORM_TENANT, actorUserId, action: 'plan.version_retired',
      resourceType: 'plan_version', resourceId: versionId, classification: 'INTERNAL',
    });
  },

  async list(): Promise<Array<PlanVersionRow & {
    limits: Array<{ metric: string; included: number; hard_cap: number | null }>;
    features: Array<{ feature: string; enabled: boolean }>;
    subscribers: number;
  }>> {
    return withPlatform(async (db) => {
      const { rows } = await db.query<PlanVersionRow & {
        limits: Array<{ metric: string; included: number; hard_cap: number | null }>;
        features: Array<{ feature: string; enabled: boolean }>;
        subscribers: number;
      }>(
        `SELECT pv.id, pv.plan_id, p.code AS plan_code, p.name AS plan_name,
                pv.version, pv.price_monthly::text, pv.price_annual::text,
                pv.currency, pv.status, pv.published_at,
                COALESCE((SELECT jsonb_agg(jsonb_build_object(
                            'metric', metric, 'included', included, 'hard_cap', hard_cap)
                          ORDER BY metric)
                     FROM plan_limit WHERE plan_version_id = pv.id), '[]'::jsonb) AS limits,
                COALESCE((SELECT jsonb_agg(jsonb_build_object(
                            'feature', feature, 'enabled', enabled) ORDER BY feature)
                     FROM plan_feature WHERE plan_version_id = pv.id), '[]'::jsonb) AS features,
                (SELECT count(*)::int FROM subscription s
                  WHERE s.plan_version_id = pv.id AND s.ended_at IS NULL) AS subscribers
           FROM plan_version pv
           JOIN plan p ON p.id = pv.plan_id
          ORDER BY p.code, pv.version DESC`);
      return rows;
    });
  },

  /** @internal — shared by draftVersion and the tests. */
  async readVersion(db: pg.PoolClient, versionId: string): Promise<PlanVersionRow> {
    const { rows } = await db.query<PlanVersionRow>(
      `SELECT pv.id, pv.plan_id, p.code AS plan_code, p.name AS plan_name, pv.version,
              pv.price_monthly::text, pv.price_annual::text, pv.currency,
              pv.status, pv.published_at
         FROM plan_version pv JOIN plan p ON p.id = pv.plan_id
        WHERE pv.id = $1`, [versionId]);
    return rows[0]!;
  },
};
