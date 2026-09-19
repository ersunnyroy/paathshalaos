/**
 * The public API. Authenticated by API key, scoped per route.
 *
 * Three things distinguish it from the app's own read surface:
 *
 *   **It is versioned and it is a contract.** `/api/v1` is a promise to people
 *   who are not us. Fields get added, never removed or retyped, and money stays
 *   a string of paise for the same reason it does everywhere else.
 *
 *   **Writes require an Idempotency-Key.** Not "support" one — require it. A
 *   client that omits it is refused, which is a five-minute fix during their
 *   integration rather than a duplicate attendance record during their term.
 *
 *   **The rows are still the database's decision.** These handlers run under
 *   `withTenant` with the API client in scope, so the policies filter exactly
 *   as they do for a person. A key with students:read and no invoices:read gets
 *   nothing from the invoice tables — not because this file checks, but because
 *   `app_actor_has_finance_scope()` is false for it.
 */
import { Controller, Get, Post, Body, Query, Headers, UseGuards, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { withTenant } from '../../db/tenant.ts';
import { currentScope } from '../../common/scope.ts';
import { getContext } from '../../common/request-context.ts';
import { ApiError } from '../../common/errors.ts';
import { Public } from '../auth/public.decorator.ts';
import { ApiKeyGuard, ApiScopes } from './api-key.guard.ts';
import { idempotencyService } from './idempotency.service.ts';
import { attendanceService } from '../attendance/attendance.service.ts';

const page = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().uuid().optional(),
});

/**
 * One page of rows, keyset-paginated.
 *
 * Written once because every list endpoint below must page identically. An
 * integration that learns the pattern on /students and finds /results does it
 * differently has been given two APIs wearing one version number.
 */
async function listPage<T extends { cursor: string }>(
  sql: string, cursor: string | null, limit: number,
): Promise<{ data: T[]; next_cursor: string | null }> {
  return withTenant(currentScope(), async (db) => {
    const { rows } = await db.query<T>(sql, [cursor, limit]);
    return {
      data: rows,
      next_cursor: rows.length === limit ? rows[rows.length - 1]!.cursor : null,
    };
  });
}

const markAttendance = z.object({
  sessionId: z.string().uuid(),
  marks: z.array(z.object({
    // The caller's own id for this mark, which the attendance service dedupes
    // on. It is required here rather than generated, because a generated one
    // would differ on every retry and defeat the layer below the idempotency
    // key — belt and braces, and both belts are the caller's to fasten.
    clientEventId: z.string().min(1).max(120),
    studentId: z.string().uuid(),
    state: z.enum(['present', 'absent', 'late', 'excused', 'half_day']),
    minutesLate: z.number().int().min(0).max(600).optional(),
  })).min(1).max(200),
});

/**
 * @Public() removes the SESSION guard, not authentication: ApiKeyGuard below
 * replaces it. Without this the global guard would demand a JWT and an API key
 * could never reach these handlers at all.
 */
@Public()
@UseGuards(ApiKeyGuard)
@Controller('api/v1')
export class PublicApiController {
  @Get('students')
  @ApiScopes('students:read')
  async students(@Query() query: unknown) {
    const parsed = page.safeParse(query);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    const { limit, cursor } = parsed.data;

    return withTenant(currentScope(), async (db) => {
      // Keyset pagination, not OFFSET. An integration walking 40,000 learners
      // with OFFSET makes the database re-scan everything it already sent, and
      // a row inserted mid-walk shifts every later page by one — so the client
      // silently skips a child.
      const { rows } = await db.query(
        `SELECT s.id, s.admission_no, s.lifecycle_status,
                -- Name parts, not a concatenation. A public API that ships
                -- "full_name" forces every consumer to re-split it, and they all
                -- split it differently.
                p.given_name, p.middle_name, p.family_name, p.preferred_name,
                s.id::text AS cursor
           FROM student s
           JOIN person p ON p.id = s.person_id
          -- Note what is NOT selected: blood_group, medical_note and
          -- accommodations sit on this table and are nobody's integration's
          -- business. A star-select here would ship a child's medical note to
          -- an accounting package.
          WHERE p.deleted_at IS NULL AND s.deleted_at IS NULL
            AND ($1::uuid IS NULL OR s.id > $1)
          ORDER BY s.id
          LIMIT $2`,
        [cursor ?? null, limit]);
      return {
        data: rows,
        next_cursor: rows.length === limit ? rows[rows.length - 1]!['cursor'] : null,
      };
    });
  }

  @Get('invoices')
  @ApiScopes('invoices:read')
  async invoices(@Query() query: unknown) {
    const parsed = page.safeParse(query);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    const { limit, cursor } = parsed.data;

    return withTenant(currentScope(), async (db) => {
      const { rows } = await db.query(
        `SELECT i.id, i.invoice_no, i.enrollment_id, i.status,
                i.due_on::text AS due_on,
                -- Rupees as a fixed-scale string, exactly as the ledger stores
                -- them. A JSON number is an IEEE double, and a fee that has been
                -- through one is no longer the amount owed.
                i.total::text AS total, i.amount_paid::text AS amount_paid,
                i.id::text AS cursor
           FROM invoice i
          WHERE ($1::uuid IS NULL OR i.id > $1)
          ORDER BY i.id
          LIMIT $2`,
        [cursor ?? null, limit]);
      return {
        data: rows,
        next_cursor: rows.length === limit ? rows[rows.length - 1]!['cursor'] : null,
      };
    });
  }

  @Get('attendance')
  @ApiScopes('attendance:read')
  async attendance(@Query() query: unknown) {
    const parsed = page.safeParse(query);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    return listPage(
      `SELECT r.id, r.attendance_session_id, r.enrollment_id, r.state,
              r.minutes_late, r.recorded_at,
              s.session_date::text AS session_date,
              r.id::text AS cursor
         FROM attendance_record r
         JOIN attendance_session s ON s.id = r.attendance_session_id
        WHERE ($1::uuid IS NULL OR r.id > $1)
        ORDER BY r.id
        LIMIT $2`,
      parsed.data.cursor ?? null, parsed.data.limit);
  }

  @Get('payments')
  @ApiScopes('payments:read')
  async payments(@Query() query: unknown) {
    const parsed = page.safeParse(query);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    return listPage(
      `SELECT p.id, p.target_invoice_id, p.method, p.status,
              p.provider, p.provider_payment_id,
              p.received_on::text AS received_on,
              -- Exact, as a string. Reconciliation is the whole reason an
              -- accounting system calls this endpoint.
              p.amount::text AS amount,
              p.id::text AS cursor
         FROM payment p
        WHERE ($1::uuid IS NULL OR p.id > $1)
        ORDER BY p.id
        LIMIT $2`,
      parsed.data.cursor ?? null, parsed.data.limit);
  }

  @Get('results')
  @ApiScopes('results:read')
  async results(@Query() query: unknown) {
    const parsed = page.safeParse(query);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    // Published lines only, and that is the policy's doing rather than this
    // query's: an unreviewed result reaching a parent's app through an
    // integration would be the same harm as publishing it by mistake.
    return listPage(
      `SELECT l.id, l.result_run_id, l.enrollment_id, l.course_offering_id,
              l.obtained::text AS obtained, l.maximum::text AS maximum,
              l.percentage::text AS percentage,
              l.is_pass, l.grade_label, l.not_graded_reason,
              l.id::text AS cursor
         FROM result_line l
        WHERE ($1::uuid IS NULL OR l.id > $1)
        ORDER BY l.id
        LIMIT $2`,
      parsed.data.cursor ?? null, parsed.data.limit);
  }

  @Get('webhooks/deliveries')
  @ApiScopes('webhooks:read')
  async deliveries(@Query() query: unknown) {
    const parsed = page.safeParse(query);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    // So an integrator can reconcile what we say we sent against what they
    // received, without asking us.
    return listPage(
      `SELECT d.id, d.webhook_endpoint_id, d.event_type, d.status,
              d.attempt_count, d.last_error,
              d.succeeded_at, d.created_at,
              d.id::text AS cursor
         FROM webhook_delivery d
        WHERE ($1::uuid IS NULL OR d.id > $1)
        ORDER BY d.id
        LIMIT $2`,
      parsed.data.cursor ?? null, parsed.data.limit);
  }

  @Post('attendance/marks')
  @ApiScopes('attendance:write')
  async mark(
    @Body() body: unknown,
    @Headers('idempotency-key') idemKey: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!idemKey || idemKey.length < 8 || idemKey.length > 255) {
      throw ApiError.make('validation_error', 'idempotency_key_required',
        'Every write to this API needs an Idempotency-Key header of 8–255 ' +
        'characters, unique per request.');
    }
    const parsed = markAttendance.safeParse(body);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);

    const scope = currentScope();
    const apiClientId = getContext()!.apiClientId!;
    // The digest is over the body EXACTLY as the client sent it, reconstructed
    // here from the parsed value. Reconstruction is a compromise: two clients
    // sending semantically identical but differently-formatted JSON would get
    // the same digest, which is the safe direction — they would replay rather
    // than double-write.
    const rawBody = JSON.stringify(parsed.data);

    const claim = await idempotencyService.begin(scope, {
      apiClientId, key: idemKey,
      method: 'POST', path: '/api/v1/attendance/marks', rawBody,
    });

    if (claim.kind === 'replay') {
      res.status(claim.statusCode);
      // Stated in a header so a client can tell a replay from a first run
      // without diffing the body — which is what you want when debugging why a
      // retry "did nothing".
      res.setHeader('idempotent-replay', 'true');
      return claim.body;
    }

    try {
      const result = await attendanceService.sync(scope, {
        sessionId: parsed.data.sessionId,
        records: parsed.data.marks.map((m) => ({
          clientEventId: m.clientEventId,
          studentId: m.studentId,
          state: m.state,
          ...(m.minutesLate === undefined ? {} : { minutesLate: m.minutesLate }),
        })),
      });
      const payload = { data: result };
      await idempotencyService.complete(scope, claim.recordId, 201, payload);
      res.status(201);
      return payload;
    } catch (error) {
      // The claim is released so the client's retry can proceed. Leaving it
      // in_flight would turn one transient failure into twenty-four hours of
      // "still being processed" for a key they will keep reusing.
      await idempotencyService.abandon(scope, claim.recordId);
      throw error;
    }
  }
}
