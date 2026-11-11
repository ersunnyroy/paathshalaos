/**
 * The parent app's read surface (M21).
 *
 * `/v1/family/*` rather than reusing `/v1/students` and friends. The office's
 * endpoints answer "show me the school"; these answer "show me my child", and a
 * parent app built on the first shape would be an app that filters — which is
 * a client deciding which children it shows.
 *
 * Not behind a feature flag. A school that has bought nothing extra still has
 * parents, and putting the parent app behind an upsell would mean a family's
 * own records are a paid add-on.
 */
import { Controller, Get, Param, Query } from '@nestjs/common';
import { z } from 'zod';
import { familyService } from './family.service.ts';
import { transportService } from '../transport/transport.service.ts';
import { currentScope } from '../../common/scope.ts';
import { ApiError } from '../../common/errors.ts';

const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** A month back, which is what a parent scrolls. */
function defaultWindow(): { from: string; to: string } {
  const to = new Date();
  const from = new Date(to.getTime() - 30 * 86_400_000);
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

@Controller('v1/family')
export class FamilyController {
  @Get('children')
  async children() {
    return { data: await familyService.children(currentScope()) };
  }

  @Get('children/:id/attendance')
  async attendance(@Param('id') id: string, @Query() query: unknown) {
    const child = uuid.safeParse(id);
    if (!child.success) throw ApiError.fromZod(child.error);
    const parsed = z.object({
      from: isoDate.optional(), to: isoDate.optional(),
    }).safeParse(query);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);

    const window = defaultWindow();
    const from = parsed.data.from ?? window.from;
    const to = parsed.data.to ?? window.to;
    if (from > to) {
      throw ApiError.make('validation_error', 'window_backwards',
        'The start of the range is after its end.');
    }
    return {
      data: await familyService.attendance(currentScope(),
        { studentId: child.data, from, to }),
    };
  }

  @Get('children/:id/fees')
  async fees(@Param('id') id: string) {
    const child = uuid.safeParse(id);
    if (!child.success) throw ApiError.fromZod(child.error);
    return { data: await familyService.fees(currentScope(), child.data) };
  }

  @Get('children/:id/results')
  async results(@Param('id') id: string) {
    const child = uuid.safeParse(id);
    if (!child.success) throw ApiError.fromZod(child.error);
    return { data: await familyService.results(currentScope(), child.data) };
  }

  /**
   * The child's bus, when the school has transport.
   *
   * Deliberately not `@RequiresFeature('transport')`: to a school without the
   * module this is not a locked door, it is a question with the answer "no
   * bus", and the parent app should not have to know which modules their
   * school bought in order to draw a screen.
   */
  @Get('children/:id/transport')
  async transport(@Param('id') id: string) {
    const child = uuid.safeParse(id);
    if (!child.success) throw ApiError.fromZod(child.error);
    return { data: await transportService.forChild(currentScope(), child.data) };
  }

  @Get('messages')
  async messages() {
    return { data: await familyService.messages(currentScope()) };
  }
}
