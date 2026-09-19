import { withTenant, type TenantScope } from '../../db/tenant.ts';
import { ApiError } from '../../common/errors.ts';

export interface ClassGroup {
  id: string;
  programme_id: string;
  academic_year_id: string;
  name: string;
  group_kind: string;
  level_sequence: number | null;
}

export interface Section {
  id: string;
  class_group_id: string;
  name: string;
  class_teacher_staff_id: string | null;
}

export interface ScheduleSlot {
  id: string;
  course_offering_id: string;
  section_id: string | null;
  room_id: string | null;
  staff_id: string | null;
  day_of_week: number;
  starts_at: string;
  ends_at: string;
}

/**
 * Postgres error codes we translate rather than leak. 23P01 is an exclusion
 * constraint violation — the timetable clash — and the constraint name tells us
 * which resource was already booked.
 */
function translateSlotConflict(err: unknown): never {
  const e = err as { code?: string; constraint?: string };
  if (e.code === '23P01') {
    const which =
      e.constraint === 'schedule_slot_room_not_double_booked' ? 'room'
      : e.constraint === 'schedule_slot_teacher_not_double_booked' ? 'teacher'
      : e.constraint === 'schedule_slot_section_not_double_booked' ? 'section'
      : 'resource';
    throw ApiError.make('conflict', `timetable_${which}_clash`,
      `That ${which} is already booked for an overlapping period.`);
  }
  throw err;
}

export const academicsRepository = {
  async listClassGroups(scope: TenantScope, academicYearId: string): Promise<ClassGroup[]> {
    return withTenant(scope, async (db) => {
      const { rows } = await db.query<ClassGroup>(
        `SELECT id, programme_id, academic_year_id, name, group_kind, level_sequence
           FROM class_group
          WHERE academic_year_id = $1 AND deleted_at IS NULL
          ORDER BY level_sequence NULLS LAST, name`,
        [academicYearId],
      );
      return rows;
    });
  },

  async createClassGroup(
    scope: TenantScope,
    input: {
      programmeId: string; academicYearId: string; name: string;
      groupKind?: string; capacity?: number; levelSequence?: number;
    },
  ): Promise<ClassGroup> {
    return withTenant(scope, async (db) => {
      const { rows } = await db.query<ClassGroup>(
        `INSERT INTO class_group
           (tenant_id, programme_id, academic_year_id, name, group_kind, capacity, level_sequence)
         VALUES (app_current_tenant_id(), $1, $2, $3, COALESCE($4, 'class'), $5, $6)
         RETURNING id, programme_id, academic_year_id, name, group_kind, level_sequence`,
        [input.programmeId, input.academicYearId, input.name, input.groupKind ?? null,
         input.capacity ?? null, input.levelSequence ?? null],
      );
      if (!rows[0]) {
        throw ApiError.make('permission_error', 'staff_only',
          'Only institute staff may change the academic structure.');
      }
      return rows[0];
    });
  },

  async addScheduleSlot(
    scope: TenantScope,
    input: {
      courseOfferingId: string; sectionId?: string; roomId?: string; staffId?: string;
      dayOfWeek: number; startsAt: string; endsAt: string; periodNo?: number;
      effectiveFrom?: string; effectiveTo?: string;
    },
  ): Promise<ScheduleSlot> {
    try {
      return await withTenant(scope, async (db) => {
        const { rows } = await db.query<ScheduleSlot>(
          `INSERT INTO schedule_slot
             (tenant_id, course_offering_id, section_id, room_id, staff_id,
              day_of_week, period_no, starts_at, ends_at, effective_from, effective_to)
           VALUES (app_current_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8,
                   COALESCE($9::date, CURRENT_DATE), $10::date)
           RETURNING id, course_offering_id, section_id, room_id, staff_id,
                     day_of_week, starts_at::text, ends_at::text`,
          [input.courseOfferingId, input.sectionId ?? null, input.roomId ?? null,
           input.staffId ?? null, input.dayOfWeek, input.periodNo ?? null,
           input.startsAt, input.endsAt, input.effectiveFrom ?? null, input.effectiveTo ?? null],
        );
        if (!rows[0]) {
          throw ApiError.make('permission_error', 'staff_only',
            'Only institute staff may change the timetable.');
        }
        return rows[0];
      });
    } catch (err) {
      return translateSlotConflict(err);
    }
  },

  async timetableForStaff(
    scope: TenantScope,
    staffId: string,
  ): Promise<Array<ScheduleSlot & { subject_name: string; section_name: string | null }>> {
    return withTenant(scope, async (db) => {
      const { rows } = await db.query<
        ScheduleSlot & { subject_name: string; section_name: string | null }
      >(
        `SELECT ss.id, ss.course_offering_id, ss.section_id, ss.room_id, ss.staff_id,
                ss.day_of_week, ss.starts_at::text, ss.ends_at::text,
                sub.name AS subject_name, sec.name AS section_name
           FROM schedule_slot ss
           JOIN course_offering co ON co.id = ss.course_offering_id
           JOIN subject sub ON sub.id = co.subject_id
           LEFT JOIN section sec ON sec.id = ss.section_id
          WHERE ss.staff_id = $1
            AND ss.deleted_at IS NULL
            AND (ss.effective_to IS NULL OR ss.effective_to >= CURRENT_DATE)
          ORDER BY ss.day_of_week, ss.starts_at`,
        [staffId],
      );
      return rows;
    });
  },
};
