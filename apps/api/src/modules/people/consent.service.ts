import { withTenant, type TenantScope } from '../../db/tenant.ts';
import { auditService } from '../audit/audit.service.ts';
import { ApiError } from '../../common/errors.ts';

export type ConsentPurpose =
  | 'core_education_service'
  | 'attendance_notifications'
  | 'fee_notifications'
  | 'photo_publication'
  | 'transport_tracking'
  | 'third_party_assessment'
  | 'marketing';

/**
 * Processing necessary to deliver the education contract is not consent-based,
 * so withdrawing consent must not be able to switch it off. Keeping this list in
 * code next to the schema CHECK means the distinction is reviewable in a diff.
 *
 * Which purposes belong on which side is a legal question, flagged for counsel.
 */
const CONTRACT_BASIS_PURPOSES = new Set<ConsentPurpose>(['core_education_service']);

export interface ConsentRecord {
  id: string;
  person_id: string;
  given_by_person_id: string;
  purpose: string;
  basis: string;
  notice_version_id: string;
  given_at: Date;
  withdrawn_at: Date | null;
}

export const consentService = {
  /**
   * Records consent against a specific notice version.
   *
   * `givenByPersonId` differs from `personId` whenever a guardian consents for a
   * minor, which is the normal case in a school. The record keeps both, so
   * "who agreed to this, and to what text" is answerable years later.
   */
  async give(
    scope: TenantScope,
    input: {
      personId: string;
      givenByPersonId: string;
      purpose: ConsentPurpose;
      noticeVersionId: string;
      channel: 'app' | 'web' | 'paper' | 'in_person';
      guardianLinkId?: string | undefined;
      evidenceRef?: string | undefined;
    },
  ): Promise<ConsentRecord> {
    const basis = CONTRACT_BASIS_PURPOSES.has(input.purpose) ? 'contract' : 'consent';

    const record = await withTenant(scope, async (db) => {
      const notice = await db.query<{ id: string }>(
        'SELECT id FROM notice_version WHERE id = $1 AND published_at IS NOT NULL',
        [input.noticeVersionId],
      );
      if (!notice.rows[0]) {
        // Consent against an unpublished draft is not evidence of anything.
        throw ApiError.make('validation_error', 'notice_not_published',
          'Consent must reference a published notice version.');
      }

      const { rows } = await db.query<ConsentRecord>(
        `INSERT INTO consent_record
           (tenant_id, person_id, given_by_person_id, guardian_link_id, purpose, basis,
            notice_version_id, channel, evidence_ref)
         VALUES (app_current_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT DO NOTHING
         RETURNING id, person_id, given_by_person_id, purpose, basis, notice_version_id,
                   given_at, withdrawn_at`,
        [input.personId, input.givenByPersonId, input.guardianLinkId ?? null, input.purpose,
         basis, input.noticeVersionId, input.channel, input.evidenceRef ?? null],
      );
      if (!rows[0]) {
        throw ApiError.make('conflict', 'consent_already_given',
          'Live consent already exists for this purpose.');
      }
      return rows[0];
    });

    await auditService.record({
      tenantId: scope.tenantId,
      actorUserId: scope.actorId,
      action: 'consent.given',
      resourceType: 'consent_record',
      resourceId: record.id,
      classification: 'RESTRICTED',
      after: { purpose: input.purpose, basis, noticeVersionId: input.noticeVersionId },
    });
    return record;
  },

  /**
   * Withdraws consent. One tap in the app, effective immediately, and the record
   * stays — a deleted consent record cannot answer "on what basis did you
   * process this in March".
   */
  async withdraw(
    scope: TenantScope,
    input: { personId: string; purpose: ConsentPurpose; reason?: string | undefined },
  ): Promise<void> {
    if (CONTRACT_BASIS_PURPOSES.has(input.purpose)) {
      throw ApiError.make('validation_error', 'purpose_not_consent_based',
        'This processing is necessary to provide the service and is not consent-based. ' +
        'Closing the account is the way to end it.');
    }

    const withdrawn = await withTenant(scope, async (db) => {
      const { rows } = await db.query<{ id: string }>(
        `UPDATE consent_record
            SET withdrawn_at = now(), withdrawn_reason = $3
          WHERE person_id = $1 AND purpose = $2 AND withdrawn_at IS NULL
          RETURNING id`,
        [input.personId, input.purpose, input.reason ?? null],
      );
      if (!rows[0]) {
        throw ApiError.make('not_found', 'no_live_consent', 'No live consent for that purpose.');
      }
      return rows[0];
    });

    await auditService.record({
      tenantId: scope.tenantId,
      actorUserId: scope.actorId,
      action: 'consent.withdrawn',
      resourceType: 'consent_record',
      resourceId: withdrawn.id,
      classification: 'RESTRICTED',
      before: { purpose: input.purpose },
      ...(input.reason ? { reason: input.reason } : {}),
    });
  },

  /**
   * The question the notification dispatcher asks at send time, per recipient.
   * Contract-basis processing is always permitted; everything else needs a live
   * consent row.
   */
  async isPermitted(
    scope: TenantScope,
    personId: string,
    purpose: ConsentPurpose,
  ): Promise<boolean> {
    if (CONTRACT_BASIS_PURPOSES.has(purpose)) return true;
    return withTenant(scope, async (db) => {
      const { rows } = await db.query<{ ok: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM consent_record
            WHERE person_id = $1 AND purpose = $2 AND withdrawn_at IS NULL
         ) AS ok`,
        [personId, purpose],
      );
      return rows[0]?.ok ?? false;
    });
  },

  async listFor(scope: TenantScope, personId: string): Promise<ConsentRecord[]> {
    return withTenant(scope, async (db) => {
      const { rows } = await db.query<ConsentRecord>(
        `SELECT id, person_id, given_by_person_id, purpose, basis, notice_version_id,
                given_at, withdrawn_at
           FROM consent_record WHERE person_id = $1 ORDER BY given_at DESC`,
        [personId],
      );
      return rows;
    });
  },
};
