/**
 * The learning surface (M28.2).
 *
 * Behind `@RequiresFeature('lms')`, which is the whole point of the milestone:
 * M16 sold the flag, and until now it guarded nothing.
 *
 * There is no endpoint here that awards a mark. Grading goes through
 * `gradeAndReturn`, which calls the assessment module — one entry point for
 * every mark in the system, so a homework score reaches the report card by the
 * same road an exam score does.
 */
import { Controller, Get, Post, Body, Param, Query } from '@nestjs/common';
import { z } from 'zod';
import { learningService } from './learning.service.ts';
import { currentScope } from '../../common/scope.ts';
import { ApiError } from '../../common/errors.ts';
import { RequiresFeature } from '../billing-plans/entitlement.guard.ts';

const uuid = z.string().uuid();

const lessonBody = z.object({
  courseOfferingId: uuid,
  title: z.string().min(1).max(200),
  summary: z.string().max(4000).optional(),
  sequenceNo: z.number().int().min(0).max(10_000).optional(),
  taughtOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

const assignmentBody = z.object({
  courseOfferingId: uuid,
  title: z.string().min(1).max(200),
  instructions: z.string().max(20_000).optional(),
  dueAt: z.string().datetime().optional(),
  acceptsLate: z.boolean().optional(),
  submissionKind: z.enum(['text', 'file', 'either', 'offline']).optional(),
  lessonId: uuid.optional(),
  // Present means "this carries marks". Its absence is the only way to say
  // practice, which is why there is no separate flag to contradict it.
  maxMarks: z.number().positive().max(10_000).optional(),
  weightPercent: z.number().min(0).max(100).optional(),
  gradingScaleId: uuid.optional(),
});

const submitBody = z.object({
  enrollmentId: uuid,
  bodyText: z.string().max(50_000).optional(),
  fileIds: z.array(uuid).max(20).optional(),
});

const gradeBody = z.object({
  grades: z.array(z.object({
    enrollmentId: uuid,
    marks: z.number().min(0).max(10_000).optional(),
    absent: z.boolean().optional(),
    exempt: z.boolean().optional(),
    feedback: z.string().max(10_000).optional(),
  })).min(1).max(200),
});

@Controller('v1/learning')
@RequiresFeature('lms')
export class LearningController {
  /** The picker every screen in this module starts with. */
  @Get('offerings')
  async offerings() {
    return { data: await learningService.offerings(currentScope()) };
  }

  @Get('offerings/:offeringId/lessons')
  async lessons(@Param('offeringId') offeringId: string) {
    const id = uuid.safeParse(offeringId);
    if (!id.success) throw ApiError.fromZod(id.error);
    return { data: await learningService.lessons(currentScope(), id.data) };
  }

  @Post('lessons')
  async createLesson(@Body() body: unknown) {
    const parsed = lessonBody.safeParse(body);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    return {
      data: await learningService.createLesson(currentScope(), parsed.data),
    };
  }

  @Post('lessons/:lessonId/publish')
  async publishLesson(@Param('lessonId') lessonId: string) {
    const id = uuid.safeParse(lessonId);
    if (!id.success) throw ApiError.fromZod(id.error);
    await learningService.publishLesson(currentScope(), id.data);
    return { data: { published: true } };
  }

  @Get('offerings/:offeringId/assignments')
  async assignments(@Param('offeringId') offeringId: string) {
    const id = uuid.safeParse(offeringId);
    if (!id.success) throw ApiError.fromZod(id.error);
    return { data: await learningService.assignments(currentScope(), id.data) };
  }

  @Post('assignments')
  async createAssignment(@Body() body: unknown) {
    const parsed = assignmentBody.safeParse(body);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    return {
      data: await learningService.createAssignment(currentScope(), parsed.data),
    };
  }

  @Post('assignments/:assignmentId/publish')
  async publishAssignment(@Param('assignmentId') assignmentId: string) {
    const id = uuid.safeParse(assignmentId);
    if (!id.success) throw ApiError.fromZod(id.error);
    await learningService.publishAssignment(currentScope(), id.data);
    return { data: { published: true } };
  }

  @Get('assignments/:assignmentId/submissions')
  async submissions(@Param('assignmentId') assignmentId: string) {
    const id = uuid.safeParse(assignmentId);
    if (!id.success) throw ApiError.fromZod(id.error);
    return { data: await learningService.submissions(currentScope(), id.data) };
  }

  @Post('assignments/:assignmentId/submissions')
  async submit(@Param('assignmentId') assignmentId: string, @Body() body: unknown) {
    const id = uuid.safeParse(assignmentId);
    if (!id.success) throw ApiError.fromZod(id.error);
    const parsed = submitBody.safeParse(body);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    return {
      data: await learningService.submit(currentScope(), {
        assignmentId: id.data, ...parsed.data,
      }),
    };
  }

  @Post('assignments/:assignmentId/grade')
  async grade(@Param('assignmentId') assignmentId: string, @Body() body: unknown) {
    const id = uuid.safeParse(assignmentId);
    if (!id.success) throw ApiError.fromZod(id.error);
    const parsed = gradeBody.safeParse(body);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    return {
      data: await learningService.gradeAndReturn(currentScope(), {
        assignmentId: id.data,
        grades: parsed.data.grades,
      }),
    };
  }

  /** What a guardian opens: everything set for one child, across subjects. */
  @Get('students/:studentId/work')
  async work(@Param('studentId') studentId: string, @Query('includeReturned') inc?: string) {
    const id = uuid.safeParse(studentId);
    if (!id.success) throw ApiError.fromZod(id.error);
    return {
      data: await learningService.dueFor(currentScope(), id.data, {
        includeReturned: inc === 'true',
      }),
    };
  }
}
