import { Controller, Get, Query } from '@nestjs/common';
import { z } from 'zod';
import { dashboardService } from './dashboard.service.ts';
import { currentScope, currentRoles } from '../../common/scope.ts';
import { getContext } from '../../common/request-context.ts';
import { ApiError } from '../../common/errors.ts';

const dateSchema = z.object({
  on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

@Controller('v1')
export class ReportingController {
  /**
   * Who the caller is, as far as this request is concerned.
   *
   * The UI uses it to decide what to show. It is deliberately derived from the
   * verified token's context rather than from anything the client sent, so a
   * client that lies about its role gets a differently-shaped screen and exactly
   * the same database answers.
   */
  @Get('me')
  me() {
    const scope = currentScope();
    const ctx = getContext();
    return {
      data: {
        tenantId: scope.tenantId,
        actorId: scope.actorId,
        roles: currentRoles(),
        // Present only inside an entry session (M15.3). The web shell draws a
        // banner from it that cannot be dismissed, because the alternative —
        // a support agent forgetting whose screen they are on and typing into
        // a real school — is a whole class of incident that is avoidable with
        // a strip of colour.
        ...(ctx?.impersonationId
          ? {
              impersonation: {
                id: ctx.impersonationId,
                writeEnabled: ctx.impersonationWriteEnabled === true,
              },
            }
          : {}),
      },
    };
  }

  @Get('dashboard')
  async dashboard(@Query() query: unknown) {
    const parsed = dateSchema.safeParse(query);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    return { data: await dashboardService.groupFigures(currentScope(), parsed.data.on) };
  }

  @Get('dashboard/trend')
  async trend(@Query() query: unknown) {
    const parsed = z.object({
      on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      days: z.coerce.number().int().min(7).max(180).default(30),
    }).safeParse(query);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    return {
      data: await dashboardService.trend(
        currentScope(), parsed.data.days, parsed.data.on),
    };
  }

  @Get('dashboard/today')
  async today(@Query() query: unknown) {
    const parsed = dateSchema.safeParse(query);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    return { data: await dashboardService.todayFor(currentScope(), parsed.data.on) };
  }
}
