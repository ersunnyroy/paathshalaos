'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Shell } from '../../../shell';
import { Empty } from '@/components/ui';
import { useApiQuery } from '@/lib/query';
import { rupeesDecimal } from '@/lib/console';
import {
  classLine, dateLabel, methodLabel, rupeesInWords, toPaise, totals, type ReceiptSheet,
} from '@/lib/receipt';

/**
 * A fee receipt, laid out to be printed on one sheet or saved as a PDF.
 *
 * The screen and the paper are the same markup: printing hides the app around
 * it and nothing else. What is printed is exactly what the office looked at.
 */
export default function ReceiptPage() {
  const { id } = useParams<{ id: string }>();
  const sheet = useApiQuery<ReceiptSheet>(`/v1/fees/invoices/${id}/receipts`);

  return (
    <Shell>
      <div className="receipt-tools no-print">
        <Link href="/fees">← Back to fees</Link>
        <button type="button" className="primary" disabled={!sheet.data}
                onClick={() => window.print()}>
          Print or save as PDF
        </button>
      </div>
      {sheet.isPending ? <p className="sub">Loading the receipt…</p> : null}
      {sheet.error ? (
        <Empty title="This receipt could not be opened">{sheet.error.message}</Empty>
      ) : null}
      {sheet.data ? <Receipt sheet={sheet.data} /> : null}
    </Shell>
  );
}

function Receipt({ sheet }: { sheet: ReceiptSheet }) {
  const { school, learner, invoice, lines } = sheet;
  const t = totals(sheet);
  const hasDiscount = toPaise(invoice.discount_total) !== 0n;
  const hasTax = toPaise(invoice.tax_total) !== 0n;

  return (
    <article className="receipt">
      <header>
        <div>
          <h1>{school.name}</h1>
          <p>
            {school.campus}
            {school.legal_name !== school.name ? ` · ${school.legal_name}` : ''}
            {school.gstin ? ` · GSTIN ${school.gstin}` : ''}
          </p>
        </div>
        <div className="kind">
          <strong>{t.standing.length > 0 ? 'Fee receipt' : 'Fee invoice'}</strong>
          {invoice.status === 'void' ? <span className="void">Void</span> : null}
        </div>
      </header>

      <dl className="receipt-meta">
        <div><dt>Learner</dt><dd>{learner.name}</dd></div>
        <div><dt>Admission no.</dt><dd>{learner.admission_no}</dd></div>
        <div><dt>Class</dt><dd>{classLine(learner) || '—'}</dd></div>
        <div><dt>Invoice</dt><dd>{invoice.invoice_no}</dd></div>
        <div><dt>Invoice date</dt><dd>{dateLabel(invoice.issued_on)}</dd></div>
        <div><dt>Due</dt><dd>{dateLabel(invoice.due_on)}</dd></div>
      </dl>

      <table>
        <thead>
          <tr><th>Particulars</th><th className="n">Amount</th></tr>
        </thead>
        <tbody>
          {lines.map((line, i) => (
            <tr key={i}>
              <td>
                {line.description}
                {Number(line.quantity) !== 1
                  ? <span className="sub"> × {Number(line.quantity)}</span> : null}
              </td>
              <td className="n">{rupeesDecimal(line.line_total)}</td>
            </tr>
          ))}
          {/* An invoice raised as one figure has no lines; a receipt with an
              empty table reads as a receipt for nothing. */}
          {lines.length === 0 ? (
            <tr><td>Fees for {invoice.financial_year}</td>
                <td className="n">{rupeesDecimal(invoice.subtotal)}</td></tr>
          ) : null}
        </tbody>
        <tfoot>
          {hasDiscount ? (
            <tr><td>Concession (included above)</td>
                <td className="n">−{rupeesDecimal(invoice.discount_total)}</td></tr>
          ) : null}
          {hasTax ? (
            <tr><td>Tax (included above)</td>
                <td className="n">{rupeesDecimal(invoice.tax_total)}</td></tr>
          ) : null}
          <tr className="total"><td>Total billed</td>
              <td className="n">{rupeesDecimal(invoice.total)}</td></tr>
        </tfoot>
      </table>

      {t.standing.length > 0 ? (
        <>
          <h2>Received</h2>
          <table>
            <thead>
              <tr>
                <th>Receipt no.</th><th>Date</th><th>Paid by</th>
                <th>Received by</th><th className="n">Amount</th>
              </tr>
            </thead>
            <tbody>
              {t.standing.map((r) => (
                <tr key={r.id}>
                  <td>{r.receipt_no}</td>
                  <td>{dateLabel(r.issued_on)}</td>
                  <td>{methodLabel(r.method)}</td>
                  <td>{r.received_by ?? '—'}</td>
                  <td className="n">{rupeesDecimal(r.allocated)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="total"><td colSpan={4}>Total received</td>
                  <td className="n">{rupeesDecimal(t.received)}</td></tr>
            </tfoot>
          </table>
          <p className="words">{rupeesInWords(t.received)}</p>
        </>
      ) : (
        <p className="words">Nothing has been received against this invoice yet.</p>
      )}

      <p className={`balance${t.settled ? ' settled' : ''}`}>
        {invoice.status === 'void' ? 'This invoice was cancelled. Nothing is owed on it.'
          : t.settled ? 'Paid in full. Nothing is owed on this invoice.'
          : <>Balance still to pay: <strong>{rupeesDecimal(t.balance)}</strong></>}
      </p>

      <footer>
        <span>Computer-generated; valid without a signature.</span>
        <span className="sign">For {school.name}</span>
      </footer>
    </article>
  );
}
