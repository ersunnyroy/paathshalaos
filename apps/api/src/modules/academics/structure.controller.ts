/**
 * Setting a school up, which was not previously possible (M36).
 *
 * Every route here writes part of the academic structure, and before this file
 * none of them existed. The product could take attendance for a section it
 * could not create, set an exam on an offering it could not define, and print a
 * report card for a term nobody could add.
 *
 * The order a school works in, and what each step needs from the one before:
 *
 *   1. campus            `POST /v1/campuses` (existed)
 *   2. academic unit     created by the console when the tenant is provisioned
 *   3. academic year     with its terms, in one call
 *   4. programme         what is taught — "CBSE Secondary", "NEET Repeater"
 *   5. subject           the subject list for that unit
 *   6. room              per campus, optional but needed for a timetable
 *   7. class group       a programme in a year — "Class IX"
 *   8. section           "IX-A", with a class teacher and a home room
 *   9. course offering   subject × class × term × teacher
 *  10. schedule slot     when it actually meets
 *
 * Nothing here checks a role. The policies decide: every INSERT is written
 * against a `WITH CHECK` that admits staff only, and the service turns the
 * resulting empty result into a named refusal rather than a 500.
 */
import { Controller, Get, Post, Body, Param, Query } from '@nestjs/common';
import { z } from 'zod';
import { structureService } from './structure.service.ts';
import { currentScope } from '../../common/scope.ts';
import { ApiError } from '../../common/errors.ts';

const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
// HH:MM or HH:MM:SS. Postgres `time` accepts more, but a timetable written by
// a person is one or the other, and accepting '9am' would store 09:00 or fail
// depending on the server's DateStyle.
const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/,
  'expected HH:MM');

/** Shared by every `code` column: the school's own short identifier. */
const code = z.string().min(1).max(32).regex(/^[A-Za-z0-9][A-Za-z0-9 _-]*$/,
  'a code may contain letters, digits, spaces, hyphens and underscores');
const name = z.string().min(1).max(200);

const termShape = z.object({
  label: z.string().min(1).max(80),
  sequence: z.number().int().min(1).max(20),
  startsOn: isoDate,
  endsOn: isoDate,
});

@Controller('v1')
export class StructureController {
  /* ------------------------------------------------------- academic units */

  /**
   * The units a school has.
   *
   * A read with no write beside it, and deliberately: units are provisioned
   * with the tenant. What was wrong before was not that a school could not
   * create one — it was that `academicUnitId` is required by fee plans, report
   * card templates, programmes, subjects and years, and no endpoint would tell
   * a client a single valid value.
   */
  @Get('academic-units')
  async academicUnits(@Query('campusId') campusId?: string) {
    const parsed = uuid.optional().safeParse(campusId ?? undefined);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    return {
      data: await structureService.academicUnits(
        currentScope(), ...(parsed.data === undefined ? [] : [parsed.data])),
    };
  }

  /* ------------------------------------------------------ years and terms */

  @Get('structure/years')
  async years(@Query('academicUnitId') academicUnitId?: string) {
    const parsed = uuid.optional().safeParse(academicUnitId ?? undefined);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    return {
      data: await structureService.years(
        currentScope(), ...(parsed.data === undefined ? [] : [parsed.data])),
    };
  }

  /**
   * A year and its terms together.
   *
   * `terms` is optional but almost always given: a year with none cannot be
   * made active, and a school that skipped them here has a row that looks like
   * setup and is not.
   */
  @Post('structure/years')
  async createYear(@Body() body: unknown) {
    const parsed = z.object({
      academicUnitId: uuid,
      label: z.string().min(1).max(80),
      startsOn: isoDate,
      endsOn: isoDate,
      terms: z.array(termShape).max(12).optional(),
    }).safeParse(body);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    const { terms, ...rest } = parsed.data;
    return {
      data: await structureService.createYear(currentScope(), {
        ...rest, ...(terms === undefined ? {} : { terms }),
      }),
    };
  }

  @Get('structure/years/:id/terms')
  async terms(@Param('id') id: string) {
    const yearId = uuid.safeParse(id);
    if (!yearId.success) throw ApiError.fromZod(yearId.error);
    return { data: await structureService.terms(currentScope(), yearId.data) };
  }

  @Post('structure/years/:id/terms')
  async addTerm(@Param('id') id: string, @Body() body: unknown) {
    const yearId = uuid.safeParse(id);
    if (!yearId.success) throw ApiError.fromZod(yearId.error);
    const parsed = termShape.safeParse(body);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    return {
      data: await structureService.addTerm(currentScope(), {
        academicYearId: yearId.data, ...parsed.data,
      }),
    };
  }

  /** planning → active. Refused for a year with no terms. */
  @Post('structure/years/:id/activate')
  async activateYear(@Param('id') id: string) {
    const yearId = uuid.safeParse(id);
    if (!yearId.success) throw ApiError.fromZod(yearId.error);
    return { data: await structureService.activateYear(currentScope(), yearId.data) };
  }

  /* ------------------------------------------ programmes, subjects, rooms */

  @Get('structure/programmes')
  async programmes(@Query('academicUnitId') academicUnitId?: string) {
    const parsed = uuid.optional().safeParse(academicUnitId ?? undefined);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    return {
      data: await structureService.programmes(
        currentScope(), ...(parsed.data === undefined ? [] : [parsed.data])),
    };
  }

  @Post('structure/programmes')
  async createProgramme(@Body() body: unknown) {
    const parsed = z.object({
      academicUnitId: uuid,
      code,
      name,
      durationTerms: z.number().int().min(1).max(60).optional(),
      credentialType: z.enum(['none', 'certificate', 'diploma', 'degree',
                              'board_examination']).optional(),
    }).safeParse(body);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    return { data: await structureService.createProgramme(currentScope(), parsed.data) };
  }

  @Get('structure/subjects')
  async subjects(@Query('academicUnitId') academicUnitId?: string) {
    const parsed = uuid.optional().safeParse(academicUnitId ?? undefined);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    return {
      data: await structureService.subjects(
        currentScope(), ...(parsed.data === undefined ? [] : [parsed.data])),
    };
  }

  @Post('structure/subjects')
  async createSubject(@Body() body: unknown) {
    const parsed = z.object({
      academicUnitId: uuid,
      code,
      name,
      subjectType: z.enum(['core', 'elective', 'co_scholastic', 'language']).optional(),
      // A decimal string, like every other numeric that crosses this boundary.
      // A JSON number is a double and credits are summed onto a transcript.
      defaultCredits: z.string().regex(/^\d{1,3}(\.\d{1,2})?$/).optional(),
    }).safeParse(body);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    return { data: await structureService.createSubject(currentScope(), parsed.data) };
  }

  @Get('structure/rooms')
  async rooms(@Query('campusId') campusId?: string) {
    const parsed = uuid.optional().safeParse(campusId ?? undefined);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    return {
      data: await structureService.rooms(
        currentScope(), ...(parsed.data === undefined ? [] : [parsed.data])),
    };
  }

  @Post('structure/rooms')
  async createRoom(@Body() body: unknown) {
    const parsed = z.object({
      campusId: uuid,
      code,
      name,
      capacity: z.number().int().min(1).max(10_000).optional(),
      roomType: z.enum(['classroom', 'laboratory', 'hall', 'library',
                        'ground', 'other']).optional(),
    }).safeParse(body);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    return { data: await structureService.createRoom(currentScope(), parsed.data) };
  }

  /* ----------------------------------------------- class groups, sections */

  @Get('structure/class-groups')
  async classGroups(@Query('academicYearId') academicYearId?: string) {
    const parsed = uuid.safeParse(academicYearId);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    return { data: await structureService.classGroups(currentScope(), parsed.data) };
  }

  @Post('structure/class-groups')
  async createClassGroup(@Body() body: unknown) {
    const parsed = z.object({
      programmeId: uuid,
      academicYearId: uuid,
      name,
      groupKind: z.enum(['class', 'cohort', 'batch']).optional(),
      capacity: z.number().int().min(1).max(10_000).optional(),
      // "Class IX = 9", kept separate from the name precisely so renaming it to
      // "Grade 10" next year does not reorder last year's reports.
      levelSequence: z.number().int().min(0).max(100).optional(),
    }).safeParse(body);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    return { data: await structureService.createClassGroup(currentScope(), parsed.data) };
  }

  @Get('structure/class-groups/:id/sections')
  async sections(@Param('id') id: string) {
    const classGroupId = uuid.safeParse(id);
    if (!classGroupId.success) throw ApiError.fromZod(classGroupId.error);
    return { data: await structureService.sections(currentScope(), classGroupId.data) };
  }

  @Post('structure/sections')
  async createSection(@Body() body: unknown) {
    const parsed = z.object({
      classGroupId: uuid,
      name,
      capacity: z.number().int().min(1).max(10_000).optional(),
      classTeacherStaffId: uuid.optional(),
      roomId: uuid.optional(),
    }).safeParse(body);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    return { data: await structureService.createSection(currentScope(), parsed.data) };
  }

  /* -------------------------------------------------- offerings and slots */

  @Get('structure/course-offerings')
  async courseOfferings(@Query('classGroupId') classGroupId?: string,
                        @Query('termId') termId?: string) {
    const parsed = z.object({
      classGroupId: uuid.optional(), termId: uuid.optional(),
    }).safeParse({ classGroupId, termId });
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    return {
      data: await structureService.courseOfferings(currentScope(), parsed.data),
    };
  }

  @Post('structure/course-offerings')
  async createCourseOffering(@Body() body: unknown) {
    const parsed = z.object({
      classGroupId: uuid,
      subjectId: uuid,
      termId: uuid,
      sectionId: uuid.optional(),
      primaryTeacherStaffId: uuid.optional(),
      credits: z.string().regex(/^\d{1,3}(\.\d{1,2})?$/).optional(),
      isElective: z.boolean().optional(),
    }).safeParse(body);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    return {
      data: await structureService.createCourseOffering(currentScope(), parsed.data),
    };
  }

  /**
   * One recurring meeting.
   *
   * `dayOfWeek` is ISO-8601: Monday is 1. Named here because the other common
   * convention puts Sunday at 0, and a timetable that is one day out is the
   * kind of wrong that looks right on a screen.
   */
  @Post('structure/schedule-slots')
  async addScheduleSlot(@Body() body: unknown) {
    const parsed = z.object({
      courseOfferingId: uuid,
      sectionId: uuid.optional(),
      roomId: uuid.optional(),
      staffId: uuid.optional(),
      dayOfWeek: z.number().int().min(1).max(7),
      startsAt: clock,
      endsAt: clock,
      periodNo: z.number().int().min(1).max(30).optional(),
      effectiveFrom: isoDate.optional(),
      effectiveTo: isoDate.optional(),
    }).safeParse(body);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    return {
      data: await structureService.addScheduleSlot(currentScope(), parsed.data),
    };
  }

  /**
   * POST, not DELETE, for the reason every removal in this API is: the row is
   * marked and kept, and a verb that says "delete" would be describing
   * something that does not happen.
   */
  @Post('structure/schedule-slots/:id/remove')
  async removeScheduleSlot(@Param('id') id: string) {
    const slotId = uuid.safeParse(id);
    if (!slotId.success) throw ApiError.fromZod(slotId.error);
    return { data: await structureService.removeScheduleSlot(currentScope(), slotId.data) };
  }

  @Post('structure/schedule-slots/:id/move')
  async moveScheduleSlot(@Param('id') id: string, @Body() body: unknown) {
    const slotId = uuid.safeParse(id);
    if (!slotId.success) throw ApiError.fromZod(slotId.error);
    const parsed = z.object({
      dayOfWeek: z.number().int().min(1).max(7),
      startsAt: clock,
      endsAt: clock,
      // Absent: leave as it is. Null: clear it. See the service.
      roomId: uuid.nullable().optional(),
      staffId: uuid.nullable().optional(),
    }).safeParse(body);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    return {
      data: await structureService.moveScheduleSlot(currentScope(), slotId.data, parsed.data),
    };
  }

  /** What a teacher is expected to be doing this week. */
  @Get('timetable/staff/:id')
  async staffTimetable(@Param('id') id: string) {
    const staffId = uuid.safeParse(id);
    if (!staffId.success) throw ApiError.fromZod(staffId.error);
    return { data: await structureService.timetableForStaff(currentScope(), staffId.data) };
  }

  /** What a class's week looks like — including the lessons the whole class takes. */
  @Get('timetable/sections/:id')
  async sectionTimetable(@Param('id') id: string) {
    const sectionId = uuid.safeParse(id);
    if (!sectionId.success) throw ApiError.fromZod(sectionId.error);
    return {
      data: await structureService.timetableForSection(currentScope(), sectionId.data),
    };
  }
}
