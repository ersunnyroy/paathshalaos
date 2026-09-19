'use client';

import { useEffect, useState } from 'react';
import { Shell, PageHead } from '../shell';
import { Tile, Panel, Empty, SkeletonRows, Avatar, Pill } from '@/components/ui';
import { apiGet, rupees, rupeesCompact } from '@/lib/api';

interface Invoice {
  id: string; invoice_no: string; status: string; due_on: string;
  total_paise: string; paid_paise: string; outstanding_paise: string;
  given_name: string | null; family_name: string | null; admission_no: string | null;
}

const FILTERS = [
  { value: '', label: 'All' },
  { value: 'issued', label: 'Issued' },
  { value: 'part_paid', label: 'Part paid' },
  { value: 'paid', label: 'Paid' },
  { value: 'void', label: 'Void' },
] as const;

/**
 * What the row actually says.
 *
 * "Issued" and "overdue" are not the same state and must not wear the same
 * colour: an invoice raised last week with three weeks to run is normal, and
 * painting it red teaches the office to ignore red. The status colour is always
 * paired with the word, so the meaning never rests on hue alone.
 */
function verdict(i: Invoice, todayIso: string):
  { label: string; tone?: 'good' | 'warning' | 'critical' } {
  if (i.status === 'void') return { label: 'void' };
  if (BigInt(i.outstanding_paise) === 0n) return { label: 'paid', tone: 'good' };
  if (i.due_on < todayIso) return { label: 'overdue', tone: 'critical' };
  if (i.status === 'part_paid') return { label: 'part paid', tone: 'warning' };
  return { label: 'issued', tone: 'warning' };
}

export default function FeesPage() {
  const [invoices, setInvoices] = useState<Invoice[] | null>(null);
  const [status, setStatus] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
    setInvoices(null);
    apiGet<Invoice[]>(`/v1/invoices${status ? `?status=${status}` : ''}`)
      .then(setInvoices)
      .catch((e: Error) => setError(e.message));
  }, [status]);

  // BigInt all the way: a running total of fees that has been through a JS
  // number is no longer the figure on the receipts.
  const owed = (invoices ?? []).reduce((t, i) => t + BigInt(i.outstanding_paise), 0n);
  const billed = (invoices ?? []).reduce((t, i) => t + BigInt(i.total_paise), 0n);
  const paid = (invoices ?? []).reduce((t, i) => t + BigInt(i.paid_paise), 0n);
  const collected = billed > 0n ? Number((paid * 10000n) / billed) / 10000 : 0;
  const todayIso = new Date().toISOString().slice(0, 10);
  const overdue = (invoices ?? []).filter(
    (i) => i.status !== 'void' && BigInt(i.outstanding_paise) > 0n && i.due_on < todayIso);
  const overdueTotal = overdue.reduce((t, i) => t + BigInt(i.outstanding_paise), 0n);

  return (
    <Shell>
      <PageHead
        title="Fees"
        lede="A teacher signing in sees nothing here. Not a hidden menu — the rows do not come back."
      >
        <div className="seg" role="group" aria-label="Filter by status">
          {FILTERS.map((f) => (
            <button key={f.value}
                    aria-pressed={status === f.value}
                    onClick={() => setStatus(f.value)}>
              {f.label}
            </button>
          ))}
        </div>
      </PageHead>

      {error ? <div className="note bad">{error}</div> : null}

      <div className="tiles">
        <Tile loading={!invoices} label="Outstanding"
              describe={invoices ? `Across ${invoices.length} invoices in this view` : 'Still owed'}
              value={rupeesCompact(owed.toString())} exact={rupees(owed.toString())} />
        <Tile loading={!invoices} label="Overdue"
              describe={invoices
                ? overdue.length ? `${overdue.length} past their due date` : 'Nothing past due'
                : 'Past the due date'}
              value={rupeesCompact(overdueTotal.toString())}
              exact={rupees(overdueTotal.toString())} />
        <Tile loading={!invoices} label="Collected"
              describe={invoices ? `${Math.round(collected * 100)}% of what was billed` : 'Received'}
              value={rupeesCompact(paid.toString())} exact={rupees(paid.toString())}
              meter={collected}
              tone={collected >= 0.75 ? 'good' : collected >= 0.4 ? 'warning' : 'critical'} />
      </div>

      <Panel title="Invoices" hint={invoices ? `${invoices.length} shown` : undefined}>
        {invoices && invoices.length === 0 ? (
          <Empty title="Nothing to show">
            If you signed in as a teacher, that is the point — finance is scoped
            out at the database, not hidden in the interface.
          </Empty>
        ) : (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Learner</th>
                  <th className="opt">Invoice</th>
                  <th className="opt">Due</th>
                  <th className="n opt">Total</th>
                  <th className="n">Outstanding</th>
                  <th className="w">Status</th>
                </tr>
              </thead>
              {invoices ? (
                <tbody>
                  {invoices.map((i) => {
                    const name = [i.given_name, i.family_name].filter(Boolean).join(' ') || '—';
                    return (
                      <tr key={i.id}>
                        <td>
                          <span className="who2">
                            <Avatar name={name} />
                            <span>
                              <span className="nm">{name}</span>
                              <span className="sub" style={{ display: 'block' }}>
                                {i.admission_no ?? i.invoice_no}
                              </span>
                            </span>
                          </span>
                        </td>
                        <td className="opt">{i.invoice_no}</td>
                        <td className="opt">{i.due_on}</td>
                        <td className="n opt">{rupees(i.total_paise)}</td>
                        <td className="n">{rupees(i.outstanding_paise)}</td>
                        <td className="w">
                          {(() => {
                            const v = verdict(i, todayIso);
                            return <Pill {...(v.tone ? { tone: v.tone } : {})}>{v.label}</Pill>;
                          })()}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              ) : <SkeletonRows rows={8} cols={6} />}
            </table>
          </div>
        )}
      </Panel>
    </Shell>
  );
}
