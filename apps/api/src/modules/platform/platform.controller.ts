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
import { catalogueService } from '../billing-plans/catalogue.service.ts';
import { subscriptionService } from '../billing-plans/subscription.service.ts';
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

const METRICS = ['learners', 'staff', 'campuses', 'messages_per_month', 'storage_mb'] as const;
const FEATURES = ['transport', 'hr', 'lms', 'public_api', 'whatsapp',
                  'advanced_reports'] as const;

/** Paise as a decimal string. Never a JSON number — see the money rules. */
const money = z.string().regex(/^\d{1,12}(\.\d{1,2})?$/,
  'An amount in paise, as a string. A price that has been through a float is not a price.');

const planInput = z.object({
  code: z.string().regex(/^[a-z][a-z0-9_]{1,30}$/),
  name: z.string().min(1).max(120),
  isPublic: z.boolean().optional(),
});

const versionInput = z.object({
  planCode: z.string().min(1).max(32),
  priceMonthly: money,
  priceAnnual: money,
  note: z.string().max(300).optional(),
});

const termsInput = z.object({
  limits: z.array(z.object({
    metric: z.enum(METRICS),
    included: z.number().int().min(0),
    hardCap: z.number().int().min(0).nullable(),
  })).max(20),
  features: z.array(z.object({
    feature: z.enum(FEATURES),
    enabled: z.boolean(),
  })).max(20),
});

const subscribeInput = z.object({
  tenantId: z.string().uuid(),
  planVersionId: z.string().uuid(),
  billingPeriod: z.enum(['monthly', 'annual']).optional(),
  trialDays: z.number().int().min(0).max(120).optional(),
});

const moveInput = z.object({
  tenantId: z.string().uuid(),
  planVersionId: z.string().uuid(),
  reason: z.string().min(5).max(300),
});

const statusInput = z.object({
  tenantId: z.string().uuid(),
  status: z.enum(['trialing', 'active', 'past_due', 'read_only', 'ended']),
  reason: z.string().min(3).max(300),
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

  // -------------------------------------------------------------------------
  // Plans and subscriptions (M16)
  // -------------------------------------------------------------------------

  @Get('plans')
  @RequiresCapability('billing')
  async plans() {
    return { data: await catalogueService.list() };
  }

  @Post('plans')
  @RequiresCapability('billing')
  async createPlan(@Body() body: unknown) {
    const parsed = planInput.safeParse(body);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    return { data: await catalogueService.createPlan(actor(), parsed.data) };
  }

  @Post('plans/versions')
  @RequiresCapability('billing')
  async draftVersion(@Body() body: unknown) {
    const parsed = versionInput.safeParse(body);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    const { planCode, ...rest } = parsed.data;
    return {
      data: await catalogueService.draftVersion(actor(), planCode, rest),
      notice: 'A draft. Set its terms, then publish — after that the terms are '
        + 'what every school on it agreed to and cannot be edited.',
    };
  }

  @Post('plans/versions/:id/terms')
  @RequiresCapability('billing')
  async setTerms(@Param('id') id: string, @Body() body: unknown) {
    const parsed = termsInput.safeParse(body);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    await catalogueService.setTerms(actor(), id, parsed.data);
    return { data: { status: 'set' } };
  }

  @Post('plans/versions/:id/publish')
  @RequiresCapability('billing')
  async publishVersion(@Param('id') id: string) {
    await catalogueService.publish(actor(), id);
    return { data: { status: 'published' } };
  }

  @Post('plans/versions/:id/retire')
  @RequiresCapability('billing')
  async retireVersion(@Param('id') id: string) {
    await catalogueService.retire(actor(), id);
    return {
      data: { status: 'retired' },
      notice: 'No new subscribers. Every school already on it stays on it at '
        + 'their price until somebody moves them deliberately.',
    };
  }

  @Post('subscriptions')
  @RequiresCapability('billing')
  async subscribe(@Body() body: unknown) {
    const parsed = subscribeInput.safeParse(body);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    return { data: await subscriptionService.subscribe(actor(), parsed.data) };
  }

  @Post('subscriptions/move')
  @RequiresCapability('billing')
  async moveSubscription(@Body() body: unknown) {
    const parsed = moveInput.safeParse(body);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    return { data: await subscriptionService.moveToVersion(actor(), parsed.data) };
  }

  @Post('subscriptions/status')
  @RequiresCapability('billing')
  async setSubscriptionStatus(@Body() body: unknown) {
    const parsed = statusInput.safeParse(body);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    return { data: await subscriptionService.setStatus(actor(), parsed.data) };
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
