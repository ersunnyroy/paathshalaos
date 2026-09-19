/**
 * The platform console's HTTP surface.
 *
 * Mounted under `/platform/v1` rather than `/v1`, so a reverse proxy can refuse
 * it from the public internet with one rule. Nothing here is reachable with a
 * tenant's token: the guard checks `platform_admin`, which no role grant can
 * confer.
 */
import { Controller, Get, Post, Body, Param, Query, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { Public } from '../auth/public.decorator.ts';
import { NoCapabilityNeeded } from './platform.guard.ts';
import { PlatformGuard, RequiresCapability } from './platform.guard.ts';
import { provisioningService } from './provisioning.service.ts';
import { platformAdminService } from './platform-admin.service.ts';
import { entryService } from './entry.service.ts';
import { consoleService } from './console.service.ts';
import { platformAuthService } from './platform-auth.service.ts';
import { getContext } from '../../common/request-context.ts';
import { ApiError } from '../../common/errors.ts';

const provision = z.object({
  requestKey: z.string().min(8).max(200),
  legalName: z.string().min(1).max(200),
  displayName: z.string().min(1).max(120),
  ownerEmail: z.string().email(),
  campusName: z.string().min(1).max(120),
  campusCode: z.string().regex(/^[A-Z0-9][A-Z0-9-]{1,30}$/,
    'Uppercase letters, digits and hyphens — it appears in receipt numbers.'),
  boardOrAffiliation: z.string().max(80).optional(),
  timezone: z.string().max(60).optional(),
});

const credentials = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(200),
});

const entry = z.object({
  tenantId: z.string().uuid(),
  targetUserId: z.string().uuid(),
  assumedRole: z.string().min(1).max(40).optional(),
  write: z.boolean().optional(),
  // The floor is a sentence, not a word. This text is what the school reads.
  reason: z.string().min(10).max(500),
  minutes: z.number().int().min(5).max(60).optional(),
});

const capability = z.object({
  userId: z.string().uuid(),
  capability: z.enum([
    'provision', 'support', 'billing', 'impersonate', 'impersonate_write', 'superadmin',
  ]),
  note: z.string().max(300).optional(),
});

function actor(): string {
  const id = getContext()?.actorId;
  if (!id) throw new Error('No actor; PlatformGuard should have refused this.');
  return id;
}

/** @Public() removes the SESSION guard; PlatformGuard replaces it. */
@Public()
@UseGuards(PlatformGuard)
@Controller('platform/v1')
export class PlatformController {
  /**
   * The console's own front door.
   *
   * Outside the capability check — it is how you get a token in the first place
   * — but not outside the credential check, which is the same one the tenant
   * login uses, lockout counter included.
   */
  @Post('login')
  @NoCapabilityNeeded()
  async login(@Body() body: unknown, @Req() request: { ip?: string }) {
    const parsed = credentials.safeParse(body);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    return {
      data: await platformAuthService.login({
        email: parsed.data.email, password: parsed.data.password, ip: request.ip,
      }),
    };
  }

  @Get('tenants')
  @RequiresCapability('provision')
  async tenants() {
    return { data: await provisioningService.listTenants() };
  }

  @Post('tenants')
  @RequiresCapability('provision')
  async createTenant(@Body() body: unknown) {
    const parsed = provision.safeParse(body);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);

    const result = await provisioningService.provision(actor(), parsed.data);
    return {
      data: result,
      notice: result.created
        ? 'The temporary password is shown once. Give it to the owner directly — '
          + 'not by email to the address it unlocks — and have them change it.'
        : 'This request key was already used. Returning the school it created; '
          + 'no second one was made and no new password was issued.',
    };
  }

  @Post('tenants/:id/suspend')
  @RequiresCapability('provision')
  async suspend(@Param('id') id: string) {
    await provisioningService.setStatus(actor(), id, 'suspended');
    return { data: { status: 'suspended' } };
  }

  @Post('tenants/:id/resume')
  @RequiresCapability('provision')
  async resume(@Param('id') id: string) {
    await provisioningService.setStatus(actor(), id, 'active');
    return { data: { status: 'active' } };
  }

  // -------------------------------------------------------------------------
  // Finding things without entering (M15.4, M15.5)
  // -------------------------------------------------------------------------

  @Get('search')
  @RequiresCapability('support')
  async search(@Query('q') q: string) {
    return { data: await consoleService.search(q ?? '') };
  }

  @Get('health')
  @RequiresCapability('support')
  async health() {
    return { data: await consoleService.health() };
  }

  /** The people you could enter a school as. Emails and roles, nothing more. */
  @Get('tenants/:id/people')
  @RequiresCapability('impersonate')
  async people(@Param('id') id: string, @Query('role') role?: string) {
    return { data: await consoleService.peopleIn(id, role) };
  }

  // -------------------------------------------------------------------------
  // Entering a school (M15)
  // -------------------------------------------------------------------------

  @Post('enter')
  @RequiresCapability('impersonate')
  async enter(@Body() body: unknown) {
    const parsed = entry.safeParse(body);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);

    const session = await entryService.enter(actor(), parsed.data);
    return {
      data: session,
      notice: session.writeEnabled
        ? 'You can change records in this school. Everything you do carries your '
          + 'name and theirs, and the school sees it as it happens.'
        : 'Read-only. The school has been told you are here and their owner can '
          + 'end this session at any time.',
    };
  }

  @Post('leave/:id')
  @RequiresCapability('impersonate')
  async leave(@Param('id') id: string) {
    await entryService.leave(actor(), id);
    return { data: { status: 'left' } };
  }

  /** The console's own record: who has been where, most recent first. */
  @Get('sessions')
  @RequiresCapability('impersonate')
  async sessions() {
    return { data: await entryService.recent() };
  }

  @Get('admins')
  @RequiresCapability('provision')
  async admins() {
    return { data: await platformAdminService.list() };
  }

  @Post('admins')
  @RequiresCapability('provision')
  async grant(@Body() body: unknown) {
    const parsed = capability.safeParse(body);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    await platformAdminService.grant(
      actor(), parsed.data.userId, parsed.data.capability, parsed.data.note);
    return { data: { granted: parsed.data.capability } };
  }

  @Post('admins/revoke')
  @RequiresCapability('provision')
  async revoke(@Body() body: unknown) {
    const parsed = capability.safeParse(body);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    await platformAdminService.revoke(actor(), parsed.data.userId, parsed.data.capability);
    return { data: { revoked: parsed.data.capability } };
  }
}
