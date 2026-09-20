/**
 * The fee lifecycle (M32.3).
 *
 * M7 built all of this — plans, components, assignment, concessions,
 * instalments, invoices, the ledger — and the product could take a payment
 * against an invoice it had no way to raise. `feePlanService` and
 * `invoiceService` had no caller in `src/` at all.
 *
 * Money is decimal strings on the way in and on the way out, never JSON
 * numbers, and the reason is narrower than the one this comment first gave.
 *
 * It said `12500.10` through a double is 12500.099999999999 and therefore a
 * receipt with the wrong figure on it. The first half is true of a NUMBER in
 * JSON; the second does not follow, because `Math.round(Number(s) * 100)`
 * recovers the exact paise for every amount a school will ever bill. Mutating
 * this conversion to the float path failed no test, which is how the claim got
 * read again — the same shape M21 found in `rupees()`, a real hazard borrowed
 * to justify something that did not need it.
 *
 * And then the honest version, which is narrower still. The two paths first
 * disagree around ₹94,575,592,174,780.41 — and `fee_component.amount` is
 * `numeric(14,2)`, which cannot hold a tenth of that. Postgres refuses the
 * value before either conversion could be wrong about it. So within this
 * schema the float path is not merely adequate, it is indistinguishable, and
 * a test trying to prove otherwise got a numeric overflow rather than a
 * mismatch.
 *
 * The string path stays because it has no rounding step to reason about, and
 * because `numeric(14,2)` is a schema decision that a school with a larger
 * campus could reasonably ask to widen — at which point the conversion would
 * start to matter and nobody would think to look at it. What is asserted in
 * the tests is the boundary that exists: exactness at the largest amount this
 * column can hold.
 *
 * The services take `bigint` paise, so the conversion happens here, once, at
 * the edge.
 *
 * Every endpoint that names a member of staff resolves them from
 * `app_current_staff_id()`. A fee waiver, a voided invoice and a published
 * plan are all documents somebody is answerable for; a client-supplied author
 * is an attribution anybody can change by editing one field.
 */
import { Controller, Get, Post, Body, Param, Query } from '@nestjs/common';
import { z } from 'zod';
import { feePlanService } from './fee-plan.service.ts';
import { invoiceService } from './invoice.service.ts';
import { refundService } from './refund.service.ts';
import { exportService } from './export.service.ts';
import { Money } from './money.ts';
import { withTenant } from '../../db/tenant.ts';
import { currentScope } from '../../common/scope.ts';
import { ApiError } from '../../common/errors.ts';

const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
/** An exact decimal, as a string. See the header. */
const decimal = z.string().regex(/^\d+(\.\d{1,2})?$/);

const planBody = z.object({
  academicUnitId: uuid,
  academicYearId: uuid,
  name: z.string().min(1).max(200),
  programmeId: uuid.optional(),
  components: z.array(z.object({
    code: z.string().min(1).max(40),
    name: z.string().min(1).max(200),
    amount: decimal,
    frequency: z.enum(['one_time', 'monthly', 'term', 'annual']),
    isRefundable: z.boolean().optional(),
    isOptional: z.boolean().optional(),
    taxRate: z.number().min(0).max(100).optional(),
    glCode: z.string().max(40).optional(),
  })).min(1).max(50),
});

const concessionBody = z.object({
  concessionType: z.enum(['sibling', 'staff_ward', 'rte', 'merit', 'need_based',
                          'early_payment', 'custom']),
  mode: z.enum(['percent', 'amount']),
  value: z.union([z.number(), decimal]),
  reason: z.string().min(1).max(2000),
  feeComponentId: uuid.optional(),
});

async function requireStaff(scope: ReturnType<typeof currentScope>): Promise<string> {
  const staffId = await withTenant(scope, async (db) => {
    const { rows } = await db.query<{ staff_id: string | null }>(
      'SELECT app_current_staff_id() AS staff_id');
    return rows[0]?.staff_id ?? undefined;
  });
  if (!staffId) {
    throw ApiError.make('permission_error', 'not_staff',
      'This is recorded against a member of staff, and this account is not '
      + 'linked to one.');
  }
  return staffId;
}

@Controller('v1/fees')
export class BillingController {
  /** The plans a school has, and what each is worth. */
  @Get('plans')
  async plans(@Query('academicYearId') academicYearId?: string) {
    const parsed = uuid.optional().safeParse(academicYearId ?? undefined);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    return {
      data: await withTenant(currentScope(), async (db) => {
        const { rows } = await db.query(
          `SELECT fp.id, fp.name, fp.status, fp.academic_year_id,
                  ay.label AS academic_year,
                  pr.name AS programme_name,
                  (SELECT count(*)::int FROM fee_component fc
                    WHERE fc.fee_plan_id = fp.id) AS component_count,
                  -- Summed as an exact decimal and rendered as a string. A
                  -- SUM() that reaches JavaScript as a number is a fee total
                  -- that has been through a double.
                  -- fee_component has no deleted_at: a component of a
                  -- published plan is frozen, so there is nothing to soft
                  -- delete. Filtering on it was a 500 on the first request.
                  (SELECT COALESCE(sum(fc.amount), 0)::text FROM fee_component fc
                    WHERE fc.fee_plan_id = fp.id AND NOT fc.is_optional) AS total,
                  (SELECT count(*)::int FROM fee_assignment fa
                    WHERE fa.fee_plan_id = fp.id) AS assigned_count
             FROM fee_plan fp
             LEFT JOIN academic_year ay ON ay.id = fp.academic_year_id
             LEFT JOIN programme pr ON pr.id = fp.programme_id
            WHERE fp.deleted_at IS NULL
              AND ($1::uuid IS NULL OR fp.academic_year_id = $1)
            ORDER BY fp.created_at DESC`,
          [parsed.data ?? null]);
        return rows;
      }),
    };
  }

  @Post('plans')
  async createPlan(@Body() body: unknown) {
    const parsed = planBody.safeParse(body);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    const { components, ...rest } = parsed.data;
    return {
      data: await feePlanService.createDraft(currentScope(), {
        ...rest,
        components: components.map((c) => {
          const { amount, ...spec } = c;
          return { ...spec, amountPaise: Money.fromDecimalString(amount) };
        }),
      }),
    };
  }

  /**
   * Draft → published. A plan cannot be assigned before this.
   *
   * Publishing is what freezes the amounts, so it is the moment a school
   * commits to a price. The staff id is resolved, not supplied.
   */
  @Post('plans/:id/publish')
  async publishPlan(@Param('id') id: string) {
    const planId = uuid.safeParse(id);
    if (!planId.success) throw ApiError.fromZod(planId.error);
    const scope = currentScope();
    return {
      data: await feePlanService.publish(scope, planId.data, await requireStaff(scope)),
    };
  }

  /** Puts a learner on a plan. */
  @Post('assignments')
  async assign(@Body() body: unknown) {
    const parsed = z.object({
      enrollmentId: uuid,
      feePlanId: uuid,
      effectiveFrom: isoDate.optional(),
    }).safeParse(body);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    return { data: await feePlanService.assign(currentScope(), parsed.data) };
  }

  /**
   * The dates the money is due on.
   *
   * Supplied rather than generated, because a school's instalment dates are a
   * local decision — three terms, ten months, one payment in April — and a
   * generator that guessed would be wrong for most of them.
   */
  @Post('assignments/:id/installments')
  async schedule(@Param('id') id: string, @Body() body: unknown) {
    const assignmentId = uuid.safeParse(id);
    if (!assignmentId.success) throw ApiError.fromZod(assignmentId.error);
    const parsed = z.object({ dueDates: z.array(isoDate).min(1).max(24) })
      .safeParse(body);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    return {
      data: await feePlanService.scheduleInstallments(currentScope(), {
        feeAssignmentId: assignmentId.data, dueDates: parsed.data.dueDates,
      }),
    };
  }

  @Post('assignments/:id/concessions')
  async grantConcession(@Param('id') id: string, @Body() body: unknown) {
    const assignmentId = uuid.safeParse(id);
    if (!assignmentId.success) throw ApiError.fromZod(assignmentId.error);
    const parsed = concessionBody.safeParse(body);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    const scope = currentScope();
    const { value, mode, ...rest } = parsed.data;
    return {
      data: await feePlanService.grantConcession(scope, {
        ...rest,
        mode,
        feeAssignmentId: assignmentId.data,
        requestedByStaffId: await requireStaff(scope),
        // A percentage is a number; an amount is money and must not become
        // one. Both arrive as the same field and diverge here.
        value: mode === 'percent'
          ? Number(value)
          : Money.fromDecimalString(String(value)),
      }),
    };
  }

  /**
   * A concession is requested by one person and approved by another.
   *
   * That separation is M7's, and it is the only control on giving money away.
   * The approver is the caller, which is what makes it a second person.
   */
  @Post('concessions/:id/approve')
  async approveConcession(@Param('id') id: string) {
    const concessionId = uuid.safeParse(id);
    if (!concessionId.success) throw ApiError.fromZod(concessionId.error);
    const scope = currentScope();
    await feePlanService.approveConcession(scope, concessionId.data,
      await requireStaff(scope));
    return { data: { approved: true } };
  }

  /**
   * Instalments that are due and have no invoice yet.
   *
   * The list the office raises invoices from, and the reason it is a query
   * rather than a job: a school decides when to bill, and a nightly job that
   * issued every invoice the moment it was due would send a January bill on
   * the 1st of January to a school that bills on the 10th.
   */
  @Get('installments')
  async installments(@Query('unbilled') unbilled?: string) {
    return {
      data: await withTenant(currentScope(), async (db) => {
        const { rows } = await db.query(
          `SELECT i.id, i.sequence, i.due_on::text, i.status,
                  i.gross_amount::text, i.concession_amount::text,
                  i.net_amount::text,
                  fa.id AS fee_assignment_id, fa.enrollment_id,
                  p.given_name, p.family_name, st.admission_no,
                  sec.name AS section_name, cg.name AS class_name,
                  inv.id AS invoice_id, inv.invoice_no
             FROM installment i
             JOIN fee_assignment fa ON fa.id = i.fee_assignment_id
             JOIN enrollment e ON e.id = fa.enrollment_id
             JOIN student st ON st.id = e.student_id
             JOIN person p ON p.id = st.person_id
             LEFT JOIN section sec ON sec.id = e.section_id
             LEFT JOIN class_group cg ON cg.id = sec.class_group_id
             LEFT JOIN invoice inv ON inv.installment_id = i.id
                                  AND inv.status <> 'void'
            WHERE ($1::boolean IS NOT TRUE OR inv.id IS NULL)
            ORDER BY i.due_on, p.given_name`,
          [unbilled === 'true']);
        return rows;
      }),
    };
  }

  @Post('invoices')
  async issue(@Body() body: unknown) {
    const parsed = z.object({
      installmentId: uuid,
      campusId: uuid,
      numberPrefix: z.string().max(20).optional(),
      dueOn: isoDate.optional(),
    }).safeParse(body);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    return { data: await invoiceService.issueForInstallment(currentScope(), parsed.data) };
  }

  // ------------------------------------------------------------- refunds
  //
  // `refundService` had no caller in `src/`. Money could come in and never go
  // back out, which for a school means the family who overpaid or withdrew in
  // April gets a cheque written outside the system and a ledger that never
  // knows about it.
  //
  // Requested by one person and approved by another, like a concession and for
  // the same reason: it is the only control on money leaving.

  @Get('refunds')
  async refunds(@Query('status') status?: string) {
    const parsed = z.enum(['requested', 'approved', 'rejected', 'settled'])
      .optional().safeParse(status ?? undefined);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    return {
      data: await withTenant(currentScope(), async (db) => {
        const { rows } = await db.query(
          `SELECT r.id, r.payment_id, r.amount::text, r.reason, r.status,
                  r.created_at, r.approved_at, r.settled_on::text,
                  p.method, p.amount::text AS payment_amount,
                  per.given_name, per.family_name, st.admission_no,
                  rq.id AS requested_by_staff_id,
                  rqp.given_name AS requested_by_name
             FROM refund r
             JOIN payment p ON p.id = r.payment_id
             LEFT JOIN invoice inv ON inv.id = p.target_invoice_id
             LEFT JOIN enrollment e ON e.id = inv.enrollment_id
             LEFT JOIN student st ON st.id = e.student_id
             LEFT JOIN person per ON per.id = st.person_id
             LEFT JOIN staff rq ON rq.id = r.requested_by
             LEFT JOIN person rqp ON rqp.id = rq.person_id
            WHERE ($1::text IS NULL OR r.status = $1)
            ORDER BY r.created_at DESC`,
          [parsed.data ?? null]);
        return rows;
      }),
    };
  }

  @Post('refunds')
  async requestRefund(@Body() body: unknown) {
    const parsed = z.object({
      paymentId: uuid,
      amount: decimal,
      reason: z.string().min(1).max(2000),
      idempotencyKey: z.string().min(8).max(200),
    }).safeParse(body);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    const scope = currentScope();
    return {
      data: await refundService.request(scope, {
        paymentId: parsed.data.paymentId,
        amountMinor: Money.fromDecimalString(parsed.data.amount),
        reason: parsed.data.reason,
        idempotencyKey: parsed.data.idempotencyKey,
        requestedByStaffId: await requireStaff(scope),
      }),
    };
  }

  /** The service refuses the person who asked. That is the whole control. */
  @Post('refunds/:id/approve')
  async approveRefund(@Param('id') id: string) {
    const refundId = uuid.safeParse(id);
    if (!refundId.success) throw ApiError.fromZod(refundId.error);
    const scope = currentScope();
    return {
      data: await refundService.approve(scope, {
        refundId: refundId.data, approverStaffId: await requireStaff(scope),
      }),
    };
  }

  @Post('refunds/:id/reject')
  async rejectRefund(@Param('id') id: string, @Body() body: unknown) {
    const refundId = uuid.safeParse(id);
    if (!refundId.success) throw ApiError.fromZod(refundId.error);
    const parsed = z.object({ reason: z.string().min(1).max(2000) }).safeParse(body);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    const scope = currentScope();
    await refundService.reject(scope, {
      refundId: refundId.data,
      reason: parsed.data.reason,
      rejectedByStaffId: await requireStaff(scope),
    });
    return { data: { rejected: true } };
  }

  /**
   * Settled OUTSIDE this system, and recorded here.
   *
   * There is no gateway (M26), so an approved refund leaves the building as a
   * cheque or a bank transfer somebody makes by hand. This is where that comes
   * back, with the reference, so the ledger closes. Pretending to push the
   * refund to a provider would be the same fiction as a fabricated SMS receipt.
   */
  @Post('refunds/:id/settled')
  async settleRefund(@Param('id') id: string, @Body() body: unknown) {
    const refundId = uuid.safeParse(id);
    if (!refundId.success) throw ApiError.fromZod(refundId.error);
    const parsed = z.object({
      providerRefundId: z.string().min(1).max(200),
      settledOn: isoDate.optional(),
    }).safeParse(body);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    await refundService.markSettled(currentScope(), {
      refundId: refundId.data, ...parsed.data,
    });
    return { data: { settled: true } };
  }

  // ------------------------------------------------------- what the accountant needs
  //
  // `exportService` had no caller either. A school's books are kept in Tally
  // or by an accountant with a spreadsheet, and a fee system that cannot hand
  // either of them a day book is a fee system that gets reconciled by hand
  // every month — which is how the two sets of numbers start to differ.

  @Get('exports/day-book')
  async dayBook(@Query() query: unknown) {
    const parsed = z.object({
      from: isoDate, to: isoDate, campusId: uuid.optional(),
      format: z.enum(['json', 'csv']).default('json'),
    }).safeParse(query ?? {});
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    const { format, ...range } = parsed.data;
    const scope = currentScope();

    if (format === 'csv') {
      return { data: await exportService.dayBookCsv(scope, range) };
    }
    return { data: await withTenant(scope, (db) => exportService.dayBook(db, range)) };
  }

  /**
   * Tally XML, which is what an Indian school's accountant actually imports.
   *
   * `companyName` has to be the name of the company in THEIR Tally file, not
   * the school's name in this system: Tally matches on it, and a mismatch
   * imports nothing with no error anybody can see.
   */
  @Get('exports/tally')
  async tally(@Query() query: unknown) {
    const parsed = z.object({
      from: isoDate, to: isoDate, campusId: uuid.optional(),
      companyName: z.string().min(1).max(200),
    }).safeParse(query ?? {});
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    return { data: await exportService.tallyXml(currentScope(), parsed.data) };
  }

  /**
   * Voided, never deleted, and never without a reason.
   *
   * An invoice that was issued and then withdrawn is part of the record a
   * school shows an auditor. Deleting it makes the numbering lie.
   */
  @Post('invoices/:id/void')
  async voidInvoice(@Param('id') id: string, @Body() body: unknown) {
    const invoiceId = uuid.safeParse(id);
    if (!invoiceId.success) throw ApiError.fromZod(invoiceId.error);
    const parsed = z.object({ reason: z.string().min(1).max(2000) }).safeParse(body);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    const scope = currentScope();
    await invoiceService.void(scope, {
      invoiceId: invoiceId.data,
      reason: parsed.data.reason,
      voidedByStaffId: await requireStaff(scope),
    });
    return { data: { voided: true } };
  }
}
