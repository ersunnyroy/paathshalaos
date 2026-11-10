'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Shell, PageHead } from '../shell';
import { Tile, Panel, Empty, SkeletonRows, Avatar, Pill } from '@/components/ui';
import { apiGet, apiPost, rupees, rupeesCompact } from '@/lib/api';
import { DataTable } from '@/components/data-table';
import { localIsoDate, actionKey } from '@/lib/dates';

interface Invoice {
  id: string; invoice_no: string; status: string; due_on: string;
  total_paise: string; paid_paise: string; outstanding_paise: string;
  given_name: string | null; family_name: string | null; admission_no: string | null;
}

interface Plan {
  id: string; name: string; status: string; academic_year: string | null;
  programme_name: string | null; component_count: number;
  total: string; assigned_count: number;
}
interface Installment {
  id: string; sequence: number; due_on: string; status: string;
  gross_amount: string; concession_amount: string; net_amount: string;
  fee_assignment_id: string; enrollment_id: string;
  given_name: string; family_name: string | null; admission_no: string;
  section_name: string | null; class_name: string | null;
  invoice_id: string | null; invoice_no: string | null;
}
interface Campus { id: string; name: string }

/**
 * A plan's amounts come back as exact decimal strings in rupees, not paise.
 *
 * `rupees()` on this page takes paise, because an invoice row is paise. A fee
 * component is `numeric(14,2)` rupees, and running it through the paise
 * formatter shows ₹420.00 for a ₹42,000 tuition fee — which is the kind of
 * wrong that looks plausible on a screen and is caught by nothing.
 */
function rupeesFromDecimal(value: string): string {
  const [whole = '0', frac = '00'] = value.split('.');
  const digits = whole.replace(/^0+(?=\d)/, '');
  const last3 = digits.slice(-3);
  const rest = digits.slice(0, -3);
  const grouped = rest
    ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}`
    : last3;
  return `₹${grouped}.${frac.padEnd(2, '0').slice(0, 2)}`;
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

const learnerName = (i: Invoice) => [i.given_name, i.family_name].filter(Boolean).join(' ') || '—';

export default function FeesPage() {
  const [invoices, setInvoices] = useState<Invoice[] | null>(null);
  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [unbilled, setUnbilled] = useState<Installment[] | null>(null);
  const [campuses, setCampuses] = useState<Campus[]>([]);
  const [status, setStatus] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [take, setTake] = useState<Record<string, { amount: string; key: string }>>({});

  const [reload, setReload] = useState(0);

  useEffect(() => {
    setError(null);
    setInvoices(null);
    apiGet<Invoice[]>(`/v1/invoices${status ? `?status=${status}` : ''}`)
      .then(setInvoices)
      .catch((e: Error) => setError(e.message));
  }, [status, reload]);

  useEffect(() => {
    apiGet<Plan[]>('/v1/fees/plans').then(setPlans).catch(() => setPlans([]));
    apiGet<Installment[]>('/v1/fees/installments?unbilled=true')
      .then(setUnbilled).catch(() => setUnbilled([]));
    apiGet<Campus[]>('/v1/campuses').then(setCampuses).catch(() => setCampuses([]));
  }, [reload]);

  async function act(fn: () => Promise<unknown>, done: string) {
    setBusy(true); setError(null); setSaid(null);
    try { await fn(); setSaid(done); setReload((n) => n + 1); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  // BigInt all the way: a running total of fees that has been through a JS
  // number is no longer the figure on the receipts.
  const owed = (invoices ?? []).reduce((t, i) => t + BigInt(i.outstanding_paise), 0n);
  const billed = (invoices ?? []).reduce((t, i) => t + BigInt(i.total_paise), 0n);
  const paid = (invoices ?? []).reduce((t, i) => t + BigInt(i.paid_paise), 0n);
  const collected = billed > 0n ? Number((paid * 10000n) / billed) / 10000 : 0;
  const todayIso = localIsoDate();
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
      {said ? <div className="note ok">{said}</div> : null}

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

      <Panel title="Ready to bill"
             hint="Instalments that are due and have no invoice — a school
                   decides when it bills, so nothing here happens on its own">
        <table>
          <thead>
            <tr>
              <th>Learner</th><th>Class</th><th>Due</th>
              <th className="n">Amount</th><th />
            </tr>
          </thead>
          {unbilled === null ? <SkeletonRows rows={3} cols={5} /> : (
            <tbody>
              {unbilled.map((i) => (
                <tr key={i.id}>
                  <td>
                    <strong>
                      {i.given_name}{i.family_name ? ` ${i.family_name}` : ''}
                    </strong>
                    <span className="sub" style={{ display: 'block' }}>
                      {i.admission_no}
                    </span>
                  </td>
                  <td>
                    {i.class_name ? `${i.class_name} ` : ''}{i.section_name ?? '—'}
                  </td>
                  <td>{i.due_on}</td>
                  <td className="n">{rupeesFromDecimal(i.net_amount)}</td>
                  <td className="n">
                    <button className="ghost"
                            disabled={busy || campuses.length === 0}
                            onClick={() => void act(() => apiPost('/v1/fees/invoices', {
                              installmentId: i.id, campusId: campuses[0]!.id,
                            }), 'Invoice raised.')}>
                      Raise the invoice
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          )}
        </table>
        {unbilled?.length === 0 ? (
          <Empty title="Nothing waiting to be billed">
            Every instalment that is due has an invoice against it.
          </Empty>
        ) : null}
      </Panel>

      <Panel title="Fee plans" hint="A plan cannot be assigned until it is published">
        <table>
          <thead>
            <tr>
              <th>Plan</th><th>Year</th><th className="n">Components</th>
              <th className="n">Per year</th><th className="n">Learners</th>
              <th>Status</th><th />
            </tr>
          </thead>
          {plans === null ? <SkeletonRows rows={3} cols={7} /> : (
            <tbody>
              {plans.map((p) => (
                <tr key={p.id}>
                  <td>
                    <strong>{p.name}</strong>
                    {p.programme_name
                      ? <span className="sub" style={{ display: 'block' }}>{p.programme_name}</span>
                      : null}
                  </td>
                  <td>{p.academic_year ?? '—'}</td>
                  <td className="n">{p.component_count}</td>
                  <td className="n">{rupeesFromDecimal(p.total)}</td>
                  <td className="n">{p.assigned_count}</td>
                  <td>
                    {p.status === 'published'
                      ? <Pill tone="good">published</Pill>
                      : <Pill tone="warning">{p.status}</Pill>}
                  </td>
                  <td className="n">
                    {p.status === 'draft' ? (
                      <button className="ghost" disabled={busy}
                              onClick={() => void act(
                                () => apiPost(`/v1/fees/plans/${p.id}/publish`),
                                'Plan published — the amounts are now frozen.')}>
                        Publish
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          )}
        </table>
        {plans?.length === 0 ? (
          <Empty title="No fee plans yet">
            A plan is a list of components — tuition, transport, laboratory —
            and the amounts freeze when it is published, because by then it is
            a price a family has been quoted.
          </Empty>
        ) : null}
      </Panel>

      <DataTable<Invoice>
        id="fee-invoices"
        title="Invoices"
        rows={invoices}
        rowKey={(i) => i.id}
        truncatedAt={200}
        empty={(
          <Empty title="Nothing to show">
            If you signed in as a teacher, that is the point — finance is scoped
            out at the database, not hidden in the interface.
          </Empty>
        )}
        columns={[
          {
            key: 'learner', label: 'Learner', required: true, text: learnerName,
            render: (i) => (
              <span className="who2">
                <Avatar name={learnerName(i)} />
                <span>
                  <span className="nm">{learnerName(i)}</span>
                  <span className="sub" style={{ display: 'block' }}>
                    {i.admission_no ?? i.invoice_no}
                  </span>
                </span>
              </span>
            ),
          },
          { key: 'admission_no', label: 'Admission no.', optional: true, text: (i) => i.admission_no ?? '' },
          // The invoice number opens the sheet that prints: the invoice, every
          // receipt against it, and what is left.
          { key: 'invoice_no', label: 'Invoice', text: (i) => i.invoice_no,
            render: (i) => (
              <Link href={`/fees/receipt/${i.id}`}
                    title={BigInt(i.paid_paise) > 0n ? 'Open the receipt' : 'Open the invoice'}>
                {i.invoice_no}
              </Link>
            ) },
          { key: 'due_on', label: 'Due', text: (i) => i.due_on },
          { key: 'total', label: 'Total', align: 'right', numeric: true, text: (i) => rupees(i.total_paise) },
          { key: 'paid', label: 'Paid', align: 'right', numeric: true, optional: true, text: (i) => rupees(i.paid_paise) },
          { key: 'outstanding', label: 'Outstanding', align: 'right', numeric: true, text: (i) => rupees(i.outstanding_paise) },
          {
            key: 'status', label: 'Status', text: (i) => verdict(i, todayIso).label,
            render: (i) => {
              const v = verdict(i, todayIso);
              return <Pill {...(v.tone ? { tone: v.tone } : {})}>{v.label}</Pill>;
            },
          },
          {
            key: 'take', label: '', action: true, align: 'right', text: () => '',
            render: (i) => (i.status !== 'void' && BigInt(i.outstanding_paise) > 0n ? (
              <div className="row-form" style={{ justifyContent: 'flex-end' }}>
                <input type="text" inputMode="decimal" placeholder="Amount"
                       aria-label={`Amount received for ${i.invoice_no}`}
                       style={{ width: 110, minWidth: 0 }}
                       value={take[i.id]?.amount ?? ''}
                       // A new amount is a new intended payment, so it gets a
                       // new key — once, here, not at each click.
                       onChange={(e) => setTake((t) => ({
                         ...t, [i.id]: { amount: e.target.value, key: actionKey(`web-pay-${i.id}`) },
                       }))} />
                <button className="ghost"
                        disabled={busy || !/^\d+(\.\d{1,2})?$/.test(take[i.id]?.amount ?? '')}
                        onClick={() => void act(async () => {
                          const entry = take[i.id]!;
                          await apiPost(`/v1/invoices/${i.id}/payments`, {
                            amount: entry.amount, method: 'cash',
                            // The same key however many times this is pressed
                            // for this amount: two taps at a counter are one
                            // payment, and the server holds us to it.
                            idempotencyKey: entry.key,
                          });
                          // Cleared only once it is recorded, so a failed
                          // attempt can be retried under the same key.
                          setTake((t) => { const { [i.id]: _done, ...rest } = t; return rest; });
                        }, 'Payment recorded, receipt issued.')}>
                  Take cash
                </button>
              </div>
            ) : null),
          },
        ]}
      />
    </Shell>
  );
}
