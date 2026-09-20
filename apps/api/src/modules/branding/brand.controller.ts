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

/** `https://stjosephs.paathshala.app:443` to `stjosephs.paathshala.app`. */
function hostFromOrigin(origin: string): string {
  try {
    return new URL(origin).hostname;
  } catch {
    return '';
  }
}

@Controller('v1')
export class BrandController {
  /**
   * @Public because a sign-in screen has no token. The response is the same
   * for everybody who can reach the host, which is anybody at all.
   */
  @Public()
  @Get('brand')
  async brand(@Req() request: Request, @Query('host') hostOverride?: string) {
    // Origin first, then Host.
    //
    // The API may not be served from the school's domain — `api.paathshala.app`
    // answering for `stjosephs.paathshala.app` is the ordinary deployment — and
    // in that case the Host header is OUR hostname, not the school's. A browser
    // sends Origin on a cross-origin request and cannot forge it, so it is the
    // better signal; when the two are same-origin no Origin is sent and Host is
    // already the school's domain.
    //
    // `?host=` is honoured only from localhost, where every app runs in
    // development and no header says anything useful.
    const hostHeader = request.headers.host ?? '';
    const origin = request.headers.origin;
    const looksLocal = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(hostHeader);

    const host = looksLocal && hostOverride
      ? hostOverride
      : (origin ? hostFromOrigin(origin) : hostHeader);

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
