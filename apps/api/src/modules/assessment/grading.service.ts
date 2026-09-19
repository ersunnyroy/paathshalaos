/**
 * M8.1 — grading scales, and the mapping from a percentage to a grade.
 *
 * The mapping lives in the database as bands, not in this file as a switch
 * statement, because every board and half the private schools grade
 * differently. A hard-coded table means a release for every customer who joins,
 * and — worse — a silent behaviour change for existing ones when it is edited.
 */
import { withTenant, type TenantScope, type TenantClient } from '../../db/tenant.ts';
import { ApiError } from '../../common/errors.ts';
import { auditService } from '../audit/audit.service.ts';

export type ScaleKind = 'percentage' | 'letter' | 'gpa';

export interface GradeBand {
  id: string;
  label: string;
  lower: string;
  upper: string;
  grade_point: string | null;
  is_pass: boolean;
}

export interface GradingScale {
  id: string;
  name: string;
  kind: ScaleKind;
  is_published: boolean;
}

/** What a percentage resolves to. `null` band means the scale has a hole. */
export interface GradeVerdict {
  label: string;
  gradePoint: number | null;
  isPass: boolean;
}

export const gradingService = {
  /**
   * Creates a draft scale with its bands.
   *
   * Bands are half-open `[lower, upper)`. A closed upper bound is how a mark of
   * exactly 90 becomes both an A and an A+ depending on which row the planner
   * happened to reach first, so the API does not offer the choice.
   */
  async createDraft(
    scope: TenantScope,
    input: {
      academicUnitId: string;
      name: string;
      kind: ScaleKind;
      bands: Array<{
        label: string; lower: number; upper: number;
        gradePoint?: number; isPass?: boolean; description?: string;
      }>;
    },
  ): Promise<GradingScale> {
    if (input.bands.length === 0) {
      throw ApiError.make('validation_error', 'scale_needs_bands',
        'A grading scale needs at least one band.');
    }

    const scale = await withTenant(scope, async (db) => {
      const { rows } = await db.query<GradingScale>(
        `INSERT INTO grading_scale (tenant_id, academic_unit_id, name, kind)
         VALUES (app_current_tenant_id(), $1::uuid, $2, $3)
         RETURNING id, name, kind, is_published`,
        [input.academicUnitId, input.name, input.kind],
      );
      const created = rows[0]!;

      for (const b of input.bands) {
        if (b.upper <= b.lower) {
          throw ApiError.make('validation_error', 'bad_band',
            `Band ${b.label} ends at or before it starts.`);
        }
        await db.query(
          `INSERT INTO grade_band
             (tenant_id, grading_scale_id, label, span, grade_point, is_pass, description)
           VALUES (app_current_tenant_id(), $1::uuid, $2,
                   numrange($3::numeric, $4::numeric, '[)'),
                   $5::numeric, $6::boolean, $7::text)`,
          [created.id, b.label, String(b.lower), String(b.upper),
           b.gradePoint ?? null, b.isPass ?? true, b.description ?? null],
        );
      }
      return created;
    });

    await auditService.record({
      tenantId: scope.tenantId,
      actorUserId: scope.actorId,
      action: 'grading_scale.created',
      resourceType: 'grading_scale',
      resourceId: scale.id,
      classification: 'INTERNAL',
    });
    return scale;
  },

  /**
   * Publishes the scale, which freezes it.
   *
   * The coverage gate is the interesting part. Overlapping bands are refused by
   * an exclusion constraint at insert; a HOLE is not, and a hole produces a
   * blank grade on a report card the day it goes home. Coverage is therefore
   * checked here — at publish, not at insert — because a scale is built band by
   * band and is incomplete for most of its construction.
   */
  async publish(scope: TenantScope, scaleId: string, byStaffId: string): Promise<void> {
    await withTenant(scope, async (db) => {
      const covered = await db.query<{ covered: boolean }>(
        'SELECT grading_scale_is_covered($1::uuid) AS covered', [scaleId],
      );
      if (!covered.rows[0]?.covered) {
        throw ApiError.make('conflict', 'scale_has_a_gap',
          'The bands must cover 0 to 100 with no gap before the scale can be published.');
      }
      const { rowCount } = await db.query(
        `UPDATE grading_scale
            SET is_published = true, published_at = now(), published_by = $2::uuid
          WHERE id = $1::uuid AND is_published = false`,
        [scaleId, byStaffId],
      );
      if (rowCount === 0) {
        throw ApiError.make('conflict', 'already_published_or_missing',
          'That scale does not exist or is already published.');
      }
    });

    await auditService.record({
      tenantId: scope.tenantId,
      actorUserId: scope.actorId,
      action: 'grading_scale.published',
      resourceType: 'grading_scale',
      resourceId: scaleId,
      classification: 'INTERNAL',
    });
  },

  async bands(db: TenantClient, scaleId: string): Promise<GradeBand[]> {
    const { rows } = await db.query<GradeBand>(
      `SELECT id, label, lower(span)::text AS lower, upper(span)::text AS upper,
              grade_point::text AS grade_point, is_pass
         FROM grade_band WHERE grading_scale_id = $1::uuid
        ORDER BY lower(span)`,
      [scaleId],
    );
    return rows;
  },

  /**
   * Resolves a percentage to a band.
   *
   * Done in SQL with `@>` rather than by comparing numbers in JavaScript,
   * because the band boundaries are `numeric` and a float comparison puts
   * 89.999999999999999 in the wrong band exactly once a year, for one learner,
   * in a way nobody can reproduce.
   */
  async gradeFor(
    db: TenantClient, scaleId: string, percentage: string,
  ): Promise<GradeVerdict | undefined> {
    const { rows } = await db.query<{
      label: string; grade_point: string | null; is_pass: boolean;
    }>(
      `SELECT label, grade_point::text AS grade_point, is_pass
         FROM grade_band
        WHERE grading_scale_id = $1::uuid AND span @> $2::numeric
        LIMIT 1`,
      [scaleId, percentage],
    );
    const band = rows[0];
    if (!band) return undefined;
    return {
      label: band.label,
      gradePoint: band.grade_point === null ? null : Number(band.grade_point),
      isPass: band.is_pass,
    };
  },

  async byId(scope: TenantScope, scaleId: string): Promise<GradingScale | undefined> {
    return withTenant(scope, async (db) => {
      const { rows } = await db.query<GradingScale>(
        'SELECT id, name, kind, is_published FROM grading_scale WHERE id = $1::uuid',
        [scaleId],
      );
      return rows[0];
    });
  },
};
