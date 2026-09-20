/**
 * Custom domains, from the console (M35.2).
 *
 * `domainService` had four methods and no caller anywhere. The school-facing
 * controller's own hint said what was supposed to happen — *"Ask us to add a
 * domain you own — we will give you a DNS record to publish, and nothing routes
 * until it is there"* — and there was no way for anybody here to be asked.
 *
 * On the platform console rather than in the school's settings, and that is the
 * design rather than an accident of where the code ended up: these run on the
 * platform pool, they cross tenants, and adding a hostname is the one operation
 * in this product where getting it wrong means serving one school's sign-in
 * page on another school's domain. The verification step is what makes that
 * safe, and it is not something a school can wave through for itself.
 */
import { Controller, Get, Post, Body, Param, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { Public } from '../auth/public.decorator.ts';
import { PlatformGuard, RequiresCapability } from '../platform/platform.guard.ts';
import { domainService } from './domain.service.ts';
import { getContext } from '../../common/request-context.ts';
import { ApiError } from '../../common/errors.ts';

const uuid = z.string().uuid();

function actor(): string {
  const id = getContext()?.actorId;
  if (!id) throw new Error('No actor; PlatformGuard should have refused this.');
  return id;
}

@Public()
@UseGuards(PlatformGuard)
@Controller('platform/v1/domains')
export class DomainController {
  /** Every domain in the estate, verified or not. */
  @Get()
  @RequiresCapability('provision')
  async list() {
    return { data: await domainService.listAll() };
  }

  /**
   * Adding one, which does not route anything yet.
   *
   * The response carries the DNS record the school has to publish. Until it is
   * there and `verify` has seen it, the hostname resolves to nobody — which is
   * the whole protection: an unverified domain is a claim, not a route.
   */
  @Post()
  @RequiresCapability('provision')
  async add(@Body() body: unknown) {
    const parsed = z.object({
      tenantId: uuid,
      host: z.string().min(3).max(253),
    }).safeParse(body);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    return {
      data: await domainService.addCustom(actor(), parsed.data.tenantId, parsed.data.host),
    };
  }

  /**
   * Checking that the record is actually published.
   *
   * A DNS lookup, against the token this system generated. Nothing about this
   * is a formality: it is the step that stops somebody pointing
   * `fees.somebodyelse.edu` at us and collecting a school's sign-ins.
   */
  @Post(':id/verify')
  @RequiresCapability('provision')
  async verify(@Param('id') id: string) {
    const domainId = uuid.safeParse(id);
    if (!domainId.success) throw ApiError.fromZod(domainId.error);
    return { data: await domainService.verify(actor(), domainId.data) };
  }

  /** Which one the school's own links are built from. Verified domains only. */
  @Post(':id/primary')
  @RequiresCapability('provision')
  async primary(@Param('id') id: string) {
    const domainId = uuid.safeParse(id);
    if (!domainId.success) throw ApiError.fromZod(domainId.error);
    await domainService.setPrimary(actor(), domainId.data);
    return { data: { primary: true } };
  }
}
