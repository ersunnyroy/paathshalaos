/**
 * The read surface the web app runs on.
 *
 * Every query here goes through `withTenant`, so the rows a caller gets are the
 * rows their ROLE permits — a guardian hitting `/v1/students` gets their own
 * children and a teacher gets their section, from the same endpoint and the same
 * SQL. The policies in 0012, 0027, 0033 and 0036 are what filter, not a `WHERE`
 * clause written here, because a `WHERE` clause written here is one somebody can
 * forget on the next endpoint.
 *
 * Money crosses this boundary as paise in a string. A JSON number is a double,
 * and a fee ledger that has been through a double is no longer exact.
 */
import { Controller, Get, Post, Body, Param, Query, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { withTenant } from '../../db/tenant.ts';
import { currentScope } from '../../common/scope.ts';
import { ApiError } from '../../common/errors.ts';
import { attendanceService } from '../attendance/attendance.service.ts';
import { paymentService } from '../billing/payment.service.ts';
import { Money } from '../billing/money.ts';

const uuid = z.string().uuid();

@Controller('v1')
export class DirectoryController {
  @Get('academic-years')
  async years() {
    return {
      data: await withTenant(currentScope(), async (db) => {
        const { rows } = await db.query(
          `SELECT id, label, starts_on::text AS starts_on, ends_on::text AS ends_on, status
             FROM academic_year WHERE deleted_at IS NULL
            ORDER BY starts_on DESC`,
        );
        return rows;
      }),
    };
  }

  @Get('terms')
  async terms(@Query('academicYearId') academicYearId?: string) {
    const parsed = uuid.optional().safeParse(academicYearId);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    return {
      data: await withTenant(currentScope(), async (db) => {
        const { rows } = await db.query(
          `SELECT id, label, sequence, starts_on::text AS starts_on, ends_on::text AS ends_on,
                  academic_year_id
             FROM term
            WHERE deleted_at IS NULL
              AND ($1::uuid IS NULL OR academic_year_id = $1::uuid)
            ORDER BY sequence`,
          [parsed.data ?? null],
        );
        return rows;
      }),
    };
  }

  @Get('sections')
  async sections(@Query('academicYearId') academicYearId?: string) {
    const parsed = uuid.optional().safeParse(academicYearId);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    return {
      data: await withTenant(currentScope(), async (db) => {
        const { rows } = await db.query(
          `SELECT s.id, s.name AS section_name, cg.name AS class_name,
                  cg.academic_year_id, au.campus_id,
                  (SELECT count(*)::int FROM enrollment e
                    WHERE e.section_id = s.id AND e.status = 'active') AS learners
             FROM section s
             JOIN class_group cg ON cg.id = s.class_group_id
             JOIN programme pr ON pr.id = cg.programme_id
             JOIN academic_unit au ON au.id = pr.academic_unit_id
            WHERE s.deleted_at IS NULL
              AND ($1::uuid IS NULL OR cg.academic_year_id = $1::uuid)
            ORDER BY cg.name, s.name`,
          [parsed.data ?? null],
        );
        return rows;
      }),
    };
  }

  /**
   * Learners. What comes back is what the caller may see: a guardian's own
   * children, a teacher's sections, an admin's campus — decided by RLS, not by a
   * branch in this method.
   */
  @Get('students')
  async students(@Query('sectionId') sectionId?: string, @Query('q') q?: string) {
    const parsed = z.object({
      sectionId: uuid.optional(),
      q: z.string().max(100).optional(),
    }).safeParse({ sectionId, q });
    if (!parsed.success) throw ApiError.fromZod(parsed.error);

    return {
      data: await withTenant(currentScope(), async (db) => {
        const { rows } = await db.query(
          `SELECT st.id, st.admission_no,
                  p.given_name, p.family_name,
                  e.id AS enrollment_id, sec.id AS section_id,
                  sec.name AS section_name, cg.name AS class_name
             FROM student st
             JOIN person p ON p.id = st.person_id
             LEFT JOIN enrollment e ON e.student_id = st.id AND e.status = 'active'
             LEFT JOIN section sec ON sec.id = e.section_id
             LEFT JOIN class_group cg ON cg.id = sec.class_group_id
            WHERE ($1::uuid IS NULL OR sec.id = $1::uuid)
              AND ($2::text IS NULL
                   OR p.given_name ILIKE '%' || $2::text || '%'
                   OR p.family_name ILIKE '%' || $2::text || '%'
                   OR st.admission_no ILIKE '%' || $2::text || '%')
            ORDER BY p.given_name, p.family_name
            LIMIT 200`,
          [parsed.data.sectionId ?? null, parsed.data.q ?? null],
        );
        return rows;
      }),
    };
  }

  @Get('students/:id')
  async student(@Param('id') id: string) {
    const parsed = uuid.safeParse(id);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);

    const found = await withTenant(currentScope(), async (db) => {
      const { rows } = await db.query(
        `SELECT st.id, st.admission_no, p.given_name, p.family_name,
                p.date_of_birth::text AS date_of_birth
           FROM student st JOIN person p ON p.id = st.person_id
          WHERE st.id = $1::uuid`,
        [parsed.data],
      );
      return rows[0];
    });
    // A learner in another tenant, or one this caller may not see, is
    // indistinguishable from one that does not exist. A 403 would confirm the id.
    if (!found) {
      throw new NotFoundException(
        ApiError.notFound('student_not_found', 'Learner not found.'));
    }
    return { data: found };
  }

  // -------------------------------------------------------------------------
  // Attendance
  // -------------------------------------------------------------------------

  @Get('attendance/sessions')
  async sessions(@Query('date') date?: string, @Query('sectionId') sectionId?: string) {
    const parsed = z.object({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      sectionId: uuid.optional(),
    }).safeParse({ date, sectionId });
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    const on = parsed.data.date ?? new Date().toISOString().slice(0, 10);

    return {
      data: await withTenant(currentScope(), async (db) => {
        const { rows } = await db.query(
          `SELECT ses.id, ses.session_date::text AS session_date, ses.status,
                  ses.section_id, sec.name AS section_name, cg.name AS class_name,
                  count(r.id)::int AS marked,
                  count(*) FILTER (WHERE r.state = 'absent')::int AS absent
             FROM attendance_session ses
             JOIN section sec ON sec.id = ses.section_id
             JOIN class_group cg ON cg.id = sec.class_group_id
             LEFT JOIN attendance_record r ON r.attendance_session_id = ses.id
            WHERE ses.session_date = $1::date
              AND ($2::uuid IS NULL OR ses.section_id = $2::uuid)
            GROUP BY ses.id, sec.name, cg.name
            ORDER BY cg.name, sec.name`,
          [on, parsed.data.sectionId ?? null],
        );
        return rows;
      }),
    };
  }

  @Get('attendance/sessions/:id/records')
  async records(@Param('id') id: string) {
    const parsed = uuid.safeParse(id);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    return {
      data: await attendanceService.recordsForSession(currentScope(), parsed.data),
    };
  }

  @Post('attendance/sessions')
  async openSession(@Body() body: unknown) {
    const parsed = z.object({
      sectionId: uuid,
      academicYearId: uuid,
      sessionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      mode: z.enum(['day', 'subject', 'device']).default('day'),
      courseOfferingId: uuid.optional(),
      markedByStaffId: uuid.optional(),
    }).safeParse(body);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    const { courseOfferingId, markedByStaffId, ...rest } = parsed.data;
    return {
      data: await attendanceService.openSession(currentScope(), {
        ...rest,
        ...(courseOfferingId ? { courseOfferingId } : {}),
        ...(markedByStaffId ? { markedByStaffId } : {}),
      }),
    };
  }

  @Post('attendance/sessions/:id/marks')
  async mark(@Param('id') id: string, @Body() body: unknown) {
    const sessionId = uuid.safeParse(id);
    if (!sessionId.success) throw ApiError.fromZod(sessionId.error);

    const parsed = z.object({
      records: z.array(z.object({
        studentId: uuid,
        state: z.enum(['present', 'absent', 'late', 'excused', 'half_day']),
        minutesLate: z.number().int().min(0).max(600).optional(),
        // The device generates this. The server accepts one if offered and
        // mints one otherwise, so a browser (which has no offline queue) is not
        // forced to invent an id it will never replay.
        clientEventId: uuid.optional(),
      })).min(1).max(500),
      markedByStaffId: uuid.optional(),
    }).safeParse(body);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);

    return {
      data: await attendanceService.sync(currentScope(), {
        sessionId: sessionId.data,
        records: parsed.data.records.map((r) => ({
          studentId: r.studentId,
          state: r.state,
          clientEventId: r.clientEventId ?? randomUUID(),
          ...(r.minutesLate !== undefined ? { minutesLate: r.minutesLate } : {}),
        })),
        ...(parsed.data.markedByStaffId
          ? { markedByStaffId: parsed.data.markedByStaffId } : {}),
      }),
    };
  }

  // -------------------------------------------------------------------------
  // Fees
  // -------------------------------------------------------------------------

  @Get('invoices')
  async invoices(@Query('status') status?: string) {
    const parsed = z.enum(['issued', 'part_paid', 'paid', 'void']).optional()
      .safeParse(status);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);

    return {
      data: await withTenant(currentScope(), async (db) => {
        const { rows } = await db.query(
          `SELECT i.id, i.invoice_no, i.financial_year, i.status,
                  i.due_on::text AS due_on,
                  (i.total * 100)::bigint::text AS total_paise,
                  (i.amount_paid * 100)::bigint::text AS paid_paise,
                  ((i.total - i.amount_paid) * 100)::bigint::text AS outstanding_paise,
                  p.given_name, p.family_name, st.admission_no
             FROM invoice i
             LEFT JOIN enrollment e ON e.id = i.enrollment_id
             LEFT JOIN student st ON st.id = e.student_id
             LEFT JOIN person p ON p.id = st.person_id
            WHERE ($1::text IS NULL OR i.status = $1::text)
            ORDER BY i.due_on DESC, i.invoice_no DESC
            LIMIT 200`,
          [parsed.data ?? null],
        );
        return rows;
      }),
    };
  }

  @Post('invoices/:id/payments')
  async recordPayment(@Param('id') id: string, @Body() body: unknown) {
    const invoiceId = uuid.safeParse(id);
    if (!invoiceId.success) throw ApiError.fromZod(invoiceId.error);

    const parsed = z.object({
      // A decimal string, never a number. `12500.10` as a JSON double is
      // 12500.099999999999, and that is a receipt with the wrong figure on it.
      amount: z.string().regex(/^\d+(\.\d{1,2})?$/),
      method: z.enum(['cash', 'cheque', 'dd', 'neft']),
      idempotencyKey: z.string().min(8).max(200),
      receivedByStaffId: uuid,
    }).safeParse(body);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);

    return {
      data: await paymentService.recordOfflinePayment(currentScope(), {
        invoiceId: invoiceId.data,
        amountMinor: Money.fromDecimalString(parsed.data.amount),
        method: parsed.data.method,
        idempotencyKey: parsed.data.idempotencyKey,
        receivedByStaffId: parsed.data.receivedByStaffId,
      }),
    };
  }

  // -------------------------------------------------------------------------
  // Results
  // -------------------------------------------------------------------------

  @Get('results')
  async results(@Query('sectionId') sectionId?: string, @Query('termId') termId?: string) {
    const parsed = z.object({
      sectionId: uuid.optional(), termId: uuid.optional(),
    }).safeParse({ sectionId, termId });
    if (!parsed.success) throw ApiError.fromZod(parsed.error);

    return {
      data: await withTenant(currentScope(), async (db) => {
        const { rows } = await db.query(
          `SELECT r.id, r.status, r.term_id, r.section_id,
                  r.computed_at, r.published_at,
                  (SELECT count(*)::int FROM result_line l WHERE l.result_run_id = r.id) AS lines
             FROM result_run r
            WHERE ($1::uuid IS NULL OR r.section_id = $1::uuid)
              AND ($2::uuid IS NULL OR r.term_id = $2::uuid)
            ORDER BY r.computed_at DESC
            LIMIT 100`,
          [parsed.data.sectionId ?? null, parsed.data.termId ?? null],
        );
        return rows;
      }),
    };
  }

  @Get('results/:id/lines')
  async resultLines(@Param('id') id: string) {
    const parsed = uuid.safeParse(id);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    return {
      data: await withTenant(currentScope(), async (db) => {
        const { rows } = await db.query(
          `SELECT l.enrollment_id, l.course_offering_id,
                  l.percentage::text AS percentage, l.grade_label, l.is_pass,
                  l.not_graded_reason,
                  p.given_name, p.family_name, st.admission_no
             FROM result_line l
             JOIN enrollment e ON e.id = l.enrollment_id
             JOIN student st ON st.id = e.student_id
             JOIN person p ON p.id = st.person_id
            WHERE l.result_run_id = $1::uuid
            ORDER BY p.given_name, l.course_offering_id NULLS FIRST`,
          [parsed.data],
        );
        return rows;
      }),
    };
  }

  // -------------------------------------------------------------------------
  // Messaging and imports, for the operations screens
  // -------------------------------------------------------------------------

  @Get('messages')
  async messages() {
    return {
      data: await withTenant(currentScope(), async (db) => {
        const { rows } = await db.query(
          `SELECT mr.id, mr.status, mr.channel, mr.suppression_reason,
                  mr.rendered_body, mr.created_at,
                  p.given_name, p.family_name
             FROM message_recipient mr
             LEFT JOIN person p ON p.id = mr.person_id
            ORDER BY mr.created_at DESC
            LIMIT 100`,
        );
        return rows;
      }),
    };
  }

  @Get('imports')
  async imports() {
    return {
      data: await withTenant(currentScope(), async (db) => {
        const { rows } = await db.query(
          `SELECT id, entity, status, original_filename, created_at,
                  preview_counts, applied_counts
             FROM import_batch
            ORDER BY created_at DESC
            LIMIT 50`,
        );
        return rows;
      }),
    };
  }
}
