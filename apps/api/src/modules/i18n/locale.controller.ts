/**
 * Setting a language (M29.3).
 *
 * M29.1 built the chain and M29.2 gave the parent app words. Neither of them
 * could be *changed* by anybody: `organization.locale` was whatever 0002's
 * default left it, and `communication_preference.locale` could only be written
 * by a test. A resolution chain nobody can set resolves the same way forever.
 *
 * Three ways in, because there are three people who know the answer:
 *
 *   - the school, which knows what it teaches in;
 *   - the family, in the parent app;
 *   - the office, on the family's behalf — which is not a workaround. A parent
 *     who cannot navigate an app in a language they do not read cannot use the
 *     screen that changes the language. That is the whole problem, and an
 *     office that can set it while the family is at the admissions desk is the
 *     only version of this that reaches the families who need it most.
 */
import { Controller, Get, Post, Body, Param } from '@nestjs/common';
import { z } from 'zod';
import { localeService } from './locale.service.ts';
import { TEACHING_LOCALES } from './locales.ts';
import { currentScope } from '../../common/scope.ts';
import { ApiError } from '../../common/errors.ts';

const uuid = z.string().uuid();
const body = z.object({ locale: z.string().min(2).max(20) });

@Controller('v1/locale')
export class LocaleController {
  /**
   * What this caller reads, and why.
   *
   * The chain comes back whole rather than collapsed to a winner, because a
   * settings screen has to distinguish "Hindi, because you asked for it" from
   * "Hindi, because that is what the school uses". Those are two different
   * things to offer to change, and a single tag cannot tell them apart.
   */
  @Get()
  async mine() {
    return {
      data: {
        ...await localeService.describe(currentScope()),
        options: TEACHING_LOCALES,
      },
    };
  }

  /** What one person reads. Staff only, by `preference_own` in 0036. */
  @Get('people/:id')
  async forPerson(@Param('id') id: string) {
    const personId = uuid.safeParse(id);
    if (!personId.success) throw ApiError.fromZod(personId.error);
    return { data: await localeService.describe(currentScope(), personId.data) };
  }

  /**
   * The caller's own.
   *
   * No id in the path on purpose. The person is `app_current_person_id()`, so
   * this route cannot be pointed at somebody else however the body is
   * constructed — the same reason M32 took the author of an admission decision
   * out of the request body.
   */
  @Post('me')
  async setMine(@Body() input: unknown) {
    const parsed = body.safeParse(input);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    const scope = currentScope();
    const { personId } = await localeService.describe(scope);
    if (!personId) {
      throw ApiError.make('not_found', 'no_person_record',
        'This login is not attached to a person in this school, so there is '
        + 'nobody to set a language for.');
    }
    return { data: await localeService.setForPerson(scope, personId, parsed.data.locale) };
  }

  /** The office setting it on a family's behalf. Refused for anybody else by RLS. */
  @Post('people/:id')
  async setForPerson(@Param('id') id: string, @Body() input: unknown) {
    const personId = uuid.safeParse(id);
    if (!personId.success) throw ApiError.fromZod(personId.error);
    const parsed = body.safeParse(input);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    return {
      data: await localeService.setForPerson(currentScope(), personId.data, parsed.data.locale),
    };
  }

  /**
   * The school's own language — the middle link of every chain in the system.
   *
   * Refused for a non-owner by the policy in 0079, not by a check here. Before
   * that migration any principal of the tenant could UPDATE this row; this is
   * the first endpoint that writes to it, and an endpoint is what turns a
   * latent grant into a live one.
   */
  @Post('organization')
  async setForOrganization(@Body() input: unknown) {
    const parsed = body.safeParse(input);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    return { data: await localeService.setForOrganization(currentScope(), parsed.data.locale) };
  }
}
