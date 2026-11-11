import { withTenant, type TenantScope } from '../../db/tenant.ts';
import { auditService } from '../audit/audit.service.ts';
import { ApiError } from '../../common/errors.ts';

export interface RolloverResult {
  fromAcademicYearId: string;
  toAcademicYearId: string;
  created: {
    terms: number;
    classGroups: number;
    sections: number;
    courseOfferings: number;
    scheduleSlots: number;
  };
  /** Maps each source structure id to the row created for the new year. */
  classGroupMap: Record<string, string>;
}

/**
 * AC-3 — an institute changes its academic structure without breaking history.
 *
 * Rollover COPIES. It never updates a prior-year row, and it never repoints one
 * at a new parent. Every insert below carries the new academic_year_id, and
 * every prior-year row keeps pointing at prior-year structures forever.
 *
 * That is the whole mechanism behind "renaming Class X to Grade 10 next year
 * cannot alter last year's report cards": last year's records reference last
 * year's `class_group` row by id, and that row is never touched again.
 *
 * Runs in one transaction, so a failure halfway leaves the new year empty rather
 * than half-built — a half-rolled-over year is far worse than an unstarted one,
 * because staff cannot tell which classes are real.
 */
export const rolloverService = {
  async rollover(
    scope: TenantScope,
    input: { fromAcademicYearId: string; toAcademicYearId: string;
             includeTimetable?: boolean | undefined },
  ): Promise<RolloverResult> {
    if (input.fromAcademicYearId === input.toAcademicYearId) {
      throw ApiError.make('validation_error', 'same_year', 'Source and target years must differ.');
    }

    const result = await withTenant(scope, async (db) => {
      const years = await db.query<{ id: string; academic_unit_id: string; status: string }>(
        `SELECT id, academic_unit_id, status FROM academic_year
          WHERE id = ANY($1) AND deleted_at IS NULL`,
        [[input.fromAcademicYearId, input.toAcademicYearId]],
      );
      if (years.rows.length !== 2) {
        throw ApiError.make('not_found', 'academic_year_not_found',
          'Both academic years must exist in this institute.');
      }
      const [a, b] = years.rows;
      if (a!.academic_unit_id !== b!.academic_unit_id) {
        throw ApiError.make('validation_error', 'different_academic_units',
          'Rollover only applies within one academic unit.');
      }

      const existing = await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM class_group
          WHERE academic_year_id = $1 AND deleted_at IS NULL`,
        [input.toAcademicYearId],
      );
      if (Number(existing.rows[0]!.n) > 0) {
        // Running it twice would silently double every class.
        throw ApiError.make('conflict', 'target_year_not_empty',
          'The target year already has classes. Rollover runs once.');
      }

      // Terms the institute has already defined for the new year are kept.
      // Staff often set next year's calendar before rolling structures over,
      // and their dates are better than a mechanical +1 year. Only the gaps
      // are filled, so rollover composes with that instead of fighting it.
      const terms = await db.query<{ n: string }>(
        `INSERT INTO term (tenant_id, academic_year_id, label, sequence, starts_on, ends_on)
         SELECT tenant_id, $2, label, sequence,
                (starts_on + interval '1 year')::date,
                (ends_on + interval '1 year')::date
           FROM term
          WHERE academic_year_id = $1 AND deleted_at IS NULL
         ON CONFLICT DO NOTHING
         RETURNING 1`,
        [input.fromAcademicYearId, input.toAcademicYearId],
      );

      // Whether created just now or defined earlier, every source term must have
      // a counterpart by sequence, or offerings would land on a NULL term.
      const unmatched = await db.query<{ sequence: number }>(
        `SELECT src.sequence
           FROM term src
          WHERE src.academic_year_id = $1 AND src.deleted_at IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM term dst
               WHERE dst.academic_year_id = $2 AND dst.sequence = src.sequence
                 AND dst.deleted_at IS NULL
            )`,
        [input.fromAcademicYearId, input.toAcademicYearId],
      );
      if (unmatched.rows.length > 0) {
        throw ApiError.make('conflict', 'term_sequence_missing',
          `The target year has no term for sequence ${unmatched.rows.map((r) => r.sequence).join(', ')}.`);
      }

      const groups = await db.query<{ id: string; source_id: string }>(
        `WITH inserted AS (
           INSERT INTO class_group
             (tenant_id, programme_id, academic_year_id, name, group_kind, capacity, level_sequence)
           SELECT tenant_id, programme_id, $2, name, group_kind, capacity, level_sequence
             FROM class_group
            WHERE academic_year_id = $1 AND deleted_at IS NULL
           RETURNING id, programme_id, name
         )
         SELECT i.id, src.id AS source_id
           FROM inserted i
           JOIN class_group src
             ON src.academic_year_id = $1
            AND src.programme_id = i.programme_id
            AND src.name = i.name
            AND src.deleted_at IS NULL`,
        [input.fromAcademicYearId, input.toAcademicYearId],
      );

      const classGroupMap: Record<string, string> = {};
      for (const row of groups.rows) classGroupMap[row.source_id] = row.id;

      const sections = await db.query<{ n: string }>(
        `INSERT INTO section
           (tenant_id, class_group_id, name, capacity, class_teacher_staff_id, room_id)
         SELECT s.tenant_id, map.new_id, s.name, s.capacity, s.class_teacher_staff_id, s.room_id
           FROM section s
           JOIN (SELECT unnest($1::uuid[]) AS old_id, unnest($2::uuid[]) AS new_id) map
             ON map.old_id = s.class_group_id
          WHERE s.deleted_at IS NULL
         RETURNING 1`,
        [Object.keys(classGroupMap), Object.values(classGroupMap)],
      );

      const offerings = await db.query<{ n: string }>(
        `INSERT INTO course_offering
           (tenant_id, class_group_id, section_id, subject_id, term_id,
            primary_teacher_staff_id, credits, is_elective)
         SELECT co.tenant_id,
                map.new_id,
                -- Match the section by name inside the newly created group.
                (SELECT ns.id FROM section ns
                  WHERE ns.class_group_id = map.new_id
                    AND ns.name = (SELECT os.name FROM section os WHERE os.id = co.section_id)
                  LIMIT 1),
                co.subject_id,
                (SELECT nt.id FROM term nt
                  WHERE nt.academic_year_id = $1::uuid
                    AND nt.sequence = (SELECT ot.sequence FROM term ot WHERE ot.id = co.term_id)
                  LIMIT 1),
                co.primary_teacher_staff_id, co.credits, co.is_elective
           FROM course_offering co
           JOIN (SELECT unnest($2::uuid[]) AS old_id, unnest($3::uuid[]) AS new_id) map
             ON map.old_id = co.class_group_id
          WHERE co.deleted_at IS NULL
         RETURNING 1`,
        [input.toAcademicYearId, Object.keys(classGroupMap), Object.values(classGroupMap)],
      );

      let slotCount = 0;
      if (input.includeTimetable) {
        // Effective dates are SHIFTED by a year, not reset.
        //
        // Resetting them all to the new year's first day collapses slots that
        // were deliberately separated in time — a lesson that ran April to June
        // and its replacement from July become the same open-ended slot, and the
        // room constraint rejects the pair. Shifting preserves the separation,
        // and the constraints proved it by refusing the collapsed version.
        const slots = await db.query<{ n: string }>(
          `INSERT INTO schedule_slot
             (tenant_id, course_offering_id, section_id, room_id, staff_id,
              day_of_week, period_no, starts_at, ends_at, effective_from, effective_to)
           SELECT ss.tenant_id, nco.id, nco.section_id, ss.room_id, ss.staff_id,
                  ss.day_of_week, ss.period_no, ss.starts_at, ss.ends_at,
                  (ss.effective_from + interval '1 year')::date,
                  (ss.effective_to + interval '1 year')::date
             FROM schedule_slot ss
             JOIN course_offering oco ON oco.id = ss.course_offering_id
             JOIN term ot ON ot.id = oco.term_id
             LEFT JOIN section osec ON osec.id = oco.section_id
             JOIN (SELECT unnest($2::uuid[]) AS old_id, unnest($3::uuid[]) AS new_id) map
               ON map.old_id = oco.class_group_id
             -- Subject alone is not enough to identify the counterpart: one
             -- class group has a Physics offering per section, so matching on
             -- subject duplicated every slot across sections and the room
             -- constraint caught it. Section name and term sequence pin it to
             -- exactly one row.
             JOIN course_offering nco
               ON nco.class_group_id = map.new_id
              AND nco.subject_id = oco.subject_id
              AND nco.deleted_at IS NULL
             LEFT JOIN section nsec ON nsec.id = nco.section_id
             JOIN term nt
               ON nt.id = nco.term_id
              AND nt.academic_year_id = $1::uuid
              AND nt.sequence = ot.sequence
            WHERE ss.deleted_at IS NULL
              AND COALESCE(nsec.name, '') = COALESCE(osec.name, '')
           RETURNING 1`,
          [input.toAcademicYearId, Object.keys(classGroupMap), Object.values(classGroupMap)],
        );
        slotCount = slots.rowCount;
      }

      return {
        fromAcademicYearId: input.fromAcademicYearId,
        toAcademicYearId: input.toAcademicYearId,
        created: {
          terms: terms.rowCount,
          classGroups: groups.rows.length,
          sections: sections.rowCount,
          courseOfferings: offerings.rowCount,
          scheduleSlots: slotCount,
        },
        classGroupMap,
      };
    });

    await auditService.record({
      tenantId: scope.tenantId,
      actorUserId: scope.actorId,
      action: 'academic_year.rolled_over',
      resourceType: 'academic_year',
      resourceId: input.toAcademicYearId,
      classification: 'INTERNAL',
      after: result.created,
    });

    return result;
  },
};
