'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Shell, PageHead } from '../shell';
import { Panel, Pill, Icon } from '@/components/ui';
import { apiGet } from '@/lib/api';

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
