/**
 * M7.9 — the mandate lifecycle (UPI AutoPay / e-NACH).
 *
 * A mandate is standing permission to pull money from a family's account. That
 * makes it the single most dangerous object in this module, and the rules here
 * are about the ways it can be abused rather than the happy path:
 *
 *   1. A mandate is only ever AUTHORISED by a signed provider callback. The app
 *      cannot promote its own pending mandate, exactly as with a payment.
 *   2. A revoked mandate is terminal. A family that withdraws permission does
 *      not get quietly reinstated by a later provider event.
 *   3. Every presentation is checked against `max_amount` and the validity
 *      window IN THE DATABASE, so a bug in the collection job cannot present a
 *      larger sum than the family authorised.
 *
 * The state machine is declared once, here, and enforced by transitionable().
 */
import { randomUUID } from 'node:crypto';
import { withTenant, type TenantScope, type TenantClient } from '../../db/tenant.ts';
import { ApiError } from '../../common/errors.ts';
import { auditService } from '../audit/audit.service.ts';
import { outboxService } from '../events/outbox.service.ts';
import { Money, type Paise } from './money.ts';

export type MandateStatus =
  | 'pending' | 'authorised' | 'paused' | 'failed' | 'revoked' | 'expired';

/**
 * Who may follow whom.
 *
 * `revoked` and `expired` have no outgoing edges on purpose: a family that
 * cancelled is done, and a lapsed mandate is re-created rather than resurrected,
 * so there is a fresh authorisation on record with its own date.
 */
const TRANSITIONS: Readonly<Record<MandateStatus, readonly MandateStatus[]>> = {
  pending: ['authorised', 'failed', 'revoked', 'expired'],
  authorised: ['paused', 'failed', 'revoked', 'expired'],
  paused: ['authorised', 'revoked', 'expired'],
  failed: ['authorised', 'revoked', 'expired'],
  revoked: [],
  expired: [],
};

export function transitionable(from: MandateStatus, to: MandateStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export interface Mandate {
  id: string;
  payer_person_id: string;
  provider: string;
  provider_mandate_id: string;
  max_amount: string;
  frequency: string;
  valid_from: string;
  valid_to: string | null;
  status: MandateStatus;
}

const SELECT_COLUMNS = `id, payer_person_id, provider, provider_mandate_id,
       max_amount::text AS max_amount, frequency,
       valid_from::text AS valid_from, valid_to::text AS valid_to, status`;

export const mandateService = {
  /**
   * Registers a mandate the provider has been asked to authorise. It starts
   * `pending` and stays there until a signed callback says otherwise.
   */
  async register(
    scope: TenantScope,
    input: {
      payerPersonId: string; provider: string; providerMandateId: string;
      maxAmountPaise: Paise; frequency: Mandate['frequency'];
      validFrom: string; validTo?: string;
    },
  ): Promise<Mandate> {
    if (input.maxAmountPaise <= 0n) {
      throw ApiError.make('validation_error', 'max_amount_required',
        'A mandate needs a positive ceiling.');
    }
    if (input.validTo && input.validTo <= input.validFrom) {
      throw ApiError.make('validation_error', 'bad_validity',
        'A mandate cannot end before it starts.');
    }

    const mandate = await withTenant(scope, async (db) => {
      const { rows } = await db.query<Mandate>(
        `INSERT INTO mandate
           (tenant_id, payer_person_id, provider, provider_mandate_id, max_amount,
            frequency, valid_from, valid_to, status)
         VALUES (app_current_tenant_id(), $1::uuid, $2, $3, $4::numeric,
                 $5, $6::date, $7::date, 'pending')
         RETURNING ${SELECT_COLUMNS}`,
        [input.payerPersonId, input.provider, input.providerMandateId,
         Money.toDecimalString(input.maxAmountPaise), input.frequency,
         input.validFrom, input.validTo ?? null],
      );
      return rows[0]!;
    });

    await auditService.record({
      tenantId: scope.tenantId,
      actorUserId: scope.actorId,
      action: 'mandate.registered',
      resourceType: 'mandate',
      resourceId: mandate.id,
      classification: 'SENSITIVE',
    });
    return mandate;
  },

  /**
   * The only path that moves a mandate's status.
   *
   * `authorised` is reachable only with `bySignedCallback`, which is the whole
   * point: standing permission to take money must come from the payer's bank,
   * never from a staff member clicking a button.
   */
  async transition(
    scope: TenantScope,
    input: {
      mandateId: string; to: MandateStatus; reason?: string;
      bySignedCallback?: boolean;
    },
  ): Promise<Mandate> {
    if (input.to === 'authorised' && !input.bySignedCallback) {
      throw ApiError.make('permission_error', 'authorisation_needs_callback',
        'A mandate is authorised by the provider, not by the institute.');
    }

    const mandate = await withTenant(scope, async (db) => {
      const found = await db.query<{ status: MandateStatus }>(
        'SELECT status FROM mandate WHERE id = $1::uuid FOR UPDATE',
        [input.mandateId],
      );
      const current = found.rows[0];
      if (!current) {
        throw ApiError.make('not_found', 'mandate_not_found', 'Mandate not found.');
      }
      if (current.status === input.to) {
        // Providers repeat callbacks. Re-sending 'revoked' is not an error.
        const same = await db.query<Mandate>(
          `SELECT ${SELECT_COLUMNS} FROM mandate WHERE id = $1::uuid`, [input.mandateId],
        );
        return same.rows[0]!;
      }
      if (!transitionable(current.status, input.to)) {
        throw ApiError.make('conflict', 'bad_transition',
          `A ${current.status} mandate cannot become ${input.to}.`);
      }
      if (input.to === 'failed' && !input.reason?.trim()) {
        throw ApiError.make('validation_error', 'reason_required',
          'A failed mandate needs the reason the bank gave; the accountant has to act on it.');
      }

      const { rows } = await db.query<Mandate>(
        `UPDATE mandate
            SET status = $2,
                authorised_at = CASE WHEN $2 = 'authorised' THEN now() ELSE authorised_at END,
                revoked_at    = CASE WHEN $2 = 'revoked'    THEN now() ELSE revoked_at END,
                failure_reason = CASE WHEN $2 = 'failed' THEN $3::text ELSE failure_reason END,
                updated_at = now()
          WHERE id = $1::uuid
        RETURNING ${SELECT_COLUMNS}`,
        [input.mandateId, input.to, input.reason ?? null],
      );
      const updated = rows[0]!;

      await outboxService.emit(db, {
        eventType: `mandate.${input.to}`,
        aggregateType: 'mandate',
        aggregateId: updated.id,
        payload: { mandateId: updated.id, from: current.status, to: input.to },
      });
      return updated;
    });

    await auditService.record({
      tenantId: scope.tenantId,
      actorUserId: scope.actorId,
      action: `mandate.${input.to}`,
      resourceType: 'mandate',
      resourceId: input.mandateId,
      classification: 'SENSITIVE',
      ...(input.reason ? { reason: input.reason } : {}),
    });

    return mandate;
  },

  /**
   * Whether a mandate may be presented for this amount today.
   *
   * The checks are re-run against the stored row rather than against whatever
   * the caller believes, because the collection job is the code most likely to
   * be wrong and the damage is money leaving a family's account.
   */
  async presentable(
    db: TenantClient,
    mandateId: string,
    amount: Paise,
    onDate?: string,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const { rows } = await db.query<Mandate>(
      `SELECT ${SELECT_COLUMNS} FROM mandate WHERE id = $1::uuid`, [mandateId],
    );
    const m = rows[0];
    if (!m) return { ok: false, reason: 'mandate_not_found' };
    if (m.status !== 'authorised') return { ok: false, reason: `mandate_${m.status}` };

    const day = onDate ?? new Date().toISOString().slice(0, 10);
    if (day < m.valid_from) return { ok: false, reason: 'not_yet_valid' };
    if (m.valid_to && day > m.valid_to) return { ok: false, reason: 'expired' };

    if (amount <= 0n) return { ok: false, reason: 'amount_not_positive' };
    if (amount > Money.fromDecimalString(m.max_amount)) {
      return { ok: false, reason: 'exceeds_max_amount' };
    }
    return { ok: true };
  },

  /**
   * Creates the payment for one presentation. It is `pending` like any other:
   * the money is not ours until the provider's signed webhook says so, and the
   * settle path is the same one a card payment takes.
   */
  async present(
    scope: TenantScope,
    input: { mandateId: string; invoiceId: string; amountMinor: Paise; onDate?: string },
  ): Promise<{ paymentId: string }> {
    return withTenant(scope, async (db) => {
      const verdict = await mandateService.presentable(
        db, input.mandateId, input.amountMinor, input.onDate,
      );
      if (!verdict.ok) {
        throw ApiError.make('conflict', verdict.reason,
          `This mandate cannot be presented: ${verdict.reason}.`);
      }

      const invoice = await db.query<{ campus_id: string; total: string; amount_paid: string }>(
        'SELECT campus_id, total::text, amount_paid::text FROM invoice WHERE id = $1::uuid',
        [input.invoiceId],
      );
      const inv = invoice.rows[0];
      if (!inv) {
        throw ApiError.make('not_found', 'invoice_not_found', 'Invoice not found.');
      }
      const outstanding =
        Money.fromDecimalString(inv.total) - Money.fromDecimalString(inv.amount_paid);
      if (input.amountMinor > outstanding) {
        // Presenting for more than is owed turns a mandate into an overdraft on
        // the family's account.
        throw ApiError.make('conflict', 'exceeds_outstanding',
          'A presentation cannot exceed what the invoice still owes.');
      }

      const mandate = await db.query<{ payer_person_id: string }>(
        'SELECT payer_person_id FROM mandate WHERE id = $1::uuid', [input.mandateId],
      );

      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO payment
           (tenant_id, campus_id, payer_person_id, method, amount, status,
            idempotency_key, mandate_id, target_invoice_id)
         VALUES (app_current_tenant_id(), $1::uuid, $2::uuid, 'mandate', $3::numeric,
                 'pending', $4, $5::uuid, $6::uuid)
         RETURNING id`,
        [inv.campus_id, mandate.rows[0]!.payer_person_id,
         Money.toDecimalString(input.amountMinor),
         `mandate:${input.mandateId}:${input.invoiceId}:${input.onDate ?? randomUUID()}`,
         input.mandateId, input.invoiceId],
      );

      return { paymentId: rows[0]!.id };
    });
  },

  async byId(scope: TenantScope, mandateId: string): Promise<Mandate | undefined> {
    return withTenant(scope, async (db) => {
      const { rows } = await db.query<Mandate>(
        `SELECT ${SELECT_COLUMNS} FROM mandate WHERE id = $1::uuid`, [mandateId],
      );
      return rows[0];
    });
  },
};
