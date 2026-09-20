/**
 * Consent, recorded against the text somebody actually agreed to (M32.6).
 *
 * `consentService` had no caller in `src/`. Every consent decision this system
 * enforces — and `may_message` consults one on every single send — came from
 * a row no part of the product could create. A school could be refused
 * permission to message a parent who had never been asked.
 *
 * Two things this surface does not let a school do, both deliberate:
 *
 * **Consent is not given in bulk.** There is no "tick everybody" endpoint. A
 * consent record names who agreed, on whose behalf, to which version of which
 * notice, through which channel — and a bulk grant would have to invent three
 * of those four. If a school collected paper forms, each one is a call with
 * `channel: 'paper'` and an evidence reference.
 *
 * **Contract-basis processing cannot be withdrawn here.** Delivering the
 * education a family is paying for is not consent-based, so there is no
 * consent to withdraw; the service refuses it and says that closing the
 * account is the way to end it. A screen that offered the toggle anyway would
 * be offering something the law does not.
 */
import { Controller, Get, Post, Body, Param, Query } from '@nestjs/common';
import { z } from 'zod';
import { consentService } from './consent.service.ts';
import { withTenant } from '../../db/tenant.ts';
import { currentScope } from '../../common/scope.ts';
import { ApiError } from '../../common/errors.ts';

const uuid = z.string().uuid();

const PURPOSES = ['core_education_service', 'attendance_notifications',
                  'fee_notifications', 'photo_publication', 'transport_tracking',
                  'third_party_assessment', 'marketing'] as const;

const giveBody = z.object({
  personId: uuid,
  /** Differs from personId whenever a guardian consents for a child. */
  givenByPersonId: uuid,
  purpose: z.enum(PURPOSES),
  noticeVersionId: uuid,
  channel: z.enum(['app', 'web', 'paper', 'in_person']),
  guardianLinkId: uuid.optional(),
  evidenceRef: z.string().max(400).optional(),
});

@Controller('v1/consent')
export class ConsentController {
  /**
   * The notices a school has published, newest version of each.
   *
   * A consent record points at a version, not at a notice, because the
   * question years later is "what did they actually agree to" and the text
   * changes. This list is what a screen offers; the service refuses an
   * unpublished one.
   */
  @Get('notices')
  async notices() {
    return {
      data: await withTenant(currentScope(), async (db) => {
        const { rows } = await db.query(
          `SELECT DISTINCT ON (code, locale)
                  id, code, version, locale, title, published_at
             FROM notice_version
            WHERE published_at IS NOT NULL
            ORDER BY code, locale, version DESC`);
        return rows;
      }),
    };
  }

  /** What one person has agreed to, and what they have taken back. */
  @Get('people/:id')
  async forPerson(@Param('id') id: string) {
    const personId = uuid.safeParse(id);
    if (!personId.success) throw ApiError.fromZod(personId.error);
    return { data: await consentService.listFor(currentScope(), personId.data) };
  }

  /**
   * The gap a school actually has to close: children with no consent on file
   * for a purpose the school wants to use.
   *
   * Listed rather than assumed, because the alternative is a school that
   * discovers the gap when a send comes back with thirty suppressions and no
   * explanation an administrator can act on.
   */
  @Get('gaps')
  async gaps(@Query('purpose') purpose?: string) {
    const parsed = z.enum(PURPOSES).safeParse(purpose ?? 'attendance_notifications');
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    return {
      data: await withTenant(currentScope(), async (db) => {
        const { rows } = await db.query(
          `SELECT st.id AS student_id, st.admission_no,
                  p.id AS person_id, p.given_name, p.family_name,
                  sec.name AS section_name, cg.name AS class_name,
                  -- The guardian who would be asked. A child with no linked
                  -- guardian is a different problem and shows as null here
                  -- rather than dropping out of the list.
                  gp.id AS guardian_person_id,
                  gp.given_name AS guardian_given_name,
                  gl.id AS guardian_link_id
             FROM student st
             JOIN person p ON p.id = st.person_id
             LEFT JOIN enrollment e ON e.student_id = st.id AND e.status = 'active'
             LEFT JOIN section sec ON sec.id = e.section_id
             LEFT JOIN class_group cg ON cg.id = sec.class_group_id
             LEFT JOIN guardian_link gl ON gl.student_id = st.id
                                       AND gl.effective_to IS NULL
                                       AND gl.is_primary
             LEFT JOIN person gp ON gp.id = gl.guardian_person_id
            WHERE st.deleted_at IS NULL
              AND st.lifecycle_status = 'enrolled'
              AND NOT EXISTS (
                SELECT 1 FROM consent_record cr
                 WHERE cr.person_id = st.person_id
                   AND cr.purpose = $1
                   AND cr.withdrawn_at IS NULL)
            ORDER BY cg.name, sec.name, p.given_name`,
          [parsed.data]);
        return rows;
      }),
    };
  }

  @Post()
  async give(@Body() body: unknown) {
    const parsed = giveBody.safeParse(body);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    return { data: await consentService.give(currentScope(), parsed.data) };
  }

  @Post('withdraw')
  async withdraw(@Body() body: unknown) {
    const parsed = z.object({
      personId: uuid,
      purpose: z.enum(PURPOSES),
      reason: z.string().max(2000).optional(),
    }).safeParse(body);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    await consentService.withdraw(currentScope(), parsed.data);
    return { data: { withdrawn: true } };
  }
}
