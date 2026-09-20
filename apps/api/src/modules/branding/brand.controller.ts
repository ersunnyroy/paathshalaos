/**
 * The one endpoint that answers before anybody has signed in.
 *
 * Public by necessity: it is what the sign-in screen calls to find out whose
 * school it is showing. That makes it the most exposed route in the system, so
 * what it returns is deliberately thin — a name, a mark, two colours, a support
 * contact the school chose to publish. Nothing about size, status, payment or
 * people.
 *
 * The host comes from the request, not from a query parameter a caller can set
 * freely — except in development, where the web app runs on localhost and has
 * to be able to say which school it is pretending to be.
 */
import { Controller, Get, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { Public } from '../auth/public.decorator.ts';
import { brandingService } from './branding.service.ts';
import { domainService } from './domain.service.ts';
import { currentScope } from '../../common/scope.ts';

@Controller('v1')
export class BrandController {
  /**
   * @Public because a sign-in screen has no token. The response is the same
   * for everybody who can reach the host, which is anybody at all.
   */
  @Public()
  @Get('brand')
  async brand(@Req() request: Request, @Query('host') hostOverride?: string) {
    // The real Host header wins. `?host=` is only consulted when the request
    // did not arrive on a real tenant host — which is development, where every
    // app runs on localhost.
    const header = request.headers.host ?? '';
    const looksLocal = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(header);
    const host = looksLocal && hostOverride ? hostOverride : header;

    const brand = await brandingService.forHost(host);
    return {
      data: brand,
      notice: brand === null
        ? 'No school is configured for this address.'
        : undefined,
    };
  }
}

/** The school's own settings: its brand, and the addresses that reach it. */
@Controller('v1/branding')
export class BrandingSettingsController {
  @Get()
  async mine() {
    return { data: await brandingService.forTenant(currentScope()) };
  }

  @Get('domains')
  async domains() {
    return {
      data: await domainService.listForTenant(currentScope()),
      notice: 'Ask us to add a domain you own — we will give you a DNS record '
        + 'to publish, and nothing routes until it is there.',
    };
  }
}
