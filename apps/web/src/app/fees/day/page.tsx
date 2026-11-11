'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Shell } from '../../shell';
import { Empty } from '@/components/ui';
import { useApiQuery } from '@/lib/query';
import { loadBrand } from '@/lib/api';
import { localIsoDate } from '@/lib/dates';
import { rupeesDecimal } from '@/lib/console';
import { dateLabel, methodLabel, rupeesInWords } from '@/lib/receipt';
import { classOf, closing, type CollectionRow } from '@/lib/collection';
import { useEffect } from 'react';

/**
 * The day's collection, laid out to be printed and signed at closing.
 *
 * Every receipt issued on the day, then the totals the drawer is counted
 * against. Cancelled receipts stay on the sheet, struck through and out of
 * every total: a gap in the run of numbers is what gets asked about.
 */
export default function DayCollectionPage() {
  const [day, setDay] = useState(() => localIsoDate());
  const [school, setSchool] = useState('');
  const rows = useApiQuery<CollectionRow[]>(`/v1/fees/collections?on=${day}`,
    { staleTime: 0, refetchOnMount: 'always' });
  useEffect(() => {
    void loadBrand().then((b) => setSchool(b?.name ?? '')).catch(() => setSchool(''));
  }, []);

  const c = rows.data ? closing(rows.data) : null;

  return (
    <Shell>
      <div className="receipt-tools no-print">
        <Link href="/fees">← Back to fees</Link>
        <div className="row">
          <input type="date" value={day} max={localIsoDate()} aria-label="Day"
                 onChange={(e) => e.target.value && setDay(e.target.value)} />
          <button type="button" className="primary" disabled={!c || c.receipts === 0}
                  onClick={() => window.print()}>
            Print or save as PDF
          </button>
        </div>
      </div>

      {rows.error ? <Empty title="The day's collection could not be read">{rows.error.message}</Empty> : null}
      {rows.isPending ? <p className="sub">Loading…</p> : null}
      {c && rows.data && rows.data.length === 0 ? (
        <Empty title={`No receipts were issued on ${dateLabel(day)}`}>
          Pick another day, or take a payment on the fee desk. If you are not
          in the accounts team, receipts are not shown to you.
        </Empty>
      ) : null}

      {c && rows.data && rows.data.length > 0 ? (
        <article className="receipt">
          <header>
            <div><h1>{school}</h1><p>Fee collection for {dateLabel(day)}</p></div>
            <div className="kind"><strong>Day's collection</strong></div>
          </header>

          <table>
            <thead>
              <tr>
                <th>Receipt</th><th>Learner</th><th>Class</th><th>Invoice</th>
                <th>Paid by</th><th>Taken by</th><th className="n">Amount</th>
              </tr>
            </thead>
            <tbody>
              {rows.data.map((r) => (
                <tr key={`${r.receipt_id}-${r.invoice_id}`} className={r.cancelled ? 'struck' : undefined}>
                  <td>{r.receipt_no}{r.cancelled ? ' (cancelled)' : ''}</td>
                  <td>{r.learner}<span className="sub"> {r.admission_no}</span></td>
                  <td>{classOf(r)}</td>
                  <td>{r.invoice_no}</td>
                  <td>{methodLabel(r.method)}</td>
                  <td>{r.received_by ?? '—'}</td>
                  <td className="n">{rupeesDecimal(r.amount)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="total">
                <td colSpan={6}>{c.receipts} {c.receipts === 1 ? 'receipt' : 'receipts'}</td>
                <td className="n">{rupeesDecimal(c.total)}</td>
              </tr>
            </tfoot>
          </table>
          <p className="words">{rupeesInWords(c.total)}</p>

          <div className="closing-grid">
            <div>
              <h2>By how it was paid</h2>
              <table><tbody>
                {c.byMethod.map((m) => (
                  <tr key={m.key}><td>{m.label} <span className="sub">× {m.receipts}</span></td>
                      <td className="n">{rupeesDecimal(m.amount)}</td></tr>
                ))}
              </tbody></table>
            </div>
            <div>
              <h2>By who took it</h2>
              <table><tbody>
                {c.byCashier.map((m) => (
                  <tr key={m.key}><td>{m.label} <span className="sub">× {m.receipts}</span></td>
                      <td className="n">{rupeesDecimal(m.amount)}</td></tr>
                ))}
              </tbody></table>
            </div>
          </div>

          <p className="balance settled">
            Cash that should be in the drawer: <strong>{rupeesDecimal(c.cash)}</strong>
          </p>
          {c.cancelled.length > 0 ? (
            <p className="words">
              {c.cancelled.length} cancelled {c.cancelled.length === 1 ? 'receipt is' : 'receipts are'} listed
              above and not counted.
            </p>
          ) : null}

          <footer>
            <span className="sign">Counted by</span>
            <span className="sign">Checked by</span>
          </footer>
        </article>
      ) : null}
    </Shell>
  );
}
