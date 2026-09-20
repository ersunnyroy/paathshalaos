/**
 * The HR surface (M32.1).
 *
 * M27 shipped this module's schema, its service and twenty-eight tests, and no
 * way for anybody to reach any of it: `src/modules/hr` contained one file, no
 * controller, and nothing in `app.module.ts`. It was, on paper, done. A school
 * could not file a single day's sick leave.
 *
 * That is the same failure as a plan flag that guards nothing, arriving from
 * the other direction — a module with nothing in front of it rather than a
 * gate with nothing behind it — and it is why `@RequiresFeature('hr')` is on
 * this class. Until now the `hr` flag was sold by M16, read by nothing, and
 * enforced nowhere.
 *
 * The decision that is NOT here: none of these endpoints take a staff id for
 * "who is asking". Cover is resolved through `app_current_staff_id()` in the
 * database, so a client cannot assign itself somebody else's classroom by
 * sending a different id.
 */
import { Controller, Get, Post, Body, Query } from '@nestjs/common';
import { z } from 'zod';
import { hrService } from './hr.service.ts';
import { currentScope } from '../../common/scope.ts';
import { ApiError } from '../../common/errors.ts';
import { RequiresFeature } from '../billing-plans/entitlement.guard.ts';

const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const absenceBody = z.object({
  staffId: uuid,
  leaveTypeId: uuid.optional(),
  startsOn: isoDate,
  endsOn: isoDate,
  halfDay: z.boolean().optional(),
  reason: z.string().max(2000).optional(),
});

const decisionBody = z.object({
  absenceId: uuid,
  approve: z.boolean(),
  note: z.string().max(2000).optional(),
});

const coverBody = z.object({
  sectionId: uuid,
  coveringStaffId: uuid,
  onDate: isoDate,
  absentStaffId: uuid.optional(),
  staffAbsenceId: uuid.optional(),
  periodNo: z.number().int().min(1).max(20).optional(),
  note: z.string().max(2000).optional(),
});

const windowQuery = z.object({
  from: isoDate,
  to: isoDate,
  status: z.enum(['requested', 'approved', 'refused', 'cancelled']).optional(),
});

/**
 * A window, defaulted rather than required.
 *
 * The payroll and absence screens both open on "this month" and a required
 * date pair makes the first render a validation error. The default is the
 * Indian financial month, not a rolling thirty days, because that is what the
 * number is reconciled against.
 */
function monthWindow(): { from: string; to: string } {
  const now = new Date();
  const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const last = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0));
  return { from: first.toISOString().slice(0, 10), to: last.toISOString().slice(0, 10) };
}

@Controller('v1/hr')
@RequiresFeature('hr')
export class HrController {
  @Get('staff')
  async staff(@Query('on') on?: string) {
    const parsed = isoDate.optional().safeParse(on ?? undefined);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    return { data: await hrService.roster(currentScope(), { on: parsed.data }) };
  }

  @Get('leave-types')
  async leaveTypes() {
    return { data: await hrService.leaveTypes(currentScope()) };
  }

  @Get('absences')
  async absences(@Query() query: unknown) {
    const raw = (query ?? {}) as Record<string, unknown>;
    const parsed = windowQuery.safeParse({ ...monthWindow(), ...raw });
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    return { data: await hrService.absences(currentScope(), parsed.data) };
  }

  @Post('absences')
  async fileAbsence(@Body() body: unknown) {
    const parsed = absenceBody.safeParse(body);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    return { data: await hrService.fileAbsence(currentScope(), parsed.data) };
  }

  @Post('absences/decide')
  async decide(@Body() body: unknown) {
    const parsed = decisionBody.safeParse(body);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    await hrService.decideAbsence(currentScope(), parsed.data);
    return { data: { decided: true } };
  }

  /** Who is away on a day, and what cover already exists for it. */
  @Get('cover')
  async cover(@Query('on') on?: string) {
    const parsed = isoDate.optional().safeParse(on ?? undefined);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    const day = parsed.data ?? new Date().toISOString().slice(0, 10);
    const scope = currentScope();
    return {
      data: {
        on: day,
        absent: await hrService.absentOn(scope, day),
        assigned: await hrService.coverOn(scope, day),
      },
    };
  }

  @Post('cover')
  async assignCover(@Body() body: unknown) {
    const parsed = coverBody.safeParse(body);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    return { data: await hrService.assignCover(currentScope(), parsed.data) };
  }

  /** What the caller themselves is standing in front of today. */
  @Get('cover/mine')
  async mine() {
    return { data: await hrService.myCoverToday(currentScope()) };
  }

  /**
   * Payroll INPUTS. Not payroll.
   *
   * M27 stopped here on purpose and this endpoint does not move the line:
   * statutory deductions, PF, ESI and TDS are a compliance product, and a
   * guess at them is worse than their absence. What comes back is days —
   * employed, paid leave, unpaid leave — for somebody else's payroll run.
   */
  @Get('payroll-inputs')
  async payroll(@Query() query: unknown) {
    const raw = (query ?? {}) as Record<string, unknown>;
    const parsed = z.object({ from: isoDate, to: isoDate })
      .safeParse({ ...monthWindow(), ...raw });
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    return { data: await hrService.payrollInputs(currentScope(), parsed.data) };
  }
}
