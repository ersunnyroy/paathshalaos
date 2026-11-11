/**
 * M25 — billing a school, and the arithmetic on a legal document.
 *
 * The first half tests the tax calculation as arithmetic. The second half
 * tests the things only a database can enforce: a gap-free series, an invoice
 * that cannot be edited, and a credit note that cannot exceed what it corrects.
 *
 * Every number here is checked against itself rather than against a figure
 * somebody looked up: the parts add to the whole, the halves are equal, the
 * tax is the stated percentage of the stated subtotal. NOT VERIFIED BY AN
 * ACCOUNTANT — the rate and the SAC code are inputs, deliberately, and what is
 * asserted is that the machinery is consistent, not that 18% is correct.
 */
import './fixtures.ts';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import {
  createTenant, destroyTenants, purgeTestData, OWNER_URL, type TenantFixture,
} from './fixtures.ts';
import {
  taxInvoice, supplyTypeFor, financialYearOf, documentNumber,
} from '../src/modules/platform-billing/gst.ts';
import { invoicingService } from '../src/modules/platform-billing/invoicing.service.ts';
import { Money } from '../src/modules/billing/money.ts';
import { platformPool } from '../src/db/platform-pool.ts';
import { pool } from '../src/db/pool.ts';
import { authPool } from '../src/db/auth-pool.ts';

/* ------------------------------------------------------------- arithmetic */

const line = (over: Partial<Parameters<typeof taxInvoice>[0]['lines'][0]> = {}) => ({
  description: 'Standard plan (monthly)',
  sacCode: '997331',
  quantity: '1',
  unitPrice: Money.fromDecimalString('5000.00'),
  taxRate: 18,
  ...over,
});

describe('which tax applies', () => {
  it('splits within a state and integrates across one', () => {
    // Not a formatting choice. The two go to different places, and the wrong
    // one is a return filed against the wrong government.
    expect(supplyTypeFor('29', '29')).toBe('intra_state');
    expect(supplyTypeFor('29', '27')).toBe('inter_state');
  });
});

describe('the numbers on the document', () => {
  it('splits an intra-state supply into equal halves', () => {
    const taxed = taxInvoice({ supplyType: 'intra_state', lines: [line()] });
    expect(Money.toDecimalString(taxed.taxableValue)).toBe('5000.00');
    expect(Money.toDecimalString(taxed.cgst)).toBe('450.00');
    expect(Money.toDecimalString(taxed.sgst)).toBe('450.00');
    expect(Money.toDecimalString(taxed.igst)).toBe('0.00');
    expect(Money.toDecimalString(taxed.total)).toBe('5900.00');
  });

  it('puts the whole tax in one place across a state line', () => {
    const taxed = taxInvoice({ supplyType: 'inter_state', lines: [line()] });
    expect(Money.toDecimalString(taxed.igst)).toBe('900.00');
    expect(taxed.cgst).toBe(0n);
    expect(taxed.sgst).toBe(0n);
  });

  it('never carries both regimes', () => {
    // The schema refuses it too, which is the point: two places that have to
    // agree, rather than one that has to be remembered.
    for (const supplyType of ['intra_state', 'inter_state'] as const) {
      const t = taxInvoice({ supplyType, lines: [line()] });
      expect(t.igst === 0n || (t.cgst === 0n && t.sgst === 0n)).toBe(true);
    }
  });

  it('keeps the halves equal, whatever the amount', () => {
    // The schema's `cgst = sgst` refuses anything else, and the first version
    // of this code produced unequal halves: it computed 18% and split it, and
    // 18% of 1234.51 is 222.21 paise, which does not halve evenly.
    for (const amount of ['1234.51', '1234.57', '0.01', '99.99', '7777.77',
                          '0.05', '0.11', '55.55']) {
      const taxed = taxInvoice({
        supplyType: 'intra_state',
        lines: [line({ unitPrice: Money.fromDecimalString(amount) })],
      });
      expect(taxed.cgst, amount).toBe(taxed.sgst);
      expect(taxed.taxableValue + taxed.cgst + taxed.sgst, amount)
        .toBe(taxed.total);
    }
  });

  it('levies each half at half the rate, not half of the whole tax', () => {
    // Nine per cent of 1234.51 is 111.11, twice — 222.22. Eighteen per cent
    // of it is 222.21. The one-paise difference is a property of the tax
    // rather than an error, and the version that looked tidier was wrong.
    const intra = taxInvoice({
      supplyType: 'intra_state',
      lines: [line({ unitPrice: Money.fromDecimalString('1234.51') })],
    });
    const inter = taxInvoice({
      supplyType: 'inter_state',
      lines: [line({ unitPrice: Money.fromDecimalString('1234.51') })],
    });
    expect(Money.toDecimalString(intra.cgst)).toBe('111.11');
    expect(Money.toDecimalString(intra.sgst)).toBe('111.11');
    expect(Money.toDecimalString(inter.igst)).toBe('222.21');
    expect(intra.cgst + intra.sgst).toBe(inter.igst + 1n);
  });

  it('adds up, whatever the amount', () => {
    for (const amount of ['0.00', '0.01', '1.00', '333.33', '99999.99']) {
      for (const supplyType of ['intra_state', 'inter_state'] as const) {
        const t = taxInvoice({
          supplyType, lines: [line({ unitPrice: Money.fromDecimalString(amount) })],
        });
        expect(t.taxableValue + t.cgst + t.sgst + t.igst, `${amount} ${supplyType}`)
          .toBe(t.total);
      }
    }
  });

  it('bills a part-month without going through a float', () => {
    // 0.42 of 5000.00 is 2100.00 exactly. `Number('0.42') * 5000` is
    // 2100.0000000000002, and a tax calculation is not the place to find out.
    const taxed = taxInvoice({
      supplyType: 'intra_state',
      lines: [line({ quantity: '0.42' })],
    });
    expect(Money.toDecimalString(taxed.taxableValue)).toBe('2100.00');
  });

  it('rounds a part-month half-up, to the paise', () => {
    // 0.33 of 1000.00 is 330.00; 0.33 of 1001.00 is 330.33.
    expect(Money.toDecimalString(taxInvoice({
      supplyType: 'intra_state',
      lines: [line({ quantity: '0.33', unitPrice: Money.fromDecimalString('1001.00') })],
    }).taxableValue)).toBe('330.33');
  });

  it('lands on the right side of a half paise', () => {
    // 0.29 of 1000.50 is 290.145 exactly — a half paise, which rounds up to
    // 290.15. Through a float it is 290.14499999999998, which rounds down.
    //
    // This test exists because breaking the exact arithmetic deliberately
    // failed nothing: every other value in this file agrees between the two,
    // and a float path that is right almost always is the kind that is found
    // by a customer rather than by a suite.
    expect(Money.toDecimalString(taxInvoice({
      supplyType: 'intra_state',
      lines: [line({
        quantity: '0.29', unitPrice: Money.fromDecimalString('1000.50'),
      })],
    }).taxableValue)).toBe('290.15');
  });

  it('refuses a quantity that is not one', () => {
    // A quantity arriving as "1e3" or "0.4999" is a caller with a float
    // already, which is the thing this avoids.
    for (const bad of ['1e3', '0.4999', '-1', '', 'one', '1.']) {
      expect(() => taxInvoice({
        supplyType: 'intra_state', lines: [line({ quantity: bad })],
      }), bad).toThrow();
    }
  });

  it('refuses an invoice with no lines', () => {
    expect(() => taxInvoice({ supplyType: 'intra_state', lines: [] })).toThrow();
  });

  it('refuses lines at different rates rather than averaging them', () => {
    // Genuinely possible and genuinely not handled: it needs a per-rate
    // breakdown on the document, which the schema does not carry. Refusing is
    // the honest answer; an average would be a plausible wrong number.
    expect(() => taxInvoice({
      supplyType: 'intra_state',
      lines: [line(), line({ taxRate: 5 })],
    })).toThrow(/per-rate breakdown/);
  });

  it('sums several lines at one rate', () => {
    const taxed = taxInvoice({
      supplyType: 'inter_state',
      lines: [
        line({ unitPrice: Money.fromDecimalString('1000.00') }),
        line({ unitPrice: Money.fromDecimalString('333.33') }),
      ],
    });
    expect(Money.toDecimalString(taxed.taxableValue)).toBe('1333.33');
    // Computed on the subtotal, not per line and summed — so the tax is
    // exactly the stated percentage of the number printed above it.
    expect(Money.toDecimalString(taxed.igst)).toBe('240.00');
    expect(Money.toDecimalString(taxed.total)).toBe('1573.33');
  });
});

describe('the financial year', () => {
  it('runs April to March', () => {
    expect(financialYearOf(new Date('2026-04-01T00:00:00Z'))).toBe('2026-27');
    expect(financialYearOf(new Date('2027-03-31T23:59:59Z'))).toBe('2026-27');
    expect(financialYearOf(new Date('2026-03-31T23:59:59Z'))).toBe('2025-26');
    expect(financialYearOf(new Date('2027-04-01T00:00:00Z'))).toBe('2027-28');
  });

  it('gets the boundary right, which is the only part that is hard', () => {
    // A day out here means either a duplicate number or a series that
    // restarts mid-year, and both are visible to an auditor before they are
    // visible to us.
    expect(financialYearOf(new Date('2026-03-31T18:30:00Z'))).toBe('2025-26');
    expect(financialYearOf(new Date('2026-04-01T00:00:01Z'))).toBe('2026-27');
  });

  it('crosses a century without producing 2099-100', () => {
    expect(financialYearOf(new Date('2099-04-01T00:00:00Z'))).toBe('2099-00');
  });
});

describe('the document number', () => {
  it('fits inside the statutory sixteen characters', () => {
    const number = documentNumber('PS', '2026-27', 1);
    expect(number).toBe('PS/2627/000001');
    expect(number.length).toBeLessThanOrEqual(16);
  });

  it('refuses to produce one that does not', () => {
    // Better a failed invoice than one with a number a filing will reject.
    expect(() => documentNumber('PAATHSHALA', '2026-27', 1)).toThrow(/16/);
  });

  it('pads so the series sorts as it reads', () => {
    expect(documentNumber('PS', '2026-27', 42)).toBe('PS/2627/000042');
    expect(documentNumber('PS', '2026-27', 999999)).toBe('PS/2627/999999');
  });
});

/* ------------------------------------------------------------- against pg */

let tenantA: TenantFixture;
let tenantB: TenantFixture;
let subA: string;
let subB: string;

async function owner<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: OWNER_URL });
  await client.connect();
  try { return await fn(client); } finally { await client.end(); }
}

beforeAll(async () => {
  await purgeTestData('%@bill-test.example');
  await owner(async (c) => {
    await c.query('DELETE FROM platform_document_series');
    await c.query(
      `INSERT INTO platform_tax_identity (id, legal_name, gstin, state_code, address)
       VALUES (true, 'paathshalaOS Technologies Private Limited',
               '29AABCP1234C1ZX', '29', 'Bengaluru, Karnataka')
       ON CONFLICT (id) DO UPDATE SET gstin = EXCLUDED.gstin,
         state_code = EXCLUDED.state_code`);
  });

  tenantA = await createTenant('BILLA');
  tenantB = await createTenant('BILLB');

  await owner(async (c) => {
    // Same state as us — intra-state.
    await c.query(
      `INSERT INTO tenant_billing_profile
         (tenant_id, billing_name, gstin, state_code, billing_email, address)
       VALUES ($1, 'Sunrise Public School Trust', '29AAACS1111A1ZK', '29',
               'accounts@bill-test.example', 'Bengaluru, Karnataka')`,
      [tenantA.orgId]);
    // A different state, and unregistered — both variations at once, because
    // an unregistered customer is an ordinary case.
    await c.query(
      `INSERT INTO tenant_billing_profile
         (tenant_id, billing_name, gstin, state_code, billing_email, address)
       VALUES ($1, 'Hilltop Academy', NULL, '27',
               'office@bill-test.example', 'Pune, Maharashtra')`,
      [tenantB.orgId]);

    const plan = await c.query<{ id: string }>(
      `INSERT INTO plan (code, name) VALUES ($1, 'Standard') RETURNING id`,
      [`bill_${randomUUID().slice(0, 8).replace(/-/g, '')}`]);
    const version = await c.query<{ id: string }>(
      `INSERT INTO plan_version
         (plan_id, version, price_monthly, price_annual, status, published_at)
       VALUES ($1, 1, 5000.00, 54000.00, 'published', now()) RETURNING id`,
      [plan.rows[0]!.id]);

    for (const [tenant, holder] of [[tenantA, 'A'], [tenantB, 'B']] as const) {
      const s = await c.query<{ id: string }>(
        `INSERT INTO subscription
           (tenant_id, plan_version_id, status, billing_period, period_start)
         VALUES ($1, $2, 'active', 'monthly', CURRENT_DATE) RETURNING id`,
        [tenant.orgId, version.rows[0]!.id]);
      if (holder === 'A') subA = s.rows[0]!.id; else subB = s.rows[0]!.id;
    }
  });
});

afterAll(async () => {
  await owner(async (c) => {
    for (const t of [tenantA, tenantB]) {
      await c.query('ALTER TABLE platform_credit_note DISABLE TRIGGER platform_credit_note_no_delete');
      await c.query('ALTER TABLE platform_invoice DISABLE TRIGGER platform_invoice_no_delete');
      await c.query('DELETE FROM platform_credit_note WHERE tenant_id = $1', [t.orgId]);
      await c.query('DELETE FROM platform_invoice_line WHERE platform_invoice_id IN (SELECT id FROM platform_invoice WHERE tenant_id = $1)', [t.orgId]);
      await c.query('DELETE FROM platform_invoice WHERE tenant_id = $1', [t.orgId]);
      await c.query('ALTER TABLE platform_credit_note ENABLE TRIGGER platform_credit_note_no_delete');
      await c.query('ALTER TABLE platform_invoice ENABLE TRIGGER platform_invoice_no_delete');
      await c.query('DELETE FROM tenant_billing_profile WHERE tenant_id = $1', [t.orgId]);
    }
  });
  await destroyTenants([tenantA.orgId, tenantB.orgId]);
  await Promise.all([pool.end(), authPool.end(), platformPool.end()]);
});

const period = { periodStart: '2026-09-01', periodEnd: '2026-09-30' };
const on = new Date('2026-09-01T00:00:00Z');

describe('issuing an invoice', () => {
  it('splits the tax for a school in our own state', async () => {
    const invoice = await invoicingService.issueForPeriod({
      tenantId: tenantA.orgId, subscriptionId: subA, ...period, issuedOn: on,
    });
    expect(invoice.supply_type).toBe('intra_state');
    expect(invoice.taxable_value).toBe('5000.00');
    expect(invoice.cgst).toBe('450.00');
    expect(invoice.sgst).toBe('450.00');
    expect(invoice.igst).toBe('0.00');
    expect(invoice.total).toBe('5900.00');
  });

  it('integrates the tax for a school in another state', async () => {
    const invoice = await invoicingService.issueForPeriod({
      tenantId: tenantB.orgId, subscriptionId: subB, ...period, issuedOn: on,
    });
    expect(invoice.supply_type).toBe('inter_state');
    expect(invoice.igst).toBe('900.00');
    expect(invoice.cgst).toBe('0.00');
  });

  it('numbers consecutively within the financial year', async () => {
    const third = await invoicingService.issueForPeriod({
      tenantId: tenantA.orgId, subscriptionId: subA, ...period, issuedOn: on,
    });
    expect(third.financial_year).toBe('2026-27');
    expect(third.serial).toBe(3);
    expect(third.invoice_no).toBe('PS/2627/000003');
  });

  it('leaves no gap when an invoice fails to issue', async () => {
    // The reason the serial comes from a locked counter and not a sequence: a
    // sequence does not roll back, so a failed insert leaves a hole, and a
    // hole is a question from an auditor about an invoice that does not exist.
    const before = await seriesAt('invoice', '2026-27');
    await expect(invoicingService.issueForPeriod({
      tenantId: tenantA.orgId, subscriptionId: randomUUID(), ...period, issuedOn: on,
    })).rejects.toThrow();
    expect(await seriesAt('invoice', '2026-27')).toBe(before);

    const next = await invoicingService.issueForPeriod({
      tenantId: tenantA.orgId, subscriptionId: subA, ...period, issuedOn: on,
    });
    expect(next.serial).toBe(before + 1);
  });

  it('has no gaps in the series at all', async () => {
    const serials = await owner(async (c) => {
      const { rows } = await c.query<{ serial: number }>(
        `SELECT serial FROM platform_invoice
          WHERE financial_year = '2026-27' ORDER BY serial`);
      return rows.map((r) => r.serial);
    });
    expect(serials).toEqual(serials.map((_, i) => i + 1));
  });

  it('refuses a school with no billing profile', async () => {
    const orphan = await createTenant('BILLC');
    try {
      await expect(invoicingService.issueForPeriod({
        tenantId: orphan.orgId, subscriptionId: subA, ...period, issuedOn: on,
      })).rejects.toThrow();
    } finally {
      await destroyTenants([orphan.orgId]);
    }
  });

  it('copies the parties rather than joining them', async () => {
    // An invoice is a statement about what was true when it was issued. A
    // school that moves next year must not retroactively change last year's
    // document.
    const stored = await owner(async (c) => {
      const { rows } = await c.query<{
        customer_name: string; customer_gstin: string | null;
        supplier_gstin: string;
      }>(
        `SELECT customer_name, customer_gstin, supplier_gstin
           FROM platform_invoice WHERE tenant_id = $1 LIMIT 1`, [tenantA.orgId]);
      return rows[0]!;
    });
    expect(stored.customer_name).toBe('Sunrise Public School Trust');
    expect(stored.customer_gstin).toBe('29AAACS1111A1ZK');
    expect(stored.supplier_gstin).toBe('29AABCP1234C1ZX');

    await owner((c) => c.query(
      `UPDATE tenant_billing_profile SET billing_name = 'Renamed Trust'
        WHERE tenant_id = $1`, [tenantA.orgId]));
    const after = await owner(async (c) => {
      const { rows } = await c.query<{ customer_name: string }>(
        `SELECT customer_name FROM platform_invoice WHERE tenant_id = $1 LIMIT 1`,
        [tenantA.orgId]);
      return rows[0]!.customer_name;
    });
    expect(after).toBe('Sunrise Public School Trust');
  });
});

describe('an issued invoice', () => {
  it('cannot have its amount changed', async () => {
    const id = await anInvoice();
    await expect(owner((c) => c.query(
      'UPDATE platform_invoice SET total = 1 WHERE id = $1', [id])))
      .rejects.toThrow(/cannot be changed/);
  });

  it('cannot have its number changed', async () => {
    const id = await anInvoice();
    await expect(owner((c) => c.query(
      `UPDATE platform_invoice SET invoice_no = 'PS/2627/999999' WHERE id = $1`, [id])))
      .rejects.toThrow(/cannot be changed/);
  });

  it('cannot be deleted', async () => {
    const id = await anInvoice();
    await expect(owner((c) => c.query(
      'DELETE FROM platform_invoice WHERE id = $1', [id])))
      .rejects.toThrow(/not deleted/);
  });

  it('can still be marked paid', async () => {
    // The one thing that legitimately changes after issue.
    const id = await anInvoice();
    await owner((c) => c.query(
      `UPDATE platform_invoice SET status = 'paid', paid_at = now() WHERE id = $1`,
      [id]));
    expect(await owner(async (c) => {
      const { rows } = await c.query<{ status: string }>(
        'SELECT status FROM platform_invoice WHERE id = $1', [id]);
      return rows[0]!.status;
    })).toBe('paid');
  });
});

describe('correcting an invoice', () => {
  it('is a credit note, with its own series', async () => {
    const id = await anInvoice();
    const note = await invoicingService.creditNote({
      invoiceId: id, reason: 'Billed for a month the school had already left',
      issuedOn: on,
    });
    expect(note.note_no).toMatch(/^CN\/2627\/\d{6}$/);
    expect(note.total).toBe('5900.00');
  });

  it('keeps the invoice’s tax regime', async () => {
    const id = await anInvoice(tenantB.orgId, subB);
    await invoicingService.creditNote({
      invoiceId: id, reason: 'Cancelled within the cooling-off window',
      issuedOn: on,
    });
    const note = await owner(async (c) => {
      const { rows } = await c.query<{ igst: string; cgst: string; total: string }>(
        `SELECT igst::text, cgst::text, total::text FROM platform_credit_note
          WHERE platform_invoice_id = $1`, [id]);
      return rows[0]!;
    });
    // An inter-state invoice credited as CGST+SGST would take money back from
    // the wrong government.
    expect(note.igst).toBe('900.00');
    expect(note.cgst).toBe('0.00');
  });

  it('adds up on a partial credit', async () => {
    const id = await anInvoice();
    await invoicingService.creditNote({
      invoiceId: id, amount: Money.fromDecimalString('1000.00'),
      reason: 'Service credit for the outage on the fourteenth', issuedOn: on,
    });
    const note = await owner(async (c) => {
      const { rows } = await c.query<{
        taxable_value: string; cgst: string; sgst: string; igst: string; total: string;
      }>(
        `SELECT taxable_value::text, cgst::text, sgst::text, igst::text, total::text
           FROM platform_credit_note WHERE platform_invoice_id = $1`, [id]);
      return rows[0]!;
    });
    const sum = ['taxable_value', 'cgst', 'sgst', 'igst']
      .map((k) => Money.fromDecimalString(note[k as keyof typeof note]))
      .reduce((a, b) => a + b, 0n);
    expect(Money.toDecimalString(sum)).toBe(note.total);
    expect(note.total).toBe('1000.00');
  });

  it('cannot credit more than the invoice', async () => {
    const id = await anInvoice();
    await expect(invoicingService.creditNote({
      invoiceId: id, amount: Money.fromDecimalString('99999.00'),
      reason: 'A refund larger than anything that was charged', issuedOn: on,
    })).rejects.toThrow(/more than the invoice/);
  });

  it('cannot credit more than the invoice across several notes', async () => {
    // The rule spans rows, which is why it is a trigger and not a constraint.
    const id = await anInvoice();
    for (const amount of ['3000.00', '2000.00']) {
      await invoicingService.creditNote({
        invoiceId: id, amount: Money.fromDecimalString(amount),
        reason: `Partial credit of ${amount} for the agreed adjustment`,
        issuedOn: on,
      });
    }
    await expect(invoicingService.creditNote({
      invoiceId: id, amount: Money.fromDecimalString('2000.00'),
      reason: 'One credit too many, taking the total past the invoice',
      issuedOn: on,
    })).rejects.toThrow(/more than the invoice/);
  });

  it('demands a reason somebody could read a year later', async () => {
    const id = await anInvoice();
    await expect(invoicingService.creditNote({
      invoiceId: id, reason: 'oops', issuedOn: on,
    })).rejects.toThrow();
  });

  it('cannot itself be edited or deleted', async () => {
    const id = await anInvoice();
    await invoicingService.creditNote({
      invoiceId: id, reason: 'Duplicate invoice raised by the billing run',
      issuedOn: on,
    });
    const noteId = await owner(async (c) => {
      const { rows } = await c.query<{ id: string }>(
        'SELECT id FROM platform_credit_note WHERE platform_invoice_id = $1', [id]);
      return rows[0]!.id;
    });
    await expect(owner((c) => c.query(
      'UPDATE platform_credit_note SET total = 1 WHERE id = $1', [noteId])))
      .rejects.toThrow();
    await expect(owner((c) => c.query(
      'DELETE FROM platform_credit_note WHERE id = $1', [noteId])))
      .rejects.toThrow();
  });
});

describe('the billing profile', () => {
  it('refuses a GSTIN whose state disagrees with the place of supply', async () => {
    // The first two characters of a GSTIN ARE the state code. A disagreement
    // means one of them was typed wrong, and the wrong one sends the tax to
    // the wrong government — which is corrected by amending a filing, not by
    // fixing a row.
    const wrong = await createTenant('BILLD');
    try {
      await expect(owner((c) => c.query(
        `INSERT INTO tenant_billing_profile
           (tenant_id, billing_name, gstin, state_code, billing_email, address)
         VALUES ($1, 'Mismatched Trust', '29AAACS1111A1ZK', '27',
                 'x@bill-test.example', 'Somewhere')`, [wrong.orgId])))
        .rejects.toThrow(/gstin_matches_state/);
    } finally {
      await destroyTenants([wrong.orgId]);
    }
  });

  it('accepts a school with no GSTIN at all', async () => {
    // An unregistered customer is an ordinary case, not an error. Treating a
    // missing GSTIN as a failure would refuse to invoice the smaller half of
    // the market.
    const unregistered = await createTenant('BILLE');
    try {
      await owner((c) => c.query(
        `INSERT INTO tenant_billing_profile
           (tenant_id, billing_name, gstin, state_code, billing_email, address)
         VALUES ($1, 'Village School', NULL, '23',
                 'y@bill-test.example', 'Madhya Pradesh')`, [unregistered.orgId]));
      const stored = await owner(async (c) => {
        const { rows } = await c.query<{ gstin: string | null }>(
          'SELECT gstin FROM tenant_billing_profile WHERE tenant_id = $1',
          [unregistered.orgId]);
        return rows[0]!.gstin;
      });
      expect(stored).toBeNull();
    } finally {
      await owner((c) => c.query(
        'DELETE FROM tenant_billing_profile WHERE tenant_id = $1',
        [unregistered.orgId]));
      await destroyTenants([unregistered.orgId]);
    }
  });
});

describe('a school cannot read our revenue', () => {
  it('is refused the invoice table by row-level security', async () => {
    // The app role has no grant AND no policy. Either alone would be a fact
    // about today's migrations; together they are a guarantee.
    const client = new pg.Client({ connectionString: process.env['DATABASE_URL'] });
    await client.connect();
    try {
      await expect(client.query('SELECT * FROM platform_invoice'))
        .rejects.toThrow(/permission denied/);
    } finally {
      await client.end();
    }
  });
});

async function anInvoice(
  tenantId = tenantA.orgId, subscriptionId = subA,
): Promise<string> {
  const invoice = await invoicingService.issueForPeriod({
    tenantId, subscriptionId, ...period, issuedOn: on,
  });
  return invoice.id;
}

async function seriesAt(kind: string, year: string): Promise<number> {
  return owner(async (c) => {
    const { rows } = await c.query<{ last_serial: number }>(
      `SELECT last_serial FROM platform_document_series
        WHERE kind = $1 AND financial_year = $2`, [kind, year]);
    return rows[0]?.last_serial ?? 0;
  });
}
