/**
 * Exams, marks, results and report cards (M32.4).
 *
 * M8 built all of it — grading scales, weighted assessments, a mark that is
 * exactly one of a number, an absence or an exemption, per-row savepoints on
 * bulk entry, a correction path with approval, result computation, review,
 * publication, versioned report cards — and the product had `GET /v1/results`
 * and nothing else. Until M28 shipped, the only way to enter a mark in this
 * system was to attach it to a piece of homework.
 *
 * The order is the design and every step of it is refused out of order:
 *
 *   scale → assessment → open → marks → lock → compute → review → publish
 *
 * Two of those separations cost a screen and are worth the cost:
 *
 * **Compute, review, publish.** A result run is computed by one person,
 * checked by a second and released by a third action. Collapsing them would
 * make "the marks are in" and "the parents can see them" the same moment,
 * which is how a class finds out its results from a typo.
 *
 * **Locking.** A locked assessment cannot be reopened; a wrong mark is
 * corrected through the correction path, which is attributed and reviewable.
 * There is deliberately no unlock endpoint here.
 */
import { Controller, Get, Post, Body, Param, Query } from '@nestjs/common';
import { z } from 'zod';
import { assessmentService } from './assessment.service.ts';
import { gradingService } from './grading.service.ts';
import { resultService } from './result.service.ts';
import { reportCardService } from './report-card.service.ts';
import { withTenant } from '../../db/tenant.ts';
import { currentScope } from '../../common/scope.ts';
import { ApiError } from '../../common/errors.ts';

const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const scaleBody = z.object({
  academicUnitId: uuid,
  name: z.string().min(1).max(200),
  // 0030's set. 'descriptive' was my invention and would have been a
  // check-constraint 500 on the first scale a school created.
  kind: z.enum(['percentage', 'letter', 'gpa']),
  bands: z.array(z.object({
    label: z.string().min(1).max(40),
    lower: z.number().min(0).max(100),
    upper: z.number().min(0).max(100),
    gradePoint: z.number().min(0).max(10).optional(),
    isPass: z.boolean().optional(),
    description: z.string().max(400).optional(),
  })).min(1).max(20),
});

const assessmentBody = z.object({
  courseOfferingId: uuid,
  termId: uuid,
  name: z.string().min(1).max(200),
  kind: z.enum(['exam', 'quiz', 'assignment', 'project', 'practical', 'oral', 'internal']),
  maxMarks: z.number().positive().max(10_000),
  passMarks: z.number().min(0).max(10_000).optional(),
  weightPercent: z.number().min(0).max(100).optional(),
  gradingScaleId: uuid.optional(),
  scheduledOn: isoDate.optional(),
});

/**
 * A mark is exactly one of three things, and the shape says so.
 *
 * An absent learner has NO mark, not a zero — a zero is a mark of zero and
 * pulls an average down, which is the difference between a child who was ill
 * and a child who answered nothing. The database refuses the other
 * combinations; this refuses them earlier and with a better sentence.
 */
const marksBody = z.object({
  marks: z.array(z.object({
    enrollmentId: uuid,
    marks: z.number().min(0).max(10_000).optional(),
    absent: z.boolean().optional(),
    exempt: z.boolean().optional(),
    remarks: z.string().max(2000).optional(),
    clientEventId: uuid.optional(),
  })).min(1).max(200),
});

async function requireStaff(scope: ReturnType<typeof currentScope>): Promise<string> {
  const staffId = await withTenant(scope, async (db) => {
    const { rows } = await db.query<{ staff_id: string | null }>(
      'SELECT app_current_staff_id() AS staff_id');
    return rows[0]?.staff_id ?? undefined;
  });
  if (!staffId) {
    throw ApiError.make('permission_error', 'not_staff',
      'Marks and results are attributed to a member of staff, and this '
      + 'account is not linked to one.');
  }
  return staffId;
}

@Controller('v1/assessments')
export class AssessmentController {
  @Get('scales')
  async scales() {
    return {
      data: await withTenant(currentScope(), async (db) => {
        const { rows } = await db.query(
          `SELECT gs.id, gs.name, gs.kind, gs.published_at,
                  -- One numrange column, not two bounds: span is what the
                  -- coverage check is built on, and splitting it out here
                  -- would be a second representation to keep in step.
                  COALESCE(json_agg(json_build_object(
                    'label', gb.label,
                    'lower', lower(gb.span), 'upper', upper(gb.span),
                    'is_pass', gb.is_pass
                  ) ORDER BY lower(gb.span) DESC)
                    FILTER (WHERE gb.id IS NOT NULL), '[]') AS bands
             FROM grading_scale gs
             LEFT JOIN grade_band gb ON gb.grading_scale_id = gs.id
            GROUP BY gs.id
            ORDER BY gs.name`);
        return rows;
      }),
    };
  }

  /**
   * A band's range is half-open — [lower, upper) — which is right, and leaks
   * at exactly one value.
   *
   * The first version of this comment said a top band of 80–100 makes the
   * scale fail its coverage check. It does not: `grading_scale_is_covered`
   * asks for [0, 100), and [80, 100) satisfies it. Mutating this away broke
   * no test, which is what sent me to look.
   *
   * What actually breaks is the learner who scores 100. Their percentage is
   * not inside [80, 100), so `gradeFor` finds no band and they get no grade —
   * the one result in the class that is certainly right, reported as
   * ungraded. The existing tests avoid it by typing `100.0001`, which is a
   * numrange implementation detail escaping into a school's data entry.
   *
   * So a top band stated as ending at 100 is stored as ending just past it.
   * "Eighty to a hundred" means what it says, and nobody has to learn about
   * half-open intervals to grade a full-marks paper. Only the top band, and
   * only when it is exactly 100: anywhere else an upper bound is a boundary
   * the school chose and is left alone.
   */
  @Post('scales')
  async createScale(@Body() body: unknown) {
    const parsed = scaleBody.safeParse(body);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    const top = Math.max(...parsed.data.bands.map((b) => b.upper));
    return {
      data: await gradingService.createDraft(currentScope(), {
        ...parsed.data,
        bands: parsed.data.bands.map((b) =>
          (b.upper === 100 && b.upper === top ? { ...b, upper: 100.0001 } : b)),
      }),
    };
  }

  /**
   * A scale cannot be published with a gap in it.
   *
   * The service checks that the bands cover 0 to 100, which is the thing a
   * hand-typed scale gets wrong: a band ending at 39 and the next starting at
   * 41 leaves every learner on exactly 40 with no grade at all.
   */
  @Post('scales/:id/publish')
  async publishScale(@Param('id') id: string) {
    const scaleId = uuid.safeParse(id);
    if (!scaleId.success) throw ApiError.fromZod(scaleId.error);
    const scope = currentScope();
    await gradingService.publish(scope, scaleId.data, await requireStaff(scope));
    return { data: { published: true } };
  }

  /** One scale, for a screen that is editing it rather than listing them. */
  @Get('scales/:id')
  async scale(@Param('id') id: string) {
    const scaleId = uuid.safeParse(id);
    if (!scaleId.success) throw ApiError.fromZod(scaleId.error);
    const found = await gradingService.byId(currentScope(), scaleId.data);
    if (!found) {
      throw ApiError.make('not_found', 'scale_not_found', 'No such grading scale.');
    }
    return { data: found };
  }

  /** The assessments on an offering, and how far each has got. */
  @Get()
  async list(@Query('courseOfferingId') courseOfferingId?: string,
             @Query('termId') termId?: string) {
    const offering = uuid.optional().safeParse(courseOfferingId ?? undefined);
    if (!offering.success) throw ApiError.fromZod(offering.error);
    const term = uuid.optional().safeParse(termId ?? undefined);
    if (!term.success) throw ApiError.fromZod(term.error);

    return {
      data: await withTenant(currentScope(), async (db) => {
        const { rows } = await db.query(
          `SELECT a.id, a.name, a.kind, a.status, a.max_marks::text,
                  a.pass_marks::text, a.weight_percent::text, a.scheduled_on::text,
                  a.course_offering_id, a.term_id,
                  sub.name AS subject_name, cg.name AS class_name,
                  sec.name AS section_name,
                  (SELECT count(*)::int FROM mark m WHERE m.assessment_id = a.id)
                    AS marks_entered,
                  -- The denominator a teacher is actually working against.
                  (SELECT count(*)::int FROM enrollment e
                    WHERE e.status = 'active'
                      AND e.section_id IN (
                        SELECT s2.id FROM section s2
                         WHERE s2.class_group_id = co.class_group_id
                           AND (co.section_id IS NULL OR co.section_id = s2.id)))
                    AS learners
             FROM assessment a
             JOIN course_offering co ON co.id = a.course_offering_id
             JOIN subject sub ON sub.id = co.subject_id
             JOIN class_group cg ON cg.id = co.class_group_id
             LEFT JOIN section sec ON sec.id = co.section_id
            WHERE ($1::uuid IS NULL OR a.course_offering_id = $1)
              AND ($2::uuid IS NULL OR a.term_id = $2)
            ORDER BY a.scheduled_on DESC NULLS LAST, a.created_at DESC`,
          [offering.data ?? null, term.data ?? null]);
        return rows;
      }),
    };
  }

  @Post()
  async create(@Body() body: unknown) {
    const parsed = assessmentBody.safeParse(body);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    return { data: await assessmentService.create(currentScope(), parsed.data) };
  }

  /** Draft → open. Marks cannot be entered before this. */
  @Post(':id/open')
  async open(@Param('id') id: string) {
    const assessmentId = uuid.safeParse(id);
    if (!assessmentId.success) throw ApiError.fromZod(assessmentId.error);
    await assessmentService.open(currentScope(), assessmentId.data);
    return { data: { opened: true } };
  }

  /**
   * One assessment.
   *
   * `list` above answers "what is on this offering" and carries the counts a
   * teacher's index needs; this answers "what is this one", which is what a
   * client holding only an id after a redirect actually has.
   */
  @Get(':id')
  async byId(@Param('id') id: string) {
    const assessmentId = uuid.safeParse(id);
    if (!assessmentId.success) throw ApiError.fromZod(assessmentId.error);
    const found = await assessmentService.byId(currentScope(), assessmentId.data);
    if (!found) {
      throw ApiError.make('not_found', 'assessment_not_found', 'No such assessment.');
    }
    return { data: found };
  }

  /** The mark sheet: every learner in the class, with whatever is entered. */
  @Get(':id/marks')
  async marks(@Param('id') id: string) {
    const assessmentId = uuid.safeParse(id);
    if (!assessmentId.success) throw ApiError.fromZod(assessmentId.error);
    return {
      data: await withTenant(currentScope(), async (db) => {
        const { rows } = await db.query(
          `SELECT e.id AS enrollment_id, st.admission_no, e.roll_no,
                  p.given_name, p.family_name,
                  m.id AS mark_id, m.marks_obtained::text, m.is_absent, m.is_exempt,
                  m.remarks
             FROM assessment a
             JOIN course_offering co ON co.id = a.course_offering_id
             JOIN section sec ON sec.class_group_id = co.class_group_id
                             AND (co.section_id IS NULL OR co.section_id = sec.id)
             JOIN enrollment e ON e.section_id = sec.id AND e.status = 'active'
             JOIN student st ON st.id = e.student_id
             JOIN person p ON p.id = st.person_id
             LEFT JOIN mark m ON m.assessment_id = a.id AND m.enrollment_id = e.id
            WHERE a.id = $1::uuid
            ORDER BY e.roll_no NULLS LAST, p.given_name`,
          [assessmentId.data]);
        return rows;
      }),
    };
  }

  /**
   * Bulk entry, returning what happened to each row.
   *
   * One rejection does not lose the rest of the class — that is M8's savepoint
   * per row, and the alternative is a teacher retyping thirty-four marks
   * because of one typo, which is how marks end up staying on paper.
   */
  @Post(':id/marks')
  async enterMarks(@Param('id') id: string, @Body() body: unknown) {
    const assessmentId = uuid.safeParse(id);
    if (!assessmentId.success) throw ApiError.fromZod(assessmentId.error);
    const parsed = marksBody.safeParse(body);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    const scope = currentScope();
    return {
      data: await assessmentService.enterMarks(scope, {
        assessmentId: assessmentId.data,
        enteredByStaffId: await requireStaff(scope),
        marks: parsed.data.marks,
      }),
    };
  }

  /**
   * Open → locked. One way.
   *
   * There is no unlock. Reopening a locked assessment silently re-opens a
   * graded paper; a wrong mark is corrected through the correction path,
   * which records who asked, who approved and what it was before.
   */
  @Post(':id/lock')
  async lock(@Param('id') id: string) {
    const assessmentId = uuid.safeParse(id);
    if (!assessmentId.success) throw ApiError.fromZod(assessmentId.error);
    const scope = currentScope();
    await assessmentService.lock(scope, assessmentId.data, await requireStaff(scope));
    return { data: { locked: true } };
  }

  @Post('corrections')
  async requestCorrection(@Body() body: unknown) {
    const parsed = z.object({
      markId: uuid,
      marks: z.number().min(0).max(10_000).optional(),
      absent: z.boolean().optional(),
      exempt: z.boolean().optional(),
      reason: z.string().min(1).max(2000),
    }).safeParse(body);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    const scope = currentScope();
    const { markId, reason, marks, absent, exempt } = parsed.data;
    return {
      data: await assessmentService.requestCorrection(scope, {
        markId, reason, requestedByStaffId: await requireStaff(scope),
        // The service's names say what the correction is TO, which is the
        // distinction the row records: `to_marks`, not `marks`.
        ...(marks === undefined ? {} : { toMarks: marks }),
        ...(absent === undefined ? {} : { toAbsent: absent }),
        ...(exempt === undefined ? {} : { toExempt: exempt }),
      }),
    };
  }

  /** Approved by somebody other than the person who asked. */
  @Post('corrections/:id/approve')
  async approveCorrection(@Param('id') id: string) {
    const correctionId = uuid.safeParse(id);
    if (!correctionId.success) throw ApiError.fromZod(correctionId.error);
    const scope = currentScope();
    await assessmentService.approveCorrection(scope, {
      correctionId: correctionId.data,
      approverStaffId: await requireStaff(scope),
    });
    return { data: { approved: true } };
  }
}

/**
 * Result runs and report cards.
 *
 * Separate controller because `/v1/results` already exists as a read for the
 * results screen, and these are the verbs that produce what it reads.
 */
@Controller('v1/result-runs')
export class ResultRunController {
  @Get()
  async list(@Query('termId') termId?: string) {
    const term = uuid.optional().safeParse(termId ?? undefined);
    if (!term.success) throw ApiError.fromZod(term.error);
    return {
      data: await withTenant(currentScope(), async (db) => {
        const { rows } = await db.query(
          `SELECT rr.id, rr.status, rr.computed_at, rr.published_at,
                  rr.section_id, rr.term_id,
                  sec.name AS section_name, cg.name AS class_name,
                  t.label AS term_label,
                  (SELECT count(*)::int FROM result_line rl
                    WHERE rl.result_run_id = rr.id) AS line_count,
                  (SELECT count(*)::int FROM report_card rc
                    WHERE rc.result_run_id = rr.id) AS card_count
             FROM result_run rr
             JOIN section sec ON sec.id = rr.section_id
             LEFT JOIN class_group cg ON cg.id = sec.class_group_id
             JOIN term t ON t.id = rr.term_id
            WHERE ($1::uuid IS NULL OR rr.term_id = $1)
            ORDER BY rr.computed_at DESC NULLS LAST`,
          [term.data ?? null]);
        return rows;
      }),
    };
  }

  /**
   * Every version of one learner's card for one term, oldest first.
   *
   * Declared before `:id` because `report-cards` is one segment and would
   * otherwise be read as a run id.
   */
  @Get('report-cards')
  async cardVersions(@Query('enrollmentId') enrollmentId?: string,
                     @Query('termId') termId?: string) {
    const parsed = z.object({ enrollmentId: uuid, termId: uuid })
      .safeParse({ enrollmentId, termId });
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    return {
      data: await withTenant(currentScope(), (db) =>
        reportCardService.versionsFor(db, parsed.data.enrollmentId, parsed.data.termId)),
    };
  }

  @Get('report-cards/:id')
  async card(@Param('id') id: string) {
    const cardId = uuid.safeParse(id);
    if (!cardId.success) throw ApiError.fromZod(cardId.error);
    const found = await reportCardService.byId(currentScope(), cardId.data);
    if (!found) {
      throw ApiError.make('not_found', 'card_not_found', 'No such report card.');
    }
    return { data: found };
  }

  @Get(':id')
  async byId(@Param('id') id: string) {
    const runId = uuid.safeParse(id);
    if (!runId.success) throw ApiError.fromZod(runId.error);
    const found = await resultService.byId(currentScope(), runId.data);
    if (!found) {
      throw ApiError.make('not_found', 'run_not_found', 'No such result run.');
    }
    return { data: found };
  }

  /**
   * Compute the term's results for a section.
   *
   * `requireCompleteWeights` defaults to true and should: assessments are
   * created over weeks and their weights are only required to sum to 100 at
   * the moment somebody computes a result from them. A run over an incomplete
   * set produces a number that looks like a result and is not one.
   */
  @Post()
  async compute(@Body() body: unknown) {
    const parsed = z.object({
      sectionId: uuid,
      termId: uuid,
      gradingScaleId: uuid,
      requireCompleteWeights: z.boolean().optional(),
    }).safeParse(body);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    const scope = currentScope();
    return {
      data: await resultService.compute(scope, {
        ...parsed.data,
        computedByStaffId: await requireStaff(scope),
      }),
    };
  }

  /** Checked by a second person. The service refuses the computer of the run. */
  @Post(':id/review')
  async review(@Param('id') id: string) {
    const runId = uuid.safeParse(id);
    if (!runId.success) throw ApiError.fromZod(runId.error);
    const scope = currentScope();
    await resultService.review(scope, {
      runId: runId.data, reviewerStaffId: await requireStaff(scope),
    });
    return { data: { reviewed: true } };
  }

  /** The moment families can see it. Reviewed runs only. */
  @Post(':id/publish')
  async publish(@Param('id') id: string) {
    const runId = uuid.safeParse(id);
    if (!runId.success) throw ApiError.fromZod(runId.error);
    const scope = currentScope();
    await resultService.publish(scope, {
      runId: runId.data, publishedByStaffId: await requireStaff(scope),
    });
    return { data: { published: true } };
  }

  /**
   * The published run this one replaces.
   *
   * `:id` is the old run, because that is the row whose meaning changes — the
   * new run was already computed and reviewed through the ordinary path. The
   * reason is required by the service and is not defaulted here: a correction
   * with no stated reason is the thing this endpoint exists to prevent.
   */
  @Post(':id/supersede')
  async supersede(@Param('id') id: string, @Body() body: unknown) {
    const oldRunId = uuid.safeParse(id);
    if (!oldRunId.success) throw ApiError.fromZod(oldRunId.error);
    const parsed = z.object({ newRunId: uuid, reason: z.string().max(1000) })
      .safeParse(body);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    const scope = currentScope();
    await resultService.supersede(scope, {
      oldRunId: oldRunId.data, ...parsed.data,
      byStaffId: await requireStaff(scope),
    });
    return { data: { superseded: true } };
  }

  @Post(':id/report-cards')
  async issueCards(@Param('id') id: string, @Body() body: unknown) {
    const runId = uuid.safeParse(id);
    if (!runId.success) throw ApiError.fromZod(runId.error);
    const parsed = z.object({ templateId: uuid.optional() }).safeParse(body ?? {});
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    return {
      data: await reportCardService.issueForRun(currentScope(), {
        runId: runId.data, ...parsed.data,
      }),
    };
  }

  @Post('report-cards/:id/publish')
  async publishCard(@Param('id') id: string) {
    const cardId = uuid.safeParse(id);
    if (!cardId.success) throw ApiError.fromZod(cardId.error);
    const scope = currentScope();
    await reportCardService.publish(scope, {
      cardId: cardId.data, publishedByStaffId: await requireStaff(scope),
    });
    return { data: { published: true } };
  }

  /**
   * A corrected card: a new version, with the old one kept and readable.
   *
   * Not a PATCH, because nothing about the old row changes — a parent who was
   * shown the wrong grade is owed the text they actually read.
   */
  @Post('report-cards/:id/correct')
  async correctCard(@Param('id') id: string, @Body() body: unknown) {
    const cardId = uuid.safeParse(id);
    if (!cardId.success) throw ApiError.fromZod(cardId.error);
    const parsed = z.object({
      newRunId: uuid,
      reason: z.string().max(1000),
      templateId: uuid.optional(),
    }).safeParse(body);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    const scope = currentScope();
    return {
      data: await reportCardService.correct(scope, {
        cardId: cardId.data, ...parsed.data,
        byStaffId: await requireStaff(scope),
      }),
    };
  }

  @Post('report-card-templates')
  async createTemplate(@Body() body: unknown) {
    const parsed = z.object({
      academicUnitId: uuid,
      name: z.string().min(1).max(200),
      board: z.string().max(60).optional(),
      // `z.unknown()` is optional in zod even when it is not marked so, which
      // is exactly the trap: the field would have been silently absent and
      // the template stored with a null layout.
      layout: z.unknown().refine((v) => v !== undefined, {
        message: 'A report card template needs a layout.',
      }),
    }).safeParse(body);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    const { layout, ...rest } = parsed.data;
    return {
      data: await reportCardService.createTemplate(currentScope(), { ...rest, layout }),
    };
  }
}
