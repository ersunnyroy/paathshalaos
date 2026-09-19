/**
 * Support, help and guided setup over HTTP.
 *
 * Session-authenticated. Nothing here checks a role: which tickets come back,
 * whether an internal note is visible, and whether a draft article is readable
 * are all decided by the policies in 0043. A guardian and a support agent call
 * the same endpoints and get different rows.
 */
import { Controller, Get, Post, Body, Param, Query } from '@nestjs/common';
import { z } from 'zod';
import { currentScope } from '../../common/scope.ts';
import { ApiError } from '../../common/errors.ts';
import { ticketService } from './ticket.service.ts';
import { kbService } from './kb.service.ts';
import { onboardingService } from './onboarding.service.ts';

const raise = z.object({
  subject: z.string().min(1).max(200),
  body: z.string().min(1).max(10_000),
  category: z.enum(['fees_and_payments', 'attendance', 'results', 'admissions',
                    'app_or_login', 'data_correction', 'other']),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
  raisedByPersonId: z.string().uuid().optional(),
});

const reply = z.object({
  body: z.string().min(1).max(10_000),
  internal: z.boolean().optional(),
});

const status = z.object({
  status: z.enum(['open', 'waiting_on_requester', 'resolved', 'closed']),
});

const article = z.object({
  slug: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(100_000),
  audience: z.enum(['everyone', 'staff', 'guardians']).optional(),
  category: z.string().max(80).optional(),
});

@Controller('v1')
export class SupportController {
  /* ------------------------------------------------------------- tickets */

  @Get('tickets')
  async tickets(@Query('status') s?: string, @Query('mine') mine?: string) {
    const parsed = z.object({
      status: z.enum(['open', 'waiting_on_requester', 'resolved', 'closed']).optional(),
      mine: z.enum(['true', 'false']).optional(),
    }).safeParse({ status: s, mine });
    if (!parsed.success) throw ApiError.fromZod(parsed.error);

    return {
      data: await ticketService.list(currentScope(), {
        ...(parsed.data.status ? { status: parsed.data.status } : {}),
        ...(parsed.data.mine === 'true' ? { mine: true } : {}),
      }),
    };
  }

  @Post('tickets')
  async raiseTicket(@Body() body: unknown) {
    const parsed = raise.safeParse(body);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    return { data: await ticketService.raise(currentScope(), parsed.data) };
  }

  @Get('tickets/breaches')
  async breaches() {
    return { data: await ticketService.breaches(currentScope()) };
  }

  @Get('tickets/:id')
  async ticket(@Param('id') id: string) {
    return { data: await ticketService.get(currentScope(), id) };
  }

  @Get('tickets/:id/thread')
  async thread(@Param('id') id: string) {
    return { data: await ticketService.thread(currentScope(), id) };
  }

  @Post('tickets/:id/reply')
  async replyTo(@Param('id') id: string, @Body() body: unknown) {
    const parsed = reply.safeParse(body);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    await ticketService.reply(currentScope(), { ticketId: id, ...parsed.data });
    return { data: { posted: true } };
  }

  @Post('tickets/:id/status')
  async setStatus(@Param('id') id: string, @Body() body: unknown) {
    const parsed = status.safeParse(body);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    await ticketService.setStatus(currentScope(), id, parsed.data.status);
    return { data: { status: parsed.data.status } };
  }

  /* ---------------------------------------------------------------- help */

  @Get('help')
  async help(@Query('q') q?: string) {
    return { data: await kbService.search(currentScope(), q ?? '') };
  }

  @Get('help/:slug')
  async articleBySlug(@Param('slug') slug: string) {
    return { data: await kbService.bySlug(currentScope(), slug) };
  }

  @Post('help')
  async createArticle(@Body() body: unknown) {
    const parsed = article.safeParse(body);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    return { data: await kbService.create(currentScope(), parsed.data) };
  }

  @Post('help/:id/publish')
  async publish(@Param('id') id: string, @Body() body: unknown) {
    const parsed = z.object({ version: z.number().int().min(1) }).safeParse(body);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    await kbService.publish(currentScope(), id, parsed.data.version);
    return { data: { published: parsed.data.version } };
  }

  /* -------------------------------------------------------------- setup */

  @Get('setup')
  async setup() {
    const scope = currentScope();
    const [state, next] = await Promise.all([
      onboardingService.steps(scope),
      onboardingService.nextStep(scope),
    ]);
    return { data: { ...state, next } };
  }
}
