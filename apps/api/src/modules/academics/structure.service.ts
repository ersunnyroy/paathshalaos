/**
 * The academic structure: everything a school has to build before it can teach.
 *
 * **This is the milestone's finding and it is the largest one in the product.**
 * Before this file, nothing in this system could create an academic year, a
 * programme, a subject, a section, a course offering or a room. Only two
 * writers existed for the whole spine: `provisioningService`, which creates one
 * academic unit when the console provisions a tenant, and `rolloverService`,
 * which copies last year's structure into next year.
 *
 * Rollover cannot bootstrap — it refuses a source year with no structure, and
 * correctly so. So the only school that has ever had a working structure in
 * this system is the one in `seed.ts`. **A real school signing up on Monday
 * could not reach the end of its first day**, and every screen built on top of
 * this — attendance, assessment, fees, the timetable, results — was reachable
 * only for data a developer had inserted by hand.
 *
 * Fourteen milestones of features sat on a foundation with no way in.
 *
 * ## Why a service and not four more repositories
 *
 * `academicsRepository` and `tenancyRepository` both held pieces of this, both
 * had methods nothing called, and the split is what let the gap hide: the
 * question "can a school make a class group" had two places to look and no
 * answer in either. Everything structural now lives here, in one file, and the
 * repositories that held fragments of it are gone.
 *
 * ## The rules that are here rather than in the schema
 *
 * Four invariants the foreign keys permit and a school would suffer:
 *
 *   **A term must sit inside its year.** The schema checks that a term's dates
 *   are ordered and that terms within a year do not overlap. It does not check
 *   that a term ends before the year does. A term running past its year makes
 *   every "which term is it" query disagree with every "which year is it" one,
 *   and the disagreement surfaces months later on a report card.
 *
 *   **A course offering's term must belong to its class group's year.** Both
 *   foreign keys are satisfied by a term from 2025-26 on a class group from
 *   2026-27. Nothing downstream notices: marks are entered, a result run
 *   computes, and a report card is issued for a term the child was not in.
 *
 *   **A schedule slot's section must belong to the offering's class group.**
 *   Same shape. The slot appears on a timetable for a section that does not
 *   take that subject.
 *
 *   **A room and the section using it must be on the same campus.** Two
 *   campuses, one room code each, and a section in Bangalore gets assigned a
 *   room in Mysore. The chain is section → class group → programme → academic
 *   unit → campus, which is exactly why nobody checks it by eye.
 *
 * Each is one query. None of them is expressible as a CHECK constraint without
 * a trigger, and a trigger reading four tables to validate one insert is a
 * worse trade than a join in the one place that writes these rows.
 */
import { withTenant, type TenantScope, type TenantClient } from '../../db/tenant.ts';
import { ApiError } from '../../common/errors.ts';

export interface AcademicUnit {
  id: string; tenant_id: string; campus_id: string;
  code: string; name: string; unit_type: string;
}

export interface AcademicYear {
  id: string; academic_unit_id: string; label: string;
  starts_on: string; ends_on: string; status: string;
}

export interface Term {
  id: string; academic_year_id: string; label: string;
  sequence: number; starts_on: string; ends_on: string;
}

export interface Programme {
  id: string; academic_unit_id: string; code: string; name: string;
  duration_terms: number | null; credential_type: string | null;
}

export interface Subject {
  id: string; academic_unit_id: string; code: string; name: string;
  subject_type: string; default_credits: string | null;
}

export interface Room {
  id: string; campus_id: string; code: string; name: string;
  capacity: number | null; room_type: string;
}

export interface ClassGroup {
  id: string; programme_id: string; academic_year_id: string;
  name: string; group_kind: string; level_sequence: number | null;
}

export interface Section {
  id: string; class_group_id: string; name: string;
  capacity: number | null; class_teacher_staff_id: string | null;
  room_id: string | null;
}

export interface CourseOffering {
  id: string; class_group_id: string; section_id: string | null;
  subject_id: string; term_id: string;
  primary_teacher_staff_id: string | null;
  credits: string | null; is_elective: boolean;
}

export interface ScheduleSlot {
  id: string; course_offering_id: string; section_id: string | null;
  room_id: string | null; staff_id: string | null;
  day_of_week: number; starts_at: string; ends_at: string;
}

/**
 * Postgres error codes we translate rather than leak.
 *
 * 23P01 is an exclusion constraint violation — the timetable clash — and the
 * constraint name says which resource was already booked. 23505 is a unique
 * violation, which for structure almost always means somebody is creating the
 * same thing twice; the index name says which.
 */
function translateConflict(err: unknown): never {
  const e = err as { code?: string | undefined; constraint?: string };
  if (e.code === '23P01') {
    const which =
      e.constraint === 'schedule_slot_room_not_double_booked' ? 'room'
      : e.constraint === 'schedule_slot_teacher_not_double_booked' ? 'teacher'
      : e.constraint === 'schedule_slot_section_not_double_booked' ? 'section'
      : 'resource';
    throw ApiError.make('conflict', `timetable_${which}_clash`,
      `That ${which} is already booked for an overlapping period.`);
  }
  if (e.code === '23505') {
    throw ApiError.make('conflict', 'already_exists',
      'Something with that code or name already exists here.');
  }
  // 42501 is the policy refusing the write outright rather than returning no
  // row. Postgres does both depending on the table: a `WITH CHECK` that
  // excludes the row raises `new row violates row-level security policy`, and
  // `RETURNING` on a row the `USING` clause hides comes back empty. Handling
  // only the second — which is what `refused()` below covers — left a guardian
  // writing to `programme` with a 500 and the words "internal error", when the
  // system had in fact worked exactly as designed and refused them.
  if (e.code === '42501') {
    throw ApiError.make('permission_error', 'staff_only',
      'Only institute staff may change the academic structure.');
  }
  throw err;
}

/**
 * A row the policies refused to write.
 *
 * Every INSERT here returns nothing rather than raising when the caller is not
 * staff, because the WITH CHECK clause simply excludes the row. A bare
 * `rows[0]!` would throw a TypeError and surface as a 500; this is the refusal
 * said out loud.
 */
function refused(what: string): never {
  throw ApiError.make('permission_error', 'staff_only',
    `Only institute staff may change the ${what}.`);
}

/** Dates as the database sees them, so comparisons happen in one place. */
async function yearOf(db: TenantClient, academicYearId: string):
Promise<{ id: string; starts_on: string; ends_on: string; status: string } | undefined> {
  const { rows } = await db.query<{
    id: string; starts_on: string; ends_on: string; status: string;
  }>(
    `SELECT id, starts_on::text, ends_on::text, status
       FROM academic_year WHERE id = $1::uuid AND deleted_at IS NULL`,
    [academicYearId]);
  return rows[0];
}

export const structureService = {
  /* ------------------------------------------------------- academic units */

  /**
   * The units inside a campus — a school, a college, a coaching centre.
   *
   * Read-only here on purpose: a unit is created when the console provisions
   * the tenant, because how many units a customer has is part of what they are
   * paying for. But a client could not previously discover one, and
   * `academicUnitId` is required by fee plans, report card templates, academic
   * years, programmes and subjects. Every one of those write routes demanded an
   * id the product would not tell you.
   */
  async academicUnits(scope: TenantScope, campusId?: string): Promise<AcademicUnit[]> {
    return withTenant(scope, async (db) => {
      const { rows } = await db.query<AcademicUnit>(
        `SELECT id, tenant_id, campus_id, code, name, unit_type
           FROM academic_unit
          WHERE deleted_at IS NULL
            AND ($1::uuid IS NULL OR campus_id = $1::uuid)
          ORDER BY name`,
        [campusId ?? null]);
      return rows;
    });
  },

  /* ------------------------------------------------------- years and terms */

  async years(scope: TenantScope, academicUnitId?: string): Promise<AcademicYear[]> {
    return withTenant(scope, async (db) => {
      const { rows } = await db.query<AcademicYear>(
        `SELECT id, academic_unit_id, label, starts_on::text, ends_on::text, status
           FROM academic_year
          WHERE deleted_at IS NULL
            AND ($1::uuid IS NULL OR academic_unit_id = $1::uuid)
          ORDER BY starts_on DESC`,
        [academicUnitId ?? null]);
      return rows;
    });
  },

  /**
   * A year, with its terms, in one transaction.
   *
   * Not two endpoints. A year with no terms cannot hold an assessment, a
   * result run or a report card, so a school that created the year and was
   * interrupted before the terms would have a row that looks like setup and is
   * not. The terms are optional in the call and the year is refused activation
   * without them — see `activateYear` — which is the same rule stated where it
   * can be enforced rather than hoped for.
   *
   * Created as `planning`. Two *active* years may not overlap within a unit
   * (0011's exclusion constraint), and a school building next year in March
   * would otherwise be refused by its own current year.
   */
  async createYear(
    scope: TenantScope,
    input: {
      academicUnitId: string; label: string; startsOn: string; endsOn: string;
      terms?: Array<{ label: string; sequence: number; startsOn: string; endsOn: string }>;
    },
  ): Promise<AcademicYear & { terms: Term[] }> {
    if (input.endsOn <= input.startsOn) {
      throw ApiError.make('validation_error', 'dates_out_of_order',
        'An academic year must end after it starts.');
    }
    return withTenant(scope, async (db) => {
      try {
        const { rows } = await db.query<AcademicYear>(
          `INSERT INTO academic_year
             (tenant_id, academic_unit_id, label, starts_on, ends_on, status)
           VALUES (app_current_tenant_id(), $1, $2, $3::date, $4::date, 'planning')
           RETURNING id, academic_unit_id, label, starts_on::text, ends_on::text, status`,
          [input.academicUnitId, input.label, input.startsOn, input.endsOn]);
        const year = rows[0] ?? refused('academic calendar');

        const terms: Term[] = [];
        for (const t of input.terms ?? []) {
          terms.push(await addTerm(db, year, t));
        }
        return { ...year, terms };
      } catch (err) {
        return translateConflict(err);
      }
    });
  },

  async terms(scope: TenantScope, academicYearId: string): Promise<Term[]> {
    return withTenant(scope, async (db) => {
      const { rows } = await db.query<Term>(
        `SELECT id, academic_year_id, label, sequence, starts_on::text, ends_on::text
           FROM term
          WHERE academic_year_id = $1::uuid AND deleted_at IS NULL
          ORDER BY sequence`,
        [academicYearId]);
      return rows;
    });
  },

  async addTerm(
    scope: TenantScope,
    input: {
      academicYearId: string; label: string; sequence: number;
      startsOn: string; endsOn: string;
    },
  ): Promise<Term> {
    return withTenant(scope, async (db) => {
      const year = await yearOf(db, input.academicYearId);
      if (!year) {
        throw ApiError.make('not_found', 'academic_year_not_found',
          'No such academic year.');
      }
      try {
        return await addTerm(db, year, input);
      } catch (err) {
        return translateConflict(err);
      }
    });
  },

  /**
   * planning → active.
   *
   * Refused for a year with no terms, because the states mean something: an
   * active year is the one the school is teaching, and teaching happens in a
   * term. Every assessment, result run and report card is keyed to one, so an
   * active year with none is a year in which nothing can be recorded — visible
   * to a principal only when a teacher tries to set the first exam.
   *
   * The exclusion constraint in 0011 does the other half: two active years may
   * not overlap within a unit. That one belongs in the schema because it is
   * about rows this call cannot see.
   */
  async activateYear(scope: TenantScope, academicYearId: string): Promise<AcademicYear> {
    return withTenant(scope, async (db) => {
      const { rows: counted } = await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM term
          WHERE academic_year_id = $1::uuid AND deleted_at IS NULL`,
        [academicYearId]);
      if (counted[0]!.n === '0') {
        throw ApiError.make('conflict', 'year_has_no_terms',
          'An academic year needs at least one term before it can be made '
          + 'active — assessments and report cards are recorded against a term.');
      }
      try {
        const { rows } = await db.query<AcademicYear>(
          `UPDATE academic_year SET status = 'active', updated_at = now()
            WHERE id = $1::uuid AND deleted_at IS NULL AND status = 'planning'
            RETURNING id, academic_unit_id, label, starts_on::text, ends_on::text, status`,
          [academicYearId]);
        if (!rows[0]) {
          throw ApiError.make('conflict', 'not_in_planning',
            'Only a year still being planned can be made active.');
        }
        return rows[0];
      } catch (err) {
        const e = err as { code?: string };
        if (e.code === '23P01') {
          throw ApiError.make('conflict', 'overlapping_active_year',
            'Another year in this unit is already active over these dates. '
            + 'Close it first.');
        }
        throw err;
      }
    });
  },

  /* ------------------------------------------- programmes, subjects, rooms */

  async programmes(scope: TenantScope, academicUnitId?: string): Promise<Programme[]> {
    return withTenant(scope, async (db) => {
      const { rows } = await db.query<Programme>(
        `SELECT id, academic_unit_id, code, name, duration_terms, credential_type
           FROM programme
          WHERE deleted_at IS NULL
            AND ($1::uuid IS NULL OR academic_unit_id = $1::uuid)
          ORDER BY code`,
        [academicUnitId ?? null]);
      return rows;
    });
  },

  async createProgramme(
    scope: TenantScope,
    input: {
      academicUnitId: string; code: string; name: string;
      durationTerms?: number | undefined; credentialType?: string | undefined;
    },
  ): Promise<Programme> {
    return withTenant(scope, async (db) => {
      try {
        const { rows } = await db.query<Programme>(
          `INSERT INTO programme
             (tenant_id, academic_unit_id, code, name, duration_terms, credential_type)
           VALUES (app_current_tenant_id(), $1, $2, $3, $4, $5)
           RETURNING id, academic_unit_id, code, name, duration_terms, credential_type`,
          [input.academicUnitId, input.code, input.name,
           input.durationTerms ?? null, input.credentialType ?? null]);
        return rows[0] ?? refused('academic structure');
      } catch (err) {
        return translateConflict(err);
      }
    });
  },

  async subjects(scope: TenantScope, academicUnitId?: string): Promise<Subject[]> {
    return withTenant(scope, async (db) => {
      const { rows } = await db.query<Subject>(
        `SELECT id, academic_unit_id, code, name, subject_type,
                default_credits::text AS default_credits
           FROM subject
          WHERE deleted_at IS NULL
            AND ($1::uuid IS NULL OR academic_unit_id = $1::uuid)
          ORDER BY code`,
        [academicUnitId ?? null]);
      return rows;
    });
  },

  async createSubject(
    scope: TenantScope,
    input: {
      academicUnitId: string; code: string; name: string;
      subjectType?: string | undefined; defaultCredits?: string | undefined;
    },
  ): Promise<Subject> {
    return withTenant(scope, async (db) => {
      try {
        const { rows } = await db.query<Subject>(
          `INSERT INTO subject
             (tenant_id, academic_unit_id, code, name, subject_type, default_credits)
           VALUES (app_current_tenant_id(), $1, $2, $3, COALESCE($4, 'core'), $5::numeric)
           RETURNING id, academic_unit_id, code, name, subject_type,
                     default_credits::text AS default_credits`,
          [input.academicUnitId, input.code, input.name,
           input.subjectType ?? null, input.defaultCredits ?? null]);
        return rows[0] ?? refused('subject list');
      } catch (err) {
        return translateConflict(err);
      }
    });
  },

  async rooms(scope: TenantScope, campusId?: string): Promise<Room[]> {
    return withTenant(scope, async (db) => {
      const { rows } = await db.query<Room>(
        `SELECT id, campus_id, code, name, capacity, room_type
           FROM room
          WHERE deleted_at IS NULL
            AND ($1::uuid IS NULL OR campus_id = $1::uuid)
          ORDER BY code`,
        [campusId ?? null]);
      return rows;
    });
  },

  async createRoom(
    scope: TenantScope,
    input: {
      campusId: string; code: string; name: string;
      capacity?: number | undefined; roomType?: string | undefined;
    },
  ): Promise<Room> {
    return withTenant(scope, async (db) => {
      try {
        const { rows } = await db.query<Room>(
          `INSERT INTO room (tenant_id, campus_id, code, name, capacity, room_type)
           VALUES (app_current_tenant_id(), $1, $2, $3, $4, COALESCE($5, 'classroom'))
           RETURNING id, campus_id, code, name, capacity, room_type`,
          [input.campusId, input.code, input.name,
           input.capacity ?? null, input.roomType ?? null]);
        return rows[0] ?? refused('room list');
      } catch (err) {
        return translateConflict(err);
      }
    });
  },

  /* ------------------------------------------------ class groups, sections */

  async classGroups(scope: TenantScope, academicYearId: string): Promise<ClassGroup[]> {
    return withTenant(scope, async (db) => {
      const { rows } = await db.query<ClassGroup>(
        `SELECT id, programme_id, academic_year_id, name, group_kind, level_sequence
           FROM class_group
          WHERE academic_year_id = $1::uuid AND deleted_at IS NULL
          ORDER BY level_sequence NULLS LAST, name`,
        [academicYearId]);
      return rows;
    });
  },

  async createClassGroup(
    scope: TenantScope,
    input: {
      programmeId: string; academicYearId: string; name: string;
      groupKind?: string | undefined; capacity?: number | undefined; levelSequence?: number | undefined;
    },
  ): Promise<ClassGroup> {
    return withTenant(scope, async (db) => {
      try {
        const { rows } = await db.query<ClassGroup>(
          `INSERT INTO class_group
             (tenant_id, programme_id, academic_year_id, name, group_kind,
              capacity, level_sequence)
           VALUES (app_current_tenant_id(), $1, $2, $3, COALESCE($4, 'class'), $5, $6)
           RETURNING id, programme_id, academic_year_id, name, group_kind, level_sequence`,
          [input.programmeId, input.academicYearId, input.name,
           input.groupKind ?? null, input.capacity ?? null, input.levelSequence ?? null]);
        return rows[0] ?? refused('academic structure');
      } catch (err) {
        return translateConflict(err);
      }
    });
  },

  async sections(scope: TenantScope, classGroupId: string): Promise<Section[]> {
    return withTenant(scope, async (db) => {
      const { rows } = await db.query<Section>(
        `SELECT id, class_group_id, name, capacity, class_teacher_staff_id, room_id
           FROM section
          WHERE class_group_id = $1::uuid AND deleted_at IS NULL
          ORDER BY name`,
        [classGroupId]);
      return rows;
    });
  },

  /**
   * A section, optionally with a home room and a class teacher.
   *
   * The room is checked against the campus the section actually sits in.
   * `room` references `campus` and `section` does not, so the two are only
   * relatable through class group → programme → academic unit → campus — four
   * joins nobody performs by eye, and a room code like `101` exists on every
   * campus a school has.
   */
  async createSection(
    scope: TenantScope,
    input: {
      classGroupId: string; name: string; capacity?: number | undefined;
      classTeacherStaffId?: string | undefined; roomId?: string | undefined;
    },
  ): Promise<Section> {
    return withTenant(scope, async (db) => {
      if (input.roomId !== undefined) {
        const { rows } = await db.query<{ same: boolean }>(
          `SELECT (r.campus_id = au.campus_id) AS same
             FROM class_group cg
             JOIN programme pr ON pr.id = cg.programme_id
             JOIN academic_unit au ON au.id = pr.academic_unit_id
             JOIN room r ON r.id = $2::uuid
            WHERE cg.id = $1::uuid`,
          [input.classGroupId, input.roomId]);
        if (!rows[0]) {
          throw ApiError.make('not_found', 'class_group_or_room_not_found',
            'No such class group or room.');
        }
        if (!rows[0].same) {
          throw ApiError.make('validation_error', 'room_on_another_campus',
            'That room is on a different campus from this class.');
        }
      }
      try {
        const { rows } = await db.query<Section>(
          `INSERT INTO section
             (tenant_id, class_group_id, name, capacity, class_teacher_staff_id, room_id)
           VALUES (app_current_tenant_id(), $1, $2, $3, $4, $5)
           RETURNING id, class_group_id, name, capacity, class_teacher_staff_id, room_id`,
          [input.classGroupId, input.name, input.capacity ?? null,
           input.classTeacherStaffId ?? null, input.roomId ?? null]);
        return rows[0] ?? refused('academic structure');
      } catch (err) {
        return translateConflict(err);
      }
    });
  },

  /* --------------------------------------------------- offerings and slots */

  async courseOfferings(
    scope: TenantScope, opts: { classGroupId?: string | undefined; termId?: string | undefined } = {},
  ): Promise<Array<CourseOffering & {
    subject_name: string; class_name: string; section_name: string | null;
  }>> {
    return withTenant(scope, async (db) => {
      const { rows } = await db.query<CourseOffering & {
        subject_name: string; class_name: string; section_name: string | null;
      }>(
        `SELECT co.id, co.class_group_id, co.section_id, co.subject_id, co.term_id,
                co.primary_teacher_staff_id, co.credits::text AS credits, co.is_elective,
                sub.name AS subject_name, cg.name AS class_name, sec.name AS section_name
           FROM course_offering co
           JOIN subject sub ON sub.id = co.subject_id
           JOIN class_group cg ON cg.id = co.class_group_id
           LEFT JOIN section sec ON sec.id = co.section_id
          WHERE co.deleted_at IS NULL
            AND ($1::uuid IS NULL OR co.class_group_id = $1::uuid)
            AND ($2::uuid IS NULL OR co.term_id = $2::uuid)
          ORDER BY cg.name, sub.name`,
        [opts.classGroupId ?? null, opts.termId ?? null]);
      return rows;
    });
  },

  /**
   * A subject taught to a class, in a term, by a teacher.
   *
   * **The term is checked against the class group's year**, which the foreign
   * keys do not do: `term` and `class_group` both reference `academic_year`,
   * and nothing requires them to reference the same one. An offering tying a
   * 2026-27 class to a 2025-26 term is accepted by the schema and then behaves
   * normally — marks go in, a result run computes, and a report card is issued
   * for a term the child was not in that class for. The error surfaces as a
   * parent disputing a grade.
   *
   * A section, when given, must belong to the class group for the same family
   * of reason: `section_id` is nullable and means "the whole class", and a
   * section from a different class is not a narrower audience, it is a
   * different one.
   */
  async createCourseOffering(
    scope: TenantScope,
    input: {
      classGroupId: string; subjectId: string; termId: string;
      sectionId?: string | undefined; primaryTeacherStaffId?: string | undefined;
      credits?: string | undefined; isElective?: boolean | undefined;
    },
  ): Promise<CourseOffering> {
    return withTenant(scope, async (db) => {
      const { rows: checked } = await db.query<{
        group_year: string; term_year: string; section_group: string | null;
      }>(
        `SELECT cg.academic_year_id AS group_year,
                t.academic_year_id AS term_year,
                sec.class_group_id AS section_group
           FROM class_group cg
           JOIN term t ON t.id = $2::uuid AND t.deleted_at IS NULL
           LEFT JOIN section sec ON sec.id = $3::uuid AND sec.deleted_at IS NULL
          WHERE cg.id = $1::uuid AND cg.deleted_at IS NULL`,
        [input.classGroupId, input.termId, input.sectionId ?? null]);
      const row = checked[0];
      if (!row) {
        throw ApiError.make('not_found', 'class_group_or_term_not_found',
          'No such class group or term.');
      }
      if (row.group_year !== row.term_year) {
        throw ApiError.make('validation_error', 'term_from_another_year',
          'That term belongs to a different academic year from this class.');
      }
      if (input.sectionId !== undefined && row.section_group !== input.classGroupId) {
        throw ApiError.make('validation_error', 'section_from_another_class',
          'That section is not part of this class.');
      }

      try {
        const { rows } = await db.query<CourseOffering>(
          `INSERT INTO course_offering
             (tenant_id, class_group_id, section_id, subject_id, term_id,
              primary_teacher_staff_id, credits, is_elective)
           VALUES (app_current_tenant_id(), $1, $2, $3, $4, $5, $6::numeric,
                   COALESCE($7, false))
           RETURNING id, class_group_id, section_id, subject_id, term_id,
                     primary_teacher_staff_id, credits::text AS credits, is_elective`,
          [input.classGroupId, input.sectionId ?? null, input.subjectId, input.termId,
           input.primaryTeacherStaffId ?? null, input.credits ?? null,
           input.isElective ?? null]);
        return rows[0] ?? refused('academic structure');
      } catch (err) {
        return translateConflict(err);
      }
    });
  },

  /**
   * One recurring meeting on the timetable.
   *
   * `academic_year_id` is deliberately not accepted: a trigger fills it from
   * the offering's term, so the constraints that stop a room or a teacher being
   * double-booked are scoped to a year without the caller being able to get it
   * wrong.
   *
   * The section is checked against the offering's class group, for the reason
   * `createCourseOffering` gives. A slot pointing at the wrong section puts a
   * lesson on a timetable for children who do not take it.
   */
  async addScheduleSlot(
    scope: TenantScope,
    input: {
      courseOfferingId: string; sectionId?: string | undefined; roomId?: string | undefined; staffId?: string | undefined;
      dayOfWeek: number; startsAt: string; endsAt: string; periodNo?: number | undefined;
      effectiveFrom?: string | undefined; effectiveTo?: string | undefined;
    },
  ): Promise<ScheduleSlot> {
    if (input.endsAt <= input.startsAt) {
      throw ApiError.make('validation_error', 'period_ends_before_it_starts',
        'A period must end after it starts.');
    }
    return withTenant(scope, async (db) => {
      if (input.sectionId !== undefined) {
        const { rows } = await db.query<{ ok: boolean }>(
          `SELECT (sec.class_group_id = co.class_group_id) AS ok
             FROM course_offering co
             JOIN section sec ON sec.id = $2::uuid
            WHERE co.id = $1::uuid`,
          [input.courseOfferingId, input.sectionId]);
        if (!rows[0]) {
          throw ApiError.make('not_found', 'offering_or_section_not_found',
            'No such course offering or section.');
        }
        if (!rows[0].ok) {
          throw ApiError.make('validation_error', 'section_from_another_class',
            'That section does not take this subject.');
        }
      }
      try {
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
           input.startsAt, input.endsAt,
           input.effectiveFrom ?? null, input.effectiveTo ?? null]);
        return rows[0] ?? refused('timetable');
      } catch (err) {
        return translateConflict(err);
      }
    });
  },

  /** What one teacher is expected to be doing, by day and time. */
  async timetableForStaff(
    scope: TenantScope, staffId: string,
  ): Promise<Array<ScheduleSlot & {
    subject_name: string; class_name: string; section_name: string | null;
    room_name: string | null;
  }>> {
    return withTenant(scope, (db) => timetable(db, { staffId }));
  },

  /**
   * What one section's week looks like.
   *
   * Includes slots with no `section_id` on an offering the section belongs to,
   * because a `NULL` section on an offering means "the whole class" — a lesson
   * the section certainly attends. Filtering on `section_id = $1` alone would
   * return an empty timetable for the ordinary case where a class takes every
   * subject together.
   */
  async timetableForSection(
    scope: TenantScope, sectionId: string,
  ): Promise<Array<ScheduleSlot & {
    subject_name: string; class_name: string; section_name: string | null;
    room_name: string | null;
  }>> {
    return withTenant(scope, (db) => timetable(db, { sectionId }));
  },
};

/**
 * Inserts one term, having checked it sits inside its year.
 *
 * Shared by `createYear` and `addTerm` so the containment rule has one
 * implementation — a year created with three terms and a term added later must
 * be held to the same rule, and two copies of a date comparison is how they
 * stop being.
 */
async function addTerm(
  db: TenantClient,
  year: { id: string; starts_on: string; ends_on: string },
  t: { label: string; sequence: number; startsOn: string; endsOn: string },
): Promise<Term> {
  if (t.endsOn <= t.startsOn) {
    throw ApiError.make('validation_error', 'dates_out_of_order',
      `Term "${t.label}" must end after it starts.`);
  }
  // Compared as ISO strings, which sort correctly and are what the database
  // returned. Parsing them into Date first would introduce a timezone where
  // there is none: these are dates, not instants.
  if (t.startsOn < year.starts_on || t.endsOn > year.ends_on) {
    throw ApiError.make('validation_error', 'term_outside_year',
      `Term "${t.label}" runs from ${t.startsOn} to ${t.endsOn}, outside the `
      + `year it belongs to (${year.starts_on} to ${year.ends_on}).`);
  }
  const { rows } = await db.query<Term>(
    `INSERT INTO term
       (tenant_id, academic_year_id, label, sequence, starts_on, ends_on)
     VALUES (app_current_tenant_id(), $1, $2, $3, $4::date, $5::date)
     RETURNING id, academic_year_id, label, sequence, starts_on::text, ends_on::text`,
    [year.id, t.label, t.sequence, t.startsOn, t.endsOn]);
  return rows[0] ?? refused('academic calendar');
}

/** One query behind both timetable readers, so they cannot disagree. */
async function timetable(
  db: TenantClient, by: { staffId?: string | undefined; sectionId?: string },
): Promise<Array<ScheduleSlot & {
  subject_name: string; class_name: string; section_name: string | null;
  room_name: string | null;
}>> {
  const { rows } = await db.query<ScheduleSlot & {
    subject_name: string; class_name: string; section_name: string | null;
    room_name: string | null;
  }>(
    `SELECT ss.id, ss.course_offering_id, ss.section_id, ss.room_id, ss.staff_id,
            ss.day_of_week, ss.starts_at::text, ss.ends_at::text,
            sub.name AS subject_name, cg.name AS class_name,
            sec.name AS section_name, r.name AS room_name
       FROM schedule_slot ss
       JOIN course_offering co ON co.id = ss.course_offering_id
       JOIN subject sub ON sub.id = co.subject_id
       JOIN class_group cg ON cg.id = co.class_group_id
       LEFT JOIN section sec ON sec.id = ss.section_id
       LEFT JOIN room r ON r.id = ss.room_id
      WHERE ss.deleted_at IS NULL
        AND (ss.effective_to IS NULL OR ss.effective_to >= CURRENT_DATE)
        AND ($1::uuid IS NULL OR ss.staff_id = $1::uuid)
        AND ($2::uuid IS NULL
             OR ss.section_id = $2::uuid
             -- A slot with no section is the whole class, which this section
             -- is part of. Omitting this empties the timetable for every
             -- school that teaches its classes together, which is most of them.
             OR (ss.section_id IS NULL
                 AND co.class_group_id = (SELECT class_group_id FROM section
                                           WHERE id = $2::uuid)))
      ORDER BY ss.day_of_week, ss.starts_at`,
    [by.staffId ?? null, by.sectionId ?? null]);
  return rows;
}
