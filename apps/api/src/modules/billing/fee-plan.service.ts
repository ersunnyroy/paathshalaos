import { withTenant, type TenantScope, type TenantClient } from '../../db/tenant.ts';
import { auditService } from '../audit/audit.service.ts';
import { ApiError } from '../../common/errors.ts';
import { Money, type Paise } from './money.ts';

export interface FeePlan {
  id: string;
  name: string;
  version: number;
  status: string;
}

export interface Installment {
  id: string;
  sequence: number;
  due_on: string;
  gross_amount: string;
  concession_amount: string;
  net_amount: string;
  status: string;
}

export const feePlanService = {
  async createDraft(
    scope: TenantScope,
    input: {
      academicUnitId: string; academicYearId: string; name: string; programmeId?: string;
      components: Array<{
        code: string; name: string; amountPaise: bigint;
        frequency: 'one_time' | 'monthly' | 'term' | 'annual';
        isRefundable?: boolean; isOptional?: boolean; taxRate?: number; glCode?: string;
      }>;
    },
  ): Promise<FeePlan> {
    if (input.components.length === 0) {
      throw ApiError.make('validation_error', 'plan_needs_components',
        'A fee plan must have at least one component.');
    }

    return withTenant(scope, async (db) => {
      const { rows } = await db.query<FeePlan>(
        `INSERT INTO fee_plan
           (tenant_id, academic_unit_id, programme_id, academic_year_id, name, version)
         VALUES (app_current_tenant_id(), $1, $2, $3, $4,
                 COALESCE((SELECT max(version) FROM fee_plan
                            WHERE tenant_id = app_current_tenant_id()
                              AND academic_year_id = $3 AND name = $4), 0) + 1)
         RETURNING id, name, version, status`,
        [input.academicUnitId, input.programmeId ?? null, input.academicYearId, input.name],
      );
      if (!rows[0]) {
        throw ApiError.make('permission_error', 'staff_only', 'Only staff may define fee plans.');
      }
      const plan = rows[0];

      let order = 0;
      for (const c of input.components) {
        await db.query(
          `INSERT INTO fee_component
             (tenant_id, fee_plan_id, code, name, amount, frequency,
              is_refundable, is_optional, tax_rate, gl_code, sort_order)
           VALUES (app_current_tenant_id(), $1, $2, $3, $4::numeric, $5, $6, $7, $8::numeric, $9, $10)`,
          [plan.id, c.code, c.name, Money.toDecimalString(c.amountPaise), c.frequency,
           c.isRefundable ?? false, c.isOptional ?? false, c.taxRate ?? 0, c.glCode ?? null,
           order++],
        );
      }
      return plan;
    });
  },

  async publish(scope: TenantScope, feePlanId: string, publishedByStaffId: string): Promise<FeePlan> {
    const published = await withTenant(scope, async (db) => {
      const { rows } = await db.query<FeePlan>(
        `UPDATE fee_plan
            SET status = 'published', published_at = now(), published_by = $2
          WHERE id = $1 AND status = 'draft'
          RETURNING id, name, version, status`,
        [feePlanId, publishedByStaffId],
      );
      if (!rows[0]) {
        throw ApiError.make('conflict', 'not_a_draft',
          'That plan is not a draft, or does not exist.');
      }
      return rows[0];
    });

    await auditService.record({
      tenantId: scope.tenantId,
      actorUserId: scope.actorId,
      action: 'fee_plan.published',
      resourceType: 'fee_plan',
      resourceId: published.id,
      classification: 'INTERNAL',
      after: { name: published.name, version: published.version },
    });
    return published;
  },

  /** Assigns a published plan to an enrollment. A draft is not billable. */
  async assign(
    scope: TenantScope,
    input: { enrollmentId: string; feePlanId: string; effectiveFrom?: string },
  ): Promise<{ id: string }> {
    return withTenant(scope, async (db) => {
      const plan = await db.query<{ status: string }>(
        'SELECT status FROM fee_plan WHERE id = $1', [input.feePlanId],
      );
      if (!plan.rows[0]) {
        throw ApiError.make('not_found', 'plan_not_found', 'Fee plan not found.');
      }
      if (plan.rows[0].status !== 'published') {
        throw ApiError.make('conflict', 'plan_not_published',
          'A draft fee plan cannot be assigned; publish it first.');
      }

      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO fee_assignment (tenant_id, enrollment_id, fee_plan_id, effective_from)
         VALUES (app_current_tenant_id(), $1, $2, COALESCE($3::date, CURRENT_DATE))
         RETURNING id`,
        [input.enrollmentId, input.feePlanId, input.effectiveFrom ?? null],
      );
      return rows[0]!;
    });
  },

  /** A concession only reduces anything once a second person has approved it. */
  async grantConcession(
    scope: TenantScope,
    input: {
      feeAssignmentId: string;
      concessionType: 'sibling' | 'staff_ward' | 'rte' | 'merit' | 'need_based' | 'early_payment' | 'custom';
      mode: 'percent' | 'amount';
      value: number | bigint;
      reason: string;
      requestedByStaffId: string;
      feeComponentId?: string;
    },
  ): Promise<{ id: string }> {
    if (!input.reason.trim()) {
      throw ApiError.make('validation_error', 'reason_required',
        'A concession must record why it was granted.');
    }
    const value = input.mode === 'percent'
      ? String(input.value)
      : Money.toDecimalString(BigInt(input.value));

    const created = await withTenant(scope, async (db) => {
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO concession
           (tenant_id, fee_assignment_id, fee_component_id, concession_type, mode, value,
            reason, requested_by)
         VALUES (app_current_tenant_id(), $1, $2, $3, $4, $5::numeric, $6, $7)
         RETURNING id`,
        [input.feeAssignmentId, input.feeComponentId ?? null, input.concessionType,
         input.mode, value, input.reason, input.requestedByStaffId],
      );
      if (!rows[0]) {
        throw ApiError.make('permission_error', 'staff_only', 'Only staff may grant concessions.');
      }
      return rows[0];
    });

    await auditService.record({
      tenantId: scope.tenantId,
      actorUserId: scope.actorId,
      action: 'concession.requested',
      resourceType: 'concession',
      resourceId: created.id,
      classification: 'SENSITIVE',
      after: { type: input.concessionType, mode: input.mode, value: String(input.value) },
      reason: input.reason,
    });
    return created;
  },

  async approveConcession(
    scope: TenantScope,
    concessionId: string,
    approverStaffId: string,
  ): Promise<void> {
    await withTenant(scope, async (db) => {
      const { rows } = await db.query<{ id: string; requested_by: string | null }>(
        'SELECT id, requested_by FROM concession WHERE id = $1 AND approved_at IS NULL',
        [concessionId],
      );
      if (!rows[0]) {
        throw ApiError.make('conflict', 'not_pending', 'That concession is not awaiting approval.');
      }
      if (rows[0].requested_by === approverStaffId) {
        // Fee leakage starts with one person granting and approving their own
        // discount.
        throw ApiError.make('permission_error', 'needs_a_second_person',
          'A concession must be approved by someone other than the person who requested it.');
      }
      await db.query(
        'UPDATE concession SET approved_by = $2, approved_at = now() WHERE id = $1',
        [concessionId, approverStaffId],
      );
    });

    await auditService.record({
      tenantId: scope.tenantId,
      actorUserId: scope.actorId,
      action: 'concession.approved',
      resourceType: 'concession',
      resourceId: concessionId,
      classification: 'SENSITIVE',
    });
  },

  /** The gross total of a plan, computed in SQL where numeric is exact. */
  async planTotal(db: TenantClient, feePlanId: string): Promise<Paise> {
    const { rows } = await db.query<{ total: string }>(
      // numeric division expands the scale (10000.00 / 100 carries 20 decimal
      // places), so each component's tax is rounded to paise BEFORE the sum.
      // Rounding per line is also what a tax invoice shows: the line tax is a
      // chargeable amount in its own right, not an artefact of the total.
      `SELECT COALESCE(sum(amount + round(amount * tax_rate / 100, 2)), 0)::numeric(14,2)::text AS total
         FROM fee_component WHERE fee_plan_id = $1 AND is_optional = false`,
      [feePlanId],
    );
    return Money.fromDecimalString(rows[0]?.total ?? '0');
  },

  /** Approved concessions only. An unapproved one reduces nothing. */
  async concessionTotal(db: TenantClient, feeAssignmentId: string, gross: Paise): Promise<Paise> {
    const { rows } = await db.query<{ mode: string; value: string }>(
      `SELECT mode, value::text FROM concession
        WHERE fee_assignment_id = $1 AND approved_at IS NOT NULL AND revoked_at IS NULL`,
      [feeAssignmentId],
    );

    let total = 0n;
    for (const c of rows) {
      total += c.mode === 'percent'
        ? Money.percentage(gross, Number(c.value))
        : Money.fromDecimalString(c.value);
    }
    // A concession stack can exceed the fee; the family owes nothing, never a
    // negative that would show as a credit they could withdraw.
    return total > gross ? gross : total;
  },

  /**
   * Builds the instalment schedule.
   *
   * The concession is applied to the total and the NET is split, rather than
   * splitting gross and netting each part — otherwise rounding is applied twice
   * and the instalments do not add back to what the family was told they owe.
   */
  async scheduleInstallments(
    scope: TenantScope,
    input: { feeAssignmentId: string; dueDates: string[] },
  ): Promise<Installment[]> {
    if (input.dueDates.length === 0) {
      throw ApiError.make('validation_error', 'no_due_dates',
        'An instalment schedule needs at least one due date.');
    }

    return withTenant(scope, async (db) => {
      const assignment = await db.query<{ fee_plan_id: string }>(
        'SELECT fee_plan_id FROM fee_assignment WHERE id = $1', [input.feeAssignmentId],
      );
      if (!assignment.rows[0]) {
        throw ApiError.make('not_found', 'assignment_not_found', 'Fee assignment not found.');
      }

      const existing = await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM installment WHERE fee_assignment_id = $1`,
        [input.feeAssignmentId],
      );
      if (Number(existing.rows[0]!.n) > 0) {
        throw ApiError.make('conflict', 'already_scheduled',
          'This assignment already has an instalment schedule.');
      }

      const gross = await this.planTotal(db, assignment.rows[0].fee_plan_id);
      const concession = await this.concessionTotal(db, input.feeAssignmentId, gross);
      const net = gross - concession;

      const grossParts = Money.split(gross, input.dueDates.length);
      const netParts = Money.split(net, input.dueDates.length);

      const created: Installment[] = [];
      for (let i = 0; i < input.dueDates.length; i++) {
        const g = grossParts[i]!;
        const n = netParts[i]!;
        const { rows } = await db.query<Installment>(
          `INSERT INTO installment
             (tenant_id, fee_assignment_id, sequence, due_on,
              gross_amount, concession_amount, net_amount)
           VALUES (app_current_tenant_id(), $1, $2, $3::date, $4::numeric, $5::numeric, $6::numeric)
           RETURNING id, sequence, due_on::text, gross_amount::text, concession_amount::text,
                     net_amount::text, status`,
          [input.feeAssignmentId, i + 1, input.dueDates[i],
           Money.toDecimalString(g), Money.toDecimalString(g - n), Money.toDecimalString(n)],
        );
        created.push(rows[0]!);
      }
      return created;
    });
  },
};
