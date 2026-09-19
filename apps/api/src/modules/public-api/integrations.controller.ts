/**
 * The screens an institute uses to manage its own integrations.
 *
 * Session-authenticated (the global AuthGuard), ORG_OWNER-gated by the policies
 * in 0039 rather than by a check written here. A secret appears in exactly two
 * responses on this controller — the creation of a key and the creation or
 * rotation of an endpoint — and in each case the response says so, because a
 * value you can only see once should announce itself.
 */
import { Controller, Get, Post, Delete, Body, Param, Query } from '@nestjs/common';
import { z } from 'zod';
import { currentScope } from '../../common/scope.ts';
import { ApiError } from '../../common/errors.ts';
import { apiKeyService } from './api-key.service.ts';
import { webhookService } from '../webhooks/webhook.service.ts';

const SCOPES = [
  'students:read', 'attendance:read', 'attendance:write',
  'invoices:read', 'payments:read', 'results:read', 'webhooks:read',
] as const;

const createClient = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  scopes: z.array(z.enum(SCOPES)).min(1),
  ratePerMin: z.number().int().min(1).max(6000).optional(),
});

const issueKey = z.object({
  clientId: z.string().uuid(),
  label: z.string().max(120).optional(),
  expiresAt: z.string().datetime().optional(),
  live: z.boolean().optional(),
});

const createEndpoint = z.object({
  url: z.string().url(),
  eventTypes: z.array(z.string().min(1)).min(1),
  description: z.string().max(500).optional(),
});

@Controller('v1/integrations')
export class IntegrationsController {
  @Get('clients')
  async clients() {
    return { data: await apiKeyService.listClients(currentScope()) };
  }

  @Post('clients')
  async addClient(@Body() body: unknown) {
    const parsed = createClient.safeParse(body);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    return { data: await apiKeyService.createClient(currentScope(), parsed.data) };
  }

  @Get('keys')
  async keys() {
    return { data: await apiKeyService.listKeys(currentScope()) };
  }

  @Post('keys')
  async addKey(@Body() body: unknown) {
    const parsed = issueKey.safeParse(body);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    const key = await apiKeyService.issueKey(currentScope(), parsed.data);
    return {
      data: key,
      notice: 'This is the only time the key is shown. Store it now; ' +
              'if it is lost, revoke it and issue another.',
    };
  }

  @Delete('keys/:id')
  async revokeKey(@Param('id') id: string) {
    await apiKeyService.revokeKey(currentScope(), id);
    return { data: { revoked: true } };
  }

  @Get('webhooks')
  async endpoints() {
    return { data: await webhookService.listEndpoints(currentScope()) };
  }

  @Post('webhooks')
  async addEndpoint(@Body() body: unknown) {
    const parsed = createEndpoint.safeParse(body);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    const made = await webhookService.createEndpoint(currentScope(), parsed.data);
    return {
      data: made,
      notice: 'This is the only time the signing secret is shown. ' +
              'Use it to verify the signature on every delivery.',
    };
  }

  @Post('webhooks/:id/rotate')
  async rotate(@Param('id') id: string) {
    const rotated = await webhookService.rotateSecret(currentScope(), id);
    return {
      data: rotated,
      notice: 'The previous secret keeps signing alongside this one for 24 hours, ' +
              'so you can update your receiver without downtime.',
    };
  }

  @Post('webhooks/:id/pause')
  async pause(@Param('id') id: string) {
    await webhookService.setStatus(currentScope(), id, 'paused');
    return { data: { status: 'paused' } };
  }

  @Post('webhooks/:id/resume')
  async resume(@Param('id') id: string) {
    await webhookService.setStatus(currentScope(), id, 'active');
    return { data: { status: 'active' } };
  }

  /** AC-10's third clause: the tenant can see what we sent and what came back. */
  @Get('webhooks/deliveries')
  async deliveries(
    @Query('endpointId') endpointId?: string,
    @Query('status') status?: string,
  ) {
    const filter = z.object({
      endpointId: z.string().uuid().optional(),
      status: z.enum(['pending', 'succeeded', 'failed', 'dead']).optional(),
    }).safeParse({ endpointId, status });
    if (!filter.success) throw ApiError.fromZod(filter.error);
    return { data: await webhookService.listDeliveries(currentScope(), filter.data) };
  }

  @Get('webhooks/deliveries/:id/attempts')
  async attempts(@Param('id') id: string) {
    return { data: await webhookService.listAttempts(currentScope(), id) };
  }

  @Post('webhooks/deliveries/:id/replay')
  async replay(@Param('id') id: string) {
    await webhookService.replay(currentScope(), id);
    return { data: { queued: true } };
  }
}
