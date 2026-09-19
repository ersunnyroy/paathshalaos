/**
 * M8.1 and M8.2 — assessments and marks entry.
 *
 * Marks entry is the feature a teacher uses under the most time pressure, on
 * the worst connection, at the end of the longest day. Everything here is shaped
 * by that:
 *
 *   - **Bulk by default.** A class is one call, not thirty-five.
 *   - **Idempotent.** A replayed batch (bad signal, tapped twice, app restarted
 *     mid-send) applies nothing the second time, on the `client_event_id`
 *     collision, exactly as attendance does in M6.
 *   - **Partial success is reported, not hidden.** One bad row must not discard
 *     thirty-four good ones, and must not be silently dropped either. Every row
 *     comes back with an outcome.
 *   - **Absent is not zero.** The database refuses to store it as one; this
 *     layer refuses to let a caller conflate them.
 */
import { withTenant, type TenantScope, type TenantClient } from '../../db/tenant.ts';
import { ApiError } from '../../common/errors.ts';
import { auditService } from '../audit/audit.service.ts';
import { outboxService } from '../events/outbox.service.ts';

export type AssessmentStatus = 'draft' | 'open' | 'locked' | 'cancelled';

export interface Assessment {
  id: string;
  name: string;
  kind: string;
  max_marks: string;
  weight_percent: string;
  status: AssessmentStatus;
  term_id: string;
  course_offering_id: string;
}

/** One row of a bulk entry. Exactly one of the three outcomes is expressed. */
export interface MarkInput {
  enrollmentId: string;
  marks?: number | string;
  absent?: boolean;
  exempt?: boolean;
  remarks?: string;
  clientEventId?: string;
}

export type MarkOutcome =
  | { enrollmentId: string; outcome: 'recorded'; markId: string }
  | { enrollmentId: string; outcome: 'updated'; markId: string }
  | { enrollmentId: string; outcome: 'already_applied'; markId: string }
  | { enrollmentId: string; outcome: 'rejected'; reason: string };

const SELECT_ASSESSMENT = `id, name, kind, max_marks::text AS max_marks,
       weight_percent::text AS weight_percent, status, term_id, course_offering_id`;

export const assessmentService = {
  async create(
    scope: TenantScope,
    input: {
      courseOfferingId: string; termId: string; name: string;
      kind: Assessment['kind']; maxMarks: number | string;
      weightPercent?: number; passMarks?: number; gradingScaleId?: string;
      scheduledOn?: string;
    },
  ): Promise<Assessment> {
    const assessment = await withTenant(scope, async (db) => {
      const { rows } = await db.query<Assessment>(
        `INSERT INTO assessment
           (tenant_id, course_offering_id, term_id, academic_year_id, name, kind,
            max_marks, pass_marks, weight_percent, grading_scale_id, scheduled_on)
         VALUES (app_current_tenant_id(), $1::uuid, $2::uuid,
                 '00000000-0000-0000-0000-000000000000'::uuid, $3, $4,
                 $5::numeric, $6::numeric, $7::numeric, $8::uuid, $9::date)
         RETURNING ${SELECT_ASSESSMENT}`,
        [input.courseOfferingId, input.termId, input.name, input.kind,
         String(input.maxMarks), input.passMarks ?? null,
         String(input.weightPercent ?? 0), input.gradingScaleId ?? null,
         input.scheduledOn ?? null],
      );
      return rows[0]!;
    });

    await auditService.record({
      tenantId: scope.tenantId,
      actorUserId: scope.actorId,
      action: 'assessment.created',
      resourceType: 'assessment',
      resourceId: assessment.id,
      classification: 'INTERNAL',
    });
    return assessment;
  },

  /** Draft → open. Marks cannot be entered before this. */
  async open(scope: TenantScope, assessmentId: string): Promise<void> {
    await withTenant(scope, async (db) => {
      const { rowCount } = await db.query(
        `UPDATE assessment SET status = 'open', updated_at = now()
          WHERE id = $1::uuid AND status = 'draft'`,
        [assessmentId],
      );
      if (rowCount === 0) {
        throw ApiError.make('conflict', 'not_a_draft',
          'Only a draft assessment can be opened.');
      }
    });
  },

  /**
   * Locks it. After this, marks are frozen and the only way to change one is an
   * approved correction — which is what makes "it always said 34" answerable.
   */
  async lock(scope: TenantScope, assessmentId: string, byStaffId: string): Promise<void> {
    await withTenant(scope, async (db) => {
      const { rowCount } = await db.query(
        `UPDATE assessment
            SET status = 'locked', locked_at = now(), locked_by_staff_id = $2::uuid,
                updated_at = now()
          WHERE id = $1::uuid AND status = 'open'`,
        [assessmentId, byStaffId],
      );
      if (rowCount === 0) {
        throw ApiError.make('conflict', 'not_open',
          'Only an open assessment can be locked.');
      }
    });

    await auditService.record({
      tenantId: scope.tenantId,
      actorUserId: scope.actorId,
      action: 'assessment.locked',
      resourceType: 'assessment',
      resourceId: assessmentId,
      classification: 'INTERNAL',
    });
  },

  /**
   * Bulk marks entry.
   *
   * Each row is attempted in its own savepoint, so one rejection does not lose
   * the rest of the class — the alternative is a teacher re-entering
   * thirty-four marks because of one typo, which is how marks end up on paper
   * instead.
   */
  async enterMarks(
    scope: TenantScope,
    input: { assessmentId: string; enteredByStaffId: string; marks: MarkInput[] },
  ): Promise<{ outcomes: MarkOutcome[] }> {
    if (input.marks.length === 0) {
      throw ApiError.make('validation_error', 'no_marks', 'No marks were supplied.');
    }

    const outcomes = await withTenant(scope, async (db) => {
      const assessment = await db.query<{ status: AssessmentStatus; max_marks: string }>(
        'SELECT status, max_marks::text AS max_marks FROM assessment WHERE id = $1::uuid',
        [input.assessmentId],
      );
      const a = assessment.rows[0];
      if (!a) {
        throw ApiError.make('not_found', 'assessment_not_found', 'Assessment not found.');
      }
      if (a.status !== 'open') {
        // A whole-batch refusal, deliberately: if the assessment is locked the
        // teacher needs to know before they retype anything.
        throw ApiError.make('conflict', `assessment_${a.status}`,
          `Marks can only be entered against an open assessment (this one is ${a.status}).`);
      }

      const results: MarkOutcome[] = [];
      for (const m of input.marks) {
        const shape = describe(m);
        if (shape.error) {
          results.push({ enrollmentId: m.enrollmentId, outcome: 'rejected',
            reason: shape.error });
          continue;
        }

        await db.query('SAVEPOINT mark_row');
        try {
          const existing = await db.query<{ id: string; client_event_id: string | null }>(
            `SELECT id, client_event_id FROM mark
              WHERE assessment_id = $1::uuid AND enrollment_id = $2::uuid`,
            [input.assessmentId, m.enrollmentId],
          );
          const prior = existing.rows[0];

          // The M6 lesson: the idempotency check must be the FIRST question and
          // must be about this event id alone. Folding it into an OR with the
          // natural key made a replay resolve to whichever row the planner
          // reached first, which silently attributed one learner's entry to
          // another.
          if (m.clientEventId) {
            const seen = await db.query<{ id: string; enrollment_id: string }>(
              'SELECT id, enrollment_id FROM mark WHERE client_event_id = $1::uuid',
              [m.clientEventId],
            );
            const event = seen.rows[0];
            if (event && event.enrollment_id === m.enrollmentId) {
              await db.query('RELEASE SAVEPOINT mark_row');
              results.push({ enrollmentId: m.enrollmentId, outcome: 'already_applied',
                markId: event.id });
              continue;
            }
            if (event) {
              await db.query('RELEASE SAVEPOINT mark_row');
              results.push({ enrollmentId: m.enrollmentId, outcome: 'rejected',
                reason: 'client_event_id_belongs_to_another_learner' });
              continue;
            }
          }

          if (prior) {
            const { rows } = await db.query<{ id: string }>(
              `UPDATE mark
                  SET marks_obtained = $3::numeric, is_absent = $4, is_exempt = $5,
                      remarks = $6::text, client_event_id = COALESCE($7::uuid, client_event_id),
                      entered_by_staff_id = $8::uuid, entered_at = now(), updated_at = now()
                WHERE id = $1::uuid AND assessment_id = $2::uuid
              RETURNING id`,
              [prior.id, input.assessmentId, shape.marks, shape.absent, shape.exempt,
               m.remarks ?? null, m.clientEventId ?? null, input.enteredByStaffId],
            );
            await db.query('RELEASE SAVEPOINT mark_row');
            results.push({ enrollmentId: m.enrollmentId, outcome: 'updated',
              markId: rows[0]!.id });
            continue;
          }

          const { rows } = await db.query<{ id: string }>(
            `INSERT INTO mark
               (tenant_id, assessment_id, enrollment_id, marks_obtained, is_absent,
                is_exempt, remarks, client_event_id, entered_by_staff_id)
             VALUES (app_current_tenant_id(), $1::uuid, $2::uuid, $3::numeric, $4, $5,
                     $6::text, $7::uuid, $8::uuid)
             RETURNING id`,
            [input.assessmentId, m.enrollmentId, shape.marks, shape.absent, shape.exempt,
             m.remarks ?? null, m.clientEventId ?? null, input.enteredByStaffId],
          );
          await db.query('RELEASE SAVEPOINT mark_row');
          results.push({ enrollmentId: m.enrollmentId, outcome: 'recorded',
            markId: rows[0]!.id });
        } catch (error) {
          await db.query('ROLLBACK TO SAVEPOINT mark_row');
          results.push({
            enrollmentId: m.enrollmentId,
            outcome: 'rejected',
            reason: reasonFor(error),
          });
        }
      }

      await outboxService.emit(db, {
        eventType: 'marks.entered',
        aggregateType: 'assessment',
        aggregateId: input.assessmentId,
        payload: {
          assessmentId: input.assessmentId,
          recorded: results.filter((r) => r.outcome === 'recorded').length,
          updated: results.filter((r) => r.outcome === 'updated').length,
          rejected: results.filter((r) => r.outcome === 'rejected').length,
        },
      });

      return results;
    });

    return { outcomes };
  },

  /**
   * A correction against a locked assessment. Two people: the requester cannot
   * approve, and that is a database constraint rather than a service check.
   */
  async requestCorrection(
    scope: TenantScope,
    input: {
      markId?: string; assessmentId?: string; enrollmentId?: string;
      toMarks?: number | string; toAbsent?: boolean; toExempt?: boolean;
      reason: string; requestedByStaffId: string;
    },
  ): Promise<{ id: string }> {
    if (!input.reason.trim()) {
      throw ApiError.make('validation_error', 'reason_required',
        'A correction needs a reason.');
    }
    const shape = describe({
      enrollmentId: input.enrollmentId ?? '',
      ...(input.toMarks !== undefined ? { marks: input.toMarks } : {}),
      ...(input.toAbsent !== undefined ? { absent: input.toAbsent } : {}),
      ...(input.toExempt !== undefined ? { exempt: input.toExempt } : {}),
    });
    if (shape.error) {
      throw ApiError.make('validation_error', 'bad_correction', shape.error);
    }

    return withTenant(scope, async (db) => {
      let fromMarks: string | null = null;
      let fromAbsent: boolean | null = null;
      if (input.markId) {
        const prior = await db.query<{ marks_obtained: string | null; is_absent: boolean }>(
          'SELECT marks_obtained::text AS marks_obtained, is_absent FROM mark WHERE id = $1::uuid',
          [input.markId],
        );
        if (!prior.rows[0]) {
          throw ApiError.make('not_found', 'mark_not_found', 'Mark not found.');
        }
        fromMarks = prior.rows[0].marks_obtained;
        fromAbsent = prior.rows[0].is_absent;
      }

      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO mark_correction
           (tenant_id, mark_id, assessment_id, enrollment_id, from_marks, from_absent,
            to_marks, to_absent, to_exempt, reason, requested_by)
         VALUES (app_current_tenant_id(), $1::uuid, $2::uuid, $3::uuid, $4::numeric,
                 $5::boolean, $6::numeric, $7, $8, $9, $10::uuid)
         RETURNING id`,
        [input.markId ?? null, input.assessmentId ?? null, input.enrollmentId ?? null,
         fromMarks, fromAbsent, shape.marks, shape.absent, shape.exempt,
         input.reason, input.requestedByStaffId],
      );
      return { id: rows[0]!.id };
    });
  },

  /**
   * Approving a correction applies it.
   *
   * The mark table's own trigger refuses writes to a locked assessment, so the
   * apply runs with the guard briefly disabled INSIDE this transaction and
   * under an explicit approval — rather than the alternative of weakening the
   * trigger, which would leave every other write path unguarded too.
   */
  async approveCorrection(
    scope: TenantScope,
    input: { correctionId: string; approverStaffId: string },
  ): Promise<void> {
    await withTenant(scope, async (db) => {
      const found = await db.query<{
        mark_id: string | null; assessment_id: string | null; enrollment_id: string | null;
        to_marks: string | null; to_absent: boolean; to_exempt: boolean;
        requested_by: string | null; status: string;
      }>(
        `SELECT mark_id, assessment_id, enrollment_id, to_marks::text AS to_marks,
                to_absent, to_exempt, requested_by, status
           FROM mark_correction WHERE id = $1::uuid FOR UPDATE`,
        [input.correctionId],
      );
      const c = found.rows[0];
      if (!c) {
        throw ApiError.make('not_found', 'correction_not_found', 'Correction not found.');
      }
      if (c.status !== 'pending') {
        throw ApiError.make('conflict', 'already_settled',
          'That correction has already been settled.');
      }
      if (c.requested_by === input.approverStaffId) {
        throw ApiError.make('conflict', 'self_approval',
          'A correction must be approved by someone other than the person who raised it.');
      }

      // The trigger in 0034 lets this one write past the lock, but only because
      // a matching PENDING correction exists — setting the flag alone achieves
      // nothing. The correction is marked approved afterwards, so the window is
      // exactly this statement.
      await db.query(`SELECT set_config('app.applying_correction', $1, true)`,
        [input.correctionId]);

      if (c.mark_id) {
        await db.query(
          `UPDATE mark
              SET marks_obtained = $2::numeric, is_absent = $3, is_exempt = $4,
                  updated_at = now()
            WHERE id = $1::uuid`,
          [c.mark_id, c.to_marks, c.to_absent, c.to_exempt],
        );
      } else {
        await db.query(
          `INSERT INTO mark
             (tenant_id, assessment_id, enrollment_id, marks_obtained, is_absent,
              is_exempt, source, entered_by_staff_id)
           VALUES (app_current_tenant_id(), $1::uuid, $2::uuid, $3::numeric, $4, $5,
                   'web', $6::uuid)`,
          [c.assessment_id, c.enrollment_id, c.to_marks, c.to_absent, c.to_exempt,
           input.approverStaffId],
        );
      }

      await db.query(`SELECT set_config('app.applying_correction', '', true)`);

      await db.query(
        `UPDATE mark_correction
            SET status = 'approved', approved_by = $2::uuid, approved_at = now()
          WHERE id = $1::uuid`,
        [input.correctionId, input.approverStaffId],
      );
    });

    await auditService.record({
      tenantId: scope.tenantId,
      actorUserId: scope.actorId,
      action: 'mark_correction.approved',
      resourceType: 'mark_correction',
      resourceId: input.correctionId,
      classification: 'SENSITIVE',
    });
  },

  async byId(scope: TenantScope, assessmentId: string): Promise<Assessment | undefined> {
    return withTenant(scope, async (db) => {
      const { rows } = await db.query<Assessment>(
        `SELECT ${SELECT_ASSESSMENT} FROM assessment WHERE id = $1::uuid`,
        [assessmentId],
      );
      return rows[0];
    });
  },

  async marksFor(db: TenantClient, assessmentId: string): Promise<Array<{
    enrollment_id: string; marks_obtained: string | null;
    is_absent: boolean; is_exempt: boolean;
  }>> {
    const { rows } = await db.query<{
      enrollment_id: string; marks_obtained: string | null;
      is_absent: boolean; is_exempt: boolean;
    }>(
      `SELECT enrollment_id, marks_obtained::text AS marks_obtained, is_absent, is_exempt
         FROM mark WHERE assessment_id = $1::uuid ORDER BY enrollment_id`,
      [assessmentId],
    );
    return rows;
  },
};

/**
 * Normalises one input row into exactly one of: a mark, an absence, an
 * exemption.
 *
 * A row that says both `marks: 0` and `absent: true` is not a row with a
 * sensible default — it is a client bug, and guessing which was meant is how a
 * learner who sat the paper is recorded absent.
 */
function describe(m: MarkInput): {
  marks: string | null; absent: boolean; exempt: boolean; error?: string;
} {
  const hasMarks = m.marks !== undefined && m.marks !== null && m.marks !== '';
  const absent = m.absent === true;
  const exempt = m.exempt === true;
  const count = Number(hasMarks) + Number(absent) + Number(exempt);

  if (count === 0) {
    return { marks: null, absent: false, exempt: false,
      error: 'a mark, an absence or an exemption is required' };
  }
  if (count > 1) {
    return { marks: null, absent: false, exempt: false,
      error: 'a row is a mark, an absence or an exemption — not more than one' };
  }
  if (!hasMarks) return { marks: null, absent, exempt };

  const value = Number(m.marks);
  if (!Number.isFinite(value)) {
    return { marks: null, absent: false, exempt: false, error: 'the mark is not a number' };
  }
  if (value < 0) {
    return { marks: null, absent: false, exempt: false, error: 'a mark cannot be negative' };
  }
  return { marks: String(m.marks), absent: false, exempt: false };
}

function reasonFor(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/exceeds the maximum/.test(message)) return 'exceeds_max_marks';
  if (/violates foreign key/.test(message)) return 'unknown_enrollment';
  if (/duplicate key/.test(message)) return 'duplicate';
  if (/locked/.test(message)) return 'assessment_locked';
  return 'rejected';
}
