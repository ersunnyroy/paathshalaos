/**
 * M7.9 and M7.10 — the mandate lifecycle, and handing the books to Tally.
 *
 * These two share a file because they share a fixture: a mandate presentation
 * produces ledger rows, and the export is what an accountant checks them in.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import {
  createTenant, destroyTenants, createUser, destroyUsers, grantRole, purgeTestData,
  createAcademicYear, createAcademicStructure, createLearnerRaw, createPersonRaw,
  createClassGroupRaw, createSectionFor,
  OWNER_URL, type TenantFixture, type UserFixture, type AcademicYearFixture,
} from './fixtures.ts';
import { Money } from '../src/modules/billing/money.ts';
import { feePlanService } from '../src/modules/billing/fee-plan.service.ts';
import { invoiceService } from '../src/modules/billing/invoice.service.ts';
import { paymentService } from '../src/modules/billing/payment.service.ts';
import { ledgerService } from '../src/modules/billing/ledger.service.ts';
import { exportService, tallyDate } from '../src/modules/billing/export.service.ts';
import { mandateService, transitionable } from '../src/modules/billing/mandate.service.ts';
import { withTenant } from '../src/db/tenant.ts';
import { pool } from '../src/db/pool.ts';
import { authPool } from '../src/db/auth-pool.ts';

let tenant: TenantFixture;
let accountant: UserFixture;
let teacherUser: UserFixture;
let year: AcademicYearFixture;
let struct: Awaited<ReturnType<typeof createAcademicStructure>>;
let sectionId: string;
let payerPersonId: string;
let enrollmentId: string;
let invoiceId: string;
let invoiceTotal: bigint;

const PASSWORD = 'correct-horse-battery';

beforeAll(async () => {
  await purgeTestData('%@xport-test.example');
  tenant = await createTenant('XPORT');

  accountant = await createUser('accounts@xport-test.example', PASSWORD);
  teacherUser = await createUser('teacher@xport-test.example', PASSWORD);
  await grantRole(tenant.orgId, accountant.userId, 'ACCOUNTANT', 'campus', tenant.campusId);
  await grantRole(tenant.orgId, teacherUser.userId, 'TEACHER', 'campus', tenant.campusId);

  struct = await createAcademicStructure(tenant.orgId, tenant.unitId, tenant.campusId);
  year = await createAcademicYear(tenant.orgId, tenant.unitId, '2026-27', 2026,
    { status: 'active' });
  const cg = await createClassGroupRaw(tenant.orgId, struct.programmeId, year.yearId, 'Class IX');
  sectionId = await createSectionFor(tenant.orgId, cg, 'A');

  payerPersonId = await createPersonRaw(tenant.orgId, 'Anita', { familyName: 'Payer' });

  const learner = await createLearnerRaw(tenant.orgId, 'Vikram', 'XPORT-0001');
  enrollmentId = await asOwner(async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO enrollment (tenant_id, student_id, section_id, academic_year_id)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [tenant.orgId, learner.studentId, sectionId, year.yearId],
    );
    return rows[0]!.id;
  });

  const plan = await feePlanService.createDraft(acct(), {
    academicUnitId: tenant.unitId, academicYearId: year.yearId, name: 'Export plan',
    components: [{ code: 'TUITION', name: 'Tuition', amountPaise: Money.fromRupees(12000),
      frequency: 'annual' }],
  });
  await feePlanService.publish(acct(), plan.id, struct.staffId);
  const assignment = await feePlanService.assign(acct(), { enrollmentId, feePlanId: plan.id });
  const instalments = await feePlanService.scheduleInstallments(acct(), {
    feeAssignmentId: assignment.id, dueDates: ['2026-04-10'],
  });
  const invoice = await invoiceService.issueForInstallment(acct(), {
    installmentId: instalments[0]!.id, campusId: tenant.campusId,
  });
  invoiceId = invoice.id;
  invoiceTotal = Money.fromDecimalString(invoice.total);
});

afterAll(async () => {
  await destroyUsers([accountant.userId, teacherUser.userId]);
  await destroyTenants([tenant.orgId]);
  await Promise.all([pool.end(), authPool.end()]);
});

const acct = () => ({ tenantId: tenant.orgId, actorId: accountant.userId });
const teacher = () => ({ tenantId: tenant.orgId, actorId: teacherUser.userId });

async function asOwner<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: OWNER_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function aMandate(max = Money.fromRupees(15000), validTo?: string) {
  return mandateService.register(acct(), {
    payerPersonId, provider: 'razorpay', providerMandateId: `mnd_${randomUUID()}`,
    maxAmountPaise: max, frequency: 'monthly', validFrom: '2026-04-01',
    ...(validTo ? { validTo } : {}),
  });
}

describe('mandate lifecycle', () => {
  it('starts pending — registering one authorises nothing', async () => {
    const m = await aMandate();
    expect(m.status).toBe('pending');
  });

  it('the institute cannot authorise its own mandate', async () => {
    const m = await aMandate();
    // The heart of it: standing permission to take money comes from the payer's
    // bank. A staff member with database access must not be able to grant it.
    await expect(
      mandateService.transition(acct(), { mandateId: m.id, to: 'authorised' }),
    ).rejects.toMatchObject({ status: 403 });

    const after = await mandateService.byId(acct(), m.id);
    expect(after!.status).toBe('pending');
  });

  it('a signed provider callback authorises it', async () => {
    const m = await aMandate();
    const after = await mandateService.transition(acct(), {
      mandateId: m.id, to: 'authorised', bySignedCallback: true,
    });
    expect(after.status).toBe('authorised');
  });

  it('revocation is terminal — a later callback cannot reinstate it', async () => {
    const m = await aMandate();
    await mandateService.transition(acct(), {
      mandateId: m.id, to: 'authorised', bySignedCallback: true,
    });
    await mandateService.transition(acct(), { mandateId: m.id, to: 'revoked' });

    await expect(
      mandateService.transition(acct(), {
        mandateId: m.id, to: 'authorised', bySignedCallback: true,
      }),
    ).rejects.toMatchObject({ status: 409 });

    const after = await mandateService.byId(acct(), m.id);
    expect(after!.status).toBe('revoked');
  });

  it('a repeated callback for the state it is already in is not an error', async () => {
    const m = await aMandate();
    await mandateService.transition(acct(), { mandateId: m.id, to: 'revoked' });
    const again = await mandateService.transition(acct(), { mandateId: m.id, to: 'revoked' });
    expect(again.status).toBe('revoked');
  });

  it('a failure must carry the bank reason', async () => {
    const m = await aMandate();
    await expect(
      mandateService.transition(acct(), { mandateId: m.id, to: 'failed' }),
    ).rejects.toMatchObject({ status: 422 });

    const withReason = await mandateService.transition(acct(), {
      mandateId: m.id, to: 'failed', reason: 'insufficient funds',
    });
    expect(withReason.status).toBe('failed');
  });

  it('the transition table has no way back out of a terminal state', () => {
    for (const to of ['pending', 'authorised', 'paused', 'failed'] as const) {
      expect(transitionable('revoked', to)).toBe(false);
      expect(transitionable('expired', to)).toBe(false);
    }
  });

  it('refuses a presentation above the authorised ceiling', async () => {
    const m = await aMandate(Money.fromRupees(100));
    await mandateService.transition(acct(), {
      mandateId: m.id, to: 'authorised', bySignedCallback: true,
    });
    const verdict = await withTenant(acct(), (db) =>
      mandateService.presentable(db, m.id, Money.fromRupees(101), '2026-05-01'));
    expect(verdict).toEqual({ ok: false, reason: 'exceeds_max_amount' });
  });

  it('refuses a presentation outside the validity window', async () => {
    const m = await aMandate(Money.fromRupees(15000), '2026-06-30');
    await mandateService.transition(acct(), {
      mandateId: m.id, to: 'authorised', bySignedCallback: true,
    });
    const early = await withTenant(acct(), (db) =>
      mandateService.presentable(db, m.id, Money.fromRupees(100), '2026-03-31'));
    expect(early).toEqual({ ok: false, reason: 'not_yet_valid' });

    const late = await withTenant(acct(), (db) =>
      mandateService.presentable(db, m.id, Money.fromRupees(100), '2026-07-01'));
    expect(late).toEqual({ ok: false, reason: 'expired' });
  });

  it('refuses a presentation on a paused or unauthorised mandate', async () => {
    const m = await aMandate();
    const pending = await withTenant(acct(), (db) =>
      mandateService.presentable(db, m.id, Money.fromRupees(100), '2026-05-01'));
    expect(pending).toEqual({ ok: false, reason: 'mandate_pending' });

    await mandateService.transition(acct(), {
      mandateId: m.id, to: 'authorised', bySignedCallback: true,
    });
    await mandateService.transition(acct(), { mandateId: m.id, to: 'paused' });
    const paused = await withTenant(acct(), (db) =>
      mandateService.presentable(db, m.id, Money.fromRupees(100), '2026-05-01'));
    expect(paused).toEqual({ ok: false, reason: 'mandate_paused' });
  });

  it('a presentation creates a PENDING payment, not money in the books', async () => {
    const m = await aMandate();
    await mandateService.transition(acct(), {
      mandateId: m.id, to: 'authorised', bySignedCallback: true,
    });

    const { paymentId } = await mandateService.present(acct(), {
      mandateId: m.id, invoiceId, amountMinor: Money.fromRupees(100), onDate: '2026-05-01',
    });

    const payment = await paymentService.byId(acct(), paymentId);
    expect(payment!.status).toBe('pending');

    // Nothing has been received, so the invoice is untouched.
    const invoice = await invoiceService.byId(acct(), invoiceId);
    expect(invoice!.amount_paid).toBe('0.00');

    const entries = await withTenant(acct(), (db) =>
      ledgerService.entriesFor(db, 'payment', paymentId));
    expect(entries).toEqual([]);
  });

  it('refuses to present for more than the invoice still owes', async () => {
    const m = await aMandate(Money.fromRupees(100000));
    await mandateService.transition(acct(), {
      mandateId: m.id, to: 'authorised', bySignedCallback: true,
    });
    await expect(
      mandateService.present(acct(), {
        mandateId: m.id, invoiceId, amountMinor: invoiceTotal + Money.fromRupees(1),
        onDate: '2026-05-02',
      }),
    ).rejects.toMatchObject({ status: 409 });
  });
});

describe('finance export', () => {
  const RANGE = { from: '2020-01-01', to: '2099-12-31' };

  it('a teacher exports nothing at all', async () => {
    // Not an empty file by accident: the RLS predicate is the same one that
    // hides invoices, so a teacher's export is empty by construction.
    const csv = await exportService.dayBookCsv(teacher(), RANGE);
    expect(csv.rowCount).toBe(0);
  });

  it('every debit has a matching credit in the exported period', async () => {
    const rows = await withTenant(acct(), (db) => exportService.dayBook(db, RANGE));
    expect(rows.length).toBeGreaterThan(0);

    const debits = Money.sum(rows.map((r) => Money.fromDecimalString(r.debit)));
    const credits = Money.sum(rows.map((r) => Money.fromDecimalString(r.credit)));
    expect(debits).toBe(credits);
  });

  it('the CSV has one line per ledger row plus a header', async () => {
    const csv = await exportService.dayBookCsv(acct(), RANGE);
    const lines = csv.content.split('\r\n').filter((l) => l !== '');
    expect(lines.length).toBe(csv.rowCount + 1);
    expect(lines[0]).toBe('date,voucher,account,debit,credit,source,narration');
    expect(csv.content.endsWith('\r\n')).toBe(true);
  });

  it('neutralises a narration that would run as a spreadsheet formula', async () => {
    // A narration can carry a family's own text. Opened in Excel, a cell
    // starting with '=' is executed.
    await withTenant(acct(), (db) =>
      ledgerService.post(db, {
        campusId: tenant.campusId,
        sourceType: 'probe_csv',
        sourceId: randomUUID(),
        lines: [
          { account: '1220_cash', debit: Money.fromRupees(5),
            narration: '=cmd|\' /c calc\'!A1' },
          { account: '4100_fee_income', credit: Money.fromRupees(5), narration: 'a,b "quoted"' },
        ],
      }));

    const csv = await exportService.dayBookCsv(acct(), RANGE);
    // Quoted because it contains a comma, and prefixed so Excel treats it as
    // text rather than a formula.
    expect(csv.content).toMatch(/,'=cmd\|/);
    expect(csv.content).not.toMatch(/,=cmd/);
    // And the comma-and-quote narration survives a round trip intact.
    expect(csv.content).toContain('"a,b ""quoted"""');
  });

  it('refuses a range that is not a real date', async () => {
    await expect(
      exportService.dayBookCsv(acct(), { from: '2026-02-31', to: '2026-03-01' }),
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      exportService.dayBookCsv(acct(), { from: '2026-04-01', to: '2026-03-01' }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('exports only the requested period', async () => {
    const empty = await exportService.dayBookCsv(acct(), { from: '1999-01-01', to: '1999-12-31' });
    expect(empty.rowCount).toBe(0);
  });

  it('records the export as a RESTRICTED audit event', async () => {
    await exportService.dayBookCsv(acct(), RANGE);
    const rows = await withTenant(acct(), async (db) => {
      const r = await db.query<{ classification: string }>(
        `SELECT classification FROM audit_log WHERE action = 'finance.exported'`,
      );
      return r.rows;
    });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.classification === 'RESTRICTED')).toBe(true);
  });

  it('writes Tally dates as DD-MMM-YYYY', () => {
    expect(tallyDate('2026-04-01')).toBe('01-Apr-2026');
    expect(tallyDate('2026-12-31')).toBe('31-Dec-2026');
  });

  it('gives Tally one voucher per entry group, with debits carried negative', async () => {
    const xml = await exportService.tallyXml(acct(), { ...RANGE, companyName: 'Test & Co' });
    const rows = await withTenant(acct(), (db) => exportService.dayBook(db, RANGE));
    const groups = new Set(rows.map((r) => r.entry_group_id));

    expect(xml.voucherCount).toBe(groups.size);
    expect((xml.content.match(/<VOUCHER /g) ?? []).length).toBe(groups.size);

    // The sign convention, which is the thing that silently mirrors the books
    // when it is wrong. Counting negatives is NOT enough: the groups balance, so
    // inverting every sign leaves the counts identical. Each entry has to be
    // checked against ITS OWN side.
    const blocks = xml.content.match(
      /<ALLLEDGERENTRIES\.LIST>[\s\S]*?<\/ALLLEDGERENTRIES\.LIST>/g) ?? [];
    expect(blocks.length).toBe(rows.length);
    for (const block of blocks) {
      const isDebit = block.includes('<ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>');
      const amount = /<AMOUNT>(-?[\d.]+)<\/AMOUNT>/.exec(block)![1]!;
      expect(amount.startsWith('-')).toBe(isDebit);
    }

    const debitRows = rows.filter((r) => Number(r.debit) !== 0).length;
    expect((xml.content.match(/<ISDEEMEDPOSITIVE>Yes/g) ?? []).length).toBe(debitRows);

    // And the company name is escaped, not injected.
    expect(xml.content).toContain('Test &amp; Co');
    expect(xml.content).not.toContain('Test & Co');
  });

  it('the two formats agree about the same period', async () => {
    const csv = await exportService.dayBookCsv(acct(), RANGE);
    const xml = await exportService.tallyXml(acct(), { ...RANGE, companyName: 'Test' });
    const xmlLines = (xml.content.match(/<ALLLEDGERENTRIES.LIST>/g) ?? []).length;
    expect(xmlLines).toBe(csv.rowCount);
  });
});
