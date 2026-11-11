/**
 * M47.1 / M47.2 — the receipt sheet, and who may read what is on it.
 *
 * 0089 opens receipts, payments, allocations and invoice lines to a family by
 * reading through `invoice_read` rather than restating it. So every test here
 * is the same question asked of a different table: does the row follow the
 * invoice — visible to exactly the people who can see the invoice, and gone
 * for exactly the people who cannot.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import {
  createTenant, destroyTenants, createUser, destroyUsers, grantRole, purgeTestData,
  createAcademicYear, createAcademicStructure, createLearnerRaw, linkGuardianRaw,
  createPersonRaw, createClassGroupRaw, createSectionFor, makeTeacher,
  OWNER_URL, type TenantFixture, type UserFixture,
} from './fixtures.ts';
import { receiptService } from '../src/modules/billing/receipt.service.ts';
import { withTenant } from '../src/db/tenant.ts';
import { pool } from '../src/db/pool.ts';
import { authPool } from '../src/db/auth-pool.ts';

const PASSWORD = 'correct-horse-battery';

let tenant: TenantFixture;
let other: TenantFixture;
let mumUser: UserFixture, coParentUser: UserFixture, formerUser: UserFixture;
let dadUser: UserFixture, teacherUser: UserFixture, accountantUser: UserFixture;
let elsewhereUser: UserFixture;

let aaravInvoice = '', diyaInvoice = '', otherSchoolInvoice = '';
let cashPayment = '', cashReceipt = '', sharedPayment = '';

const as = (u: UserFixture, t: TenantFixture = tenant) => ({ tenantId: t.orgId, actorId: u.userId });

async function owner<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: OWNER_URL });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

/** How many rows of `table` matching `where` this person can see. */
const sees = (u: UserFixture, table: string, where: string, params: unknown[],
  t: TenantFixture = tenant) =>
  withTenant(as(u, t), async (db) => {
    const { rows } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ${table} WHERE ${where}`, params);
    return rows[0]!.n;
  });

beforeAll(async () => {
  await purgeTestData('%@rcpt-test.example');
  tenant = await createTenant('RCP');
  other = await createTenant('RCP2');

  mumUser = await createUser('mum@rcpt-test.example', PASSWORD);
  coParentUser = await createUser('coparent@rcpt-test.example', PASSWORD);
  formerUser = await createUser('former@rcpt-test.example', PASSWORD);
  dadUser = await createUser('dad@rcpt-test.example', PASSWORD);
  teacherUser = await createUser('teacher@rcpt-test.example', PASSWORD);
  accountantUser = await createUser('accounts@rcpt-test.example', PASSWORD);
  elsewhereUser = await createUser('parent@rcpt2-test.example', PASSWORD);

  for (const u of [mumUser, coParentUser, formerUser, dadUser]) {
    await grantRole(tenant.orgId, u.userId, 'GUARDIAN', 'self', tenant.campusId);
  }
  await grantRole(tenant.orgId, teacherUser.userId, 'TEACHER', 'campus', tenant.campusId);
  await grantRole(tenant.orgId, accountantUser.userId, 'ACCOUNTANT', 'campus', tenant.campusId);
  await grantRole(other.orgId, elsewhereUser.userId, 'GUARDIAN', 'self', other.campusId);

  const mum = await createPersonRaw(tenant.orgId, 'Kavita', { userAccountId: mumUser.userId });
  const coParent = await createPersonRaw(tenant.orgId, 'Suresh', { userAccountId: coParentUser.userId });
  const former = await createPersonRaw(tenant.orgId, 'Lakshmi', { userAccountId: formerUser.userId });
  const dad = await createPersonRaw(tenant.orgId, 'Rajesh', { userAccountId: dadUser.userId });
  const far = await createPersonRaw(other.orgId, 'Far', { userAccountId: elsewhereUser.userId });
  await createPersonRaw(tenant.orgId, 'Priya', { userAccountId: accountantUser.userId });

  const struct = await createAcademicStructure(tenant.orgId, tenant.unitId, tenant.campusId);
  const year = await createAcademicYear(tenant.orgId, tenant.unitId, '2026-27', 2026, { status: 'active' });
  const cg = await createClassGroupRaw(tenant.orgId, struct.programmeId, year.yearId, 'Class IX');
  const sectionId = await createSectionFor(tenant.orgId, cg, 'A');
  const cashier = await makeTeacher(tenant.orgId, tenant.campusId, teacherUser.userId,
    { givenName: 'Meera' });

  const aarav = await createLearnerRaw(tenant.orgId, 'Aarav', 'RCP-0001');
  const diya = await createLearnerRaw(tenant.orgId, 'Diya', 'RCP-0002');
  await linkGuardianRaw(tenant.orgId, aarav.studentId, mum, { isPrimary: true });
  // The same child, a parent the school does not share fees with.
  await linkGuardianRaw(tenant.orgId, aarav.studentId, coParent, { canViewFinance: false, canPay: false });
  await linkGuardianRaw(tenant.orgId, diya.studentId, dad, { isPrimary: true });

  const otherStruct = await createAcademicStructure(other.orgId, other.unitId, other.campusId);
  const otherYear = await createAcademicYear(other.orgId, other.unitId, '2026-27', 2026, { status: 'active' });
  const otherCg = await createClassGroupRaw(other.orgId, otherStruct.programmeId, otherYear.yearId, 'Class IX');
  const otherSection = await createSectionFor(other.orgId, otherCg, 'A');
  const farChild = await createLearnerRaw(other.orgId, 'Zoya', 'RCP2-0001');
  await linkGuardianRaw(other.orgId, farChild.studentId, far, { isPrimary: true });

  await owner(async (c) => {
    // Somebody who had finance access to Aarav until last month.
    await c.query(
      `INSERT INTO guardian_link (tenant_id, student_id, guardian_person_id, relationship,
                                  can_view_academics, can_view_finance, can_pay,
                                  effective_from, effective_to)
       VALUES ($1, $2, $3, 'uncle_aunt', true, true, true, CURRENT_DATE - 400, CURRENT_DATE - 30)`,
      [tenant.orgId, aarav.studentId, former]);

    const enrol = async (t: TenantFixture, student: string, section: string, y: string) =>
      (await c.query<{ id: string }>(
        `INSERT INTO enrollment (tenant_id, student_id, section_id, academic_year_id)
         VALUES ($1, $2, $3, $4) RETURNING id`, [t.orgId, student, section, y])).rows[0]!.id;
    const invoice = async (t: TenantFixture, enrollment: string, no: string, paid: string) =>
      (await c.query<{ id: string }>(
        `INSERT INTO invoice (tenant_id, campus_id, enrollment_id, invoice_no, financial_year,
                              issued_on, due_on, subtotal, total, amount_paid, status)
         VALUES ($1, $2, $3, $4, '2026-27', CURRENT_DATE - 10, CURRENT_DATE + 5,
                 4500.00, 4500.00, $5::numeric,
                 CASE WHEN $5::numeric = 0 THEN 'issued' ELSE 'part_paid' END)
         RETURNING id`, [t.orgId, t.campusId, enrollment, no, paid])).rows[0]!.id;
    const pay = async (t: TenantFixture, amount: string, key: string, receivedBy: string | null) =>
      (await c.query<{ id: string }>(
        `INSERT INTO payment (tenant_id, campus_id, method, amount, status,
                              idempotency_key, received_by)
         VALUES ($1, $2, 'cash', $3, 'succeeded', $4, $5) RETURNING id`,
        [t.orgId, t.campusId, amount, key, receivedBy])).rows[0]!.id;
    const allocate = (t: TenantFixture, payment: string, inv: string, amount: string) => c.query(
      `INSERT INTO payment_allocation (tenant_id, payment_id, invoice_id, amount)
       VALUES ($1, $2, $3, $4)`, [t.orgId, payment, inv, amount]);
    const receipt = async (t: TenantFixture, payment: string, no: string, amount: string) =>
      (await c.query<{ id: string }>(
        `INSERT INTO receipt (tenant_id, campus_id, payment_id, receipt_no, financial_year, amount)
         VALUES ($1, $2, $3, $4, '2026-27', $5) RETURNING id`,
        [t.orgId, t.campusId, payment, no, amount])).rows[0]!.id;

    aaravInvoice = await invoice(tenant, await enrol(tenant, aarav.studentId, sectionId, year.yearId), 'RCP-INV-1', '1500.00');
    diyaInvoice = await invoice(tenant, await enrol(tenant, diya.studentId, sectionId, year.yearId), 'RCP-INV-2', '500.00');
    otherSchoolInvoice = await invoice(other,
      await enrol(other, farChild.studentId, otherSection, otherYear.yearId), 'RCP2-INV-1', '700.00');

    await c.query(
      `INSERT INTO invoice_line (tenant_id, invoice_id, description, unit_amount, line_total)
       VALUES ($1, $2, 'Tuition', 4000.00, 4000.00), ($1, $2, 'Lab fee', 500.00, 500.00)`,
      [tenant.orgId, aaravInvoice]);
    await c.query(
      `INSERT INTO invoice_line (tenant_id, invoice_id, description, unit_amount, line_total)
       VALUES ($1, $2, 'Tuition', 4500.00, 4500.00)`, [tenant.orgId, diyaInvoice]);

    // Cash at the counter: nobody is recorded as the payer. This is the
    // payment no guardian could see before 0089.
    cashPayment = await pay(tenant, '1000.00', 'rcpt-cash-1', cashier.staffId);
    await allocate(tenant, cashPayment, aaravInvoice, '1000.00');
    cashReceipt = await receipt(tenant, cashPayment, 'RCP-000001', '1000.00');

    // One payment for two cousins: ₹500 each.
    sharedPayment = await pay(tenant, '1000.00', 'rcpt-shared-1', cashier.staffId);
    await allocate(tenant, sharedPayment, aaravInvoice, '500.00');
    await allocate(tenant, sharedPayment, diyaInvoice, '500.00');
    await receipt(tenant, sharedPayment, 'RCP-000002', '1000.00');

    const farPayment = await pay(other, '700.00', 'rcpt2-cash-1', null);
    await allocate(other, farPayment, otherSchoolInvoice, '700.00');
    await receipt(other, farPayment, 'RCP-000001', '700.00');

    // Money that never arrived, against Aarav's invoice. No receipt for it
    // should ever print.
    const failed = (await c.query<{ id: string }>(
      `INSERT INTO payment (tenant_id, campus_id, method, amount, status, idempotency_key)
       VALUES ($1, $2, 'upi', 250.00, 'failed', 'rcpt-failed-1') RETURNING id`,
      [tenant.orgId, tenant.campusId])).rows[0]!.id;
    await allocate(tenant, failed, aaravInvoice, '250.00');
    await receipt(tenant, failed, 'RCP-000003', '250.00');
  });
});

afterAll(async () => {
  await destroyUsers([mumUser, coParentUser, formerUser, dadUser, teacherUser,
    accountantUser, elsewhereUser].map((u) => u.userId));
  await destroyTenants([tenant.orgId, other.orgId]);
  await Promise.all([pool.end(), authPool.end()]);
});

describe('the sheet, for the office', () => {
  it('has the school, the learner, the lines and every standing receipt', async () => {
    const sheet = (await receiptService.sheetFor(as(accountantUser), aaravInvoice))!;
    expect(sheet.learner).toMatchObject({ name: 'Aarav Learner', admission_no: 'RCP-0001',
      class_name: 'Class IX', section_name: 'A' });
    expect(sheet.invoice).toMatchObject({ invoice_no: 'RCP-INV-1', total: '4500.00',
      amount_paid: '1500.00', status: 'part_paid' });
    expect(sheet.lines.map((l) => [l.description, l.line_total]))
      .toEqual([['Tuition', '4000.00'], ['Lab fee', '500.00']]);
    expect(sheet.receipts.map((r) => [r.receipt_no, r.amount, r.allocated, r.method]))
      .toEqual([['RCP-000001', '1000.00', '1000.00', 'cash'],
                ['RCP-000002', '1000.00', '500.00', 'cash']]);
    expect(sheet.receipts[0]!.received_by).toBe('Meera Teacher');
    expect(sheet.school.campus).toBeTruthy();
  });

  it('never lists a receipt for money that did not arrive', async () => {
    const sheet = (await receiptService.sheetFor(as(accountantUser), aaravInvoice))!;
    expect(sheet.receipts.map((r) => r.receipt_no)).not.toContain('RCP-000003');
  });

  it('is undefined for an invoice that does not exist, or is another school’s', async () => {
    expect(await receiptService.sheetFor(as(accountantUser),
      '00000000-0000-4000-8000-000000000000')).toBeUndefined();
    expect(await receiptService.sheetFor(as(accountantUser), otherSchoolInvoice)).toBeUndefined();
  });
});

describe('the sheet, for a family', () => {
  it('shows a parent the counter receipt for their own child', async () => {
    const sheet = (await receiptService.sheetFor(as(mumUser), aaravInvoice))!;
    expect(sheet.receipts.map((r) => r.receipt_no)).toEqual(['RCP-000001', 'RCP-000002']);
    expect(sheet.lines).toHaveLength(2);
  });

  it('shows each family only its own share of a payment made for two', async () => {
    const mine = (await receiptService.sheetFor(as(dadUser), diyaInvoice))!;
    expect(mine.receipts.map((r) => [r.receipt_no, r.allocated])).toEqual([['RCP-000002', '500.00']]);
  });

  it('gives nothing to the other family, the unshared parent, a former guardian or a teacher', async () => {
    for (const u of [dadUser, coParentUser, formerUser, teacherUser]) {
      expect(await receiptService.sheetFor(as(u), aaravInvoice), u.email).toBeUndefined();
    }
  });

  it('gives nothing across schools', async () => {
    expect(await receiptService.sheetFor(as(elsewhereUser, other), aaravInvoice)).toBeUndefined();
    expect(await receiptService.sheetFor(as(mumUser), otherSchoolInvoice)).toBeUndefined();
  });
});

describe('each table follows the invoice, asked directly', () => {
  /*
   * The service inner-joins everything to the invoice, so a test through it
   * passes whether or not the policies on the other four tables say anything.
   * These read each table the way some later query will.
   */
  const tables: Array<[string, string, () => unknown[]]> = [
    ['invoice_line', 'invoice_id = $1', () => [aaravInvoice]],
    ['payment_allocation', 'invoice_id = $1', () => [aaravInvoice]],
    ['payment', 'id = $1', () => [cashPayment]],
    ['receipt', 'id = $1', () => [cashReceipt]],
  ];

  it.each(tables)('%s: the parent with finance access sees it', async (table, where, params) => {
    expect(await sees(mumUser, table, where, params())).toBeGreaterThan(0);
  });

  it.each(tables)('%s: nobody else in the school without finance access does', async (table, where, params) => {
    for (const u of [dadUser, coParentUser, formerUser, teacherUser]) {
      expect(await sees(u, table, where, params()), `${table} for ${u.email}`).toBe(0);
    }
  });

  it.each(tables)('%s: the accountant still sees it', async (table, where, params) => {
    expect(await sees(accountantUser, table, where, params())).toBeGreaterThan(0);
  });

  it.each(tables)('%s: a parent at another school does not', async (table, where, params) => {
    expect(await sees(elsewhereUser, table, where, params(), other)).toBe(0);
  });

  it('a parent sees the shared payment, and not the other cousin’s allocation of it', async () => {
    expect(await sees(mumUser, 'payment', 'id = $1', [sharedPayment])).toBe(1);
    expect(await sees(mumUser, 'payment_allocation', 'payment_id = $1', [sharedPayment])).toBe(1);
    expect(await sees(mumUser, 'invoice_line', 'invoice_id = $1', [diyaInvoice])).toBe(0);
  });

  it('opens nothing for writing', async () => {
    const changed = await withTenant(as(mumUser), async (db) => {
      const a = await db.query(`UPDATE payment SET amount = 1 WHERE id = $1`, [cashPayment]);
      const b = await db.query(`UPDATE invoice_line SET description = 'x' WHERE invoice_id = $1`, [aaravInvoice]);
      return (a.rowCount ?? 0) + (b.rowCount ?? 0);
    });
    expect(changed).toBe(0);
  });
});
