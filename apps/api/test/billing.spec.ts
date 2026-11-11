/**
 * M7 — AC-6 (a student pays and receives a reconciled receipt) and
 *      AC-7 (a refund preserves the financial trail).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { createHmac, randomUUID } from 'node:crypto';
import {
  createTenant, destroyTenants, createUser, destroyUsers, grantRole, purgeTestData,
  createAcademicYear, createAcademicStructure, createLearnerRaw, linkGuardianRaw,
  createPersonRaw, createClassGroupRaw, createSectionFor, rowHash,
  OWNER_URL, type TenantFixture, type UserFixture, type AcademicYearFixture, type LearnerFixture,
} from './fixtures.ts';
import { Money } from '../src/modules/billing/money.ts';
import { feePlanService } from '../src/modules/billing/fee-plan.service.ts';
import { invoiceService, financialYearOf } from '../src/modules/billing/invoice.service.ts';
import { paymentService } from '../src/modules/billing/payment.service.ts';
import { refundService } from '../src/modules/billing/refund.service.ts';
import { reconciliationService } from '../src/modules/billing/reconciliation.service.ts';
import { ledgerService, Account } from '../src/modules/billing/ledger.service.ts';
import { exportService, tallyDate } from '../src/modules/billing/export.service.ts';
import { mandateService, transitionable } from '../src/modules/billing/mandate.service.ts';
import { withTenant } from '../src/db/tenant.ts';
import { pool } from '../src/db/pool.ts';
import { authPool } from '../src/db/auth-pool.ts';

let tenant: TenantFixture;
let accountant: UserFixture;
let principal: UserFixture;
let teacherUser: UserFixture;
let guardianUser: UserFixture;
let guardianPersonId: string;
let year: AcademicYearFixture;
let struct: Awaited<ReturnType<typeof createAcademicStructure>>;
let secondStaffId: string;
let sectionId: string;
let learner: LearnerFixture;
let enrollmentId: string;

const PASSWORD = 'correct-horse-battery';
const WEBHOOK_SECRET = 'test_webhook_secret_value';

beforeAll(async () => {
  await purgeTestData('%@bill-test.example');
  tenant = await createTenant('BILL');

  accountant = await createUser('accounts@bill-test.example', PASSWORD);
  principal = await createUser('principal@bill-test.example', PASSWORD);
  teacherUser = await createUser('teacher@bill-test.example', PASSWORD);
  guardianUser = await createUser('parent@bill-test.example', PASSWORD);
  await grantRole(tenant.orgId, accountant.userId, 'ACCOUNTANT', 'campus', tenant.campusId);
  await grantRole(tenant.orgId, principal.userId, 'ORG_OWNER', 'organization', null);
  await grantRole(tenant.orgId, teacherUser.userId, 'TEACHER', 'campus', tenant.campusId);
  await grantRole(tenant.orgId, guardianUser.userId, 'GUARDIAN', 'self', tenant.campusId);
  guardianPersonId = await createPersonRaw(tenant.orgId, 'Meena', {
    userAccountId: guardianUser.userId, familyName: 'Payer',
  });

  struct = await createAcademicStructure(tenant.orgId, tenant.unitId, tenant.campusId);
  year = await createAcademicYear(tenant.orgId, tenant.unitId, '2026-27', 2026, { status: 'active' });
  const cg = await createClassGroupRaw(tenant.orgId, struct.programmeId, year.yearId, 'Class X');
  sectionId = await createSectionFor(tenant.orgId, cg, 'A');

  learner = await createLearnerRaw(tenant.orgId, 'Ishaan', 'BILL-0001');
  await linkGuardianRaw(tenant.orgId, learner.studentId, guardianPersonId);
  enrollmentId = await asOwner(async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO enrollment (tenant_id, student_id, section_id, academic_year_id)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [tenant.orgId, learner.studentId, sectionId, year.yearId],
    );
    return rows[0]!.id;
  });

  // A second staff member, for the two-person rules.
  secondStaffId = await asOwner(async (c) => {
    const p = await c.query<{ id: string }>(
      `INSERT INTO person (tenant_id, given_name, family_name) VALUES ($1, 'Raj', 'Bursar')
       RETURNING id`, [tenant.orgId],
    );
    const s = await c.query<{ id: string }>(
      `INSERT INTO staff (tenant_id, person_id, campus_id, employee_code, joined_on)
       VALUES ($1, $2, $3, 'EMP-002', CURRENT_DATE) RETURNING id`,
      [tenant.orgId, p.rows[0]!.id, tenant.campusId],
    );
    return s.rows[0]!.id;
  });
});

afterAll(async () => {
  await destroyUsers([accountant.userId, principal.userId, teacherUser.userId, guardianUser.userId]);
  await destroyTenants([tenant.orgId]);
  await Promise.all([pool.end(), authPool.end()]);
});

const acct = () => ({ tenantId: tenant.orgId, actorId: accountant.userId });
const teacher = () => ({ tenantId: tenant.orgId, actorId: teacherUser.userId });
const guardian = () => ({ tenantId: tenant.orgId, actorId: guardianUser.userId });

async function asOwner<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: OWNER_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

let planCounter = 0;
async function aPublishedPlanAssignedTo(
  targetEnrollmentId: string,
  opts: { tuition?: bigint; instalments?: number } = {},
) {
  planCounter += 1;
  const plan = await feePlanService.createDraft(acct(), {
    academicUnitId: tenant.unitId,
    academicYearId: year.yearId,
    name: `Class X fees ${planCounter}`,
    components: [
      { code: 'TUITION', name: 'Tuition', amountPaise: opts.tuition ?? Money.fromRupees(30000),
        frequency: 'annual' },
      { code: 'LAB', name: 'Laboratory', amountPaise: Money.fromRupees(3000), frequency: 'annual' },
    ],
  });
  await feePlanService.publish(acct(), plan.id, struct.staffId);
  const assignment = await feePlanService.assign(acct(), {
    enrollmentId: targetEnrollmentId, feePlanId: plan.id,
  });
  const dates = Array.from({ length: opts.instalments ?? 3 }, (_, i) =>
    `2026-0${4 + i * 2}-10`);
  const instalments = await feePlanService.scheduleInstallments(acct(), {
    feeAssignmentId: assignment.id, dueDates: dates,
  });
  return { plan, assignment, instalments };
}

function signedWebhook(body: object) {
  const raw = JSON.stringify(body);
  return { raw, signature: createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex') };
}

describe('fee plans', () => {
  it('a draft plan cannot be assigned', async () => {
    const draft = await feePlanService.createDraft(acct(), {
      academicUnitId: tenant.unitId, academicYearId: year.yearId, name: 'Unpublished',
      components: [{ code: 'T', name: 'Tuition', amountPaise: Money.fromRupees(1000),
        frequency: 'annual' }],
    });
    await expect(
      feePlanService.assign(acct(), { enrollmentId, feePlanId: draft.id }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('a published plan and its components are frozen', async () => {
    const plan = await feePlanService.createDraft(acct(), {
      academicUnitId: tenant.unitId, academicYearId: year.yearId, name: 'Frozen',
      components: [{ code: 'T', name: 'Tuition', amountPaise: Money.fromRupees(1000),
        frequency: 'annual' }],
    });
    await feePlanService.publish(acct(), plan.id, struct.staffId);

    // The plan row.
    await expect(
      asOwner((c) => c.query(`UPDATE fee_plan SET name = 'Renamed' WHERE id = $1`, [plan.id])),
    ).rejects.toThrow(/is published; create a new version/i);

    // And the amounts, which is the part that matters.
    await expect(
      asOwner((c) => c.query(
        `UPDATE fee_component SET amount = 999999 WHERE fee_plan_id = $1`, [plan.id])),
    ).rejects.toThrow(/published/i);
  });

  it('rounds tax per component, not on the total', async () => {
    // Two lines of 100.10 at 5%: each line's tax is 5.005, which rounds to 5.01
    // on the line and 210.21 on the total. A rupee a term is nothing; a tax
    // invoice whose lines do not add up to its total is a filing problem, and
    // the line tax is the figure that goes on the return.
    const plan = await feePlanService.createDraft(acct(), {
      academicUnitId: tenant.unitId, academicYearId: year.yearId, name: `Taxed ${randomUUID()}`,
      components: [
        { code: 'A', name: 'Materials A', amountPaise: 10_010n, frequency: 'annual', taxRate: 5 },
        { code: 'B', name: 'Materials B', amountPaise: 10_010n, frequency: 'annual', taxRate: 5 },
      ],
    });
    const total = await withTenant(acct(), (db) => feePlanService.planTotal(db, plan.id));
    expect(Money.toDecimalString(total)).toBe('210.22');
  });

  it('instalments add back to the plan total exactly', async () => {
    const other = await createLearnerRaw(tenant.orgId, 'Split', 'BILL-0100');
    const otherEnrollment = await asOwner(async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO enrollment (tenant_id, student_id, section_id, academic_year_id)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [tenant.orgId, other.studentId, sectionId, year.yearId],
      );
      return rows[0]!.id;
    });

    // 10,000 over 3 is the case that loses a paise if each part is rounded.
    const { instalments } = await aPublishedPlanAssignedTo(otherEnrollment, {
      tuition: Money.fromRupees(10000) - Money.fromRupees(3000), instalments: 3,
    });
    const sum = Money.sum(instalments.map((i) => Money.fromDecimalString(i.net_amount)));
    expect(Money.toDecimalString(sum)).toBe('10000.00');
  });
});

describe('concessions need a second person', () => {
  it('the requester cannot approve their own concession', async () => {
    const { assignment } = await aPublishedPlanAssignedTo(
      await freshEnrollment('BILL-0200'), {},
    );
    const concession = await feePlanService.grantConcession(acct(), {
      feeAssignmentId: assignment.id, concessionType: 'sibling', mode: 'percent',
      value: 10, reason: 'Second child at the school.', requestedByStaffId: struct.staffId,
    });
    // Fee leakage starts with one person granting and approving their own discount.
    await expect(
      feePlanService.approveConcession(acct(), concession.id, struct.staffId),
    ).rejects.toMatchObject({ status: 403 });

    await feePlanService.approveConcession(acct(), concession.id, secondStaffId);
  });

  it('an unapproved concession reduces nothing', async () => {
    const target = await freshEnrollment('BILL-0300');
    const plan = await feePlanService.createDraft(acct(), {
      academicUnitId: tenant.unitId, academicYearId: year.yearId, name: 'Unapproved concession',
      components: [{ code: 'T', name: 'Tuition', amountPaise: Money.fromRupees(12000),
        frequency: 'annual' }],
    });
    await feePlanService.publish(acct(), plan.id, struct.staffId);
    const assignment = await feePlanService.assign(acct(), {
      enrollmentId: target, feePlanId: plan.id,
    });
    await feePlanService.grantConcession(acct(), {
      feeAssignmentId: assignment.id, concessionType: 'merit', mode: 'percent',
      value: 50, reason: 'Pending approval.', requestedByStaffId: struct.staffId,
    });

    const instalments = await feePlanService.scheduleInstallments(acct(), {
      feeAssignmentId: assignment.id, dueDates: ['2026-04-10'],
    });
    // Full amount, because nobody approved the discount.
    expect(instalments[0]!.net_amount).toBe('12000.00');
  });
});

describe('invoices', () => {
  it('numbers gaplessly per campus per financial year', async () => {
    const { instalments } = await aPublishedPlanAssignedTo(await freshEnrollment('BILL-0400'), {});
    const first = await invoiceService.issueForInstallment(acct(), {
      installmentId: instalments[0]!.id, campusId: tenant.campusId,
    });
    const second = await invoiceService.issueForInstallment(acct(), {
      installmentId: instalments[1]!.id, campusId: tenant.campusId,
    });

    expect(first.invoice_no).toMatch(/^INV-\d{6}$/);
    expect(first.financial_year).toBe(financialYearOf(new Date()));
    const a = Number(first.invoice_no.slice(4));
    const b = Number(second.invoice_no.slice(4));
    expect(b).toBe(a + 1);
  });

  it('is immutable once issued', async () => {
    const { instalments } = await aPublishedPlanAssignedTo(await freshEnrollment('BILL-0500'), {});
    const invoice = await invoiceService.issueForInstallment(acct(), {
      installmentId: instalments[0]!.id, campusId: tenant.campusId,
    });

    await expect(
      asOwner((c) => c.query('UPDATE invoice SET total = 1 WHERE id = $1', [invoice.id])),
    ).rejects.toThrow(/cannot be altered/i);
    await expect(
      asOwner((c) => c.query('DELETE FROM invoice WHERE id = $1', [invoice.id])),
    ).rejects.toThrow(/cannot be deleted/i);
  });

  it('posts a balanced ledger group when issued', async () => {
    const { instalments } = await aPublishedPlanAssignedTo(await freshEnrollment('BILL-0600'), {});
    const invoice = await invoiceService.issueForInstallment(acct(), {
      installmentId: instalments[0]!.id, campusId: tenant.campusId,
    });

    const entries = await withTenant(acct(), (db) =>
      ledgerService.entriesFor(db, 'invoice', invoice.id));
    expect(entries.length).toBeGreaterThanOrEqual(2);

    const debits = Money.sum(entries.map((e) => Money.fromDecimalString(e.debit)));
    const credits = Money.sum(entries.map((e) => Money.fromDecimalString(e.credit)));
    expect(debits).toBe(credits);
    expect(entries.some((e) => e.account_code === Account.FEE_RECEIVABLE)).toBe(true);
  });

  it('cannot be voided once money has been received', async () => {
    const { instalments } = await aPublishedPlanAssignedTo(await freshEnrollment('BILL-0700'), {});
    const invoice = await invoiceService.issueForInstallment(acct(), {
      installmentId: instalments[0]!.id, campusId: tenant.campusId,
    });
    await paymentService.recordOfflinePayment(acct(), {
      invoiceId: invoice.id, amountMinor: Money.fromRupees(100), method: 'cash',
      idempotencyKey: randomUUID(), receivedByStaffId: struct.staffId,
    });

    const err = await invoiceService
      .void(acct(), { invoiceId: invoice.id, reason: 'Raised in error.',
        voidedByStaffId: struct.staffId })
      .catch((e) => e);
    // The correction is a refund, not a void that leaves a receipt pointing at
    // nothing.
    expect(err.getResponse().error.code).toBe('invoice_has_payments');
  });
});

describe('AC-6 — a student pays and receives a reconciled receipt', () => {
  let invoiceId: string;
  let order: Awaited<ReturnType<typeof paymentService.createOrder>>;

  beforeAll(async () => {
    const { instalments } = await aPublishedPlanAssignedTo(await freshEnrollment('BILL-1000'), {});
    const invoice = await invoiceService.issueForInstallment(acct(), {
      installmentId: instalments[0]!.id, campusId: tenant.campusId,
    });
    invoiceId = invoice.id;
    order = await paymentService.createOrder(acct(), {
      invoiceId, idempotencyKey: randomUUID(), method: 'upi',
      payerPersonId: guardianPersonId,
    });
  });

  it('creates the order server-side, deriving the amount from the invoice', async () => {
    const invoice = await invoiceService.byId(acct(), invoiceId);
    // A client that can name the amount can pay a 12,500 rupee invoice with 1 rupee.
    expect(order.amount).toBe(invoice!.total);
    expect(order.providerOrderId).toBeTruthy();
  });

  it('leaves the payment pending until a signed webhook arrives', async () => {
    const payment = await paymentService.byId(acct(), order.paymentId);
    expect(payment!.status).toBe('pending');

    const invoice = await invoiceService.byId(acct(), invoiceId);
    expect(invoice!.amount_paid).toBe('0.00');
  });

  it('REFUSES a forged client success callback', async () => {
    // The attack: a client-side success callback is a URL anybody can call.
    const forged = signedWebhook({
      providerOrderId: order.providerOrderId,
      providerPaymentId: 'pay_forged',
      amountMinor: order.amount.replace('.', ''),
    });

    await expect(
      paymentService.handleWebhook(acct(), {
        provider: 'razorpay', providerEventId: `evt_${randomUUID()}`,
        eventType: 'payment.captured', rawBody: forged.raw,
        signature: 'not-the-real-signature', secret: WEBHOOK_SECRET,
      }),
    ).rejects.toMatchObject({ status: 401 });

    // And the invoice is still unpaid.
    const invoice = await invoiceService.byId(acct(), invoiceId);
    expect(invoice!.status).toBe('issued');
    expect(invoice!.amount_paid).toBe('0.00');
  });

  it('records the rejected signature for investigation', async () => {
    const rows = await withTenant(acct(), async (db) => {
      const r = await db.query<{ action: string }>(
        `SELECT action FROM audit_log WHERE action = 'payment.webhook_signature_invalid'`,
      );
      return r.rows;
    });
    expect(rows.length).toBeGreaterThan(0);
  });

  it('refuses a webhook whose amount differs from the order', async () => {
    const wrong = signedWebhook({
      providerOrderId: order.providerOrderId,
      providerPaymentId: 'pay_wrong_amount',
      amountMinor: '100',
    });
    const err = await paymentService
      .handleWebhook(acct(), {
        provider: 'razorpay', providerEventId: `evt_${randomUUID()}`,
        eventType: 'payment.captured', rawBody: wrong.raw,
        signature: wrong.signature, secret: WEBHOOK_SECRET,
      })
      .catch((e) => e);
    expect(err.getResponse().error.code).toBe('amount_mismatch');
  });

  it('settles on a correctly signed webhook and issues a receipt', async () => {
    const body = signedWebhook({
      providerOrderId: order.providerOrderId,
      providerPaymentId: 'pay_genuine_001',
      amountMinor: Money.fromDecimalString(order.amount).toString(),
    });

    const result = await paymentService.handleWebhook(acct(), {
      provider: 'razorpay', providerEventId: 'evt_genuine_001',
      eventType: 'payment.captured', rawBody: body.raw,
      signature: body.signature, secret: WEBHOOK_SECRET,
    });
    expect(result.processed).toBe(true);

    const payment = await paymentService.byId(acct(), order.paymentId);
    expect(payment!.status).toBe('succeeded');

    const invoice = await invoiceService.byId(acct(), invoiceId);
    expect(invoice!.status).toBe('paid');
    expect(invoice!.amount_paid).toBe(invoice!.total);

    const receipt = await withTenant(acct(), async (db) => {
      const r = await db.query<{ receipt_no: string; amount: string }>(
        'SELECT receipt_no, amount::text FROM receipt WHERE payment_id = $1', [order.paymentId],
      );
      return r.rows[0]!;
    });
    expect(receipt.receipt_no).toMatch(/^RCP-\d{6}$/);
    expect(receipt.amount).toBe(invoice!.total);
  });

  it('the ledger group for the payment balances', async () => {
    const entries = await withTenant(acct(), (db) =>
      ledgerService.entriesFor(db, 'payment', order.paymentId));
    const debits = Money.sum(entries.map((e) => Money.fromDecimalString(e.debit)));
    const credits = Money.sum(entries.map((e) => Money.fromDecimalString(e.credit)));
    expect(debits).toBe(credits);
    expect(debits).toBe(Money.fromDecimalString(order.amount));
  });

  it('is idempotent across duplicate and concurrent webhooks', async () => {
    const body = signedWebhook({
      providerOrderId: order.providerOrderId,
      providerPaymentId: 'pay_genuine_001',
      amountMinor: Money.fromDecimalString(order.amount).toString(),
    });

    // The same event id again: the provider retried.
    const repeat = await paymentService.handleWebhook(acct(), {
      provider: 'razorpay', providerEventId: 'evt_genuine_001',
      eventType: 'payment.captured', rawBody: body.raw,
      signature: body.signature, secret: WEBHOOK_SECRET,
    });
    expect(repeat.processed).toBe(false);
    expect(repeat.reason).toBe('duplicate_event');

    // A different event id for the same payment, twice, concurrently.
    const concurrent = await Promise.all([
      paymentService.handleWebhook(acct(), {
        provider: 'razorpay', providerEventId: `evt_${randomUUID()}`,
        eventType: 'payment.captured', rawBody: body.raw,
        signature: body.signature, secret: WEBHOOK_SECRET,
      }).catch(() => ({ processed: false })),
      paymentService.handleWebhook(acct(), {
        provider: 'razorpay', providerEventId: `evt_${randomUUID()}`,
        eventType: 'payment.captured', rawBody: body.raw,
        signature: body.signature, secret: WEBHOOK_SECRET,
      }).catch(() => ({ processed: false })),
    ]);
    expect(concurrent).toHaveLength(2);

    // Exactly one receipt, one allocation, one ledger group.
    const counts = await withTenant(acct(), async (db) => {
      const r = await db.query<{ receipts: string; allocations: string; groups: string }>(
        `SELECT (SELECT count(*) FROM receipt WHERE payment_id = $1)::text AS receipts,
                (SELECT count(*) FROM payment_allocation WHERE payment_id = $1)::text AS allocations,
                (SELECT count(DISTINCT entry_group_id) FROM ledger_entry
                  WHERE source_type = 'payment' AND source_id = $1)::text AS groups`,
        [order.paymentId],
      );
      return r.rows[0]!;
    });
    expect(counts.receipts).toBe('1');
    expect(counts.allocations).toBe('1');
    expect(counts.groups).toBe('1');
  });

  it('reconciles against the settlement file', async () => {
    const amount = Money.fromDecimalString(order.amount);
    const fee = Money.fromRupees(20);

    const result = await reconciliationService.importSettlement(acct(), {
      provider: 'razorpay', utr: 'UTR20260918001', settledOn: '2026-09-18',
      grossMinor: amount, feeMinor: fee, taxMinor: 0n,
      lines: [{ providerPaymentId: 'pay_genuine_001', amountMinor: amount, providerFeeMinor: fee }],
    });
    expect(result.matched).toBe(1);
    expect(result.unmatched).toBe(0);
  });

  it('puts an unattributable settlement line into the queue rather than a log', async () => {
    await reconciliationService.importSettlement(acct(), {
      provider: 'razorpay', utr: 'UTR20260918002', settledOn: '2026-09-18',
      grossMinor: Money.fromRupees(500), feeMinor: 0n, taxMinor: 0n,
      lines: [{ providerPaymentId: 'pay_we_have_never_seen',
        amountMinor: Money.fromRupees(500), providerFeeMinor: 0n }],
    });

    const queue = await reconciliationService.unmatchedQueue(acct());
    // Money in the bank nobody has attributed to a family. Somebody has to look.
    expect(queue.some((l) => l.provider_payment_id === 'pay_we_have_never_seen')).toBe(true);
  });
});

describe('AC-7 — a refund preserves the financial trail', () => {
  let paymentId: string;
  let invoiceId: string;
  let paymentHashBefore: string;
  let receiptHashBefore: string;

  beforeAll(async () => {
    const { instalments } = await aPublishedPlanAssignedTo(await freshEnrollment('BILL-2000'), {});
    const invoice = await invoiceService.issueForInstallment(acct(), {
      installmentId: instalments[0]!.id, campusId: tenant.campusId,
    });
    invoiceId = invoice.id;

    const paid = await paymentService.recordOfflinePayment(acct(), {
      invoiceId, amountMinor: Money.fromDecimalString(invoice.total), method: 'neft',
      idempotencyKey: randomUUID(), receivedByStaffId: struct.staffId,
      payerPersonId: guardianPersonId,
    });
    paymentId = paid.paymentId;

    paymentHashBefore = await rowHash('payment', paymentId);
    const receiptId = await withTenant(acct(), async (db) => {
      const r = await db.query<{ id: string }>(
        'SELECT id FROM receipt WHERE payment_id = $1', [paymentId],
      );
      return r.rows[0]!.id;
    });
    receiptHashBefore = await rowHash('receipt', receiptId);
  });

  it('requires a second person to approve', async () => {
    const refund = await refundService.request(acct(), {
      paymentId, amountMinor: Money.fromRupees(2500),
      reason: 'Withdrew before the term started.',
      requestedByStaffId: struct.staffId, idempotencyKey: randomUUID(),
    });

    await expect(
      refundService.approve(acct(), { refundId: refund.id, approverStaffId: struct.staffId }),
    ).rejects.toMatchObject({ status: 403 });

    await refundService.approve(acct(), { refundId: refund.id, approverStaffId: secondStaffId });
  });

  it('leaves the original payment and receipt byte-identical', async () => {
    // Not "looks the same" — identical.
    expect(await rowHash('payment', paymentId)).toBe(paymentHashBefore);
    const receiptId = await withTenant(acct(), async (db) => {
      const r = await db.query<{ id: string }>(
        'SELECT id FROM receipt WHERE payment_id = $1', [paymentId],
      );
      return r.rows[0]!.id;
    });
    expect(await rowHash('receipt', receiptId)).toBe(receiptHashBefore);
  });

  it('posts reversing entries rather than editing the originals', async () => {
    const refundEntries = await withTenant(acct(), async (db) => {
      const r = await db.query<{ account_code: string; debit: string; credit: string }>(
        `SELECT account_code, debit::text, credit::text FROM ledger_entry
          WHERE source_type = 'refund'`,
      );
      return r.rows;
    });
    expect(refundEntries.length).toBeGreaterThanOrEqual(2);

    const debits = Money.sum(refundEntries.map((e) => Money.fromDecimalString(e.debit)));
    const credits = Money.sum(refundEntries.map((e) => Money.fromDecimalString(e.credit)));
    expect(debits).toBe(credits);
    // The ledger shows money in and money out, not a payment that shrank.
    expect(refundEntries.some((e) => e.account_code === Account.REFUND_PAYABLE)).toBe(true);
  });

  it('reopens the invoice by the refunded amount', async () => {
    const invoice = await invoiceService.byId(acct(), invoiceId);
    const total = Money.fromDecimalString(invoice!.total);
    const paidNow = Money.fromDecimalString(invoice!.amount_paid);
    expect(total - paidNow).toBe(Money.fromRupees(2500));
    expect(invoice!.status).toBe('part_paid');
  });

  it('is idempotent on replay', async () => {
    const key = randomUUID();
    const first = await refundService.request(acct(), {
      paymentId, amountMinor: Money.fromRupees(100), reason: 'Duplicate test.',
      requestedByStaffId: struct.staffId, idempotencyKey: key,
    });
    const second = await refundService.request(acct(), {
      paymentId, amountMinor: Money.fromRupees(100), reason: 'Duplicate test.',
      requestedByStaffId: struct.staffId, idempotencyKey: key,
    });
    expect(second.id).toBe(first.id);

    const count = await withTenant(acct(), async (db) => {
      const r = await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM refund WHERE idempotency_key = $1`, [key],
      );
      return Number(r.rows[0]!.n);
    });
    expect(count).toBe(1);
  });

  it('refuses to refund more than was received', async () => {
    const err = await refundService
      .request(acct(), {
        paymentId, amountMinor: Money.fromRupees(999999), reason: 'Too much.',
        requestedByStaffId: struct.staffId, idempotencyKey: randomUUID(),
      })
      .catch((e) => e);
    // Refunding more than was received creates money.
    expect(err.getResponse().error.code).toBe('refund_exceeds_payment');
  });

  it('settling the refund completes the ledger picture', async () => {
    const refund = await refundService.request(acct(), {
      paymentId, amountMinor: Money.fromRupees(500), reason: 'Partial adjustment.',
      requestedByStaffId: struct.staffId, idempotencyKey: randomUUID(),
    });
    await refundService.approve(acct(), { refundId: refund.id, approverStaffId: secondStaffId });
    await refundService.markSettled(acct(), {
      refundId: refund.id, providerRefundId: `rfnd_${randomUUID().slice(0, 8)}`,
    });

    const entries = await withTenant(acct(), (db) =>
      ledgerService.entriesFor(db, 'refund_settlement', refund.id));
    const debits = Money.sum(entries.map((e) => Money.fromDecimalString(e.debit)));
    const credits = Money.sum(entries.map((e) => Money.fromDecimalString(e.credit)));
    expect(debits).toBe(credits);
  });
});

describe('the ledger as a whole', () => {
  it('has no unbalanced group anywhere', async () => {
    // The nightly integrity job's query.
    const unbalanced = await withTenant(acct(), (db) => ledgerService.unbalancedGroups(db));
    expect(unbalanced).toEqual([]);
  });

  it('is append-only even for the owner', async () => {
    await expect(
      asOwner((c) => c.query(`UPDATE ledger_entry SET debit = 0`)),
    ).rejects.toThrow(/append-only/i);
    await expect(
      asOwner((c) => c.query('DELETE FROM ledger_entry')),
    ).rejects.toThrow(/append-only/i);
  });

  it('grants the application role no UPDATE or DELETE privilege at all', async () => {
    const privileges = await asOwner(async (c) => {
      const r = await c.query<{ privilege_type: string }>(
        `SELECT privilege_type FROM information_schema.role_table_grants
          WHERE table_name = 'ledger_entry' AND grantee = 'paathshala_app'`,
      );
      return r.rows.map((x) => x.privilege_type).sort();
    });
    // A stray ORM update fails on privilege, before any trigger runs.
    expect(privileges).toEqual(['INSERT', 'SELECT']);
  });

  it('refuses an unbalanced group in the service, before any row is written', async () => {
    // The deferred constraint below is the real guard, but it fires at COMMIT
    // and names a trigger, not a caller. This check fails fast and says which
    // source was wrong, which is what the on-call engineer actually needs.
    // Without it a mutation to the service is invisible: every caller happens
    // to be balanced by construction.
    const sourceId = randomUUID();
    await expect(
      withTenant(acct(), (db) =>
        ledgerService.post(db, {
          campusId: tenant.campusId,
          sourceType: 'probe_unbalanced',
          sourceId,
          lines: [
            { account: Account.FEE_RECEIVABLE, debit: Money.fromRupees(100) },
            { account: Account.FEE_INCOME, credit: Money.fromRupees(99) },
          ],
        })),
    // The source type, not a group uuid: the deferred trigger's own message
    // names the group and never the caller, so matching on the source is what
    // distinguishes the service check from the database one. Without it this
    // test passes whether or not the service check exists.
    ).rejects.toThrow(/does not balance.*probe_unbalanced/is);

    const written = await withTenant(acct(), (db) =>
      ledgerService.entriesFor(db, 'probe_unbalanced', sourceId));
    expect(written).toEqual([]);
  });

  it('refuses an empty group', async () => {
    await expect(
      withTenant(acct(), (db) =>
        ledgerService.post(db, { campusId: tenant.campusId, sourceType: 'probe_empty', lines: [] })),
    ).rejects.toThrow(/empty ledger group/i);
  });

  it('refuses an unbalanced group at commit', async () => {
    await expect(
      withTenant(acct(), async (db) => {
        await db.query(
          `INSERT INTO ledger_entry (tenant_id, entry_group_id, account_code, debit, source_type)
           VALUES (app_current_tenant_id(), gen_random_uuid(), '1100_fee_receivable', 100, 'probe')`,
        );
      }),
    ).rejects.toThrow(/does not balance/i);
  });
});

describe('who can see money', () => {
  it('a teacher cannot see invoices at all', async () => {
    const seen = await withTenant(teacher(), async (db) => {
      const r = await db.query('SELECT id FROM invoice');
      return r.rows.length;
    });
    // A teacher knowing which families are behind on fees changes how they
    // treat a child.
    expect(seen).toBe(0);
  });

  it('a guardian with can_view_finance sees their learner invoices', async () => {
    const { instalments } = await aPublishedPlanAssignedTo(enrollmentId, {});
    await invoiceService.issueForInstallment(acct(), {
      installmentId: instalments[0]!.id, campusId: tenant.campusId,
    });

    const seen = await withTenant(guardian(), async (db) => {
      const r = await db.query('SELECT id FROM invoice WHERE enrollment_id = $1', [enrollmentId]);
      return r.rows.length;
    });
    expect(seen).toBeGreaterThan(0);
  });

  it('a guardian cannot alter an invoice', async () => {
    const affected = await withTenant(guardian(), async (db) => {
      const r = await db.query(`UPDATE invoice SET amount_paid = total`);
      return r.rowCount;
    }).catch(() => 0);
    expect(affected).toBe(0);
  });

  it('a guardian cannot write a ledger entry', async () => {
    await expect(
      withTenant(guardian(), async (db) => {
        await db.query(
          `INSERT INTO ledger_entry (tenant_id, entry_group_id, account_code, debit, source_type)
           VALUES (app_current_tenant_id(), gen_random_uuid(), '1210_bank', 1, 'fraud')`,
        );
      }),
    ).rejects.toThrow();
  });
});

let enrollmentCounter = 0;
async function freshEnrollment(admissionNo: string): Promise<string> {
  enrollmentCounter += 1;
  const l = await createLearnerRaw(tenant.orgId, `Payer${enrollmentCounter}`, admissionNo);
  return asOwner(async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO enrollment (tenant_id, student_id, section_id, academic_year_id)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [tenant.orgId, l.studentId, sectionId, year.yearId],
    );
    return rows[0]!.id;
  });
}
