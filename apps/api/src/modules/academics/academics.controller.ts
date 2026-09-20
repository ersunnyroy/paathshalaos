/**
 * Rolling a school into the next academic year (M32.6).
 *
 * `rolloverService` had no caller in `src/`. AC-3's whole claim — that renaming
 * Class X to Grade 10 next year cannot alter last year's report cards — rests
 * on rollover COPYING the structure rather than editing it, and a school with
 * no way to run it would have edited last year's rows instead. The mechanism
 * was built and the only path to it was a test.
 *
 * The preview is not decoration. Rollover writes class groups, sections,
 * offerings and optionally a timetable in one transaction, and a school
 * running it on the wrong pair of years finds out afterwards. So there is a
 * dry read first, saying what exists on each side, and the service still
 * refuses a target year that already has structure.
 */
import { Controller, Get, Post, Body, Param } from '@nestjs/common';
import { z } from 'zod';
import { rolloverService } from './rollover.service.ts';
import { withTenant } from '../../db/tenant.ts';
import { currentScope } from '../../common/scope.ts';
import { ApiError } from '../../common/errors.ts';

const uuid = z.string().uuid();

@Controller('v1/academic-years')
export class AcademicsController {
  /** What is in a year, for both sides of a rollover. */
  @Get(':id/structure')
  async structure(@Param('id') id: string) {
    const yearId = uuid.safeParse(id);
    if (!yearId.success) throw ApiError.fromZod(yearId.error);
    return {
      data: await withTenant(currentScope(), async (db) => {
        const { rows } = await db.query(
          `SELECT ay.id, ay.label, ay.status, ay.academic_unit_id,
                  (SELECT count(*)::int FROM term t
                    WHERE t.academic_year_id = ay.id) AS terms,
                  (SELECT count(*)::int FROM class_group cg
                    WHERE cg.academic_year_id = ay.id AND cg.deleted_at IS NULL)
                    AS class_groups,
                  (SELECT count(*)::int FROM section s
                     JOIN class_group cg2 ON cg2.id = s.class_group_id
                    WHERE cg2.academic_year_id = ay.id AND s.deleted_at IS NULL)
                    AS sections,
                  (SELECT count(*)::int FROM course_offering co
                     JOIN class_group cg3 ON cg3.id = co.class_group_id
                    WHERE cg3.academic_year_id = ay.id AND co.deleted_at IS NULL)
                    AS course_offerings,
                  (SELECT count(*)::int FROM schedule_slot sl
                    WHERE sl.academic_year_id = ay.id) AS schedule_slots,
                  -- The number that decides whether rollover is even offered:
                  -- a year that already has learners in it is not empty.
                  (SELECT count(*)::int FROM enrollment e
                    WHERE e.academic_year_id = ay.id) AS enrolments
             FROM academic_year ay
            WHERE ay.id = $1::uuid AND ay.deleted_at IS NULL`,
          [yearId.data]);
        if (!rows[0]) {
          throw ApiError.make('not_found', 'academic_year_not_found',
            'Academic year not found.');
        }
        return rows[0];
      }),
    };
  }

  /**
   * Copy one year's structure into the next.
   *
   * `includeTimetable` is opt-in because a timetable is the part a school most
   * often wants to rebuild rather than inherit — rooms change, staff change,
   * and a copied slot that is wrong is harder to spot than a missing one.
   */
  @Post(':id/rollover')
  async rollover(@Param('id') id: string, @Body() body: unknown) {
    const fromId = uuid.safeParse(id);
    if (!fromId.success) throw ApiError.fromZod(fromId.error);
    const parsed = z.object({
      toAcademicYearId: uuid,
      includeTimetable: z.boolean().optional(),
    }).safeParse(body);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);

    return {
      data: await rolloverService.rollover(currentScope(), {
        fromAcademicYearId: fromId.data,
        toAcademicYearId: parsed.data.toAcademicYearId,
        ...(parsed.data.includeTimetable === undefined
          ? {} : { includeTimetable: parsed.data.includeTimetable }),
      }),
    };
  }
}
