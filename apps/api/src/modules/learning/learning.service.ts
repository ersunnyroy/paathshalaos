/**
 * Learning (M28).
 *
 * Thin, like transport's, and for the same reason: who may see a lesson or a
 * child's homework is decided by 0076's policies, not by a `WHERE` clause a
 * controller remembers to write.
 *
 * What lives here is the one sequence the schema cannot express on its own —
 * **grading**. Returning a graded piece of work is two writes that have to
 * agree: a mark against the assessment, where M8's weighting and the result
 * run will find it, and the feedback on the submission. This module does not
 * own a second way to record a score, and `gradeAndReturn` below is the reason
 * it does not need one: it calls `assessmentService.enterMarks`, the same entry
 * point the exam screen uses, and gets the same lock, the same corrections and
 * the same absent/exempt rule for free.
 */
import { withTenant, type TenantScope, type TenantClient } from '../../db/tenant.ts';
import { ApiError } from '../../common/errors.ts';
import { auditService } from '../audit/audit.service.ts';
import { assessmentService, type MarkOutcome } from '../assessment/assessment.service.ts';

/**
 * Who the caller is, as a staff row, asked of the database.
 *
 * 0073 already resolves this from the verified person id, so taking it from a
 * request body instead would be a second answer to a question that has one —
 * and the failure mode is silent misattribution: every mark entered by a
 * client that sent the wrong id is recorded against another teacher.
 */
async function currentStaffId(db: TenantClient): Promise<string | undefined> {
  const { rows } = await db.query<{ staff_id: string | null }>(
    'SELECT app_current_staff_id() AS staff_id');
  return rows[0]?.staff_id ?? undefined;
}

export type AssignmentStatus = 'draft' | 'published' | 'closed';
export type SubmissionKind = 'text' | 'file' | 'either' | 'offline';

export interface Lesson {
  id: string;
  course_offering_id: string;
  title: string;
  summary: string | null;
  sequence_no: number | null;
  taught_on: string | null;
  status: 'draft' | 'published' | 'archived';
  resource_count: number;
}

export interface Assignment {
  id: string;
  course_offering_id: string;
  lesson_id: string | null;
  assessment_id: string | null;
  title: string;
  instructions: string | null;
  due_at: string | null;
  accepts_late: boolean;
  submission_kind: SubmissionKind;
  status: AssignmentStatus;
  max_marks: string | null;
  submitted_count: number;
  returned_count: number;
}

export interface Submission {
  id: string;
  assignment_id: string;
  enrollment_id: string;
  student_id: string;
  body_text: string | null;
  submitted_at: string;
  is_late: boolean;
  status: 'submitted' | 'returned';
  feedback: string | null;
  returned_at: string | null;
  /**
   * From `mark`, not from this table — there is no score column here and there
   * is not going to be one. It is on this row because the marking screen has
   * to show what was already awarded: a teacher reopening returned work and
   * finding empty boxes will either retype thirty marks or assume they were
   * never saved, and both are worse than the join.
   */
  marks_obtained: string | null;
}

const SELECT_ASSIGNMENT = `
  a.id, a.course_offering_id, a.lesson_id, a.assessment_id, a.title,
  a.instructions, a.due_at, a.accepts_late, a.submission_kind, a.status,
  asm.max_marks::text AS max_marks,
  (SELECT count(*)::int FROM submission s WHERE s.assignment_id = a.id)
    AS submitted_count,
  (SELECT count(*)::int FROM submission s
    WHERE s.assignment_id = a.id AND s.status = 'returned') AS returned_count`;

/**
 * Turned into the assessment the marks hang off.
 *
 * Called on the create path rather than exposed, because an assignment that
 * awards marks and has no assessment is the state this milestone exists to
 * make unreachable. A teacher says "this is out of 20"; they do not also have
 * to know that an assessment row is how that becomes part of the term.
 */
async function assessmentFor(
  scope: TenantScope,
  db: TenantClient,
  input: { courseOfferingId: string; title: string; maxMarks: number | string;
           weightPercent?: number | undefined; gradingScaleId?: string | undefined },
): Promise<string> {
  const { rows } = await db.query<{ term_id: string }>(
    'SELECT term_id FROM course_offering WHERE id = $1::uuid AND deleted_at IS NULL',
    [input.courseOfferingId],
  );
  const offering = rows[0];
  if (!offering) {
    throw ApiError.make('not_found', 'offering_not_found', 'Course offering not found.');
  }

  const assessment = await assessmentService.create(scope, {
    courseOfferingId: input.courseOfferingId,
    termId: offering.term_id,
    name: input.title,
    kind: 'assignment',
    maxMarks: input.maxMarks,
    ...(input.weightPercent === undefined ? {} : { weightPercent: input.weightPercent }),
    ...(input.gradingScaleId === undefined ? {} : { gradingScaleId: input.gradingScaleId }),
  });
  // Marks cannot be entered against a draft, and the point of an assignment is
  // that they will be. Opening it here keeps the two objects in one state.
  await assessmentService.open(scope, assessment.id);
  return assessment.id;
}

export const learningService = {
  /**
   * The classes this caller teaches or can see, for the picker every screen
   * in this module starts with.
   *
   * `course_offering` is readable tenant-wide — a timetable is not a secret,
   * and several unrelated screens depend on that. So the narrowing is explicit
   * here rather than borrowed from a policy: this list drives a page whose
   * every other call will be refused for anything not on it, and a picker
   * offering classes whose contents then 404 is a worse screen than a short
   * picker.
   */
  async offerings(scope: TenantScope): Promise<Array<{
    id: string; subject_name: string; class_group_name: string;
    section_name: string | null; term_label: string; is_mine: boolean;
    assignment_count: number; awaiting_count: number;
  }>> {
    return withTenant(scope, async (db) => {
      const { rows } = await db.query<{
        id: string; subject_name: string; class_group_name: string;
        section_name: string | null; term_label: string; is_mine: boolean;
        assignment_count: number; awaiting_count: number;
      }>(
        `SELECT co.id, sub.name AS subject_name, cg.name AS class_group_name,
                sec.name AS section_name, t.label AS term_label,
                app_may_set_work(co.id) AS is_mine,
                (SELECT count(*)::int FROM assignment a
                  WHERE a.course_offering_id = co.id) AS assignment_count,
                -- Handed in and not yet returned. The number a teacher opens
                -- this page to find.
                (SELECT count(*)::int FROM submission s
                  WHERE s.course_offering_id = co.id AND s.status = 'submitted')
                  AS awaiting_count
           FROM course_offering co
           JOIN subject sub ON sub.id = co.subject_id
           JOIN class_group cg ON cg.id = co.class_group_id
           JOIN term t ON t.id = co.term_id
           LEFT JOIN section sec ON sec.id = co.section_id
          WHERE co.deleted_at IS NULL
            AND app_may_see_offering(co.id)
          ORDER BY cg.name, sec.name NULLS FIRST, sub.name`);
      return rows;
    });
  },

  // ------------------------------------------------------------------ lessons

  async lessons(scope: TenantScope, courseOfferingId: string): Promise<Lesson[]> {
    return withTenant(scope, async (db) => {
      const { rows } = await db.query<Lesson>(
        `SELECT l.id, l.course_offering_id, l.title, l.summary, l.sequence_no,
                l.taught_on::text AS taught_on, l.status,
                (SELECT count(*)::int FROM lesson_resource lr
                  WHERE lr.lesson_id = l.id) AS resource_count
           FROM lesson l
          WHERE l.course_offering_id = $1::uuid
          ORDER BY l.sequence_no NULLS LAST, l.taught_on NULLS LAST, l.created_at`,
        [courseOfferingId],
      );
      return rows;
    });
  },

  async createLesson(
    scope: TenantScope,
    input: { courseOfferingId: string; title: string; summary?: string | undefined;
             sequenceNo?: number | undefined; taughtOn?: string | undefined },
  ): Promise<Lesson> {
    const lesson = await withTenant(scope, async (db) => {
      const staffId = await currentStaffId(db);
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO lesson
           (tenant_id, course_offering_id, academic_year_id, title, summary,
            sequence_no, taught_on, created_by_staff_id)
         VALUES (app_current_tenant_id(), $1::uuid,
                 '00000000-0000-0000-0000-000000000000'::uuid, $2, $3,
                 $4::integer, $5::date, $6::uuid)
         RETURNING id`,
        [input.courseOfferingId, input.title, input.summary ?? null,
         input.sequenceNo ?? null, input.taughtOn ?? null, staffId ?? null],
      );
      return rows[0]!;
    });

    await auditService.record({
      tenantId: scope.tenantId,
      ...(scope.actorId ? { actorUserId: scope.actorId } : {}),
      action: 'lesson.created',
      resourceType: 'lesson',
      resourceId: lesson.id,
      classification: 'INTERNAL',
    });

    const all = await this.lessons(scope, input.courseOfferingId);
    return all.find((l) => l.id === lesson.id)!;
  },

  async publishLesson(scope: TenantScope, lessonId: string): Promise<void> {
    await withTenant(scope, async (db) => {
      const { rowCount } = await db.query(
        `UPDATE lesson SET status = 'published', published_at = now(), updated_at = now()
          WHERE id = $1::uuid AND status = 'draft'`,
        [lessonId],
      );
      if (rowCount === 0) {
        throw ApiError.make('conflict', 'lesson_not_draft',
          'Only a draft lesson can be published.');
      }
    });
  },

  // -------------------------------------------------------------- assignments

  async assignments(scope: TenantScope, courseOfferingId: string): Promise<Assignment[]> {
    return withTenant(scope, async (db) => {
      const { rows } = await db.query<Assignment>(
        `SELECT ${SELECT_ASSIGNMENT}
           FROM assignment a
           LEFT JOIN assessment asm ON asm.id = a.assessment_id
          WHERE a.course_offering_id = $1::uuid
          ORDER BY a.due_at NULLS LAST, a.created_at DESC`,
        [courseOfferingId],
      );
      return rows;
    });
  },

  /**
   * What is due, for one learner, across every subject.
   *
   * The screen a parent actually opens. `submitted_at IS NULL` is the whole
   * question, and it is a LEFT JOIN rather than a NOT EXISTS so that one query
   * answers "what is set" and "what have we done" together — a parent looking
   * at a list of six items needs to know which two are outstanding, not that
   * six exist.
   */
  async dueFor(
    scope: TenantScope,
    studentId: string,
    opts: { includeReturned?: boolean } = {},
  ): Promise<Array<{
    assignment_id: string; title: string; subject_name: string;
    due_at: string | null; status: AssignmentStatus; submission_kind: SubmissionKind;
    submitted_at: string | null; is_late: boolean | null;
    submission_status: string | null; feedback: string | null;
    marks_obtained: string | null; max_marks: string | null;
  }>> {
    return withTenant(scope, async (db) => {
      const { rows } = await db.query<{
        assignment_id: string; title: string; subject_name: string;
        due_at: string | null; status: AssignmentStatus; submission_kind: SubmissionKind;
        submitted_at: string | null; is_late: boolean | null;
        submission_status: string | null; feedback: string | null;
        marks_obtained: string | null; max_marks: string | null;
      }>(
        `SELECT a.id AS assignment_id, a.title, sub.name AS subject_name,
                a.due_at, a.status, a.submission_kind,
                s.submitted_at, s.is_late, s.status AS submission_status, s.feedback,
                m.marks_obtained::text AS marks_obtained,
                asm.max_marks::text AS max_marks
           FROM assignment a
           JOIN course_offering co ON co.id = a.course_offering_id
           JOIN subject sub ON sub.id = co.subject_id
           JOIN enrollment e ON e.student_id = $1::uuid AND e.status = 'active'
           LEFT JOIN assessment asm ON asm.id = a.assessment_id
           LEFT JOIN submission s
             ON s.assignment_id = a.id AND s.enrollment_id = e.id
           LEFT JOIN mark m
             ON m.assessment_id = a.assessment_id AND m.enrollment_id = e.id
          WHERE a.status = 'published'
            AND e.section_id IN (
              SELECT sec.id FROM section sec
               WHERE sec.class_group_id = co.class_group_id
                 AND (co.section_id IS NULL OR co.section_id = sec.id))
            AND ($2::boolean OR s.status IS DISTINCT FROM 'returned')
          ORDER BY a.due_at NULLS LAST, a.created_at DESC`,
        [studentId, opts.includeReturned ?? false],
      );
      return rows;
    });
  },

  /**
   * Create an assignment, and — if it carries marks — the assessment behind it.
   *
   * `maxMarks` is the only thing that decides. There is no `isGraded` flag to
   * get out of step with it.
   */
  async createAssignment(
    scope: TenantScope,
    input: {
      courseOfferingId: string; title: string; instructions?: string | undefined;
      dueAt?: string | undefined; acceptsLate?: boolean | undefined;
      submissionKind?: SubmissionKind | undefined; lessonId?: string | undefined;
      maxMarks?: number | string | undefined; weightPercent?: number | undefined;
      gradingScaleId?: string | undefined;
    },
  ): Promise<Assignment> {
    if (input.acceptsLate === false && !input.dueAt) {
      throw ApiError.make('validation_error', 'late_needs_deadline',
        'An assignment that refuses late work needs a due date.');
    }

    const id = await withTenant(scope, async (db) => {
      const staffId = await currentStaffId(db);
      const assessmentId = input.maxMarks === undefined
        ? null
        : await assessmentFor(scope, db, {
            courseOfferingId: input.courseOfferingId,
            title: input.title,
            maxMarks: input.maxMarks,
            ...(input.weightPercent === undefined ? {} : { weightPercent: input.weightPercent }),
            ...(input.gradingScaleId === undefined ? {} : { gradingScaleId: input.gradingScaleId }),
          });

      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO assignment
           (tenant_id, course_offering_id, academic_year_id, lesson_id, assessment_id,
            title, instructions, due_at, accepts_late, submission_kind,
            created_by_staff_id)
         VALUES (app_current_tenant_id(), $1::uuid,
                 '00000000-0000-0000-0000-000000000000'::uuid, $2::uuid, $3::uuid,
                 $4, $5, $6::timestamptz, $7::boolean, $8, $9::uuid)
         RETURNING id`,
        [input.courseOfferingId, input.lessonId ?? null, assessmentId,
         input.title, input.instructions ?? null, input.dueAt ?? null,
         input.acceptsLate ?? true, input.submissionKind ?? 'either',
         staffId ?? null],
      );
      return rows[0]!.id;
    });

    await auditService.record({
      tenantId: scope.tenantId,
      ...(scope.actorId ? { actorUserId: scope.actorId } : {}),
      action: 'assignment.created',
      resourceType: 'assignment',
      resourceId: id,
      classification: 'INTERNAL',
    });

    const found = await this.assignmentById(scope, id);
    if (!found) throw ApiError.make('not_found', 'assignment_not_found', 'Assignment not found.');
    return found;
  },

  async assignmentById(scope: TenantScope, assignmentId: string): Promise<Assignment | undefined> {
    return withTenant(scope, async (db) => {
      const { rows } = await db.query<Assignment>(
        `SELECT ${SELECT_ASSIGNMENT}
           FROM assignment a
           LEFT JOIN assessment asm ON asm.id = a.assessment_id
          WHERE a.id = $1::uuid`,
        [assignmentId],
      );
      return rows[0];
    });
  },

  async publishAssignment(scope: TenantScope, assignmentId: string): Promise<void> {
    await withTenant(scope, async (db) => {
      const { rowCount } = await db.query(
        `UPDATE assignment
            SET status = 'published', published_at = now(), updated_at = now()
          WHERE id = $1::uuid AND status = 'draft'`,
        [assignmentId],
      );
      if (rowCount === 0) {
        throw ApiError.make('conflict', 'assignment_not_draft',
          'Only a draft assignment can be published.');
      }
    });
  },

  // -------------------------------------------------------------- submissions

  async submissions(scope: TenantScope, assignmentId: string): Promise<Submission[]> {
    return withTenant(scope, async (db) => {
      const { rows } = await db.query<Submission>(
        `SELECT s.id, s.assignment_id, s.enrollment_id, s.student_id, s.body_text,
                s.submitted_at, s.is_late, s.status, s.feedback, s.returned_at,
                m.marks_obtained::text AS marks_obtained
           FROM submission s
           JOIN assignment a ON a.id = s.assignment_id
           LEFT JOIN mark m ON m.assessment_id = a.assessment_id
                           AND m.enrollment_id = s.enrollment_id
          WHERE s.assignment_id = $1::uuid
          ORDER BY s.submitted_at`,
        [assignmentId],
      );
      return rows;
    });
  },

  /**
   * Hand work in, or replace what was handed in before.
   *
   * Upsert rather than insert-or-error: a learner who re-uploads before the
   * deadline has corrected their work, not made a mistake, and an endpoint that
   * refuses the second attempt teaches them to submit late instead. The
   * lateness of the row is recomputed by the trigger either way, so a
   * resubmission after the deadline is late even if the first one was not.
   */
  async submit(
    scope: TenantScope,
    input: { assignmentId: string; enrollmentId: string;
             bodyText?: string | undefined; fileIds?: string[] | undefined },
  ): Promise<Submission> {
    return withTenant(scope, async (db) => {
      const { rows } = await db.query<Submission>(
        `INSERT INTO submission
           (tenant_id, assignment_id, enrollment_id, student_id, course_offering_id,
            body_text, submitted_at)
         VALUES (app_current_tenant_id(), $1::uuid, $2::uuid,
                 '00000000-0000-0000-0000-000000000000'::uuid,
                 '00000000-0000-0000-0000-000000000000'::uuid, $3, now())
         ON CONFLICT (tenant_id, assignment_id, enrollment_id) DO UPDATE
           SET body_text = EXCLUDED.body_text,
               submitted_at = now(),
               updated_at = now()
         RETURNING id, assignment_id, enrollment_id, student_id, body_text,
                   submitted_at, is_late, status, feedback, returned_at,
                   NULL::text AS marks_obtained`,
        [input.assignmentId, input.enrollmentId, input.bodyText ?? null],
      );
      const submission = rows[0]!;

      for (const fileId of input.fileIds ?? []) {
        await db.query(
          `INSERT INTO submission_file (tenant_id, submission_id, file_id)
           VALUES (app_current_tenant_id(), $1::uuid, $2::uuid)
           ON CONFLICT (tenant_id, submission_id, file_id) DO NOTHING`,
          [submission.id, fileId],
        );
      }
      return submission;
    });
  },

  /**
   * The one method this module exists to get right.
   *
   * Marks first, feedback second. If the mark is refused — the assessment is
   * locked, the number is out of range, the learner is not in this class — the
   * submission is left as it was, and the teacher sees the refusal that names
   * the reason. Writing the feedback first would leave work showing as returned
   * with no mark behind it, which is the failure 0076's trigger refuses; doing
   * it in this order means the trigger never has to.
   */
  async gradeAndReturn(
    scope: TenantScope,
    input: {
      assignmentId: string;
      grades: Array<{ enrollmentId: string; marks?: number | string | undefined;
                      absent?: boolean | undefined; exempt?: boolean | undefined;
                      feedback?: string | undefined }>;
    },
  ): Promise<{ outcomes: MarkOutcome[]; returned: number }> {
    if (input.grades.length === 0) {
      throw ApiError.make('validation_error', 'no_grades', 'No grades were supplied.');
    }

    const assignment = await this.assignmentById(scope, input.assignmentId);
    if (!assignment) {
      throw ApiError.make('not_found', 'assignment_not_found', 'Assignment not found.');
    }

    const byStaffId = await withTenant(scope, currentStaffId);
    if (!byStaffId) {
      throw ApiError.make('permission_error', 'not_staff',
        'Only a member of staff can grade work.');
    }

    let outcomes: MarkOutcome[] = [];
    if (assignment.assessment_id) {
      ({ outcomes } = await assessmentService.enterMarks(scope, {
        assessmentId: assignment.assessment_id,
        enteredByStaffId: byStaffId,
        marks: input.grades.map((g) => ({
          enrollmentId: g.enrollmentId,
          ...(g.marks === undefined ? {} : { marks: g.marks }),
          ...(g.absent === undefined ? {} : { absent: g.absent }),
          ...(g.exempt === undefined ? {} : { exempt: g.exempt }),
        })),
      }));
    } else if (input.grades.some((g) => g.marks !== undefined)) {
      // A number with nowhere to go. Silently dropping it is how a teacher
      // discovers in March that a term of marks was never recorded.
      throw ApiError.make('validation_error', 'assignment_not_graded',
        'This assignment carries no marks. Set a maximum when creating it, or '
        + 'return the work with feedback only.');
    }

    // Only the rows whose mark actually landed may be returned. A rejection is
    // not a grading failure for the rest of the class — it is one child whose
    // row the teacher has to look at again.
    const refused = new Set(
      outcomes.filter((o) => o.outcome === 'rejected').map((o) => o.enrollmentId),
    );

    const returned = await withTenant(scope, async (db) => {
      let count = 0;
      for (const g of input.grades) {
        if (refused.has(g.enrollmentId)) continue;
        const { rowCount } = await db.query(
          `UPDATE submission
              SET status = 'returned', returned_at = now(),
                  returned_by_staff_id = $3::uuid,
                  feedback = COALESCE($4, feedback), updated_at = now()
            WHERE assignment_id = $1::uuid AND enrollment_id = $2::uuid`,
          [input.assignmentId, g.enrollmentId, byStaffId, g.feedback ?? null],
        );
        count += rowCount ?? 0;
      }
      return count;
    });

    await auditService.record({
      tenantId: scope.tenantId,
      ...(scope.actorId ? { actorUserId: scope.actorId } : {}),
      action: 'assignment.graded',
      resourceType: 'assignment',
      resourceId: input.assignmentId,
      classification: 'INTERNAL',
      after: { returned, rejected: refused.size },
    });

    return { outcomes, returned };
  },
};
