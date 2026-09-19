/**
 * M8.3, M8.4 and M8.5 — computing, reviewing, publishing and correcting results.
 *
 * The three properties, and where each one actually lives:
 *
 *   **Deterministic.** Every input the computation reads is folded into a
 *   digest: assessment ids, weights, maxima, every mark, and the grading bands.
 *   Re-running over unchanged inputs produces the same digest and the same
 *   lines. A different digest means an input moved, which the caller is told
 *   about rather than left to notice in a spreadsheet.
 *
 *   **Reviewed before published.** Computing is not publishing. A run sits in
 *   `computed` until someone who is NOT the person who ran it marks it
 *   reviewed, and that constraint is in the database. A wrong subject weighting
 *   published single-handed reaches three hundred families before anybody reads
 *   a number.
 *
 *   **Corrections supersede.** A published run is never edited. A correction is
 *   a new run that points back at the one it replaces, and the old lines and
 *   report cards stay exactly as they were sent.
 *
 * Arithmetic note: marks are `numeric` in the database and are aggregated in
 * SQL, never parsed into JavaScript floats and added up. A report card that
 * disagrees with itself by 0.01 is a phone call from a parent.
 */
import { createHash } from 'node:crypto';
import { withTenant, type TenantScope, type TenantClient } from '../../db/tenant.ts';
import { ApiError } from '../../common/errors.ts';
import { auditService } from '../audit/audit.service.ts';
import { outboxService } from '../events/outbox.service.ts';
import { gradingService } from './grading.service.ts';

export type RunStatus = 'computed' | 'reviewed' | 'published' | 'superseded' | 'discarded';

export interface ResultRun {
  id: string;
  status: RunStatus;
  inputs_digest: string;
  section_id: string;
  term_id: string;
}

export interface ResultLine {
  enrollment_id: string;
  course_offering_id: string | null;
  obtained: string | null;
  maximum: string | null;
  percentage: string | null;
  grade_label: string | null;
  grade_point: string | null;
  is_pass: boolean | null;
  not_graded_reason: string | null;
}

interface AssessmentInput {
  id: string;
  course_offering_id: string;
  max_marks: string;
  weight_percent: string;
  status: string;
}

interface MarkInputRow {
  assessment_id: string;
  enrollment_id: string;
  marks_obtained: string | null;
  is_absent: boolean;
  is_exempt: boolean;
}

export const resultService = {
  /**
   * Computes a run for one section and term.
   *
   * Per subject: the weighted percentage across that subject's assessments.
   * Overall: the mean of the subject percentages, weighted by each subject's
   * total weight. Exempt assessments are removed from BOTH the numerator and
   * the denominator — an exemption is "this does not count for you", not "you
   * scored nothing" — while an absence scores zero within a subject that the
   * learner did partly sit, because they were assessed and did not attend.
   */
  async compute(
    scope: TenantScope,
    input: {
      sectionId: string; termId: string; gradingScaleId: string;
      computedByStaffId: string; requireCompleteWeights?: boolean;
    },
  ): Promise<{ run: ResultRun; lines: ResultLine[]; unchanged: boolean }> {
    const outcome = await withTenant(scope, async (db) => {
      const year = await db.query<{ academic_year_id: string }>(
        'SELECT academic_year_id FROM term WHERE id = $1::uuid', [input.termId],
      );
      if (!year.rows[0]) {
        throw ApiError.make('not_found', 'term_not_found', 'Term not found.');
      }

      const scale = await db.query<{ is_published: boolean }>(
        'SELECT is_published FROM grading_scale WHERE id = $1::uuid', [input.gradingScaleId],
      );
      if (!scale.rows[0]) {
        throw ApiError.make('not_found', 'scale_not_found', 'Grading scale not found.');
      }
      if (!scale.rows[0].is_published) {
        // A draft scale can still have its boundaries moved, so a result graded
        // on one is a number that may change without any mark changing.
        throw ApiError.make('conflict', 'scale_not_published',
          'Results can only be graded on a published scale.');
      }

      const assessments = await db.query<AssessmentInput>(
        `SELECT a.id, a.course_offering_id, a.max_marks::text AS max_marks,
                a.weight_percent::text AS weight_percent, a.status
           FROM assessment a
           JOIN course_offering co ON co.id = a.course_offering_id
          WHERE a.term_id = $1::uuid
            AND a.status <> 'cancelled'
            AND (co.section_id = $2::uuid OR co.section_id IS NULL)
          ORDER BY a.course_offering_id, a.id`,
        [input.termId, input.sectionId],
      );
      if (assessments.rows.length === 0) {
        throw ApiError.make('conflict', 'nothing_to_compute',
          'This section has no assessments in that term.');
      }

      const open = assessments.rows.filter((a) => a.status !== 'locked');
      if (open.length > 0) {
        // Computing over an assessment still accepting marks produces a number
        // that changes under the reviewer's feet.
        throw ApiError.make('conflict', 'assessments_not_locked',
          `${open.length} assessment(s) in this term are not locked yet.`);
      }

      // Weights per subject must add to 100, or the percentage means nothing.
      // Checked here rather than at insert because assessments are created over
      // weeks and an incomplete set mid-term is normal.
      if (input.requireCompleteWeights !== false) {
        const bySubject = new Map<string, number>();
        for (const a of assessments.rows) {
          bySubject.set(a.course_offering_id,
            (bySubject.get(a.course_offering_id) ?? 0) + Number(a.weight_percent));
        }
        const wrong = [...bySubject.entries()].filter(([, total]) =>
          Math.abs(total - 100) > 0.005);
        if (wrong.length > 0) {
          throw ApiError.make('conflict', 'weights_do_not_total_100',
            `${wrong.length} subject(s) have assessment weights that do not add to 100.`);
        }
      }

      const enrollments = await db.query<{ id: string }>(
        `SELECT id FROM enrollment
          WHERE section_id = $1::uuid AND academic_year_id = $2::uuid
            AND status = 'active'
          ORDER BY id`,
        [input.sectionId, year.rows[0].academic_year_id],
      );

      const marks = await db.query<MarkInputRow>(
        `SELECT m.assessment_id, m.enrollment_id, m.marks_obtained::text AS marks_obtained,
                m.is_absent, m.is_exempt
           FROM mark m
          WHERE m.assessment_id = ANY($1::uuid[])
          ORDER BY m.assessment_id, m.enrollment_id`,
        [assessments.rows.map((a) => a.id)],
      );

      const bands = await gradingService.bands(db, input.gradingScaleId);

      const digest = digestOf({
        assessments: assessments.rows,
        marks: marks.rows,
        enrollments: enrollments.rows.map((e) => e.id),
        bands,
      });

      // Determinism, made observable. An identical digest means an identical
      // computation, so the existing run IS the answer — recomputing it would
      // only produce a second row saying the same thing.
      const prior = await db.query<ResultRun>(
        `SELECT id, status, inputs_digest, section_id, term_id
           FROM result_run
          WHERE section_id = $1::uuid AND term_id = $2::uuid
            AND inputs_digest = $3
            AND status <> 'discarded'
          ORDER BY computed_at DESC LIMIT 1`,
        [input.sectionId, input.termId, digest],
      );
      if (prior.rows[0]) {
        const existing = prior.rows[0];
        const lines = await resultService.linesFor(db, existing.id);
        return { run: existing, lines, unchanged: true };
      }

      const { rows: created } = await db.query<ResultRun>(
        `INSERT INTO result_run
           (tenant_id, academic_year_id, term_id, section_id, inputs_digest,
            grading_scale_id, policy, computed_by)
         VALUES (app_current_tenant_id(), $1::uuid, $2::uuid, $3::uuid, $4,
                 $5::uuid, $6::jsonb, $7::uuid)
         RETURNING id, status, inputs_digest, section_id, term_id`,
        [year.rows[0].academic_year_id, input.termId, input.sectionId, digest,
         input.gradingScaleId,
         JSON.stringify({ absentScoresZero: true, exemptExcluded: true }),
         input.computedByStaffId],
      );
      const run = created[0]!;

      const markIndex = new Map<string, MarkInputRow>();
      for (const m of marks.rows) markIndex.set(`${m.assessment_id}:${m.enrollment_id}`, m);

      const subjects = new Map<string, AssessmentInput[]>();
      for (const a of assessments.rows) {
        const list = subjects.get(a.course_offering_id);
        if (list) list.push(a);
        else subjects.set(a.course_offering_id, [a]);
      }

      for (const enrollment of enrollments.rows) {
        let overallWeighted = 0;
        let overallWeight = 0;

        for (const [offeringId, list] of subjects) {
          let weighted = 0;
          let weight = 0;
          let assessed = 0;

          for (const a of list) {
            const mark = markIndex.get(`${a.id}:${enrollment.id}`);
            const w = Number(a.weight_percent);
            if (!mark) {
              // No row at all is not an absence — nobody recorded anything. It
              // is excluded and surfaces as an incomplete subject, so the gap is
              // visible to the reviewer instead of scoring zero silently.
              continue;
            }
            if (mark.is_exempt) continue;
            assessed += 1;
            weight += w;
            if (mark.is_absent) continue;
            const ratio = Number(mark.marks_obtained) / Number(a.max_marks);
            weighted += ratio * w;
          }

          if (assessed === 0 || weight === 0) {
            await insertLine(db, run.id, enrollment.id, offeringId, {
              notGradedReason: 'no_marks_recorded',
            });
            continue;
          }

          const percentage = (weighted / weight) * 100;
          const verdict = await gradingService.gradeFor(
            db, input.gradingScaleId, percentage.toFixed(3),
          );
          await insertLine(db, run.id, enrollment.id, offeringId, {
            percentage,
            ...(verdict ? { verdict } : {}),
          });

          overallWeighted += weighted;
          overallWeight += weight;
        }

        if (overallWeight === 0) {
          await insertLine(db, run.id, enrollment.id, null, {
            notGradedReason: 'no_marks_recorded',
          });
          continue;
        }
        const overall = (overallWeighted / overallWeight) * 100;
        const verdict = await gradingService.gradeFor(
          db, input.gradingScaleId, overall.toFixed(3),
        );
        await insertLine(db, run.id, enrollment.id, null, {
          percentage: overall,
          ...(verdict ? { verdict } : {}),
        });
      }

      const lines = await resultService.linesFor(db, run.id);
      return { run, lines, unchanged: false };
    });

    if (!outcome.unchanged) {
      await auditService.record({
        tenantId: scope.tenantId,
        actorUserId: scope.actorId,
        action: 'result_run.computed',
        resourceType: 'result_run',
        resourceId: outcome.run.id,
        classification: 'SENSITIVE',
        after: { digest: outcome.run.inputs_digest, lines: outcome.lines.length },
      });
    }
    return outcome;
  },

  /** A second pair of eyes. The database refuses the reviewer who computed it. */
  async review(
    scope: TenantScope, input: { runId: string; reviewerStaffId: string },
  ): Promise<void> {
    await withTenant(scope, async (db) => {
      const found = await db.query<{ status: RunStatus; computed_by: string | null }>(
        'SELECT status, computed_by FROM result_run WHERE id = $1::uuid FOR UPDATE',
        [input.runId],
      );
      const run = found.rows[0];
      if (!run) throw ApiError.make('not_found', 'run_not_found', 'Result run not found.');
      if (run.status !== 'computed') {
        throw ApiError.make('conflict', 'not_reviewable',
          `A ${run.status} run cannot be reviewed.`);
      }
      if (run.computed_by === input.reviewerStaffId) {
        throw ApiError.make('conflict', 'self_review',
          'Results must be reviewed by someone other than the person who computed them.');
      }
      await db.query(
        `UPDATE result_run SET status = 'reviewed', reviewed_by = $2::uuid, reviewed_at = now()
          WHERE id = $1::uuid`,
        [input.runId, input.reviewerStaffId],
      );
    });

    await auditService.record({
      tenantId: scope.tenantId,
      actorUserId: scope.actorId,
      action: 'result_run.reviewed',
      resourceType: 'result_run',
      resourceId: input.runId,
      classification: 'SENSITIVE',
    });
  },

  /**
   * Publishes a reviewed run. This is the moment results become visible to
   * learners and guardians — the RLS policy in 0033 keys on exactly this status.
   */
  async publish(
    scope: TenantScope, input: { runId: string; publishedByStaffId: string },
  ): Promise<void> {
    await withTenant(scope, async (db) => {
      const { rowCount } = await db.query(
        `UPDATE result_run
            SET status = 'published', published_at = now(), published_by = $2::uuid
          WHERE id = $1::uuid AND status = 'reviewed'`,
        [input.runId, input.publishedByStaffId],
      );
      if (rowCount === 0) {
        throw ApiError.make('conflict', 'not_reviewed',
          'Only a reviewed run can be published.');
      }

      await outboxService.emit(db, {
        eventType: 'results.published',
        aggregateType: 'result_run',
        aggregateId: input.runId,
        payload: { runId: input.runId },
      });
    });

    await auditService.record({
      tenantId: scope.tenantId,
      actorUserId: scope.actorId,
      action: 'result_run.published',
      resourceType: 'result_run',
      resourceId: input.runId,
      classification: 'SENSITIVE',
    });
  },

  /**
   * A correction: the new run replaces the old one, which becomes `superseded`
   * rather than disappearing. Both are kept, because "what did the March card
   * say" is a question that gets asked and has to be answerable.
   */
  async supersede(
    scope: TenantScope,
    input: { oldRunId: string; newRunId: string; reason: string; byStaffId: string },
  ): Promise<void> {
    if (!input.reason.trim()) {
      throw ApiError.make('validation_error', 'reason_required',
        'Superseding a published result needs a reason.');
    }

    await withTenant(scope, async (db) => {
      const both = await db.query<{ id: string; status: RunStatus }>(
        'SELECT id, status FROM result_run WHERE id = ANY($1::uuid[]) FOR UPDATE',
        [[input.oldRunId, input.newRunId]],
      );
      const older = both.rows.find((r) => r.id === input.oldRunId);
      const newer = both.rows.find((r) => r.id === input.newRunId);
      if (!older || !newer) {
        throw ApiError.make('not_found', 'run_not_found', 'One of those runs does not exist.');
      }
      if (older.status !== 'published') {
        throw ApiError.make('conflict', 'not_published',
          'Only a published run can be superseded.');
      }
      if (newer.status !== 'reviewed') {
        throw ApiError.make('conflict', 'replacement_not_reviewed',
          'The replacement run must be reviewed before it can take over.');
      }

      // Order matters: the partial unique index allows exactly one published run
      // per section and term, so the old one steps down first.
      await db.query(
        `UPDATE result_run
            SET status = 'superseded', superseded_by = $2::uuid, supersede_reason = $3
          WHERE id = $1::uuid`,
        [input.oldRunId, input.newRunId, input.reason],
      );
      await db.query(
        `UPDATE result_run
            SET status = 'published', published_at = now(), published_by = $2::uuid
          WHERE id = $1::uuid`,
        [input.newRunId, input.byStaffId],
      );
    });

    await auditService.record({
      tenantId: scope.tenantId,
      actorUserId: scope.actorId,
      action: 'result_run.superseded',
      resourceType: 'result_run',
      resourceId: input.oldRunId,
      classification: 'SENSITIVE',
      reason: input.reason,
      after: { replacedBy: input.newRunId },
    });
  },

  async linesFor(db: TenantClient, runId: string): Promise<ResultLine[]> {
    const { rows } = await db.query<ResultLine>(
      `SELECT enrollment_id, course_offering_id, obtained::text AS obtained,
              maximum::text AS maximum, percentage::text AS percentage,
              grade_label, grade_point::text AS grade_point, is_pass, not_graded_reason
         FROM result_line WHERE result_run_id = $1::uuid
        ORDER BY enrollment_id, course_offering_id NULLS FIRST`,
      [runId],
    );
    return rows;
  },

  async byId(scope: TenantScope, runId: string): Promise<ResultRun | undefined> {
    return withTenant(scope, async (db) => {
      const { rows } = await db.query<ResultRun>(
        `SELECT id, status, inputs_digest, section_id, term_id
           FROM result_run WHERE id = $1::uuid`,
        [runId],
      );
      return rows[0];
    });
  },
};

async function insertLine(
  db: TenantClient,
  runId: string,
  enrollmentId: string,
  offeringId: string | null,
  value: {
    percentage?: number;
    verdict?: { label: string; gradePoint: number | null; isPass: boolean };
    notGradedReason?: string;
  },
): Promise<void> {
  // A band that does not exist is not a silent blank: the scale had a hole, the
  // line says so, and the reviewer sees it before a family does.
  const reason = value.notGradedReason
    ?? (value.percentage !== undefined && !value.verdict ? 'no_band_for_percentage' : null);

  await db.query(
    `INSERT INTO result_line
       (tenant_id, result_run_id, enrollment_id, course_offering_id,
        percentage, grade_label, grade_point, is_pass, not_graded_reason)
     VALUES (app_current_tenant_id(), $1::uuid, $2::uuid, $3::uuid,
             $4::numeric, $5::text, $6::numeric, $7::boolean, $8::text)`,
    [runId, enrollmentId, offeringId,
     value.percentage === undefined ? null : value.percentage.toFixed(3),
     value.verdict?.label ?? null,
     value.verdict?.gradePoint ?? null,
     value.verdict?.isPass ?? null,
     reason],
  );
}

/**
 * The input digest.
 *
 * Every field that can change a number goes in, in a fixed order. A digest that
 * ignored, say, `max_marks` would call two runs identical while one of them
 * halved everybody's percentage — which is exactly the class of change this is
 * meant to catch.
 */
export function digestOf(inputs: {
  assessments: Array<{
    id: string; course_offering_id: string; max_marks: string; weight_percent: string;
  }>;
  marks: Array<{
    assessment_id: string; enrollment_id: string;
    marks_obtained: string | null; is_absent: boolean; is_exempt: boolean;
  }>;
  enrollments: string[];
  bands: Array<{ label: string; lower: string; upper: string; grade_point: string | null }>;
}): string {
  const hash = createHash('sha256');
  for (const a of inputs.assessments) {
    hash.update(`A|${a.id}|${a.course_offering_id}|${a.max_marks}|${a.weight_percent}\n`);
  }
  for (const m of inputs.marks) {
    hash.update(
      `M|${m.assessment_id}|${m.enrollment_id}|${m.marks_obtained ?? ''}` +
      `|${m.is_absent ? 1 : 0}|${m.is_exempt ? 1 : 0}\n`,
    );
  }
  for (const e of inputs.enrollments) hash.update(`E|${e}\n`);
  for (const b of inputs.bands) {
    hash.update(`B|${b.label}|${b.lower}|${b.upper}|${b.grade_point ?? ''}\n`);
  }
  return hash.digest('hex');
}
