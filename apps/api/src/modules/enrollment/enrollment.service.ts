import { withTenant, type TenantScope } from '../../db/tenant.ts';
import { auditService } from '../audit/audit.service.ts';
import { ApiError } from '../../common/errors.ts';

export interface Enrollment {
  id: string;
  student_id: string;
  section_id: string;
  academic_year_id: string;
  status: string;
  roll_no: string | null;
  enrolled_on: string;
  ended_on: string | null;
}

export interface EnrollmentEvent {
  id: string;
  event_type: string;
  effective_on: string;
  from_section_id: string | null;
  to_section_id: string | null;
  related_enrollment_id: string | null;
  reason: string | null;
}

export const enrollmentService = {
  async current(scope: TenantScope, studentId: string): Promise<Enrollment | undefined> {
    return withTenant(scope, async (db) => {
      const { rows } = await db.query<Enrollment>(
        `SELECT id, student_id, section_id, academic_year_id, status, roll_no,
                enrolled_on::text, ended_on::text
           FROM enrollment
          WHERE student_id = $1 AND status = 'active'`,
        [studentId],
      );
      return rows[0];
    });
  },

  async history(scope: TenantScope, enrollmentId: string): Promise<EnrollmentEvent[]> {
    return withTenant(scope, async (db) => {
      const { rows } = await db.query<EnrollmentEvent>(
        `SELECT id, event_type, effective_on::text, from_section_id, to_section_id,
                related_enrollment_id, reason
           FROM enrollment_event
          WHERE enrollment_id = $1
          ORDER BY effective_on, created_at`,
        [enrollmentId],
      );
      return rows;
    });
  },

  /**
   * A move between sections inside the same academic year.
   *
   * Updates section_id on the SAME enrollment row. One enrollment means one fee
   * assignment, one attendance history and one roll — a learner who moves from
   * XI-A to XI-B in August has not started a new relationship with the school,
   * and creating a second row would split their year in two everywhere it
   * matters.
   */
  async changeSection(
    scope: TenantScope,
    input: { enrollmentId: string; toSectionId: string; reason: string; effectiveOn?: string },
  ): Promise<Enrollment> {
    if (!input.reason.trim()) {
      throw ApiError.make('validation_error', 'reason_required',
        'A section change must record why.');
    }

    const moved = await withTenant(scope, async (db) => {
      const before = await db.query<{ section_id: string; status: string; academic_year_id: string }>(
        'SELECT section_id, status, academic_year_id FROM enrollment WHERE id = $1',
        [input.enrollmentId],
      );
      const current = before.rows[0];
      if (!current) {
        throw ApiError.make('not_found', 'enrollment_not_found', 'Enrollment not found.');
      }
      if (current.status !== 'active') {
        throw ApiError.make('conflict', 'enrollment_not_active',
          'Only an active enrollment can change section.');
      }
      if (current.section_id === input.toSectionId) {
        throw ApiError.make('validation_error', 'same_section',
          'The learner is already in that section.');
      }

      // The trigger from migration 0019 refuses a section from another academic
      // year, so a cross-year "section change" cannot slip through here.
      const { rows } = await db.query<Enrollment>(
        `UPDATE enrollment SET section_id = $2
          WHERE id = $1 AND status = 'active'
          RETURNING id, student_id, section_id, academic_year_id, status, roll_no,
                    enrolled_on::text, ended_on::text`,
        [input.enrollmentId, input.toSectionId],
      );
      if (!rows[0]) {
        throw ApiError.make('permission_error', 'staff_only',
          'Only staff may move a learner between sections.');
      }

      await db.query(
        `INSERT INTO enrollment_event
           (tenant_id, enrollment_id, event_type, effective_on, from_section_id, to_section_id,
            actor_user_id, reason)
         VALUES (app_current_tenant_id(), $1, 'section_changed',
                 COALESCE($2::date, CURRENT_DATE), $3, $4, $5, $6)`,
        [input.enrollmentId, input.effectiveOn ?? null, current.section_id,
         input.toSectionId, scope.actorId ?? null, input.reason],
      );
      return rows[0];
    });

    await auditService.record({
      tenantId: scope.tenantId,
      actorUserId: scope.actorId,
      action: 'enrollment.section_changed',
      resourceType: 'enrollment',
      resourceId: moved.id,
      classification: 'INTERNAL',
      after: { sectionId: moved.section_id },
      reason: input.reason,
    });
    return moved;
  },

  /**
   * A move to a different campus or academic unit.
   *
   * Ends one enrollment and opens another, linked in both directions, in one
   * transaction. Two rows because the learner genuinely belonged to two places,
   * and each has its own roll number, fee ledger and attendance record that must
   * stay attributable to where it happened.
   *
   * The partial unique index makes the ORDER mandatory: the old enrollment must
   * stop being active before the new one is inserted, or the database refuses
   * the pair. That is the invariant doing its job rather than being worked
   * around.
   */
  async transferCampus(
    scope: TenantScope,
    input: {
      enrollmentId: string;
      toSectionId: string;
      toAcademicYearId: string;
      reason: string;
      effectiveOn?: string;
      rollNo?: string;
    },
  ): Promise<{ from: Enrollment; to: Enrollment }> {
    if (!input.reason.trim()) {
      throw ApiError.make('validation_error', 'reason_required', 'A transfer must record why.');
    }

    const result = await withTenant(scope, async (db) => {
      const found = await db.query<Enrollment>(
        `SELECT id, student_id, section_id, academic_year_id, status, roll_no,
                enrolled_on::text, ended_on::text
           FROM enrollment WHERE id = $1`,
        [input.enrollmentId],
      );
      const source = found.rows[0];
      if (!source) {
        throw ApiError.make('not_found', 'enrollment_not_found', 'Enrollment not found.');
      }
      if (source.status !== 'active') {
        throw ApiError.make('conflict', 'enrollment_not_active',
          'Only an active enrollment can be transferred.');
      }

      const closed = await db.query<Enrollment>(
        `UPDATE enrollment
            SET status = 'transferred', ended_on = COALESCE($2::date, CURRENT_DATE)
          WHERE id = $1 AND status = 'active'
          RETURNING id, student_id, section_id, academic_year_id, status, roll_no,
                    enrolled_on::text, ended_on::text`,
        [input.enrollmentId, input.effectiveOn ?? null],
      );
      if (!closed.rows[0]) {
        throw ApiError.make('permission_error', 'staff_only',
          'Only staff may transfer a learner.');
      }

      const opened = await db.query<Enrollment>(
        `INSERT INTO enrollment
           (tenant_id, student_id, section_id, academic_year_id, roll_no, enrolled_on)
         VALUES (app_current_tenant_id(), $1, $2, $3, $4, COALESCE($5::date, CURRENT_DATE))
         RETURNING id, student_id, section_id, academic_year_id, status, roll_no,
                   enrolled_on::text, ended_on::text`,
        [source.student_id, input.toSectionId, input.toAcademicYearId,
         input.rollNo ?? null, input.effectiveOn ?? null],
      );
      const target = opened.rows[0]!;

      await db.query(
        `INSERT INTO enrollment_event
           (tenant_id, enrollment_id, event_type, effective_on, from_section_id,
            related_enrollment_id, actor_user_id, reason)
         VALUES (app_current_tenant_id(), $1, 'transferred_out',
                 COALESCE($2::date, CURRENT_DATE), $3, $4, $5, $6)`,
        [source.id, input.effectiveOn ?? null, source.section_id, target.id,
         scope.actorId ?? null, input.reason],
      );
      await db.query(
        `INSERT INTO enrollment_event
           (tenant_id, enrollment_id, event_type, effective_on, to_section_id,
            related_enrollment_id, actor_user_id, reason)
         VALUES (app_current_tenant_id(), $1, 'transferred_in',
                 COALESCE($2::date, CURRENT_DATE), $3, $4, $5, $6)`,
        [target.id, input.effectiveOn ?? null, input.toSectionId, source.id,
         scope.actorId ?? null, input.reason],
      );

      return { from: closed.rows[0]!, to: target };
    });

    await auditService.record({
      tenantId: scope.tenantId,
      actorUserId: scope.actorId,
      action: 'enrollment.transferred',
      resourceType: 'enrollment',
      resourceId: result.to.id,
      classification: 'SENSITIVE',
      before: { enrollmentId: result.from.id, sectionId: result.from.section_id },
      after: { enrollmentId: result.to.id, sectionId: result.to.section_id },
      reason: input.reason,
    });
    return result;
  },

  async withdraw(
    scope: TenantScope,
    input: { enrollmentId: string; reason: string; effectiveOn?: string },
  ): Promise<Enrollment> {
    return this.close(scope, { ...input, to: 'withdrawn', eventType: 'withdrawn' });
  },

  async complete(
    scope: TenantScope,
    input: { enrollmentId: string; reason?: string; effectiveOn?: string },
  ): Promise<Enrollment> {
    return this.close(scope, {
      ...input, reason: input.reason ?? 'Programme completed.',
      to: 'completed', eventType: 'completed',
    });
  },

  async close(
    scope: TenantScope,
    input: {
      enrollmentId: string; reason: string; effectiveOn?: string;
      to: 'withdrawn' | 'completed'; eventType: 'withdrawn' | 'completed';
    },
  ): Promise<Enrollment> {
    if (!input.reason.trim()) {
      throw ApiError.make('validation_error', 'reason_required',
        'Ending an enrollment must record why.');
    }

    const closed = await withTenant(scope, async (db) => {
      const { rows } = await db.query<Enrollment>(
        `UPDATE enrollment
            SET status = $2, ended_on = COALESCE($3::date, CURRENT_DATE)
          WHERE id = $1 AND status = 'active'
          RETURNING id, student_id, section_id, academic_year_id, status, roll_no,
                    enrolled_on::text, ended_on::text`,
        [input.enrollmentId, input.to, input.effectiveOn ?? null],
      );
      if (!rows[0]) {
        throw ApiError.make('conflict', 'enrollment_not_active',
          'That enrollment is not active.');
      }

      await db.query(
        `INSERT INTO enrollment_event
           (tenant_id, enrollment_id, event_type, effective_on, from_section_id,
            actor_user_id, reason)
         VALUES (app_current_tenant_id(), $1, $2, COALESCE($3::date, CURRENT_DATE), $4, $5, $6)`,
        [input.enrollmentId, input.eventType, input.effectiveOn ?? null,
         rows[0].section_id, scope.actorId ?? null, input.reason],
      );

      // The learner's own lifecycle follows, but the record stays forever:
      // an alumnus asks for a transcript a decade later.
      await db.query(
        `UPDATE student SET lifecycle_status = $2 WHERE id = $1`,
        [rows[0].student_id, input.to === 'completed' ? 'completed' : 'withdrawn'],
      );
      return rows[0];
    });

    await auditService.record({
      tenantId: scope.tenantId,
      actorUserId: scope.actorId,
      action: `enrollment.${input.eventType}`,
      resourceType: 'enrollment',
      resourceId: closed.id,
      classification: 'SENSITIVE',
      reason: input.reason,
    });
    return closed;
  },
};
