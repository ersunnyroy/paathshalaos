import { withTenant, type TenantScope, type TenantClient } from '../../db/tenant.ts';
import { auditService } from '../audit/audit.service.ts';
import { ApiError } from '../../common/errors.ts';
import { formsService } from './forms.service.ts';

export interface Application {
  id: string;
  application_no: string;
  applicant_person_id: string;
  programme_id: string;
  academic_year_id: string;
  status: string;
}

export interface AdmissionDecision {
  id: string;
  application_id: string;
  outcome: string;
  offered_section_id: string | null;
  offer_expires_at: Date | null;
  accepted_at: Date | null;
  declined_at: Date | null;
}

export interface EnrollmentRow {
  id: string;
  student_id: string;
  section_id: string;
  academic_year_id: string;
  status: string;
  roll_no: string | null;
}

/**
 * Application numbers are gapless per campus per academic year, generated under
 * a transaction-scoped advisory lock.
 *
 * `max(n) + 1` under concurrency gives two applicants the same number; a
 * sequence gives gaps, which an admissions office reads as a lost application
 * and will ask about. The lock serialises only the numbering, and only against
 * other numbering in the same year.
 */
async function nextApplicationNo(
  db: TenantClient,
  academicYearId: string,
  prefix: string,
): Promise<string> {
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`appno:${academicYearId}`]);
  const { rows } = await db.query<{ next: string }>(
    `SELECT COALESCE(max(substring(application_no from '[0-9]+$')::int), 0) + 1 AS next
       FROM application
      WHERE academic_year_id = $1 AND application_no LIKE $2 || '%'`,
    [academicYearId, prefix],
  );
  return `${prefix}${String(rows[0]!.next).padStart(5, '0')}`;
}

export const admissionsService = {

  /**
   * The pipeline, as one list.
   *
   * Added with M32's controller. M5 built every step of admissions and no way
   * to see them together, because nothing that needed the list existed — the
   * same absence M27 had, found the same way.
   *
   * Enquiries and applications are separate tables and deliberately one list
   * here: an office does not think in terms of which table a family is in, it
   * thinks "who have we heard from and what happens next". A screen that makes
   * somebody check two places is a screen where the second place stops being
   * checked.
   */
  async pipeline(scope: TenantScope, opts: { academicYearId?: string | undefined } = {}):
  Promise<Array<{
    kind: 'enquiry' | 'application';
    id: string; person_id: string | null; name: string;
    phone: string | null; programme_name: string | null;
    stage: string; application_no: string | null;
    decision_id: string | null; outcome: string | null;
    offered_section: string | null; offer_expires_at: string | null;
    accepted_at: string | null; declined_at: string | null;
    enrolled: boolean; created_at: string;
  }>> {
    return withTenant(scope, async (db) => {
      const { rows } = await db.query<{
        kind: 'enquiry' | 'application';
        id: string; person_id: string | null; name: string;
        phone: string | null; programme_name: string | null;
        stage: string; application_no: string | null;
        decision_id: string | null; outcome: string | null;
        offered_section: string | null; offer_expires_at: string | null;
        accepted_at: string | null; declined_at: string | null;
        enrolled: boolean; created_at: string;
      }>(
        `SELECT 'application'::text AS kind, a.id, a.applicant_person_id AS person_id,
                p.given_name || COALESCE(' ' || p.family_name, '') AS name,
                NULL::text AS phone, pr.name AS programme_name,
                a.status AS stage, a.application_no,
                d.id AS decision_id, d.outcome, sec.name AS offered_section,
                d.offer_expires_at::text, d.accepted_at::text, d.declined_at::text,
                EXISTS (SELECT 1 FROM enrollment e
                         WHERE e.student_id = (SELECT st.id FROM student st
                                                WHERE st.person_id = a.applicant_person_id))
                  AS enrolled,
                a.created_at::text
           FROM application a
           JOIN person p ON p.id = a.applicant_person_id
           LEFT JOIN programme pr ON pr.id = a.programme_id
           -- The decision in force. Superseded ones stay on the record — that
           -- is the point of M5's supersede path — and must not appear here as
           -- a second row for the same family.
           LEFT JOIN LATERAL (
             SELECT d2.* FROM admission_decision d2
              WHERE d2.application_id = a.id AND d2.superseded_at IS NULL
              ORDER BY d2.decided_at DESC LIMIT 1) d ON true
           LEFT JOIN section sec ON sec.id = d.offered_section_id
          WHERE a.deleted_at IS NULL
            AND ($1::uuid IS NULL OR a.academic_year_id = $1)

          UNION ALL

         SELECT 'enquiry'::text, e.id, NULL::uuid,
                l.name, l.phone, pr.name, e.stage, NULL::text,
                NULL::uuid, NULL::text, NULL::text, NULL::text, NULL::text, NULL::text,
                false, e.created_at::text
           FROM enquiry e
           JOIN lead l ON l.id = e.lead_id
           LEFT JOIN programme pr ON pr.id = e.programme_id
          WHERE e.deleted_at IS NULL
            -- An enquiry that became an application is shown as the
            -- application. Listing both is how one family gets rung twice.
            AND e.stage NOT IN ('closed_won', 'closed_lost')
            AND NOT EXISTS (SELECT 1 FROM application a2 WHERE a2.enquiry_id = e.id)
            AND ($1::uuid IS NULL OR e.academic_year_id = $1)

          ORDER BY created_at DESC`,
        [opts.academicYearId ?? null]);
      return rows;
    });
  },

  /** Published admission forms, for the intake screen's picker. */
  async admissionForms(scope: TenantScope): Promise<Array<{
    id: string; code: string; version: number; title: string; json_schema: unknown;
  }>> {
    return withTenant(scope, async (db) => {
      const { rows } = await db.query<{
        id: string; code: string; version: number; title: string; json_schema: unknown;
      }>(
        `SELECT DISTINCT ON (code) id, code, version, title, json_schema
           FROM form_definition
          WHERE purpose = 'application' AND published_at IS NOT NULL
          ORDER BY code, version DESC`);
      return rows;
    });
  },

  /**
   * Somebody rang, or walked in.
   *
   * The cheapest possible record, because the alternative is a note on paper.
   * A lead with a name and a phone number is worth more than a perfect record
   * that nobody had time to make.
   */
  async recordEnquiry(scope: TenantScope, input: {
    name: string; phone?: string | undefined; email?: string | undefined;
    source: string; campusId: string;
    programmeId: string; academicYearId: string;
    note?: string | undefined;
  }): Promise<{ leadId: string; enquiryId: string }> {
    const made = await withTenant(scope, async (db) => {
      const lead = await db.query<{ id: string }>(
        `INSERT INTO lead (tenant_id, campus_id, source, name, phone, email)
         VALUES (app_current_tenant_id(), $1::uuid, $2, $3, $4, $5) RETURNING id`,
        [input.campusId, input.source, input.name, input.phone ?? null,
         input.email ?? null]);
      const enquiry = await db.query<{ id: string }>(
        `INSERT INTO enquiry
           (tenant_id, lead_id, programme_id, academic_year_id, stage,
            next_action_note)
         VALUES (app_current_tenant_id(), $1::uuid, $2::uuid, $3::uuid,
                 'enquired', $4) RETURNING id`,
        [lead.rows[0]!.id, input.programmeId, input.academicYearId,
         input.note ?? null]);
      return { leadId: lead.rows[0]!.id, enquiryId: enquiry.rows[0]!.id };
    });

    await auditService.record({
      tenantId: scope.tenantId,
      ...(scope.actorId ? { actorUserId: scope.actorId } : {}),
      action: 'enquiry.recorded', resourceType: 'enquiry',
      resourceId: made.enquiryId, classification: 'INTERNAL',
    });
    return made;
  },

  /**
   * A family at the counter, in one call.
   *
   * `createApplication` needs a person and a validated form submission, which
   * is right — an application without an answer set is an application nobody
   * can reproduce years later. But it means the counter path is three calls
   * that must all succeed, and a screen that leaves a person row behind when
   * the third fails is a screen that creates duplicate children.
   *
   * So this is one method: the person, the submission and the application, in
   * that order, and the application's own failure takes the lot with it
   * because `withTenant` is a transaction.
   */
  async intake(scope: TenantScope, input: {
    givenName: string; familyName?: string | undefined; dateOfBirth?: string | undefined;
    programmeId: string; academicYearId: string; formDefinitionId: string;
    answers: Record<string, unknown>;
    enquiryId?: string | undefined;
    requiredDocuments?: string[] | undefined;
  }): Promise<Application> {
    // ONE transaction. The first version of this was three `withTenant` calls
    // and a comment claiming they were atomic, which they are not: `withTenant`
    // opens a transaction per call. An HTTP test that submitted answers failing
    // validation then found the person row still there — so an office retrying
    // the form ends up with two children who are one child.
    //
    // The validation and the version pinning stay in the forms service, which
    // owns them; only the transaction boundary moved.
    const application = await withTenant(scope, async (db) => {
      const person = await db.query<{ id: string }>(
        `INSERT INTO person (tenant_id, given_name, family_name, date_of_birth)
         VALUES (app_current_tenant_id(), $1, $2, $3::date) RETURNING id`,
        [input.givenName, input.familyName ?? null, input.dateOfBirth ?? null]);
      const personId = person.rows[0]!.id;

      const submission = await formsService.submitWithin(db, scope, {
        formDefinitionId: input.formDefinitionId,
        payload: input.answers,
      });

      const created = await this.createApplicationWithin(db, scope, {
        applicantPersonId: personId,
        programmeId: input.programmeId,
        academicYearId: input.academicYearId,
        formSubmissionId: submission.id,
        ...(input.enquiryId ? { enquiryId: input.enquiryId } : {}),
        ...(input.requiredDocuments ? { requiredDocuments: input.requiredDocuments } : {}),
      });

      if (input.enquiryId) {
        // The enquiry did its job. Leaving it open is how a family gets rung
        // about applying after they have applied.
        await db.query(
          `UPDATE enquiry SET stage = 'form_submitted', form_submission_id = $2::uuid,
                              updated_at = now()
            WHERE id = $1::uuid`, [input.enquiryId, submission.id]);
      }
      return created;
    });

    await auditService.record({
      tenantId: scope.tenantId,
      ...(scope.actorId ? { actorUserId: scope.actorId } : {}),
      action: 'application.submitted',
      resourceType: 'application',
      resourceId: application.id,
      classification: 'SENSITIVE',
      after: { applicationNo: application.application_no },
    });

    return application;
  },

  /** The caller's own staff row, for attributing a decision. */
  async currentStaffId(scope: TenantScope): Promise<string | undefined> {
    return withTenant(scope, async (db) => {
      const { rows } = await db.query<{ staff_id: string | null }>(
        'SELECT app_current_staff_id() AS staff_id');
      return rows[0]?.staff_id ?? undefined;
    });
  },
  /** Converts a submitted form into an application with its document checklist. */
  async createApplication(
    scope: TenantScope,
    input: {
      applicantPersonId: string;
      programmeId: string;
      academicYearId: string;
      formSubmissionId: string;
      enquiryId?: string;
      requiredDocuments?: string[];
      numberPrefix?: string;
    },
  ): Promise<Application> {
    const created = await withTenant(scope,
      (db) => this.createApplicationWithin(db, scope, input));

    await auditService.record({
      tenantId: scope.tenantId,
      actorUserId: scope.actorId,
      action: 'application.submitted',
      resourceType: 'application',
      resourceId: created.id,
      classification: 'SENSITIVE',
      after: { applicationNo: created.application_no },
    });
    return created;
  },

  /** As above, inside a transaction the caller already opened. See intake. */
  async createApplicationWithin(
    db: TenantClient,
    scope: TenantScope,
    input: {
      applicantPersonId: string;
      programmeId: string;
      academicYearId: string;
      formSubmissionId: string;
      enquiryId?: string | undefined;
      requiredDocuments?: string[] | undefined;
      numberPrefix?: string | undefined;
    },
  ): Promise<Application> {
    {
      const applicationNo = await nextApplicationNo(
        db, input.academicYearId, input.numberPrefix ?? 'APP-',
      );

      const { rows } = await db.query<Application>(
        `INSERT INTO application
           (tenant_id, enquiry_id, applicant_person_id, programme_id, academic_year_id,
            application_no, form_submission_id, status, submitted_at)
         VALUES (app_current_tenant_id(), $1, $2, $3, $4, $5, $6, 'submitted', now())
         RETURNING id, application_no, applicant_person_id, programme_id, academic_year_id, status`,
        [input.enquiryId ?? null, input.applicantPersonId, input.programmeId,
         input.academicYearId, applicationNo, input.formSubmissionId],
      );
      if (!rows[0]) {
        throw ApiError.make('permission_error', 'staff_only',
          'Only admissions staff may create an application.');
      }
      const application = rows[0];

      for (const documentType of input.requiredDocuments ?? []) {
        await db.query(
          `INSERT INTO application_document (tenant_id, application_id, document_type, is_required)
           VALUES (app_current_tenant_id(), $1, $2, true)`,
          [application.id, documentType],
        );
      }

      if (input.enquiryId) {
        await db.query(
          `UPDATE enquiry SET stage = 'form_submitted' WHERE id = $1 AND stage <> 'closed_won'`,
          [input.enquiryId],
        );
      }
      return application;
    }
  },

  async attachDocument(
    scope: TenantScope,
    input: { applicationId: string; documentType: string; fileId: string },
  ): Promise<void> {
    await withTenant(scope, async (db) => {
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO application_document
           (tenant_id, application_id, document_type, file_id, status)
         VALUES (app_current_tenant_id(), $1, $2, $3, 'uploaded')
         ON CONFLICT (tenant_id, application_id, document_type)
         DO UPDATE SET file_id = EXCLUDED.file_id, status = 'uploaded',
                       rejection_reason = NULL, verified_by = NULL, verified_at = NULL
         RETURNING id`,
        [input.applicationId, input.documentType, input.fileId],
      );
      if (!rows[0]) {
        throw ApiError.make('permission_error', 'staff_only', 'Only staff may attach documents.');
      }
    });
  },

  async verifyDocument(
    scope: TenantScope,
    input: {
      documentId: string; verifierStaffId: string; accept: boolean;
      reason?: string | undefined;
    },
  ): Promise<void> {
    if (!input.accept && !input.reason?.trim()) {
      throw ApiError.make('validation_error', 'rejection_needs_reason',
        'Rejecting a document requires a reason the family can act on.');
    }

    await withTenant(scope, async (db) => {
      const { rows } = await db.query<{ id: string; file_id: string | null }>(
        `SELECT id, file_id FROM application_document WHERE id = $1`,
        [input.documentId],
      );
      const doc = rows[0];
      if (!doc) throw ApiError.make('not_found', 'document_not_found', 'Document not found.');
      if (!doc.file_id) {
        throw ApiError.make('conflict', 'nothing_uploaded',
          'There is no uploaded file to verify.');
      }

      if (input.accept) {
        // A file that has not cleared the scanner must not be verifiable: a
        // verified document is one a human accepted as genuine, and accepting
        // something nobody could safely open is not that.
        const scan = await db.query<{ virus_scan_state: string }>(
          'SELECT virus_scan_state FROM file WHERE id = $1',
          [doc.file_id],
        );
        if (scan.rows[0]?.virus_scan_state !== 'clean') {
          throw ApiError.make('conflict', 'file_not_scanned',
            'This file has not cleared virus scanning yet.');
        }
      }

      await db.query(
        `UPDATE application_document
            SET status = $2,
                verified_by = CASE WHEN $2 = 'verified' THEN $3::uuid ELSE NULL END,
                verified_at = CASE WHEN $2 = 'verified' THEN now() ELSE NULL END,
                rejection_reason = $4
          WHERE id = $1`,
        [input.documentId, input.accept ? 'verified' : 'rejected',
         input.verifierStaffId, input.accept ? null : input.reason],
      );
    });

    await auditService.record({
      tenantId: scope.tenantId,
      actorUserId: scope.actorId,
      action: input.accept ? 'document.verified' : 'document.rejected',
      resourceType: 'application_document',
      resourceId: input.documentId,
      classification: 'RESTRICTED',
      ...(input.reason ? { reason: input.reason } : {}),
    });
  },

  /**
   * Issues a decision. Immutable once written — a change of mind supersedes the
   * old decision rather than editing it, so the sequence of what the institute
   * actually told the family stays on the record.
   */
  async decide(
    scope: TenantScope,
    input: {
      applicationId: string;
      outcome: 'offered' | 'waitlisted' | 'rejected';
      decidedByStaffId: string;
      offeredSectionId?: string | undefined;
      offerValidDays?: number | undefined;
      conditions?: string | undefined;
      reason?: string | undefined;
      supersede?: boolean | undefined;
    },
  ): Promise<AdmissionDecision> {
    if (input.outcome === 'offered' && !input.offeredSectionId) {
      throw ApiError.make('validation_error', 'offer_needs_section',
        'An offer must name the section being offered.');
    }
    if (input.outcome === 'rejected' && !input.reason?.trim()) {
      throw ApiError.make('validation_error', 'rejection_needs_reason',
        'A rejection must record a reason.');
    }

    const decision = await withTenant(scope, async (db) => {
      const pending = await db.query<{ id: string; status: string }>(
        `SELECT id, status FROM application WHERE id = $1 AND deleted_at IS NULL`,
        [input.applicationId],
      );
      if (!pending.rows[0]) {
        throw ApiError.make('not_found', 'application_not_found', 'Application not found.');
      }
      if (pending.rows[0].status === 'draft') {
        throw ApiError.make('conflict', 'application_not_submitted',
          'A draft application cannot be decided.');
      }

      if (input.supersede) {
        await db.query(
          `UPDATE admission_decision SET superseded_at = now()
            WHERE application_id = $1 AND superseded_at IS NULL AND accepted_at IS NULL`,
          [input.applicationId],
        );
      }

      const { rows } = await db.query<AdmissionDecision>(
        `INSERT INTO admission_decision
           (tenant_id, application_id, outcome, decided_by, offered_section_id,
            offer_expires_at, conditions, reason)
         VALUES (app_current_tenant_id(), $1, $2, $3, $4,
                 CASE WHEN $2 = 'offered'
                      THEN now() + make_interval(days => COALESCE($5::int, 14))
                      ELSE NULL END,
                 $6, $7)
         RETURNING id, application_id, outcome, offered_section_id, offer_expires_at,
                   accepted_at, declined_at`,
        [input.applicationId, input.outcome, input.decidedByStaffId,
         input.offeredSectionId ?? null, input.offerValidDays ?? null,
         input.conditions ?? null, input.reason ?? null],
      );

      await db.query(`UPDATE application SET status = 'decided' WHERE id = $1`,
        [input.applicationId]);
      return rows[0]!;
    });

    await auditService.record({
      tenantId: scope.tenantId,
      actorUserId: scope.actorId,
      action: 'admission.decided',
      resourceType: 'admission_decision',
      resourceId: decision.id,
      classification: 'SENSITIVE',
      after: { outcome: decision.outcome },
      ...(input.reason ? { reason: input.reason } : {}),
    });
    return decision;
  },

  /**
   * Acceptance, then enrollment, in one transaction.
   *
   * The applicant becomes a learner here: a `student` row is created if there
   * is not one already, and the enrollment is opened against the offered
   * section. Splitting this across two transactions would allow an accepted
   * offer with no enrollment, which is the state nobody notices until fees.
   */
  async acceptOfferAndEnrol(
    scope: TenantScope,
    input: { decisionId: string; admissionNoPrefix?: string | undefined;
             rollNo?: string | undefined },
  ): Promise<{ decision: AdmissionDecision; enrollment: EnrollmentRow }> {
    const result = await withTenant(scope, async (db) => {
      const found = await db.query<{
        id: string; application_id: string; outcome: string; offered_section_id: string | null;
        offer_expires_at: Date | null; accepted_at: Date | null; declined_at: Date | null;
        applicant_person_id: string; academic_year_id: string;
      }>(
        `SELECT d.id, d.application_id, d.outcome, d.offered_section_id, d.offer_expires_at,
                d.accepted_at, d.declined_at,
                a.applicant_person_id, a.academic_year_id
           FROM admission_decision d
           JOIN application a ON a.id = d.application_id
          WHERE d.id = $1 AND d.superseded_at IS NULL`,
        [input.decisionId],
      );
      const d = found.rows[0];
      if (!d) throw ApiError.make('not_found', 'decision_not_found', 'No live decision found.');
      if (d.outcome !== 'offered') {
        throw ApiError.make('conflict', 'not_an_offer', 'Only an offer can be accepted.');
      }
      if (d.accepted_at) {
        throw ApiError.make('conflict', 'already_accepted', 'This offer was already accepted.');
      }
      if (d.declined_at) {
        throw ApiError.make('conflict', 'already_declined', 'This offer was declined.');
      }
      if (d.offer_expires_at && d.offer_expires_at <= new Date()) {
        // Evaluated here rather than by a sweeper job, so an offer lapses
        // exactly on time even if no job has run.
        throw ApiError.make('conflict', 'offer_expired', 'This offer has expired.');
      }

      await db.query('UPDATE admission_decision SET accepted_at = now() WHERE id = $1', [d.id]);

      const existing = await db.query<{ id: string }>(
        'SELECT id FROM student WHERE person_id = $1 AND deleted_at IS NULL',
        [d.applicant_person_id],
      );
      let studentId = existing.rows[0]?.id;

      if (!studentId) {
        await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',
          [`admno:${d.academic_year_id}`]);
        const prefix = input.admissionNoPrefix ?? 'ADM-';
        const next = await db.query<{ next: string }>(
          `SELECT COALESCE(max(substring(admission_no from '[0-9]+$')::int), 0) + 1 AS next
             FROM student WHERE admission_no LIKE $1 || '%'`,
          [prefix],
        );
        const admissionNo = `${prefix}${String(next.rows[0]!.next).padStart(5, '0')}`;

        const created = await db.query<{ id: string }>(
          `INSERT INTO student (tenant_id, person_id, admission_no, lifecycle_status, first_admitted_on)
           VALUES (app_current_tenant_id(), $1, $2, 'enrolled', CURRENT_DATE)
           RETURNING id`,
          [d.applicant_person_id, admissionNo],
        );
        studentId = created.rows[0]!.id;
      } else {
        await db.query(
          `UPDATE student SET lifecycle_status = 'enrolled',
                              first_admitted_on = COALESCE(first_admitted_on, CURRENT_DATE)
            WHERE id = $1`,
          [studentId],
        );
      }

      const enrolled = await db.query<EnrollmentRow>(
        `INSERT INTO enrollment
           (tenant_id, student_id, section_id, academic_year_id, admission_decision_id, roll_no)
         VALUES (app_current_tenant_id(), $1, $2, $3, $4, $5)
         RETURNING id, student_id, section_id, academic_year_id, status, roll_no`,
        [studentId, d.offered_section_id, d.academic_year_id, d.id, input.rollNo ?? null],
      );
      const enrollment = enrolled.rows[0]!;

      await db.query(
        `INSERT INTO enrollment_event
           (tenant_id, enrollment_id, event_type, to_section_id, actor_user_id, reason)
         VALUES (app_current_tenant_id(), $1, 'enrolled', $2, $3, 'Offer accepted.')`,
        [enrollment.id, enrollment.section_id, scope.actorId ?? null],
      );

      const decision = await db.query<AdmissionDecision>(
        `SELECT id, application_id, outcome, offered_section_id, offer_expires_at,
                accepted_at, declined_at
           FROM admission_decision WHERE id = $1`,
        [d.id],
      );
      return { decision: decision.rows[0]!, enrollment };
    });

    await auditService.record({
      tenantId: scope.tenantId,
      actorUserId: scope.actorId,
      action: 'admission.accepted',
      resourceType: 'enrollment',
      resourceId: result.enrollment.id,
      classification: 'SENSITIVE',
      after: {
        studentId: result.enrollment.student_id,
        sectionId: result.enrollment.section_id,
      },
    });
    return result;
  },

  async declineOffer(scope: TenantScope, decisionId: string, reason?: string): Promise<void> {
    await withTenant(scope, async (db) => {
      const { rows } = await db.query<{ id: string }>(
        `UPDATE admission_decision SET declined_at = now()
          WHERE id = $1 AND superseded_at IS NULL AND accepted_at IS NULL AND declined_at IS NULL
          RETURNING id`,
        [decisionId],
      );
      if (!rows[0]) {
        throw ApiError.make('conflict', 'cannot_decline',
          'That offer is not in a state that can be declined.');
      }
    });

    await auditService.record({
      tenantId: scope.tenantId,
      actorUserId: scope.actorId,
      action: 'admission.declined',
      resourceType: 'admission_decision',
      resourceId: decisionId,
      classification: 'SENSITIVE',
      ...(reason ? { reason } : {}),
    });
  },
};
