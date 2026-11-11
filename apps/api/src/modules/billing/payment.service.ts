import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import { withTenant, type TenantScope, type TenantClient } from '../../db/tenant.ts';
import { auditService } from '../audit/audit.service.ts';
import { outboxService } from '../events/outbox.service.ts';
import { ApiError } from '../../common/errors.ts';
import { Money, type Paise } from './money.ts';
import { ledgerService, Account } from './ledger.service.ts';
import { financialYearOf } from './invoice.service.ts';

export interface PaymentOrder {
  paymentId: string;
  providerOrderId: string;
  amount: string;
  currency: string;
}

export interface Payment {
  id: string;
  amount: string;
  status: string;
  provider_payment_id: string | null;
}

/**
 * The gateway boundary.
 *
 * We never receive, transmit or store a card number. The client talks to the
 * provider's SDK; we create an order server-side and hand back a token. What the
 * client tells us afterwards is a UI hint and NOTHING ELSE — the payment moves
 * to `succeeded` only on a signed provider webhook.
 *
 * That is AC-6, and it is not a theoretical attack: a client-side success
 * callback is a URL an enterprising sixteen-year-old can call by hand.
 */
export interface PaymentProvider {
  createOrder(input: {
    amountMinor: bigint; currency: string; receipt: string;
  }): Promise<{ providerOrderId: string }>;
  verifyWebhookSignature(rawBody: string, signature: string, secret: string): boolean;
}

/** The default adapter shape, modelled on Razorpay's HMAC-SHA256 scheme. */
export const hmacProvider: Pick<PaymentProvider, 'verifyWebhookSignature'> = {
  verifyWebhookSignature(rawBody: string, signature: string, secret: string): boolean {
    const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(signature, 'utf8');
    // Constant-time, so the comparison does not leak the expected signature one
    // byte at a time.
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  },
};

export const paymentService = {
  /**
   * Creates the order. The amount is re-derived from the invoice here and never
   * taken from the client, because a client that can name the amount can pay a
   * 12,500 rupee invoice with 1 rupee.
   */
  async createOrder(
    scope: TenantScope,
    input: {
      invoiceId: string; idempotencyKey: string; method: string;
      payerPersonId?: string; provider?: PaymentProvider;
    },
  ): Promise<PaymentOrder> {
    return withTenant(scope, async (db) => {
      const existing = await db.query<{
        id: string; provider_order_id: string | null; amount: string; currency: string;
      }>(
        `SELECT id, provider_order_id, amount::text, currency
           FROM payment WHERE idempotency_key = $1`,
        [input.idempotencyKey],
      );
      if (existing.rows[0]) {
        // A retried request is the same payment, not a second one.
        const p = existing.rows[0];
        return {
          paymentId: p.id,
          providerOrderId: p.provider_order_id ?? '',
          amount: p.amount,
          currency: p.currency,
        };
      }

      const invoiceRows = await db.query<{
        id: string; campus_id: string; total: string; amount_paid: string; status: string;
      }>(
        `SELECT id, campus_id, total::text, amount_paid::text, status
           FROM invoice WHERE id = $1`,
        [input.invoiceId],
      );
      const invoice = invoiceRows.rows[0];
      if (!invoice) {
        throw ApiError.make('not_found', 'invoice_not_found', 'Invoice not found.');
      }
      if (invoice.status === 'void') {
        throw ApiError.make('conflict', 'invoice_void', 'That invoice has been voided.');
      }

      const outstanding =
        Money.fromDecimalString(invoice.total) - Money.fromDecimalString(invoice.amount_paid);
      if (outstanding <= 0n) {
        throw ApiError.make('conflict', 'nothing_outstanding',
          'That invoice is already settled.');
      }

      const providerOrderId = input.provider
        ? (await input.provider.createOrder({
            amountMinor: outstanding, currency: 'INR', receipt: invoice.id,
          })).providerOrderId
        : `order_${randomUUID().replace(/-/g, '').slice(0, 20)}`;

      const { rows } = await db.query<{ id: string; amount: string; currency: string }>(
        `INSERT INTO payment
           (tenant_id, campus_id, payer_person_id, method, amount, received_on,
            status, provider, provider_order_id, idempotency_key, target_invoice_id)
         VALUES (app_current_tenant_id(), $1, $2, $3, $4::numeric, CURRENT_DATE,
                 'pending', 'razorpay', $5, $6, $7::uuid)
         RETURNING id, amount::text, currency`,
        [invoice.campus_id, input.payerPersonId ?? null, input.method,
         Money.toDecimalString(outstanding), providerOrderId, input.idempotencyKey,
         invoice.id],
      );
      const payment = rows[0]!;

      await db.query(
        `INSERT INTO payment_attempt (tenant_id, payment_id, provider_order_id, provider_status)
         VALUES (app_current_tenant_id(), $1, $2, 'created')`,
        [payment.id, providerOrderId],
      );

      return {
        paymentId: payment.id,
        providerOrderId,
        amount: payment.amount,
        currency: payment.currency,
      };
    });
  },

  /**
   * AC-6. The ONLY path that settles a payment.
   *
   * The signature is verified before the body is parsed, the raw body is stored
   * before anything else, and the whole thing is idempotent on the provider's
   * own event id — because a provider that does not receive a 200 will send the
   * same event again, and often several times concurrently.
   */
  async handleWebhook(
    scope: TenantScope,
    input: {
      provider: string; providerEventId: string; eventType: string;
      rawBody: string; signature: string; secret: string;
    },
  ): Promise<{ processed: boolean; reason?: string }> {
    const signatureValid = hmacProvider.verifyWebhookSignature(
      input.rawBody, input.signature, input.secret,
    );

    const stored = await withTenant(scope, async (db) => {
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO payment_webhook_event
           (tenant_id, provider, provider_event_id, event_type, raw_body, signature_valid)
         VALUES (app_current_tenant_id(), $1, $2, $3, $4, $5)
         ON CONFLICT (provider, provider_event_id) DO NOTHING
         RETURNING id`,
        [input.provider, input.providerEventId, input.eventType, input.rawBody, signatureValid],
      );
      return rows[0];
    });

    if (!stored) {
      // Already seen. Return success so the provider stops retrying.
      return { processed: false, reason: 'duplicate_event' };
    }

    if (!signatureValid) {
      await auditService.record({
        tenantId: scope.tenantId,
        action: 'payment.webhook_signature_invalid',
        resourceType: 'payment_webhook_event',
        resourceId: stored.id,
        classification: 'RESTRICTED',
        after: { provider: input.provider, providerEventId: input.providerEventId },
      });
      throw ApiError.make('authentication_error', 'invalid_signature',
        'Webhook signature verification failed.');
    }

    const body = JSON.parse(input.rawBody) as {
      providerOrderId?: string; providerPaymentId?: string; amountMinor?: string;
      status?: string;
    };

    if (input.eventType !== 'payment.captured') {
      await withTenant(scope, async (db) => {
        await db.query('UPDATE payment_webhook_event SET processed_at = now() WHERE id = $1',
          [stored.id]);
      });
      return { processed: false, reason: 'event_type_not_handled' };
    }

    await this.settle(scope, {
      providerOrderId: body.providerOrderId!,
      providerPaymentId: body.providerPaymentId!,
      amountMinor: BigInt(body.amountMinor ?? '0'),
      webhookEventId: stored.id,
    });

    return { processed: true };
  },

  /**
   * Marks a payment succeeded, allocates it, issues a receipt and posts the
   * ledger — all in one transaction, so a receipt can never exist for money the
   * ledger does not know about.
   */
  async settle(
    scope: TenantScope,
    input: {
      providerOrderId: string; providerPaymentId: string; amountMinor: Paise;
      webhookEventId?: string;
    },
  ): Promise<{ paymentId: string; receiptNo: string }> {
    const result = await withTenant(scope, async (db) => {
      const found = await db.query<{
        id: string; campus_id: string; amount: string; status: string; method: string;
      }>(
        `SELECT id, campus_id, amount::text, status, method
           FROM payment WHERE provider_order_id = $1 FOR UPDATE`,
        [input.providerOrderId],
      );
      const payment = found.rows[0];
      if (!payment) {
        throw ApiError.make('not_found', 'payment_not_found',
          'No payment matches that provider order.');
      }

      if (payment.status === 'succeeded') {
        const existing = await db.query<{ receipt_no: string }>(
          'SELECT receipt_no FROM receipt WHERE payment_id = $1', [payment.id],
        );
        // Concurrent duplicate webhooks: the second one finds the work done.
        return { paymentId: payment.id, receiptNo: existing.rows[0]?.receipt_no ?? '' };
      }

      const expected = Money.fromDecimalString(payment.amount);
      if (input.amountMinor !== expected) {
        // The provider says a different amount than we created the order for.
        // Never settle on trust; this is a human's problem.
        throw ApiError.make('conflict', 'amount_mismatch',
          `Provider reported ${Money.toDecimalString(input.amountMinor)} but the order was ` +
          `for ${payment.amount}.`);
      }

      await db.query(
        `UPDATE payment
            SET status = 'succeeded', provider_payment_id = $2
          WHERE id = $1`,
        [payment.id, input.providerPaymentId],
      );
      await db.query(
        `INSERT INTO payment_attempt (tenant_id, payment_id, provider_order_id, provider_status)
         VALUES (app_current_tenant_id(), $1, $2, 'captured')`,
        [payment.id, input.providerOrderId],
      );

      const allocatedTo = await this.allocate(db, payment.id, expected);
      const receiptNo = await this.issueReceipt(
        db, payment.id, payment.campus_id, expected,
      );

      await ledgerService.post(db, {
        campusId: payment.campus_id,
        sourceType: 'payment',
        sourceId: payment.id,
        lines: [
          { account: Account.BANK_CLEARING, debit: expected, narration: `Receipt ${receiptNo}` },
          { account: Account.FEE_RECEIVABLE, credit: expected, narration: `Receipt ${receiptNo}` },
        ],
      });

      await outboxService.emit(db, {
        eventType: 'payment.settled',
        aggregateType: 'payment',
        aggregateId: payment.id,
        payload: {
          paymentId: payment.id,
          amount: Money.toDecimalString(expected),
          receiptNo,
          invoiceIds: allocatedTo,
        },
      });

      if (input.webhookEventId) {
        await db.query('UPDATE payment_webhook_event SET processed_at = now() WHERE id = $1',
          [input.webhookEventId]);
      }

      return { paymentId: payment.id, receiptNo };
    });

    await auditService.record({
      tenantId: scope.tenantId,
      actorUserId: scope.actorId,
      action: 'payment.settled',
      resourceType: 'payment',
      resourceId: result.paymentId,
      classification: 'INTERNAL',
      after: { receiptNo: result.receiptNo },
    });
    return result;
  },

  /**
   * The invoice the payment was raised for first, then oldest first, never more
   * than each is owed.
   *
   * The target ordering is not a nicety. A counter receipt written against a
   * specific invoice must settle THAT invoice, even when an older one is also
   * outstanding — otherwise the family is handed a receipt for a bill the books
   * say is still unpaid.
   */
  async allocate(db: TenantClient, paymentId: string, amount: Paise): Promise<string[]> {
    const invoices = await db.query<{ id: string; outstanding: string }>(
      `SELECT i.id, (i.total - i.amount_paid)::text AS outstanding
         FROM invoice i
         JOIN payment p ON p.id = $1::uuid
        WHERE i.status IN ('issued', 'part_paid')
          AND i.campus_id = p.campus_id
          AND i.total > i.amount_paid
        ORDER BY (i.id = p.target_invoice_id) DESC, i.due_on, i.invoice_no`,
      [paymentId],
    );

    const outstanding = invoices.rows.map((r) => Money.fromDecimalString(r.outstanding));
    const allocation = Money.allocate(amount, outstanding);

    const touched: string[] = [];
    for (let i = 0; i < invoices.rows.length; i++) {
      const share = allocation[i]!;
      if (share === 0n) continue;
      const invoiceId = invoices.rows[i]!.id;

      await db.query(
        `INSERT INTO payment_allocation (tenant_id, payment_id, invoice_id, amount)
         VALUES (app_current_tenant_id(), $1, $2, $3::numeric)`,
        [paymentId, invoiceId, Money.toDecimalString(share)],
      );
      await db.query(
        `UPDATE invoice
            SET amount_paid = amount_paid + $2::numeric,
                status = CASE WHEN amount_paid + $2::numeric >= total THEN 'paid'
                              ELSE 'part_paid' END
          WHERE id = $1`,
        [invoiceId, Money.toDecimalString(share)],
      );
      touched.push(invoiceId);
    }
    return touched;
  },

  async issueReceipt(
    db: TenantClient,
    paymentId: string,
    campusId: string,
    amount: Paise,
  ): Promise<string> {
    const financialYear = financialYearOf(new Date());
    await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',
      [`rcptno:${campusId}:${financialYear}`]);

    const next = await db.query<{ next: string }>(
      `SELECT COALESCE(max(substring(receipt_no from '[0-9]+$')::int), 0) + 1 AS next
         FROM receipt WHERE campus_id = $1 AND financial_year = $2`,
      [campusId, financialYear],
    );
    const receiptNo = `RCP-${String(next.rows[0]!.next).padStart(6, '0')}`;

    await db.query(
      `INSERT INTO receipt (tenant_id, campus_id, payment_id, receipt_no, financial_year, amount)
       VALUES (app_current_tenant_id(), $1, $2, $3, $4, $5::numeric)`,
      [campusId, paymentId, receiptNo, financialYear, Money.toDecimalString(amount)],
    );
    return receiptNo;
  },

  /** Cash at the counter. No gateway, but the same ledger and receipt path. */
  async recordOfflinePayment(
    scope: TenantScope,
    input: {
      invoiceId: string; amountMinor: Paise; method: 'cash' | 'cheque' | 'dd' | 'neft';
      idempotencyKey: string; receivedByStaffId: string; payerPersonId?: string;
    },
  ): Promise<{ paymentId: string; receiptNo: string }> {
    return withTenant(scope, async (db) => {
      const invoice = await db.query<{ campus_id: string }>(
        'SELECT campus_id FROM invoice WHERE id = $1', [input.invoiceId],
      );
      if (!invoice.rows[0]) {
        throw ApiError.make('not_found', 'invoice_not_found', 'Invoice not found.');
      }
      const campusId = invoice.rows[0].campus_id;

      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO payment
           (tenant_id, campus_id, payer_person_id, method, amount, status, idempotency_key,
            target_invoice_id, received_by)
         VALUES (app_current_tenant_id(), $1, $2, $3, $4::numeric, 'succeeded', $5, $6::uuid,
                 $7::uuid)
         ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
         RETURNING id`,
        // `received_by` was accepted by this method and written nowhere until
        // 0078 — every cash receipt was attributed to nobody. Cash at a
        // counter is the one place money can quietly not arrive, and a named
        // cashier is the control.
        [campusId, input.payerPersonId ?? null, input.method,
         Money.toDecimalString(input.amountMinor), input.idempotencyKey, input.invoiceId,
         input.receivedByStaffId],
      );
      if (!rows[0]) {
        const existing = await db.query<{ id: string }>(
          'SELECT id FROM payment WHERE idempotency_key = $1', [input.idempotencyKey],
        );
        const receipt = await db.query<{ receipt_no: string }>(
          'SELECT receipt_no FROM receipt WHERE payment_id = $1', [existing.rows[0]!.id],
        );
        return { paymentId: existing.rows[0]!.id, receiptNo: receipt.rows[0]?.receipt_no ?? '' };
      }

      const paymentId = rows[0].id;
      await this.allocate(db, paymentId, input.amountMinor);
      const receiptNo = await this.issueReceipt(db, paymentId, campusId, input.amountMinor);

      await ledgerService.post(db, {
        campusId,
        sourceType: 'payment',
        sourceId: paymentId,
        lines: [
          {
            account: input.method === 'cash' ? Account.CASH : Account.BANK_CLEARING,
            debit: input.amountMinor,
            narration: `Receipt ${receiptNo}`,
          },
          { account: Account.FEE_RECEIVABLE, credit: input.amountMinor,
            narration: `Receipt ${receiptNo}` },
        ],
      });

      return { paymentId, receiptNo };
    });
  },

  async byId(scope: TenantScope, paymentId: string): Promise<Payment | undefined> {
    return withTenant(scope, async (db) => {
      const { rows } = await db.query<Payment>(
        'SELECT id, amount::text, status, provider_payment_id FROM payment WHERE id = $1',
        [paymentId],
      );
      return rows[0];
    });
  },
};
