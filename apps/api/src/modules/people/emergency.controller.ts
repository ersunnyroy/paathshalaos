/**
 * The information somebody needs in ten seconds (M34.3).
 *
 * `peopleRepository.findStudentSensitive` reads a learner's blood group,
 * medical note, accommodations and emergency contact. It does it properly: on a
 * separate database role whose column grants are narrower than the application
 * role's, under the same row-level security, and it writes an audit row whether
 * or not it returned anything — because a refused attempt on a medical note is
 * exactly as interesting as a successful one.
 *
 * **Nothing could call it.** A method-level sweep found that the whole of
 * `peopleRepository` has no caller anywhere in `src/`: the directory controller
 * writes its own SQL, and that SQL returns a name, an admission number and a
 * date of birth. So a school could not see a child's allergies from anywhere in
 * this product, and a teacher standing over a child who had collapsed had
 * nothing to read.
 *
 * That is why this is one small controller rather than a tidy-up of the
 * repository: the gap is a person's, not an architecture's.
 *
 * ## Deliberately not on the learner list
 *
 * A separate route, not extra columns on `/v1/students/:id`. Sensitive fields
 * that ride along with an ordinary read are fields that end up in a CSV export,
 * a log line and a support screenshot — and every one of those reads is audited
 * as if somebody had asked for a medical note, which makes the audit trail
 * useless for spotting somebody who actually did.
 */
import { Controller, Get, Post, Body, Param, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { peopleRepository } from './people.repository.ts';
import { certificateService } from './certificate.service.ts';
import { currentScope } from '../../common/scope.ts';
import { ApiError } from '../../common/errors.ts';

const uuid = z.string().uuid();

@Controller('v1/students')
export class EmergencyController {
  /** What has been issued in this learner's name (M47.6). */
  @Get(':id/certificates')
  async certificates(@Param('id') id: string) {
    const studentId = uuid.safeParse(id);
    if (!studentId.success) throw ApiError.fromZod(studentId.error);
    return { data: await certificateService.listFor(currentScope(), studentId.data) };
  }

  /**
   * Issues one onto the register. The body says which kind and what it is
   * for; the words are composed here from the record, never taken from the
   * request.
   */
  @Post(':id/certificates')
  async issueCertificate(@Param('id') id: string, @Body() body: unknown) {
    const studentId = uuid.safeParse(id);
    if (!studentId.success) throw ApiError.fromZod(studentId.error);
    const parsed = z.object({
      kind: z.enum(['bonafide', 'study', 'dob']),
      purpose: z.string().max(120).optional(),
    }).safeParse(body);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    return {
      data: await certificateService.issue(currentScope(), {
        studentId: studentId.data, kind: parsed.data.kind, purpose: parsed.data.purpose,
      }),
    };
  }

  /**
   * Blood group, medical note, accommodations, and who to call.
   *
   * Refused rows and missing learners answer the same way, which is the rule
   * the rest of this product follows: a 403 confirms the id exists.
   */
  @Get(':id/emergency')
  async emergency(@Param('id') id: string) {
    const studentId = uuid.safeParse(id);
    if (!studentId.success) throw ApiError.fromZod(studentId.error);

    const found = await peopleRepository.findStudentSensitive(
      currentScope(), studentId.data);
    if (!found) {
      throw new NotFoundException(
        ApiError.notFound('student_not_found', 'Learner not found.'));
    }
    return { data: found };
  }

  /**
   * Who may collect this child, and what each of them is allowed to do.
   *
   * `guardiansOf` had no caller either. `can_authorise_pickup` has been a
   * column since M3 and a permission the product enforces, and the office had
   * no screen that could answer "is this person allowed to take her home".
   */
  @Get(':id/guardians')
  async guardians(@Param('id') id: string) {
    const studentId = uuid.safeParse(id);
    if (!studentId.success) throw ApiError.fromZod(studentId.error);
    return { data: await peopleRepository.guardiansOf(currentScope(), studentId.data) };
  }
}

/**
 * Guardian links (M36).
 *
 * `linkGuardian` and `endGuardianLink` were built properly — both write a
 * SENSITIVE audit row, and ending a link preserves history rather than deleting
 * it — and neither had a route. The only way a school could link a guardian to
 * a child was to upload a CSV through the import module.
 *
 * That is fine for the first Monday and wrong for every day after it. A child
 * admitted mid-term, a grandparent added to the pickup list, a wrong link
 * typed at the counter, a custody order that removes one parent's access:
 * every one of those is a single change, and every one of them required a
 * spreadsheet.
 *
 * Reading who a child's guardians are already had a route. Changing it did
 * not — the third time in this codebase that a feature shipped with a read
 * surface and no write surface, after white-labelling (M34.4) and custom
 * domains (M35.2).
 */
@Controller('v1/guardian-links')
export class GuardianLinkController {
  /**
   * Links a guardian to a learner.
   *
   * The capabilities default to permissive — academics, finance, pay, pickup,
   * notifications all true — because 0012's defaults say so and a school adding
   * a parent means a parent. The restrictive case is a deliberate act and looks
   * like one: every flag is named in the body.
   *
   * `legalCustodyNote` is free text and is not a flag. A custody arrangement is
   * a court's words, not an enum, and the flags are what the system enforces.
   */
  @Post()
  async link(@Body() body: unknown) {
    const parsed = z.object({
      studentId: uuid,
      guardianPersonId: uuid,
      relationship: z.string().min(1).max(60),
      isPrimary: z.boolean().optional(),
      capabilities: z.object({
        canViewAcademics: z.boolean().optional(),
        canViewFinance: z.boolean().optional(),
        canPay: z.boolean().optional(),
        canAuthorisePickup: z.boolean().optional(),
        canReceiveNotifications: z.boolean().optional(),
      }).optional(),
      legalCustodyNote: z.string().max(2000).optional(),
    }).safeParse(body);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    return { data: await peopleRepository.linkGuardian(currentScope(), parsed.data) };
  }

  /**
   * Ends a link, with a reason.
   *
   * Not a DELETE, and the reason is not optional. The row stays and
   * `effective_to` is set, because "who could collect this child last March"
   * is a question that gets asked after something has gone wrong, and a
   * deleted row answers it with silence. The reason goes to the audit trail
   * rather than to the link.
   */
  @Post(':id/end')
  async end(@Param('id') id: string, @Body() body: unknown) {
    const linkId = uuid.safeParse(id);
    if (!linkId.success) throw ApiError.fromZod(linkId.error);
    const parsed = z.object({ reason: z.string().min(1).max(2000) }).safeParse(body);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    await peopleRepository.endGuardianLink(currentScope(), linkId.data, parsed.data.reason);
    return { data: { ended: true } };
  }
}
