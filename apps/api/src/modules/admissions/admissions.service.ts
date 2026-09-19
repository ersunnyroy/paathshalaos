import { withTenant, type TenantScope, type TenantClient } from '../../db/tenant.ts';
import { auditService } from '../audit/audit.service.ts';
import { ApiError } from '../../common/errors.ts';

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
    const created = await withTenant(scope, async (db) => {
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
    });

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
    input: { documentId: string; verifierStaffId: string; accept: boolean; reason?: string },
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
      offeredSectionId?: string;
      offerValidDays?: number;
      conditions?: string;
      reason?: string;
      supersede?: boolean;
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
    input: { decisionId: string; admissionNoPrefix?: string; rollNo?: string },
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
