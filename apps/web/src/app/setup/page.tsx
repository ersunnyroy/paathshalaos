'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Shell, PageHead } from '../shell';
import { Panel, Pill, Icon } from '@/components/ui';
import { apiGet, rupees } from '@/lib/api';

interface Step {
  key: string; title: string; why: string;
  done: boolean; count: number; href: string | null; needs: string[];
}
interface Setup {
  steps: Step[]; done: number; total: number; ready: boolean; next: Step | null;
}

export default function SetupPage() {
  const [setup, setSetup] = useState<Setup | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiGet<Setup>('/v1/setup').then(setSetup).catch((e: Error) => setError(e.message));
  }, []);

  return (
    <Shell>
      <PageHead
        title="Getting started"
        lede="Every line below is checked against your data when this page loads — nothing here is a box somebody ticked."
      />

      {error ? <div className="note bad">{error}</div> : null}

      {setup ? (
        <>
          <div className="tiles">
            <div className="tile">
              <div className="top"><span className="k">Steps done</span></div>
              <div className="d">Counted, not estimated</div>
              <div className="v">{setup.done} of {setup.total}</div>
              <div className="meter">
                <i style={{ width: `${(setup.done / setup.total) * 100}%` }} />
              </div>
            </div>
            <div className="tile">
              <div className="top"><span className="k">Ready to run</span></div>
              <div className="d">Can you enrol, bill and mark a register?</div>
              <div className="v">
                {setup.ready
                  ? <Pill tone="good">Yes</Pill>
                  : <Pill tone="warning">Not yet</Pill>}
              </div>
            </div>
            {setup.next ? (
              <div className="tile" style={{ gridColumn: 'span 2' }}>
                <div className="top"><span className="k">Do this next</span></div>
                <div className="v" style={{ fontSize: 17 }}>{setup.next.title}</div>
                <div className="d">{setup.next.why}</div>
                {setup.next.href ? (
                  <Link className="btn primary" href={setup.next.href}
                        style={{ marginTop: 10, display: 'inline-flex' }}>
                    Open
                  </Link>
                ) : null}
              </div>
            ) : null}
          </div>

          <PlanPanel />

          <Panel
            title="All steps"
            hint="In the order they can actually be done — each one needs the ones above it"
          >
            <ol className="steps">
              {setup.steps.map((step) => (
                <li key={step.key} className={step.done ? 'done' : ''}>
                  <span className="mark" aria-hidden="true">
                    {step.done ? <Icon.check /> : null}
                  </span>
                  <div style={{ minWidth: 0 }}>
                    <strong>{step.title}</strong>
                    {/* The count, not a tick. "3 sections" is a different
                        sentence from "done", and it is the one that tells you
                        whether the step is finished or merely started. */}
                    {step.count > 0 ? (
                      <span className="sub"> · {step.count} so far</span>
                    ) : null}
                    <span className="sub" style={{ display: 'block' }}>{step.why}</span>
                  </div>
                  {step.href && !step.done ? (
                    <Link className="btn" href={step.href}>Open</Link>
                  ) : null}
                </li>
              ))}
            </ol>
          </Panel>
        </>
      ) : (
        <div className="skel" style={{ height: 280 }} />
      )}
    </Shell>
  );
}

/* ------------------------------------------------------- the plan (M16.6) */

interface Usage {
  metric: string; used: number; included: number; hard_cap: number | null;
  state: 'ok' | 'over_allowance' | 'at_cap';
}
interface Plan {
  plan_code: string; plan_name: string; version: number; status: string;
  trial_ends_on: string | null; billing_period: string;
  limits: Array<{ metric: string; included: number; hard_cap: number | null }>;
  features: Array<{ feature: string; enabled: boolean }>;
  usage: Usage[];
}
interface Option {
  plan_version_id: string; plan_code: string; plan_name: string;
  price_monthly: string;
  limits: Array<{ metric: string; included: number; hard_cap: number | null }>;
}

const METRIC_LABEL: Record<string, string> = {
  learners: 'Learners on the roll',
  staff: 'Staff',
  campuses: 'Campuses',
  messages_per_month: 'Messages this month',
  storage_mb: 'Storage',
};

const FEATURE_LABEL: Record<string, string> = {
  transport: 'Transport', hr: 'HR', lms: 'Learning',
  public_api: 'Public API', whatsapp: 'WhatsApp', advanced_reports: 'Advanced reports',
};

/**
 * The plan, the usage, and what the next tier would change.
 *
 * On Getting started rather than behind a Billing tab, because the number that
 * matters — how close the roll is to the cap — is worth seeing before it is a
 * problem. A school should learn it has outgrown its plan from this panel in
 * February, not from an admission being refused in April.
 */
function PlanPanel() {
  const [plan, setPlan] = useState<Plan | null | undefined>(undefined);
  const [options, setOptions] = useState<Option[]>([]);

  useEffect(() => {
    apiGet<Plan | null>('/v1/plan').then(setPlan).catch(() => setPlan(null));
    apiGet<Option[]>('/v1/plan/options').then(setOptions).catch(() => setOptions([]));
  }, []);

  if (plan === undefined) return <div className="skel" style={{ height: 120 }} />;
  if (plan === null) {
    return (
      <Panel title="Your plan" hint="Nothing is metered on this account">
        <div className="body">
          <p className="sub" style={{ margin: 0 }}>
            This school is not on a plan. Everything works and nothing is counted.
          </p>
        </div>
      </Panel>
    );
  }

  const tone = (u: Usage) =>
    u.state === 'at_cap' ? 'critical' : u.state === 'over_allowance' ? 'warning' : 'good';

  // The next tier is the cheapest plan that raises the limit we are closest to,
  // which is a more useful answer than "here are all our plans".
  const tightest = [...plan.usage].sort((a, b) =>
    (b.used / Math.max(b.hard_cap ?? b.included, 1)) -
    (a.used / Math.max(a.hard_cap ?? a.included, 1)))[0];
  const better = tightest
    ? options
        .filter((o) => o.plan_code !== plan.plan_code)
        .map((o) => ({ o, limit: o.limits.find((l) => l.metric === tightest.metric) }))
        .filter((x) => (x.limit?.included ?? 0) > tightest.included)
        .sort((a, b) => Number(a.o.price_monthly) - Number(b.o.price_monthly))[0]
    : undefined;

  return (
    <Panel
      title="Your plan"
      hint={`${plan.plan_name} · version ${plan.version} · billed ${plan.billing_period}`}
      actions={
        plan.status === 'read_only'
          ? <Pill tone="critical">new entries paused</Pill>
          : plan.status === 'past_due'
            ? <Pill tone="warning">payment overdue</Pill>
            : plan.status === 'trialing'
              ? <Pill tone="warning">trial ends {plan.trial_ends_on}</Pill>
              : <Pill tone="good">active</Pill>
      }
    >
      <div className="body">
        {plan.status === 'read_only' ? (
          <div className="note bad" style={{ marginBottom: 14 }}>
            <span>
              New entries are paused while the account is past due. Everything
              already here can be read and exported, and nothing has been deleted.
            </span>
          </div>
        ) : null}

        <div className="usage">
          {plan.usage.map((u) => {
            const ceiling = u.hard_cap ?? u.included;
            const pct = Math.min(100, Math.round((u.used / Math.max(ceiling, 1)) * 100));
            return (
              <div className="usage-row" key={u.metric}>
                <div>
                  <strong>{METRIC_LABEL[u.metric] ?? u.metric}</strong>
                  <span className="sub">
                    {u.used} of {u.included} included
                    {u.hard_cap === null ? ' · no cap' : ` · cap ${u.hard_cap}`}
                  </span>
                </div>
                <div className={`meter ${tone(u)}`}><i style={{ width: `${pct}%` }} /></div>
                {u.state === 'over_allowance' ? (
                  <span className="sub">
                    Over the included allowance. Nothing is blocked; the extra is metered.
                  </span>
                ) : u.state === 'at_cap' ? (
                  <span className="sub">
                    At the cap. New records of this kind are refused — everything
                    already here keeps working.
                  </span>
                ) : null}
              </div>
            );
          })}
        </div>

        <div className="features">
          {plan.features.map((f) => (
            <Pill key={f.feature} tone={f.enabled ? 'good' : undefined}>
              {FEATURE_LABEL[f.feature] ?? f.feature}{f.enabled ? '' : ' — not included'}
            </Pill>
          ))}
        </div>

        {better?.limit ? (
          <p className="sub" style={{ marginTop: 14, marginBottom: 0 }}>
            {better.o.plan_name} would take{' '}
            {(METRIC_LABEL[tightest!.metric] ?? tightest!.metric).toLowerCase()} from{' '}
            {tightest!.included} to {better.limit.included}, at{' '}
            {rupees(better.o.price_monthly)} a month.
          </p>
        ) : null}
      </div>
    </Panel>
  );
}
