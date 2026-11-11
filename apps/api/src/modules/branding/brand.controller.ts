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
import { Controller, Get, Post, Body, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import type { Request } from 'express';
import { Public } from '../auth/public.decorator.ts';
import { brandingService } from './branding.service.ts';
import { letterheadService } from './letterhead.service.ts';
import { domainService } from './domain.service.ts';
import { currentScope } from '../../common/scope.ts';
import { ApiError } from '../../common/errors.ts';

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

  /**
   * Changing it (M34.4).
   *
   * `brandingService.set` has existed since M19 with no caller anywhere: the
   * school could see its own branding and could not change it, which is worse
   * than not having the feature — it looks like something somebody else
   * controls. Found by a method-level reachability sweep, not by anybody using
   * the product, which is its own comment on how visible this was.
   *
   * Every field is optional and a missing one is left alone, because the
   * service's UPSERT is `COALESCE(EXCLUDED.x, existing.x)`. Sending `null`
   * clears a field; omitting it does not.
   */
  @Post()
  async update(@Body() body: unknown) {
    const parsed = z.object({
      appName: z.string().max(80).nullable().optional(),
      // Deliberately NOT `.max(7)`. A seven-character bound here refuses every
      // bad colour before `brandingService.set` sees it, so the service's own
      // HEX check — the one with the message and the reason — becomes
      // unreachable, and a mutation removing it breaks nothing. One answer per
      // question: the bound is only wide enough to stop an absurd payload.
      primaryColour: z.string().max(64).nullable().optional(),
      inkColour: z.string().max(64).nullable().optional(),
      supportEmail: z.string().email().max(200).nullable().optional(),
      supportPhone: z.string().max(32).nullable().optional(),
      logoFileId: z.string().uuid().nullable().optional(),
      logoDarkFileId: z.string().uuid().nullable().optional(),
    }).safeParse(body);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);

    return { data: await brandingService.set(currentScope(), parsed.data) };
  }

  /** What the school prints at the top of its paper (M47.4). Anybody in the school may read it. */
  @Get('letterhead')
  async letterhead() {
    return { data: await letterheadService.get(currentScope()) };
  }

  /**
   * Replaces it. The digit counts are checked here so the answer names the
   * field; the table's own CHECKs are the backstop for any other writer.
   */
  @Post('letterhead')
  async saveLetterhead(@Body() body: unknown) {
    const text = z.string().max(200).nullable().optional();
    const parsed = z.object({
      address_line1: text, address_line2: text, city: text, state: text,
      phone: text, website: text,
      affiliation_body: text, affiliation_no: text, school_code: text,
      signatory_name: text, signatory_title: text,
      pincode: z.string().trim().regex(/^[1-9][0-9]{5}$/, 'A PIN code is six digits.')
        .or(z.literal('')).nullable().optional(),
      udise_code: z.string().trim().regex(/^[0-9]{11}$/, 'A UDISE+ code is eleven digits.')
        .or(z.literal('')).nullable().optional(),
      email: z.string().trim().email().max(200).or(z.literal('')).nullable().optional(),
    }).safeParse(body);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    return { data: await letterheadService.save(currentScope(), parsed.data) };
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
