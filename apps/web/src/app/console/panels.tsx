'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { consoleGet, consolePost, ApiError } from '@/lib/api';
import { Panel, Pill, Empty, SkeletonRows } from '@/components/ui';
import { ConfirmButton } from '@/components/confirm';

export { ConfirmButton };
import {
  rupeesDecimal, sumDecimals, groupTeam, grantable, versionAction,
  CAPABILITY_MEANING, type AdminRow,
  METRICS, FEATURES, planCodeFrom, buildTerms, priceOrNull, type TermsForm,
  buildSchool, campusCodeFrom, SUBSCRIPTION_STATUSES, STATUS_MEANING, type SchoolForm,
  monthName, barWidths, daysPhrase,
} from '@/lib/console';

const day = (value: string | null) =>
  value ? new Date(value).toLocaleDateString('en-IN', { dateStyle: 'medium' }) : '—';

/* ------------------------------------------------------------------- plans */

interface PlanVersion {
  id: string; plan_code: string; plan_name: string; version: number;
  price_monthly: string; price_annual: string; currency: string;
  status: string; published_at: string | null;
  limits: Array<{ metric: string; included: number; hard_cap: number | null }>;
  features: Array<{ feature: string; enabled: boolean }>;
  subscribers: number;
}

/**
 * The catalogue: every version of every plan, and how many schools are on it.
 *
 * Versions, not plans, because a price change never edits what a school
 * agreed to — it publishes a new version, and the schools on the old one stay
 * there until somebody moves them deliberately.
 */
export function Plans() {
  const [plans, setPlans] = useState<PlanVersion[] | null>(null);
  const [said, setSaid] = useState<{ text: string; bad?: boolean } | null>(null);
  const [drafting, setDrafting] = useState(false);

  const load = useCallback(() => {
    consoleGet<PlanVersion[]>('/plans').then(setPlans)
      .catch((e: ApiError) => { setPlans([]); setSaid({ text: e.message, bad: true }); });
  }, []);
  useEffect(load, [load]);

  async function act(version: PlanVersion, action: 'publish' | 'retire') {
    setSaid(null);
    try {
      await consolePost(`/plans/versions/${version.id}/${action}`, {});
      setSaid({
        text: action === 'publish'
          ? `${version.plan_name} v${version.version} is published. Its terms can no longer be edited.`
          : `${version.plan_name} v${version.version} is retired. Schools already on it stay on it.`,
      });
      load();
    } catch (e) {
      setSaid({ text: (e as ApiError).message, bad: true });
    }
  }

  return (
    <Panel title="Plans"
           hint="Each row is a version. Published terms are what schools agreed to and are never edited."
           actions={<button className="primary" onClick={() => setDrafting(true)}>New plan version</button>}>
      {said ? <div className={`note${said.bad ? ' bad' : ''}`} style={{ margin: '0 16px 12px' }}>{said.text}</div> : null}
      <div className="scroll">
        <table>
          <thead>
            <tr>
              <th>Plan</th><th>Status</th><th className="num">Monthly</th>
              <th className="num">Annual</th><th className="num">Schools</th>
              <th className="opt">Includes</th><th />
            </tr>
          </thead>
          {plans === null ? <SkeletonRows cols={7} /> : plans.length === 0 ? (
            <tbody><tr><td colSpan={7}>
              <Empty title="No plans yet">Create one to put a school on it and bill for it.</Empty>
            </td></tr></tbody>
          ) : (
            <tbody>
              {plans.map((p) => {
                const action = versionAction(p.status);
                const on = p.features.filter((f) => f.enabled).map((f) => f.feature);
                return (
                  <tr key={p.id}>
                    <td>
                      <strong>{p.plan_name}</strong>
                      <span className="sub" style={{ display: 'block' }}>{p.plan_code} · v{p.version}</span>
                    </td>
                    <td>
                      <Pill tone={p.status === 'published' ? 'good' : p.status === 'draft' ? 'warning' : undefined}>
                        {p.status}
                      </Pill>
                    </td>
                    <td className="num">{rupeesDecimal(p.price_monthly)}</td>
                    <td className="num">{rupeesDecimal(p.price_annual)}</td>
                    <td className="num">{p.subscribers}</td>
                    <td className="opt">
                      <span className="chips">
                        {p.limits.map((l) => (
                          <span className="chip" key={l.metric}
                                title={l.hard_cap === null ? 'No hard cap' : `Hard cap ${l.hard_cap}`}>
                            {l.included.toLocaleString('en-IN')} {l.metric.replace(/_/g, ' ')}
                          </span>
                        ))}
                        {on.map((f) => <span className="chip on" key={f}>{f.replace(/_/g, ' ')}</span>)}
                      </span>
                    </td>
                    <td className="num">
                      {action === 'publish'
                        ? <ConfirmButton label="Publish" confirmLabel="Publish — terms lock"
                                         onConfirm={() => act(p, 'publish')} />
                        : action === 'retire'
                          ? <ConfirmButton label="Retire" confirmLabel="Retire — no new schools" tone="critical"
                                           onConfirm={() => act(p, 'retire')} />
                          : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          )}
        </table>
      </div>
      {drafting ? (
        <PlanDraft existing={plans ?? []} onClose={() => setDrafting(false)}
                   onDone={(text) => { setDrafting(false); setSaid({ text }); load(); }} />
      ) : null}
    </Panel>
  );
}

/**
 * A new version, as a draft.
 *
 * Three calls in order — the plan if it is new, the version with its prices,
 * then its terms — and it stops at draft on purpose. Publishing is a separate,
 * deliberate click on the row, because that is the moment the terms lock.
 */
function PlanDraft({ existing, onClose, onDone }: {
  existing: PlanVersion[]; onClose: () => void; onDone: (said: string) => void;
}) {
  const [name, setName] = useState('');
  const [monthly, setMonthly] = useState('');
  const [annual, setAnnual] = useState('');
  const [form, setForm] = useState<TermsForm>({ limits: {}, features: {} });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const code = planCodeFrom(name);
  const known = existing.find((p) => p.plan_code === code);

  function limit(metric: string, field: 'included' | 'hardCap', value: string) {
    const current = form.limits[metric] ?? { included: '', hardCap: '' };
    setForm({ ...form, limits: { ...form.limits, [metric]: { ...current, [field]: value } } });
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    const priceMonthly = priceOrNull(monthly);
    const priceAnnual = priceOrNull(annual);
    if (!code) { setError('Give the plan a name with at least two letters.'); return; }
    if (!priceMonthly || !priceAnnual) { setError('Prices are rupees, like 1500 or 1499.50.'); return; }
    const built = buildTerms(form);
    if (!built.ok) { setError(built.error); return; }

    setBusy(true);
    try {
      if (!known) await consolePost('/plans', { code, name: name.trim() });
      const version = await consolePost<{ id: string; version: number }>(
        '/plans/versions', { planCode: code, priceMonthly, priceAnnual });
      await consolePost(`/plans/versions/${version.id}/terms`, built.terms);
      onDone(`${name.trim()} v${version.version} saved as a draft. Publish it when the terms are right.`);
    } catch (e) {
      setError((e as ApiError).message);
    } finally { setBusy(false); }
  }

  return (
    <div className="sheet-backdrop" onMouseDown={onClose}>
      <form className="sheet wide" onSubmit={submit} onMouseDown={(e) => e.stopPropagation()}>
        <h2>New plan version</h2>
        <p className="lede">
          {known
            ? `There is already a plan called ${known.plan_name}. This adds a new version of it; schools on older versions keep their price.`
            : 'Saved as a draft. Nothing is offered to a school until you publish it.'}
        </p>
        <label htmlFor="plan-name">Plan name</label>
        <input id="plan-name" type="text" value={name} onChange={(e) => setName(e.target.value)}
               placeholder="Starter" required />
        {code ? <span className="sub">Code: {code}</span> : null}
        <div className="grid2">
          <div>
            <label htmlFor="plan-monthly">Monthly price, ₹</label>
            <input id="plan-monthly" type="text" inputMode="decimal" value={monthly}
                   onChange={(e) => setMonthly(e.target.value)} placeholder="1500" required />
          </div>
          <div>
            <label htmlFor="plan-annual">Annual price, ₹</label>
            <input id="plan-annual" type="text" inputMode="decimal" value={annual}
                   onChange={(e) => setAnnual(e.target.value)} placeholder="15000" required />
          </div>
        </div>

        <label>Limits — leave a row empty for no limit</label>
        <table className="mini">
          <thead><tr><th>Metric</th><th>Included</th><th>Hard cap</th></tr></thead>
          <tbody>
            {METRICS.map((metric) => (
              <tr key={metric}>
                <td>{metric.replace(/_/g, ' ')}</td>
                <td><input type="text" inputMode="numeric" aria-label={`${metric} included`}
                           value={form.limits[metric]?.included ?? ''}
                           onChange={(e) => limit(metric, 'included', e.target.value)} /></td>
                <td><input type="text" inputMode="numeric" aria-label={`${metric} hard cap`}
                           value={form.limits[metric]?.hardCap ?? ''} placeholder="none"
                           onChange={(e) => limit(metric, 'hardCap', e.target.value)} /></td>
              </tr>
            ))}
          </tbody>
        </table>

        <label>Features</label>
        <div className="chips">
          {FEATURES.map((feature) => (
            <label key={feature} className="check chipcheck">
              <input type="checkbox" checked={form.features[feature] === true}
                     onChange={(e) => setForm({ ...form, features: { ...form.features, [feature]: e.target.checked } })} />
              {feature.replace(/_/g, ' ')}
            </label>
          ))}
        </div>

        {error ? <div className="note bad" style={{ marginTop: 12 }}>{error}</div> : null}
        <div className="row" style={{ marginTop: 16, justifyContent: 'flex-end' }}>
          <button type="button" className="ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="primary" disabled={busy}>
            {busy ? 'Saving…' : 'Save draft'}
          </button>
        </div>
      </form>
    </div>
  );
}

/* ----------------------------------------------------------------- billing */

interface Invoice {
  id: string; invoice_no: string; financial_year: string; supply_type: string;
  taxable_value: string; cgst: string; sgst: string; igst: string;
  total: string; issued_on: string; due_on: string;
}

/**
 * What a school has been billed.
 *
 * One school at a time, chosen by name. The console can read its own invoices
 * to a school — that is our relationship with them — and still cannot read the
 * invoices the school raises to parents, which are theirs.
 */
export function Billing({ schools }: { schools: Array<{ id: string; display_name: string }> }) {
  const [tenantId, setTenantId] = useState('');
  const [invoices, setInvoices] = useState<Invoice[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [crediting, setCrediting] = useState<Invoice | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [subscribing, setSubscribing] = useState(false);
  const [changing, setChanging] = useState(false);

  const load = useCallback((id: string) => {
    if (!id) { setInvoices(null); return; }
    setError(null); setInvoices(null);
    consoleGet<Invoice[]>(`/tenants/${id}/invoices`).then(setInvoices)
      .catch((e: ApiError) => { setError(e.message); setInvoices([]); });
  }, []);
  useEffect(() => load(tenantId), [tenantId, load]);

  const billed = invoices ? sumDecimals(invoices.map((i) => i.total)) : null;
  const tax = invoices
    ? sumDecimals(invoices.flatMap((i) => [i.cgst, i.sgst, i.igst])) : null;

  return (
    <Panel title="Billing"
           hint="GST invoices we have issued to a school. An issued invoice is credited, never edited."
           actions={(<>
             <select value={tenantId} onChange={(e) => { setTenantId(e.target.value); setSaid(null); }}
                     aria-label="School">
               <option value="">Choose a school…</option>
               {schools.map((s) => <option key={s.id} value={s.id}>{s.display_name}</option>)}
             </select>
             <button disabled={!tenantId} onClick={() => setSubscribing(true)}>Put on a plan…</button>
             <button disabled={!tenantId} onClick={() => setChanging(true)}>Change subscription…</button>
           </>)}>
      {error ? <div className="note bad" style={{ margin: '0 16px 12px' }}>{error}</div> : null}
      {said ? <div className="note" style={{ margin: '0 16px 12px' }}>{said}</div> : null}
      {!tenantId ? <Empty title="Choose a school to see its invoices" /> : (
        <>
          {invoices && invoices.length > 0 ? (
            <div className="figures">
              <div><span>Invoices</span><strong>{invoices.length}</strong></div>
              <div><span>Billed, with tax</span><strong>{rupeesDecimal(billed)}</strong></div>
              <div><span>Of which GST</span><strong>{rupeesDecimal(tax)}</strong></div>
            </div>
          ) : null}
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Invoice</th><th>Issued</th><th className="opt">Due</th>
                  <th className="opt">Supply</th><th className="num">Taxable</th>
                  <th className="num">GST</th><th className="num">Total</th><th />
                </tr>
              </thead>
              {invoices === null ? <SkeletonRows cols={8} rows={4} /> : invoices.length === 0 ? (
                <tbody><tr><td colSpan={8}>
                  <Empty title="Nothing billed yet">This school has no platform invoices.</Empty>
                </td></tr></tbody>
              ) : (
                <tbody>
                  {invoices.map((i) => (
                    <tr key={i.id}>
                      <td><strong>{i.invoice_no}</strong></td>
                      <td>{day(i.issued_on)}</td>
                      <td className="opt">{day(i.due_on)}</td>
                      <td className="opt">{i.supply_type.replace(/_/g, ' ')}</td>
                      <td className="num">{rupeesDecimal(i.taxable_value)}</td>
                      <td className="num">{rupeesDecimal(sumDecimals([i.cgst, i.sgst, i.igst]))}</td>
                      <td className="num"><strong>{rupeesDecimal(i.total)}</strong></td>
                      <td className="num"><button onClick={() => setCrediting(i)}>Credit…</button></td>
                    </tr>
                  ))}
                </tbody>
              )}
            </table>
          </div>
        </>
      )}
      {subscribing && tenantId ? (
        <Subscribe tenantId={tenantId}
                   school={schools.find((s) => s.id === tenantId)?.display_name ?? 'this school'}
                   onClose={() => setSubscribing(false)}
                   onDone={(text) => { setSubscribing(false); setSaid(text); }} />
      ) : null}
      {changing && tenantId ? (
        <ChangeSubscription tenantId={tenantId}
                   school={schools.find((s) => s.id === tenantId)?.display_name ?? 'this school'}
                   onClose={() => setChanging(false)}
                   onDone={(text) => { setChanging(false); setSaid(text); }} />
      ) : null}
      {crediting ? (
        <CreditNote invoice={crediting} onClose={() => setCrediting(null)}
                    onDone={(text) => { setCrediting(null); setSaid(text); load(tenantId); }} />
      ) : null}
    </Panel>
  );
}

/** Puts a school on a published plan version, optionally with a trial. */
function Subscribe({ tenantId, school, onClose, onDone }: {
  tenantId: string; school: string; onClose: () => void; onDone: (said: string) => void;
}) {
  const [versions, setVersions] = useState<PlanVersion[] | null>(null);
  const [versionId, setVersionId] = useState('');
  const [period, setPeriod] = useState<'monthly' | 'annual'>('monthly');
  const [trial, setTrial] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    consoleGet<PlanVersion[]>('/plans')
      // Only what can be sold: a draft has no agreed terms and a retired
      // version takes no new schools.
      .then((all) => setVersions(all.filter((p) => p.status === 'published')))
      .catch((e: ApiError) => { setError(e.message); setVersions([]); });
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    const days = trial.trim() === '' ? 0 : Number(trial);
    if (!Number.isInteger(days) || days < 0 || days > 120) {
      setError('A trial is a whole number of days, up to 120.'); return;
    }
    setBusy(true);
    try {
      await consolePost('/subscriptions', {
        tenantId, planVersionId: versionId, billingPeriod: period,
        ...(days > 0 ? { trialDays: days } : {}),
      });
      const chosen = versions?.find((v) => v.id === versionId);
      onDone(`${school} is on ${chosen?.plan_name ?? 'the plan'} v${chosen?.version ?? ''}, billed ${period}${days > 0 ? `, with a ${days}-day trial` : ''}.`);
    } catch (e) {
      setError((e as ApiError).message);
    } finally { setBusy(false); }
  }

  return (
    <div className="sheet-backdrop" onMouseDown={onClose}>
      <form className="sheet" onSubmit={submit} onMouseDown={(e) => e.stopPropagation()}>
        <h2>Put {school} on a plan</h2>
        <p className="lede">Only published versions are listed.</p>
        {versions && versions.length === 0 ? (
          <div className="note">No published plan yet. Create one on the Plans tab and publish it.</div>
        ) : (
          <>
            <label htmlFor="sub-version">Plan</label>
            <select id="sub-version" value={versionId} onChange={(e) => setVersionId(e.target.value)} required>
              <option value="">Choose…</option>
              {(versions ?? []).map((v) => (
                <option key={v.id} value={v.id}>
                  {v.plan_name} v{v.version} — {rupeesDecimal(v.price_monthly)}/month, {rupeesDecimal(v.price_annual)}/year
                </option>
              ))}
            </select>
            <label htmlFor="sub-period">Billed</label>
            <select id="sub-period" value={period}
                    onChange={(e) => setPeriod(e.target.value as 'monthly' | 'annual')}>
              <option value="monthly">Monthly</option>
              <option value="annual">Annually</option>
            </select>
            <label htmlFor="sub-trial">Trial days (optional)</label>
            <input id="sub-trial" type="text" inputMode="numeric" value={trial}
                   onChange={(e) => setTrial(e.target.value)} placeholder="0" />
          </>
        )}
        {error ? <div className="note bad" style={{ marginTop: 12 }}>{error}</div> : null}
        <div className="row" style={{ marginTop: 16, justifyContent: 'flex-end' }}>
          <button type="button" className="ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="primary" disabled={busy || !versionId}>
            {busy ? 'Saving…' : 'Subscribe'}
          </button>
        </div>
      </form>
    </div>
  );
}

/**
 * Moves a school to another plan version, or changes what state it is in.
 *
 * Both ask for a reason, and the reason is kept: "why is this school
 * read-only" is a question somebody asks months later, usually the school.
 */
function ChangeSubscription({ tenantId, school, onClose, onDone }: {
  tenantId: string; school: string; onClose: () => void; onDone: (said: string) => void;
}) {
  const [mode, setMode] = useState<'move' | 'status'>('move');
  const [versions, setVersions] = useState<PlanVersion[] | null>(null);
  const [versionId, setVersionId] = useState('');
  const [status, setStatus] = useState<string>('active');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    consoleGet<PlanVersion[]>('/plans')
      .then((all) => setVersions(all.filter((p) => p.status === 'published')))
      .catch((e: ApiError) => { setError(e.message); setVersions([]); });
  }, []);

  const minimum = mode === 'move' ? 5 : 3;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null); setBusy(true);
    try {
      if (mode === 'move') {
        await consolePost('/subscriptions/move', { tenantId, planVersionId: versionId, reason: reason.trim() });
        const chosen = versions?.find((v) => v.id === versionId);
        onDone(`${school} moved to ${chosen?.plan_name ?? 'the plan'} v${chosen?.version ?? ''}.`);
      } else {
        await consolePost('/subscriptions/status', { tenantId, status, reason: reason.trim() });
        onDone(`${school} is now ${status.replace(/_/g, ' ')}: ${STATUS_MEANING[status]?.toLowerCase() ?? ''}.`);
      }
    } catch (e) {
      setError((e as ApiError).message);
    } finally { setBusy(false); }
  }

  return (
    <div className="sheet-backdrop" onMouseDown={onClose}>
      <form className="sheet" onSubmit={submit} onMouseDown={(e) => e.stopPropagation()}>
        <h2>Change {school}'s subscription</h2>
        <div className="row" style={{ margin: '10px 0 4px' }}>
          <label className="check chipcheck">
            <input type="radio" name="mode" checked={mode === 'move'} onChange={() => setMode('move')} />
            Move to another plan
          </label>
          <label className="check chipcheck">
            <input type="radio" name="mode" checked={mode === 'status'} onChange={() => setMode('status')} />
            Change its status
          </label>
        </div>
        {mode === 'move' ? (
          <>
            <label htmlFor="move-version">Plan</label>
            <select id="move-version" value={versionId} onChange={(e) => setVersionId(e.target.value)} required>
              <option value="">Choose…</option>
              {(versions ?? []).map((v) => (
                <option key={v.id} value={v.id}>
                  {v.plan_name} v{v.version} — {rupeesDecimal(v.price_monthly)}/month
                </option>
              ))}
            </select>
          </>
        ) : (
          <>
            <label htmlFor="sub-status">Status</label>
            <select id="sub-status" value={status} onChange={(e) => setStatus(e.target.value)}>
              {SUBSCRIPTION_STATUSES.map((s) => (
                <option key={s} value={s}>{s.replace(/_/g, ' ')} — {STATUS_MEANING[s]}</option>
              ))}
            </select>
          </>
        )}
        <label htmlFor="change-reason">Reason — kept on the record</label>
        <textarea id="change-reason" rows={2} value={reason} required minLength={minimum} maxLength={300}
                  onChange={(e) => setReason(e.target.value)} />
        {error ? <div className="note bad" style={{ marginTop: 12 }}>{error}</div> : null}
        <div className="row" style={{ marginTop: 16, justifyContent: 'flex-end' }}>
          <button type="button" className="ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="primary"
                  disabled={busy || reason.trim().length < minimum || (mode === 'move' && !versionId)}>
            {busy ? 'Saving…' : mode === 'move' ? 'Move school' : 'Change status'}
          </button>
        </div>
      </form>
    </div>
  );
}

function CreditNote({ invoice, onClose, onDone }: {
  invoice: Invoice; onClose: () => void; onDone: (said: string) => void;
}) {
  const [reason, setReason] = useState('');
  const [amount, setAmount] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError(null);
    try {
      await consolePost(`/invoices/${invoice.id}/credit-note`, {
        reason, ...(amount.trim() ? { amount: amount.trim() } : {}),
      });
      onDone(`Credit note raised against ${invoice.invoice_no}.`);
    } catch (e) {
      setError((e as ApiError).message);
    } finally { setBusy(false); }
  }

  return (
    <div className="sheet-backdrop" onMouseDown={onClose}>
      <form className="sheet" onSubmit={submit} onMouseDown={(e) => e.stopPropagation()}>
        <h2>Credit {invoice.invoice_no}</h2>
        <p className="lede">
          The invoice keeps its number and stays as issued; a credit note is raised against it.
          Total {rupeesDecimal(invoice.total)}.
        </p>
        <label htmlFor="credit-amount">Amount to credit, in rupees (leave empty for the full invoice)</label>
        <input id="credit-amount" type="text" inputMode="decimal" value={amount}
               pattern="\d+(\.\d{1,2})?" placeholder={invoice.total}
               onChange={(e) => setAmount(e.target.value)} />
        <label htmlFor="credit-reason">Reason — somebody reads this in the ledger a year from now</label>
        <textarea id="credit-reason" rows={3} value={reason} required minLength={10} maxLength={2000}
                  onChange={(e) => setReason(e.target.value)} />
        {error ? <div className="note bad" style={{ marginTop: 12 }}>{error}</div> : null}
        <div className="row" style={{ marginTop: 16, justifyContent: 'flex-end' }}>
          <button type="button" className="ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="primary" disabled={busy || reason.trim().length < 10}>
            {busy ? 'Raising…' : 'Raise credit note'}
          </button>
        </div>
      </form>
    </div>
  );
}

/* -------------------------------------------------------------------- team */

/**
 * Who on our side can do what.
 *
 * Capabilities, not job titles: "support" and "billing" are separate so that
 * somebody who answers tickets cannot raise an invoice, and nobody opens a
 * school without the capability that says so on the record.
 */
export function Team() {
  const [rows, setRows] = useState<AdminRow[] | null>(null);
  const [said, setSaid] = useState<{ text: string; bad?: boolean } | null>(null);
  const [picked, setPicked] = useState<Record<string, string>>({});

  const load = useCallback(() => {
    consoleGet<AdminRow[]>('/admins').then(setRows)
      .catch((e: ApiError) => { setRows([]); setSaid({ text: e.message, bad: true }); });
  }, []);
  useEffect(load, [load]);

  async function change(userId: string, email: string, capability: string, action: 'grant' | 'revoke') {
    setSaid(null);
    try {
      await consolePost(action === 'grant' ? '/admins' : '/admins/revoke', { userId, capability });
      setSaid({ text: action === 'grant'
        ? `${email} now holds ${capability}.` : `${capability} revoked from ${email}.` });
      load();
    } catch (e) {
      setSaid({ text: (e as ApiError).message, bad: true });
    }
  }

  const team = rows ? groupTeam(rows) : null;

  return (
    <Panel title="Team" hint="Platform staff and what each can do. Every grant and revoke is on the audit log.">
      {said ? <div className={`note${said.bad ? ' bad' : ''}`} style={{ margin: '0 16px 12px' }}>{said.text}</div> : null}
      <div className="scroll">
        <table>
          <thead><tr><th>Person</th><th>Can</th><th>Give</th></tr></thead>
          {team === null ? <SkeletonRows cols={3} rows={3} /> : team.length === 0 ? (
            <tbody><tr><td colSpan={3}><Empty title="No platform staff" /></td></tr></tbody>
          ) : (
            <tbody>
              {team.map((m) => {
                const options = grantable(m);
                const choice = picked[m.userId] ?? '';
                return (
                  <tr key={m.userId}>
                    <td>
                      <strong>{m.email}</strong>
                      {m.capabilities.length === 0
                        ? <span className="sub" style={{ display: 'block' }}>No access now</span> : null}
                    </td>
                    <td>
                      <span className="chips">
                        {m.capabilities.map((c) => (
                          <span className="chip on" key={c} title={CAPABILITY_MEANING[c]}>
                            {c.replace(/_/g, ' ')}
                            <ConfirmButton label="×" confirmLabel="Revoke?" tone="critical"
                                           onConfirm={() => change(m.userId, m.email, c, 'revoke')} />
                          </span>
                        ))}
                        {m.revoked.map((c) => (
                          <span className="chip off" key={c} title="Revoked">{c.replace(/_/g, ' ')}</span>
                        ))}
                      </span>
                    </td>
                    <td>
                      {options.length > 0 ? (
                        <span className="row">
                          <select value={choice} aria-label={`Capability to give ${m.email}`}
                                  onChange={(e) => setPicked({ ...picked, [m.userId]: e.target.value })}>
                            <option value="">Capability…</option>
                            {options.map((c) => <option key={c} value={c}>{c.replace(/_/g, ' ')}</option>)}
                          </select>
                          <ConfirmButton label="Grant" confirmLabel="Grant it" disabled={!choice}
                                         onConfirm={async () => {
                                           await change(m.userId, m.email, choice, 'grant');
                                           setPicked({ ...picked, [m.userId]: '' });
                                         }} />
                        </span>
                      ) : <span className="sub">Holds everything</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          )}
        </table>
      </div>
      <dl className="meanings">
        {Object.entries(CAPABILITY_MEANING).map(([c, meaning]) => (
          <div key={c}><dt>{c.replace(/_/g, ' ')}</dt><dd>{meaning}</dd></div>
        ))}
      </dl>
    </Panel>
  );
}

/* -------------------------------------------------------------- new school */

interface Provisioned { tenantId: string; temporaryPassword: string; created: boolean; host?: string }

/**
 * Creates a school: the organisation, its first campus and its owner account.
 *
 * The request key is made once, when the form opens, and reused for every
 * press of the button. A double click, or a retry after a timeout that
 * actually succeeded, returns the school already created instead of a second.
 *
 * The temporary password is shown once and never again — the API does not
 * keep it — so the result stays on screen until somebody closes it.
 */
export function NewSchool({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [requestKey] = useState(() =>
    `console-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`);
  const [form, setForm] = useState<SchoolForm>({
    legalName: '', displayName: '', ownerEmail: '', campusName: 'Main Campus', campusCode: 'MAIN', board: '',
  });
  const [codeTouched, setCodeTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ result: Provisioned; notice: string; name: string; email: string } | null>(null);

  const set = (field: keyof SchoolForm, value: string) => setForm((f) => ({ ...f, [field]: value }));

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    const built = buildSchool(form, requestKey);
    if (!built.ok) { setError(built.error); return; }
    setBusy(true);
    try {
      const result = await consolePost<Provisioned>('/tenants', built.body);
      setDone({
        result, name: built.body['displayName'] ?? '', email: built.body['ownerEmail'] ?? '',
        notice: result.created
          ? 'Give this password to the owner directly — not by email to the address it unlocks — and have them change it at first sign-in.'
          : 'This form had already created the school. No second school was made and no new password was issued.',
      });
      onCreated();
    } catch (e) {
      setError((e as ApiError).message);
    } finally { setBusy(false); }
  }

  if (done) {
    return (
      <div className="sheet-backdrop">
        <div className="sheet">
          <h2>{done.name} is created</h2>
          <dl className="facts" style={{ padding: '8px 0' }}>
            <div><dt>Owner signs in as</dt><dd>{done.email}</dd></div>
            {done.result.host ? <div><dt>Web address</dt><dd>{done.result.host}</dd></div> : null}
            {done.result.temporaryPassword
              ? <div><dt>Temporary password</dt><dd><code className="secret">{done.result.temporaryPassword}</code></dd></div>
              : null}
          </dl>
          <div className="note">{done.notice}</div>
          <div className="row" style={{ marginTop: 16, justifyContent: 'flex-end' }}>
            <button className="primary" onClick={onClose}>
              {done.result.temporaryPassword ? 'I have noted the password' : 'Close'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="sheet-backdrop" onMouseDown={onClose}>
      <form className="sheet wide" onSubmit={submit} onMouseDown={(e) => e.stopPropagation()}>
        <h2>New school</h2>
        <p className="lede">Creates the school, its first campus and one owner account. The owner sets up everything else.</p>
        <label htmlFor="school-legal">Legal name — as it should appear on invoices</label>
        <input id="school-legal" type="text" value={form.legalName} required
               onChange={(e) => set('legalName', e.target.value)} placeholder="St Mary Education Trust" />
        <label htmlFor="school-display">Name people know it by</label>
        <input id="school-display" type="text" value={form.displayName}
               onChange={(e) => set('displayName', e.target.value)} placeholder="St Mary's High School" />
        <label htmlFor="school-owner">Owner's email</label>
        <input id="school-owner" type="email" value={form.ownerEmail} required
               onChange={(e) => set('ownerEmail', e.target.value)} placeholder="principal@school.in" />
        <div className="grid2">
          <div>
            <label htmlFor="school-campus">First campus</label>
            <input id="school-campus" type="text" value={form.campusName} required
                   onChange={(e) => {
                     set('campusName', e.target.value);
                     if (!codeTouched) set('campusCode', campusCodeFrom(e.target.value));
                   }} />
          </div>
          <div>
            <label htmlFor="school-code">Campus code</label>
            <input id="school-code" type="text" value={form.campusCode} required
                   onChange={(e) => { set('campusCode', e.target.value.toUpperCase()); setCodeTouched(true); }} />
          </div>
        </div>
        <label htmlFor="school-board">Board or affiliation (optional)</label>
        <input id="school-board" type="text" value={form.board}
               onChange={(e) => set('board', e.target.value)} placeholder="CBSE" />
        {error ? <div className="note bad" style={{ marginTop: 12 }}>{error}</div> : null}
        <div className="row" style={{ marginTop: 16, justifyContent: 'flex-end' }}>
          <button type="button" className="ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="primary" disabled={busy}>{busy ? 'Creating…' : 'Create school'}</button>
        </div>
      </form>
    </div>
  );
}

/* ----------------------------------------------------------------- revenue */

interface Revenue {
  asOf: string; mrr: string; arr: string; pastDueMrr: string; trialPipeline: string;
  schools: { total: number; paying: number; pastDue: number; trialing: number; readOnly: number; unsubscribed: number };
  byPlan: Array<{ plan_code: string; plan_name: string; version: number; schools: number; paying: number; mrr: string }>;
  trialsEnding: Array<{ tenant_id: string; display_name: string; trial_ends_on: string; days_left: number }>;
  months: Array<{ month: string; invoices: number; invoiced: string; tax: string; credited: string; net: string }>;
  financialYear: { label: string; invoices: number; invoiced: string; credited: string; net: string };
}

/**
 * What the business is earning.
 *
 * MRR counts schools being billed — active and past due — and nothing else. A
 * trial is shown beside it as pipeline, never inside it. There is no
 * "collected" figure on this screen because nothing records a school paying
 * an invoice yet; showing one would be the invoiced number wearing another
 * label.
 */
export function RevenueTab() {
  const [data, setData] = useState<Revenue | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    consoleGet<Revenue>('/revenue').then(setData).catch((e: ApiError) => setError(e.message));
  }, []);

  if (error) return <div className="note bad">{error}</div>;
  if (!data) return <Panel title="Revenue"><div className="body sub">Loading…</div></Panel>;

  const widths = barWidths(data.months.map((m) => m.net));

  return (
    <>
      <div className="figures boxed">
        <div><span>Monthly recurring revenue</span><strong>{rupeesDecimal(data.mrr)}</strong></div>
        <div><span>Annual run rate</span><strong>{rupeesDecimal(data.arr)}</strong></div>
        <div><span>Of MRR, past due</span><strong>{rupeesDecimal(data.pastDueMrr)}</strong></div>
        <div><span>Trials, if they convert</span><strong>{rupeesDecimal(data.trialPipeline)}</strong></div>
      </div>
      <div className="figures boxed">
        <div><span>Schools</span><strong>{data.schools.total}</strong></div>
        <div><span>Paying</span><strong>{data.schools.paying}</strong></div>
        <div><span>On trial</span><strong>{data.schools.trialing}</strong></div>
        <div><span>Past due</span><strong>{data.schools.pastDue}</strong></div>
        <div><span>Read only</span><strong>{data.schools.readOnly}</strong></div>
        <div><span>No plan</span><strong>{data.schools.unsubscribed}</strong></div>
      </div>

      {data.trialsEnding.length > 0 ? (
        <Panel title="Trials ending" hint="Within fourteen days, or already past. The lapsed ones come first.">
          <div className="scroll"><table>
            <thead><tr><th>School</th><th>Trial ends</th><th /></tr></thead>
            <tbody>
              {data.trialsEnding.map((t) => (
                <tr key={t.tenant_id}>
                  <td><strong>{t.display_name}</strong></td>
                  <td>{day(t.trial_ends_on)}</td>
                  <td><Pill tone={t.days_left < 0 ? 'critical' : t.days_left <= 3 ? 'warning' : undefined}>
                    {daysPhrase(t.days_left)}
                  </Pill></td>
                </tr>
              ))}
            </tbody>
          </table></div>
        </Panel>
      ) : null}

      <Panel title="By plan" hint="Schools on each version, and what the paying ones are worth a month.">
        <div className="scroll"><table>
          <thead><tr><th>Plan</th><th className="num">Schools</th><th className="num">Paying</th><th className="num">MRR</th></tr></thead>
          {data.byPlan.length === 0 ? (
            <tbody><tr><td colSpan={4}><Empty title="No school is on a plan yet" /></td></tr></tbody>
          ) : (
            <tbody>
              {data.byPlan.map((p) => (
                <tr key={`${p.plan_code}-${p.version}`}>
                  <td><strong>{p.plan_name}</strong> <span className="sub">v{p.version}</span></td>
                  <td className="num">{p.schools}</td>
                  <td className="num">{p.paying}</td>
                  <td className="num"><strong>{rupeesDecimal(p.mrr)}</strong></td>
                </tr>
              ))}
            </tbody>
          )}
        </table></div>
      </Panel>

      <Panel title="Invoiced, month by month"
             hint={`Financial year ${data.financialYear.label}: ${data.financialYear.invoices} invoices, ${rupeesDecimal(data.financialYear.net)} net of credit notes. This is what was billed, not what was collected.`}>
        <div className="scroll"><table>
          <thead><tr>
            <th>Month</th><th className="num">Invoices</th><th className="num">Invoiced</th>
            <th className="num opt">Of which GST</th><th className="num">Credited</th>
            <th className="num">Net</th><th className="opt" style={{ width: '22%' }} />
          </tr></thead>
          <tbody>
            {data.months.map((m, index) => (
              <tr key={m.month}>
                <td>{monthName(m.month)}</td>
                <td className="num">{m.invoices}</td>
                <td className="num">{rupeesDecimal(m.invoiced)}</td>
                <td className="num opt">{rupeesDecimal(m.tax)}</td>
                <td className="num">{rupeesDecimal(m.credited)}</td>
                <td className="num"><strong>{rupeesDecimal(m.net)}</strong></td>
                <td className="opt"><span className="bar"><span style={{ width: `${widths[index] ?? 0}%` }} /></span></td>
              </tr>
            ))}
          </tbody>
        </table></div>
      </Panel>
    </>
  );
}
