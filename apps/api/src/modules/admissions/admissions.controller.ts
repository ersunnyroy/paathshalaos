/**
 * Admissions and enrollment (M32.2).
 *
 * M5 built this pipeline — enquiry, application, documents, decision, offer,
 * acceptance, enrolment — with fifty-two passing tests and no route to any of
 * it. `admissionsService` and `enrollmentService` had, until this file, no
 * caller anywhere in `src/`. A school using this product could not admit a
 * child or enrol one.
 *
 * Two decisions worth stating, because both are the kind that get undone by a
 * later "convenience":
 *
 * **Who decided is not in the body.** `decide` takes `decidedByStaffId`, and
 * it comes from `app_current_staff_id()` here. An admission decision is the
 * document a family disputes, and a client-supplied author is an attribution
 * anybody can forge by editing one field.
 *
 * **Intake is one call, not three.** The counter path needs a person, a
 * validated form submission and an application. Three endpoints means a screen
 * that can leave a person row behind when the third fails, which is how
 * duplicate children get created. The service does all three or none.
 */
import { Controller, Get, Post, Body, Param, Query } from '@nestjs/common';
import { z } from 'zod';
import { admissionsService } from './admissions.service.ts';
import { formsService } from './forms.service.ts';
import { enrollmentService } from '../enrollment/enrollment.service.ts';
import { currentScope } from '../../common/scope.ts';
import { ApiError } from '../../common/errors.ts';

const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const enquiryBody = z.object({
  name: z.string().min(1).max(200),
  phone: z.string().max(30).optional(),
  email: z.string().email().max(200).optional(),
  // The set 0018 actually allows. 'campaign' was my invention and would have
  // been a 500 from a check constraint on the first real enquiry.
  source: z.enum(['walk_in', 'phone', 'website', 'referral', 'event',
                  'advertisement', 'import', 'other']),
  campusId: uuid,
  // Both NOT NULL on `enquiry`, and an enquiry is always about something: a
  // programme, for a year. Optional here meant a null-violation 500 where a
  // 422 naming the missing field belongs.
  programmeId: uuid,
  academicYearId: uuid,
  note: z.string().max(2000).optional(),
})
  // `lead` requires one of the two, because a lead nobody can contact is a
  // row. Saying so here makes it a named refusal instead of a constraint
  // violation with a Postgres sentence in it.
  .refine((v) => Boolean(v.phone ?? v.email), {
    message: 'An enquiry needs a phone number or an email address — otherwise '
      + 'nobody can ring them back.',
    path: ['phone'],
  });

const intakeBody = z.object({
  givenName: z.string().min(1).max(120),
  familyName: z.string().max(120).optional(),
  dateOfBirth: isoDate.optional(),
  programmeId: uuid,
  academicYearId: uuid,
  formDefinitionId: uuid,
  answers: z.record(z.unknown()),
  enquiryId: uuid.optional(),
  requiredDocuments: z.array(z.string().max(60)).max(20).optional(),
});

const decideBody = z.object({
  outcome: z.enum(['offered', 'waitlisted', 'rejected']),
  offeredSectionId: uuid.optional(),
  offerValidDays: z.number().int().min(1).max(365).optional(),
  conditions: z.string().max(4000).optional(),
  reason: z.string().max(4000).optional(),
  supersede: z.boolean().optional(),
});

const reasonBody = z.object({ reason: z.string().min(1).max(2000) });

const formBody = z.object({
  code: z.string().min(1).max(60),
  title: z.string().min(1).max(200),
  jsonSchema: z.unknown(),
  uiSchema: z.unknown().optional(),
});

@Controller('v1/admissions')
export class AdmissionsController {
  /** Enquiries and applications as one list — see the service's note on why. */
  @Get('pipeline')
  async pipeline(@Query('academicYearId') academicYearId?: string) {
    const parsed = uuid.optional().safeParse(academicYearId ?? undefined);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    return {
      data: await admissionsService.pipeline(currentScope(), {
        academicYearId: parsed.data,
      }),
    };
  }

  @Get('forms')
  async forms() {
    return { data: await admissionsService.admissionForms(currentScope()) };
  }

  /**
   * Creates and publishes an admission form in one step.
   *
   * Drafting and publishing are separate in the service, correctly: a draft
   * cannot accept submissions, which is what stops a half-written form
   * collecting answers. They are one call here because a school with NO
   * published form cannot admit anybody at all, and making that first form a
   * two-step is a school that gets stuck on step one. Editing an existing
   * form still goes through the draft path — this only ever makes a new
   * version.
   */
  @Post('forms')
  async createForm(@Body() body: unknown) {
    const parsed = formBody.safeParse(body);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    const scope = currentScope();
    const draft = await formsService.createDraft(scope, {
      code: parsed.data.code,
      title: parsed.data.title,
      // 0017's allowed set is enquiry | application | feedback | custom. An
      // admission form is an 'application' form; 'admission' is not a value.
      purpose: 'application',
      jsonSchema: parsed.data.jsonSchema,
      ...(parsed.data.uiSchema === undefined ? {} : { uiSchema: parsed.data.uiSchema }),
    });
    return { data: await formsService.publish(scope, draft.id) };
  }

  @Post('enquiries')
  async recordEnquiry(@Body() body: unknown) {
    const parsed = enquiryBody.safeParse(body);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    return { data: await admissionsService.recordEnquiry(currentScope(), parsed.data) };
  }

  @Post('applications')
  async intake(@Body() body: unknown) {
    const parsed = intakeBody.safeParse(body);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    return { data: await admissionsService.intake(currentScope(), parsed.data) };
  }

  /**
   * A document against an application. Upsert, not append.
   *
   * Re-uploading a birth certificate that was rejected clears the rejection
   * and the verifier, because the old verdict was about the old file. Keeping
   * it would leave a document reading "rejected: illegible" next to a legible
   * scan, which is how a family gets told twice to send what they already sent.
   */
  @Post('applications/:id/documents')
  async attachDocument(@Param('id') id: string, @Body() body: unknown) {
    const applicationId = uuid.safeParse(id);
    if (!applicationId.success) throw ApiError.fromZod(applicationId.error);
    const parsed = z.object({
      documentType: z.string().min(1).max(60),
      fileId: uuid,
    }).safeParse(body);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    await admissionsService.attachDocument(currentScope(), {
      applicationId: applicationId.data, ...parsed.data,
    });
    return { data: { attached: true } };
  }

  /**
   * Accept or reject one uploaded document.
   *
   * The verifier comes from the session for the same reason the decider does:
   * "who checked this certificate" is a question asked when the certificate
   * turns out to be forged.
   */
  @Post('application-documents/:id/verify')
  async verifyDocument(@Param('id') id: string, @Body() body: unknown) {
    const documentId = uuid.safeParse(id);
    if (!documentId.success) throw ApiError.fromZod(documentId.error);
    const parsed = z.object({
      accept: z.boolean(),
      // Deliberately not `.min(1)`: the service refuses a blank reason on a
      // rejection and accepts its absence on an acceptance. A stricter rule
      // here would make that service rule unreachable.
      reason: z.string().max(2000).optional(),
    }).safeParse(body);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);

    const scope = currentScope();
    const staffId = await admissionsService.currentStaffId(scope);
    if (!staffId) {
      throw ApiError.make('permission_error', 'not_staff',
        'Verifying a document is attributed to a member of staff, and this '
        + 'account is not linked to one.');
    }
    await admissionsService.verifyDocument(scope, {
      documentId: documentId.data, verifierStaffId: staffId, ...parsed.data,
    });
    return { data: { verified: parsed.data.accept } };
  }

  @Post('applications/:id/decide')
  async decide(@Param('id') id: string, @Body() body: unknown) {
    const applicationId = uuid.safeParse(id);
    if (!applicationId.success) throw ApiError.fromZod(applicationId.error);
    const parsed = decideBody.safeParse(body);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);

    const scope = currentScope();
    const staffId = await admissionsService.currentStaffId(scope);
    if (!staffId) {
      // Not a refusal about permissions — the caller may well be entitled. It
      // is that an admission decision has to name a person, and an account
      // with no staff row cannot be named.
      throw ApiError.make('permission_error', 'not_staff',
        'An admission decision is attributed to a member of staff, and this '
        + 'account is not linked to one.');
    }

    return {
      data: await admissionsService.decide(scope, {
        applicationId: applicationId.data,
        decidedByStaffId: staffId,
        ...parsed.data,
      }),
    };
  }

  /** Accepting an offer is what creates the learner and their enrolment. */
  @Post('decisions/:id/accept')
  async accept(@Param('id') id: string, @Body() body: unknown) {
    const decisionId = uuid.safeParse(id);
    if (!decisionId.success) throw ApiError.fromZod(decisionId.error);
    const parsed = z.object({
      admissionNoPrefix: z.string().max(20).optional(),
      rollNo: z.string().max(20).optional(),
    }).safeParse(body ?? {});
    if (!parsed.success) throw ApiError.fromZod(parsed.error);

    return {
      data: await admissionsService.acceptOfferAndEnrol(currentScope(), {
        decisionId: decisionId.data, ...parsed.data,
      }),
    };
  }

  @Post('decisions/:id/decline')
  async decline(@Param('id') id: string, @Body() body: unknown) {
    const decisionId = uuid.safeParse(id);
    if (!decisionId.success) throw ApiError.fromZod(decisionId.error);
    const parsed = z.object({ reason: z.string().max(2000).optional() })
      .safeParse(body ?? {});
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    await admissionsService.declineOffer(currentScope(), decisionId.data,
      parsed.data.reason);
    return { data: { declined: true } };
  }
}

/**
 * What happens to a learner after they are enrolled.
 *
 * Separate controller, same milestone. Every route here demands a reason and
 * the service refuses without one — a learner moved between sections with no
 * recorded why is the row somebody has to explain to a parent in March.
 */
@Controller('v1/enrollments')
export class EnrollmentController {
  /**
   * The enrollment a learner is on right now, or nothing.
   *
   * Declared before `:id/history` because `current` is one segment and would
   * otherwise be read as an enrollment id — and the error would be a 422 about
   * a malformed uuid, which sends the reader to the wrong file.
   *
   * Keyed by student rather than by enrollment, because a caller who already
   * had the enrollment id would not need to ask. Returns 404 rather than an
   * empty body: "this learner is not enrolled" is an answer, and a null that
   * looks like a missing field is not.
   */
  @Get('current/:studentId')
  async current(@Param('studentId') studentId: string) {
    const parsed = uuid.safeParse(studentId);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    const found = await enrollmentService.current(currentScope(), parsed.data);
    if (!found) {
      throw ApiError.make('not_found', 'not_enrolled',
        'That learner has no active enrollment.');
    }
    return { data: found };
  }

  @Get(':id/history')
  async history(@Param('id') id: string) {
    const parsed = uuid.safeParse(id);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    return { data: await enrollmentService.history(currentScope(), parsed.data) };
  }

  /**
   * A campus move: the old enrollment ends and a new one opens, linked.
   *
   * Not `changeSection` with a different section id. A campus has its own
   * academic year rows, and 0019's invariant refuses one enrollment spanning
   * two — so the honest shape is two rows with an event tying them together,
   * which is also what a transfer certificate has to be printed from.
   */
  @Post(':id/transfer')
  async transferCampus(@Param('id') id: string, @Body() body: unknown) {
    const enrollmentId = uuid.safeParse(id);
    if (!enrollmentId.success) throw ApiError.fromZod(enrollmentId.error);
    const parsed = z.object({
      toSectionId: uuid,
      toAcademicYearId: uuid,
      reason: z.string().max(2000),
      effectiveOn: isoDate.optional(),
      rollNo: z.string().max(20).optional(),
    }).safeParse(body);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    return {
      data: await enrollmentService.transferCampus(currentScope(), {
        enrollmentId: enrollmentId.data, ...parsed.data,
      }),
    };
  }

  @Post(':id/section')
  async changeSection(@Param('id') id: string, @Body() body: unknown) {
    const enrollmentId = uuid.safeParse(id);
    if (!enrollmentId.success) throw ApiError.fromZod(enrollmentId.error);
    const parsed = z.object({
      toSectionId: uuid,
      reason: z.string().min(1).max(2000),
      effectiveOn: isoDate.optional(),
    }).safeParse(body);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    return {
      data: await enrollmentService.changeSection(currentScope(), {
        enrollmentId: enrollmentId.data, ...parsed.data,
      }),
    };
  }

  @Post(':id/withdraw')
  async withdraw(@Param('id') id: string, @Body() body: unknown) {
    const enrollmentId = uuid.safeParse(id);
    if (!enrollmentId.success) throw ApiError.fromZod(enrollmentId.error);
    const parsed = reasonBody.extend({ effectiveOn: isoDate.optional() }).safeParse(body);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    return {
      data: await enrollmentService.withdraw(currentScope(), {
        enrollmentId: enrollmentId.data, ...parsed.data,
      }),
    };
  }

  @Post(':id/complete')
  async complete(@Param('id') id: string, @Body() body: unknown) {
    const enrollmentId = uuid.safeParse(id);
    if (!enrollmentId.success) throw ApiError.fromZod(enrollmentId.error);
    const parsed = z.object({
      reason: z.string().max(2000).optional(),
      effectiveOn: isoDate.optional(),
    }).safeParse(body ?? {});
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    return {
      data: await enrollmentService.complete(currentScope(), {
        enrollmentId: enrollmentId.data, ...parsed.data,
      }),
    };
  }
}
