/**
 * The transport surface (M20.2).
 *
 * Everything here sits behind `@RequiresFeature('transport')`, which is the
 * whole reason this milestone exists: M16 already sold a `transport` flag on
 * the plan, and a gate that guards nothing is a promise on a pricing page.
 *
 * No endpoint here writes a `WHERE` clause that decides who may see a child.
 * That decision lives in 0066's policies — `app_may_see_transport` — because
 * the manifest is the one document in this system that would be most useful to
 * somebody meaning a child harm, and "the controller remembered to filter" is
 * not a sentence a school should have to take on trust.
 */
import { Controller, Get, Post, Body, Param, Query } from '@nestjs/common';
import { z } from 'zod';
import { transportService } from './transport.service.ts';
import { currentScope } from '../../common/scope.ts';
import { ApiError } from '../../common/errors.ts';
import { RequiresFeature } from '../billing-plans/entitlement.guard.ts';

const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const manifestQuery = z.object({
  direction: z.enum(['pickup', 'drop']),
  on: isoDate.optional(),
});

const assignBody = z.object({
  studentId: uuid,
  routeId: uuid,
  stopId: uuid,
  direction: z.enum(['pickup', 'drop', 'both']),
  from: isoDate.optional(),
});

/**
 * A batch, always — even for one event.
 *
 * The device that sends these is a phone on a bus, and the shape that survives
 * a tunnel is "here is everything I have not managed to send yet". An endpoint
 * that takes a single event forces the client to loop, and a client that loops
 * over a flaky link gets a partial result it has no way to interpret.
 */
const boardingBody = z.object({
  events: z.array(z.object({
    clientEventId: uuid,
    studentId: uuid,
    routeId: uuid,
    stopId: uuid.optional(),
    vehicleId: uuid.optional(),
    direction: z.enum(['pickup', 'drop']),
    kind: z.enum(['boarded', 'alighted', 'absent', 'no_show']),
    onDate: isoDate.optional(),
    deviceRecordedAt: z.string().datetime().optional(),
  })).min(1).max(200),
});

@Controller('v1/transport')
@RequiresFeature('transport')
export class TransportController {
  /** The routes the caller may see. Policy decides; this does not filter. */
  @Get('routes')
  async routes() {
    return { data: await transportService.routes(currentScope()) };
  }

  @Get('routes/:routeId/manifest')
  async manifest(@Param('routeId') routeId: string, @Query() query: unknown) {
    const id = uuid.safeParse(routeId);
    if (!id.success) throw ApiError.fromZod(id.error);
    const parsed = manifestQuery.safeParse(query);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    return {
      data: await transportService.manifest(currentScope(), {
        routeId: id.data,
        direction: parsed.data.direction,
        on: parsed.data.on,
      }),
    };
  }

  @Post('enrolments')
  async assign(@Body() body: unknown) {
    const parsed = assignBody.safeParse(body);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    await transportService.assignChild(currentScope(), parsed.data);
    return { data: { assigned: true } };
  }

  /**
   * Returns what happened to each event, not just a 201.
   *
   * `replayed` is not an error and must not read like one: a bus coming back
   * into signal replays by design, and a client that treats a replay as a
   * failure will retry forever.
   */
  @Post('boardings')
  async boardings(@Body() body: unknown) {
    const parsed = boardingBody.safeParse(body);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    return {
      data: await transportService.recordBoarding(
        currentScope(), parsed.data.events),
    };
  }

  /** What a guardian opens: their child's bus, stop and time. */
  @Get('students/:studentId')
  async forChild(@Param('studentId') studentId: string) {
    const id = uuid.safeParse(studentId);
    if (!id.success) throw ApiError.fromZod(id.error);
    return { data: await transportService.forChild(currentScope(), id.data) };
  }

  @Get('compliance')
  async compliance(@Query('withinDays') withinDays?: string) {
    const parsed = z.coerce.number().int().min(0).max(365).default(45)
      .safeParse(withinDays ?? undefined);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    return {
      data: await transportService.complianceDue(currentScope(), parsed.data),
    };
  }
}
