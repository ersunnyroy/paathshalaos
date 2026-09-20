/**
 * M7.10 — handing the books to the accountant's own software.
 *
 * Almost every institute of this size keeps its statutory books in Tally, and
 * the person who does that is not going to retype a term's receipts. The export
 * is therefore a first-class feature, not a report: if it is wrong, the audited
 * accounts are wrong.
 *
 * Two formats, deliberately:
 *   - `dayBookCsv` — a flat CSV any spreadsheet or package can read. This is the
 *                    fallback that always works.
 *   - `tallyXml`   — Tally's own import shape (one voucher per entry group).
 *
 * Both read the SAME rows through the SAME projection, so the two can never
 * disagree about a period. Neither invents a figure: every line comes from
 * ledger_entry, which is append-only and balanced by a deferred constraint.
 */
import { withTenant, type TenantScope, type TenantClient } from '../../db/tenant.ts';
import { ApiError } from '../../common/errors.ts';
import { auditService } from '../audit/audit.service.ts';

export interface DayBookRow {
  entry_group_id: string;
  occurred_on: string;
  account_code: string;
  debit: string;
  credit: string;
  source_type: string;
  source_id: string | null;
  narration: string | null;
}

/**
 * ISO date, or nothing. A malformed range that silently exports "everything" is
 * how an accountant ends up filing a year's figures for a month.
 */
function assertIsoDate(value: string, label: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw ApiError.make('validation_error', 'bad_date', `${label} must be YYYY-MM-DD.`);
  }
  // Round-trip rather than Date.parse, which turns 2026-02-31 into 3 March.
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw ApiError.make('validation_error', 'bad_date', `${label} is not a real date.`);
  }
}

/**
 * RFC 4180 quoting.
 *
 * The leading-character guard is not pedantry: a cell beginning `=`, `+`, `-` or
 * `@` is executed as a formula when the file is opened in Excel, and a narration
 * is free text a parent can influence. Prefixing a single quote keeps the cell
 * readable to a human while making it inert.
 */
function csvCell(value: string | null): string {
  const raw = value ?? '';
  const guarded = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return /[",\r\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

function xmlText(value: string | null): string {
  return (value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    // Tally's parser rejects the whole file on a control character, so one
    // pasted into a narration would fail the entire import, not one voucher.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

/** Tally wants DD-MMM-YYYY (`01-Apr-2026`), not ISO. */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

export function tallyDate(iso: string): string {
  const [y, m, d] = iso.split('-') as [string, string, string];
  return `${d}-${MONTHS[Number(m) - 1]}-${y}`;
}

export const exportService = {
  /**
   * The rows themselves. Ordered by group so a voucher's lines stay together,
   * and by date so the day book reads like one.
   */
  async dayBook(
    db: TenantClient,
    range: { from: string; to: string; campusId?: string | undefined },
  ): Promise<DayBookRow[]> {
    assertIsoDate(range.from, 'from');
    assertIsoDate(range.to, 'to');
    if (range.from > range.to) {
      throw ApiError.make('validation_error', 'bad_range', 'from is after to.');
    }

    const { rows } = await db.query<DayBookRow>(
      `SELECT entry_group_id, occurred_on::text AS occurred_on, account_code,
              debit::text AS debit, credit::text AS credit,
              source_type, source_id, narration
         FROM ledger_entry
        WHERE occurred_on >= $1::date
          AND occurred_on <= $2::date
          AND ($3::uuid IS NULL OR campus_id = $3::uuid)
        ORDER BY occurred_on, entry_group_id, account_code`,
      [range.from, range.to, range.campusId ?? null],
    );
    return rows;
  },

  /**
   * A flat CSV of the day book.
   *
   * Exporting is a read of every family's finances at once, so it is audited as
   * RESTRICTED even though nothing is written.
   */
  async dayBookCsv(
    scope: TenantScope,
    range: { from: string; to: string; campusId?: string | undefined },
  ): Promise<{ filename: string; content: string; rowCount: number }> {
    const rows = await withTenant(scope, (db) => exportService.dayBook(db, range));

    const header = ['date', 'voucher', 'account', 'debit', 'credit', 'source', 'narration'];
    const lines = [header.join(',')];
    for (const r of rows) {
      lines.push([
        csvCell(r.occurred_on),
        csvCell(r.entry_group_id),
        csvCell(r.account_code),
        csvCell(r.debit),
        csvCell(r.credit),
        csvCell(r.source_id ? `${r.source_type}:${r.source_id}` : r.source_type),
        csvCell(r.narration),
      ].join(','));
    }

    await auditService.record({
      tenantId: scope.tenantId,
      actorUserId: scope.actorId,
      action: 'finance.exported',
      resourceType: 'ledger_entry',
      classification: 'RESTRICTED',
      after: { format: 'csv', from: range.from, to: range.to, rowCount: rows.length },
    });

    return {
      filename: `daybook_${range.from}_${range.to}.csv`,
      // CRLF and a trailing newline: a file without one is a line short in half
      // the tools that read it.
      content: `${lines.join('\r\n')}\r\n`,
      rowCount: rows.length,
    };
  },

  /**
   * Tally's import XML: one VOUCHER per entry group, one ALLLEDGERENTRIES.LIST
   * per line.
   *
   * Tally's sign convention is the trap. It carries no debit and credit columns,
   * only one AMOUNT whose SIGN is the side — negative is a debit. Getting this
   * backwards imports a mirror image of the books that still balances, so
   * nothing complains and every figure is wrong.
   */
  async tallyXml(
    scope: TenantScope,
    range: { from: string; to: string; campusId?: string | undefined;
             companyName: string },
  ): Promise<{ filename: string; content: string; voucherCount: number }> {
    const rows = await withTenant(scope, (db) => exportService.dayBook(db, range));

    const groups = new Map<string, DayBookRow[]>();
    for (const r of rows) {
      const g = groups.get(r.entry_group_id);
      if (g) g.push(r);
      else groups.set(r.entry_group_id, [r]);
    }

    const out: string[] = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<ENVELOPE>',
      '<HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>',
      '<BODY><IMPORTDATA>',
      '<REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME>',
      `<STATICVARIABLES><SVCURRENTCOMPANY>${xmlText(range.companyName)}`
        + '</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC>',
      '<REQUESTDATA>',
    ];

    for (const [groupId, lines] of groups) {
      const first = lines[0]!;
      out.push(
        '<TALLYMESSAGE><VOUCHER VCHTYPE="Journal" ACTION="Create">',
        `<DATE>${tallyDate(first.occurred_on)}</DATE>`,
        '<VOUCHERTYPENAME>Journal</VOUCHERTYPENAME>',
        // The group id is the dedupe key: re-importing a period must update the
        // same vouchers, not duplicate a term's income.
        `<REMOTEID>${xmlText(groupId)}</REMOTEID>`,
        `<NARRATION>${xmlText(first.narration ?? first.source_type)}</NARRATION>`,
      );
      for (const l of lines) {
        const isDebit = Number(l.debit) !== 0;
        const magnitude = isDebit ? l.debit : l.credit;
        out.push(
          '<ALLLEDGERENTRIES.LIST>',
          `<LEDGERNAME>${xmlText(l.account_code)}</LEDGERNAME>`,
          `<ISDEEMEDPOSITIVE>${isDebit ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE>`,
          `<AMOUNT>${isDebit ? '-' : ''}${magnitude}</AMOUNT>`,
          '</ALLLEDGERENTRIES.LIST>',
        );
      }
      out.push('</VOUCHER></TALLYMESSAGE>');
    }

    out.push('</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>');

    await auditService.record({
      tenantId: scope.tenantId,
      actorUserId: scope.actorId,
      action: 'finance.exported',
      resourceType: 'ledger_entry',
      classification: 'RESTRICTED',
      after: { format: 'tally', from: range.from, to: range.to, voucherCount: groups.size },
    });

    return {
      filename: `tally_${range.from}_${range.to}.xml`,
      content: out.join('\n'),
      voucherCount: groups.size,
    };
  },
};
