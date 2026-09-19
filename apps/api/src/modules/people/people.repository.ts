import { withTenant, type TenantScope } from '../../db/tenant.ts';
import { withHealthScope } from '../../db/health-pool.ts';
import { auditService } from '../audit/audit.service.ts';
import { ApiError } from '../../common/errors.ts';

export interface Person {
  id: string;
  given_name: string;
  family_name: string | null;
  preferred_name: string | null;
  date_of_birth: string | null;
}

export interface Student {
  id: string;
  person_id: string;
  admission_no: string;
  lifecycle_status: string;
}

export interface GuardianLink {
  id: string;
  student_id: string;
  guardian_person_id: string;
  relationship: string;
  is_primary: boolean;
  can_view_academics: boolean;
  can_view_finance: boolean;
  can_pay: boolean;
  can_authorise_pickup: boolean;
  can_receive_notifications: boolean;
}

/** The RESTRICTED columns. Never returned by a list query. */
export interface StudentSensitive {
  blood_group: string | null;
  medical_note: string | null;
  accommodations: string | null;
  emergency_contact_name: string | null;
  emergency_contact_phone: string | null;
}

/**
 * Note what is absent from every method below: a guardian filter.
 *
 * `listStudents` is the same SQL for a principal and for a parent. The principal
 * sees the school; the parent sees their two children. That difference lives in
 * the row-level security policy from migration 0012, not in a `WHERE` clause a
 * developer has to remember — which is what "enforced at the query, not the UI"
 * has to mean if it is to survive the twentieth endpoint.
 */
export const peopleRepository = {
  async listStudents(scope: TenantScope, opts: { limit?: number } = {}): Promise<Student[]> {
    return withTenant(scope, async (db) => {
      const { rows } = await db.query<Student>(
        `SELECT id, person_id, admission_no, lifecycle_status
           FROM student
          WHERE deleted_at IS NULL
          ORDER BY admission_no
          LIMIT $1`,
        [Math.min(opts.limit ?? 100, 500)],
      );
      return rows;
    });
  },

  async findStudent(scope: TenantScope, studentId: string): Promise<Student | undefined> {
    return withTenant(scope, async (db) => {
      const { rows } = await db.query<Student>(
        `SELECT id, person_id, admission_no, lifecycle_status
           FROM student WHERE id = $1 AND deleted_at IS NULL`,
        [studentId],
      );
      return rows[0];
    });
  },

  /**
   * Reads the RESTRICTED columns, and audits the read.
   *
   * Separate from findStudent so the decision "this is a sensitive read" is made
   * at the call site and is greppable. Two gates: the row must be visible under
   * RLS, and a guardian must additionally hold can_view_academics — a capability
   * check that belongs to the relationship, not the role.
   */
  /**
   * The RESTRICTED columns, read on the third role.
   *
   * Since migration 0045 the ordinary application role has no column privilege
   * on blood_group, medical_note, accommodations or the emergency contacts, so
   * this is the only path to them and it is one line to find in review. The
   * point is not that this function is careful — it is that every other query
   * in the codebase now fails loudly if it reaches for these fields, including
   * the `SELECT *` somebody adds to a debug log at 11pm.
   *
   * The visibility rule is unchanged and still lives in SQL: staff, or a
   * guardian whose link carries can_view_academics. The health role is subject
   * to row-level security exactly as the app role is, so widening which COLUMNS
   * are reachable did not widen which ROWS are.
   */
  async findStudentSensitive(
    scope: TenantScope,
    studentId: string,
  ): Promise<StudentSensitive | undefined> {
    if (!scope.actorId) {
      throw new Error('findStudentSensitive requires an actor; a machine client has no path here.');
    }

    const row = await withHealthScope({ tenantId: scope.tenantId, actorId: scope.actorId },
      async (db) => {
        const { rows } = await db.query<StudentSensitive>(
          `SELECT s.blood_group, s.medical_note, s.accommodations,
                  s.emergency_contact_name, s.emergency_contact_phone
             FROM student s
            WHERE s.id = $1
              AND s.deleted_at IS NULL
              AND (
                app_actor_has_staff_scope()
                OR EXISTS (
                  SELECT 1 FROM guardian_link gl
                   WHERE gl.student_id = s.id
                     AND gl.guardian_person_id = app_current_person_id()
                     AND gl.effective_to IS NULL
                     AND gl.can_view_academics
                )
              )`,
          [studentId],
        );
        return rows[0];
      });

    // Audited whether or not it returned anything: a refused attempt on a
    // medical note is exactly as interesting as a successful one.
    await auditService.recordRead({
      tenantId: scope.tenantId,
      actorUserId: scope.actorId,
      action: row ? 'student.sensitive.read' : 'student.sensitive.read_denied',
      resourceType: 'student',
      resourceId: studentId,
      classification: 'RESTRICTED',
    });

    if (!row) return undefined;
    return row;
  },

  /** The guardian app's first call on launch: which learners am I linked to. */
  async linkedLearners(
    scope: TenantScope,
  ): Promise<Array<Student & { relationship: string; can_view_finance: boolean }>> {
    return withTenant(scope, async (db) => {
      const { rows } = await db.query<Student & { relationship: string; can_view_finance: boolean }>(
        `SELECT s.id, s.person_id, s.admission_no, s.lifecycle_status,
                gl.relationship, gl.can_view_finance
           FROM student s
           JOIN guardian_link gl ON gl.student_id = s.id
          WHERE gl.guardian_person_id = app_current_person_id()
            AND gl.effective_to IS NULL
            AND s.deleted_at IS NULL
          ORDER BY s.admission_no`,
      );
      return rows;
    });
  },

  async guardiansOf(scope: TenantScope, studentId: string): Promise<GuardianLink[]> {
    return withTenant(scope, async (db) => {
      const { rows } = await db.query<GuardianLink>(
        `SELECT id, student_id, guardian_person_id, relationship, is_primary,
                can_view_academics, can_view_finance, can_pay,
                can_authorise_pickup, can_receive_notifications
           FROM guardian_link
          WHERE student_id = $1 AND effective_to IS NULL
          ORDER BY is_primary DESC`,
        [studentId],
      );
      return rows;
    });
  },

  async createPerson(
    scope: TenantScope,
    input: { givenName: string; familyName?: string; dateOfBirth?: string; userAccountId?: string },
  ): Promise<Person> {
    return withTenant(scope, async (db) => {
      const { rows } = await db.query<Person>(
        `INSERT INTO person (tenant_id, given_name, family_name, date_of_birth, user_account_id)
         VALUES (app_current_tenant_id(), $1, $2, $3, $4)
         RETURNING id, given_name, family_name, preferred_name, date_of_birth`,
        [input.givenName, input.familyName ?? null, input.dateOfBirth ?? null,
         input.userAccountId ?? null],
      );
      return rows[0]!;
    });
  },

  async createStudent(
    scope: TenantScope,
    input: { personId: string; admissionNo: string; lifecycleStatus?: string },
  ): Promise<Student> {
    const created = await withTenant(scope, async (db) => {
      const { rows } = await db.query<Student>(
        `INSERT INTO student (tenant_id, person_id, admission_no, lifecycle_status)
         VALUES (app_current_tenant_id(), $1, $2, COALESCE($3, 'enquiry'))
         RETURNING id, person_id, admission_no, lifecycle_status`,
        [input.personId, input.admissionNo, input.lifecycleStatus ?? null],
      );
      return rows[0]!;
    });

    await auditService.record({
      tenantId: scope.tenantId,
      actorUserId: scope.actorId,
      action: 'student.created',
      resourceType: 'student',
      resourceId: created.id,
      classification: 'SENSITIVE',
      after: { admissionNo: created.admission_no },
    });
    return created;
  },

  /**
   * Links a guardian. Staff only — enforced by the WITH CHECK on guardian_link,
   * so a guardian cannot attach themselves to a learner even by calling this
   * directly. That is a child-safety boundary, not a UI concern.
   */
  async linkGuardian(
    scope: TenantScope,
    input: {
      studentId: string;
      guardianPersonId: string;
      relationship: string;
      isPrimary?: boolean;
      capabilities?: Partial<{
        canViewAcademics: boolean; canViewFinance: boolean; canPay: boolean;
        canAuthorisePickup: boolean; canReceiveNotifications: boolean;
      }>;
      legalCustodyNote?: string;
    },
  ): Promise<GuardianLink> {
    const c = input.capabilities ?? {};
    const created = await withTenant(scope, async (db) => {
      const { rows } = await db.query<GuardianLink>(
        `INSERT INTO guardian_link
           (tenant_id, student_id, guardian_person_id, relationship, is_primary,
            can_view_academics, can_view_finance, can_pay,
            can_authorise_pickup, can_receive_notifications, legal_custody_note)
         VALUES (app_current_tenant_id(), $1, $2, $3, COALESCE($4, false),
                 COALESCE($5, true), COALESCE($6, true), COALESCE($7, true),
                 COALESCE($8, true), COALESCE($9, true), $10)
         RETURNING id, student_id, guardian_person_id, relationship, is_primary,
                   can_view_academics, can_view_finance, can_pay,
                   can_authorise_pickup, can_receive_notifications`,
        [input.studentId, input.guardianPersonId, input.relationship,
         input.isPrimary ?? null,
         c.canViewAcademics ?? null, c.canViewFinance ?? null, c.canPay ?? null,
         c.canAuthorisePickup ?? null, c.canReceiveNotifications ?? null,
         input.legalCustodyNote ?? null],
      );
      if (!rows[0]) {
        throw ApiError.make('permission_error', 'cannot_link_guardian',
          'Only institute staff may link a guardian to a learner.');
      }
      return rows[0];
    });

    await auditService.record({
      tenantId: scope.tenantId,
      actorUserId: scope.actorId,
      action: 'guardian.linked',
      resourceType: 'guardian_link',
      resourceId: created.id,
      classification: 'SENSITIVE',
      after: { studentId: input.studentId, relationship: input.relationship },
    });
    return created;
  },

  /** Ends a link. History is preserved: the row stays, effective_to is set. */
  async endGuardianLink(scope: TenantScope, linkId: string, reason: string): Promise<void> {
    const ended = await withTenant(scope, async (db) => {
      const { rows } = await db.query<{ id: string }>(
        `UPDATE guardian_link SET effective_to = CURRENT_DATE
          WHERE id = $1 AND effective_to IS NULL
          RETURNING id`,
        [linkId],
      );
      if (!rows[0]) throw ApiError.make('not_found', 'link_not_found', 'Guardian link not found.');
      return rows[0];
    });

    await auditService.record({
      tenantId: scope.tenantId,
      actorUserId: scope.actorId,
      action: 'guardian.unlinked',
      resourceType: 'guardian_link',
      resourceId: ended.id,
      classification: 'SENSITIVE',
      reason,
    });
  },
};
