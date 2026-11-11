/**
 * Onboarding a school.
 *
 * Every step is in ONE transaction, and that is not tidiness. A school that
 * exists with no campus cannot enrol anybody; one with no owner account cannot
 * be logged into at all and needs a DBA to rescue — which is the exact
 * situation this module exists to end. Partial provisioning is worse than
 * failed provisioning, because failure is visible.
 *
 * Idempotent on a caller-supplied key, because onboarding is the one operation
 * nobody retries carefully. Somebody refreshes a page mid-sale and a second
 * school appears with the same name and no data in it; a week later nobody can
 * tell which one the customer has been using.
 */
import { randomUUID } from 'node:crypto';
import { withPlatform } from '../../db/platform-pool.ts';
import { ApiError } from '../../common/errors.ts';
import { logger } from '../../common/logger.ts';
import { domainService } from '../branding/domain.service.ts';
import { auditService } from '../audit/audit.service.ts';
import { passwordService } from '../auth/password.service.ts';

export interface ProvisionInput {
  /** Unique per intended school. A retry with the same key returns the first result. */
  requestKey: string;
  legalName: string;
  displayName: string;
  ownerEmail: string;
  /** The first campus. A school without one cannot enrol anybody. */
  campusName: string;
  campusCode: string;
  /** Free-form, e.g. 'CBSE'. Recorded, never validated against a list we maintain. */
  boardOrAffiliation?: string | undefined;
  timezone?: string | undefined;
}

export interface ProvisionResult {
  tenantId: string;
  campusId: string;
  academicUnitId: string;
  ownerUserId: string;
  /** Shown once. The owner changes it at first sign-in. */
  temporaryPassword: string;
  /** True when this call created the school; false when it replayed an earlier one. */
  created: boolean;
  /**
   * The school's web address, allocated at creation.
   *
   * Absent only when allocation failed, which is logged and does not undo the
   * school — a missing subdomain is fixable afterwards; a half-created school
   * is not.
   */
  host?: string;
}

/** Enough entropy that it is a real credential, short enough to read down a phone. */
function temporaryPassword(): string {
  // Ambiguous characters left out: somebody reads this aloud to a principal.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = new Uint8Array(20);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

export const provisioningService = {
  /**
   * Creates a school, its first campus and academic unit, and the owner login.
   *
   * @param actorUserId the platform administrator doing this, for the record.
   */
  async provision(actorUserId: string, input: ProvisionInput): Promise<ProvisionResult> {
    const password = temporaryPassword();
    const passwordHash = await passwordService.hash(password);

    const result = await withPlatform(async (db) => {
      // The replay check, inside the transaction.
      //
      // What actually guarantees one school per key is the unique index on
      // request_key: two concurrent retries both read nothing here, both begin
      // provisioning, and the second one's INSERT into tenant_provisioning
      // fails, rolling its whole transaction back. The row lock below does not
      // add correctness — a mutation removing it changed no outcome — it stops
      // the loser doing the entire provisioning first and throwing it away.
      const existing = await db.query<{
        tenant_id: string | null; status: string; failure_reason: string | null;
      }>(
        `SELECT tenant_id, status, failure_reason
           FROM tenant_provisioning WHERE request_key = $1 FOR UPDATE`,
        [input.requestKey]);

      if (existing.rows[0]) {
        const prior = existing.rows[0];
        if (prior.status === 'failed') {
          throw ApiError.make('conflict', 'provisioning_previously_failed',
            `That request key was already used by an attempt that failed: `
            + `${prior.failure_reason}. Use a new key.`);
        }
        const structure = await db.query<{
          campus_id: string; academic_unit_id: string; owner_user_id: string;
        }>(
          `SELECT c.id AS campus_id, au.id AS academic_unit_id, rg.user_account_id AS owner_user_id
             FROM campus c
             JOIN academic_unit au ON au.campus_id = c.id
             JOIN role_grant rg ON rg.tenant_id = c.tenant_id AND rg.role = 'ORG_OWNER'
            WHERE c.tenant_id = $1
            ORDER BY c.created_at LIMIT 1`,
          [prior.tenant_id]);
        const s = structure.rows[0];
        if (!s) {
          throw ApiError.make('conflict', 'provisioning_incomplete',
            'An earlier attempt with this key left an incomplete school. '
            + 'This needs a human to look at it.');
        }
        return {
          tenantId: prior.tenant_id!,
          campusId: s.campus_id,
          academicUnitId: s.academic_unit_id,
          ownerUserId: s.owner_user_id,
          // Not re-issued. The first call's password was shown once and this is
          // not a way to recover it — that is what a password reset is for.
          temporaryPassword: '',
          created: false,
        };
      }

      const org = await db.query<{ id: string }>(
        `INSERT INTO organization (legal_name, display_name, timezone)
         VALUES ($1, $2, COALESCE($3, 'Asia/Kolkata')) RETURNING id`,
        [input.legalName, input.displayName, input.timezone ?? null]);
      const tenantId = org.rows[0]!.id;

      const campus = await db.query<{ id: string }>(
        `INSERT INTO campus (tenant_id, code, name, is_primary)
         VALUES ($1, $2, $3, true) RETURNING id`,
        [tenantId, input.campusCode, input.campusName]);
      const campusId = campus.rows[0]!.id;

      const unit = await db.query<{ id: string }>(
        `INSERT INTO academic_unit
           (tenant_id, campus_id, code, name, unit_type, board_or_affiliation)
         VALUES ($1, $2, $3, $4, 'school', $5) RETURNING id`,
        [tenantId, campusId, `${input.campusCode}-MAIN`,
         input.displayName, input.boardOrAffiliation ?? null]);

      // The owner's login. This role can write a password hash and cannot read
      // one back — see the column grants in 0050.
      const owner = await db.query<{ id: string }>(
        `INSERT INTO user_account (login_email, password_hash, status)
         VALUES ($1, $2, 'active') RETURNING id`,
        [input.ownerEmail.toLowerCase(), passwordHash]);
      const ownerUserId = owner.rows[0]!.id;

      await db.query(
        `INSERT INTO role_grant
           (tenant_id, user_account_id, role, scope_type, granted_by)
         VALUES ($1, $2, 'ORG_OWNER', 'organization', $3)`,
        [tenantId, ownerUserId, actorUserId]);

      await db.query(
        `INSERT INTO tenant_provisioning
           (tenant_id, request_key, legal_name, display_name, owner_email, provisioned_by)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [tenantId, input.requestKey, input.legalName, input.displayName,
         input.ownerEmail.toLowerCase(), actorUserId]);

      return {
        tenantId,
        campusId,
        academicUnitId: unit.rows[0]!.id,
        ownerUserId,
        temporaryPassword: password,
        created: true,
      };
    });

    if (result.created) {
      // Creating a school is the single most consequential action available on
      // this platform, and the audit row says who did it and for whom.
      await auditService.record({
        tenantId: result.tenantId,
        action: 'platform.tenant.provisioned',
        resourceType: 'organization',
        resourceId: result.tenantId,
        actorUserId,
        classification: 'RESTRICTED',
        after: {
          legal_name: input.legalName,
          display_name: input.displayName,
          owner_email: input.ownerEmail.toLowerCase(),
        },
      });

      // A school with no address is a school nobody can reach: the sign-in
      // screen resolves the tenant from the host, so provisioning without one
      // would hand somebody a login page that cannot know whose it is.
      //
      // Outside the transaction deliberately — a subdomain collision must not
      // roll back a school that is otherwise correctly created.
      try {
        const domain = await domainService.allocateManaged(
          actorUserId, result.tenantId, input.displayName);
        return { ...result, host: domain.host };
      } catch (err) {
        logger.error({ err, tenant_id: result.tenantId },
          'school provisioned but no subdomain could be allocated');
      }
    }

    return result;
  },

  /** The customer list. Counts, not contents. */
  async listTenants(): Promise<Array<{
    id: string; display_name: string; legal_name: string; status: string;
    created_at: string; campuses: number;
  }>> {
    return withPlatform(async (db) => {
      const { rows } = await db.query<{
        id: string; display_name: string; legal_name: string; status: string;
        created_at: string; campuses: number;
      }>(
        // What a customer list legitimately needs. Learner and invoice counts
        // would be more useful and are deliberately absent: this role has no
        // grant on those tables, and widening it "just for a count" is how a
        // console becomes a way to read a school.
        `SELECT o.id, o.display_name, o.legal_name, o.status,
                o.created_at,
                (SELECT count(*)::int FROM campus c
                  WHERE c.tenant_id = o.id AND c.deleted_at IS NULL) AS campuses
           FROM organization o
          WHERE o.deleted_at IS NULL
          ORDER BY o.created_at DESC`);
      return rows;
    });
  },

  /** Suspends a school without deleting anything. */
  async setStatus(
    actorUserId: string, tenantId: string, status: 'active' | 'suspended',
  ): Promise<void> {
    await withPlatform(async (db) => {
      const { rowCount } = await db.query(
        'UPDATE organization SET status = $2 WHERE id = $1 AND deleted_at IS NULL',
        [tenantId, status]);
      if (rowCount === 0) {
        throw ApiError.make('not_found', 'tenant_not_found', 'No such school.');
      }
    });
    await auditService.record({
      tenantId, action: `platform.tenant.${status}`,
      resourceType: 'organization', resourceId: tenantId,
      actorUserId, classification: 'RESTRICTED',
    });
  },

  /** A fresh request key, for a caller that has no natural one. */
  newRequestKey(): string {
    return `prov-${randomUUID()}`;
  },
};
