'use client';

import { useCallback, useEffect, useState } from 'react';
import { Shell, PageHead } from '../shell';
import { Panel, Pill, SkeletonRows, Empty, Icon } from '@/components/ui';
import { apiGet } from '@/lib/api';

interface Run {
  id: string; status: string; term_id: string; section_id: string;
  computed_at: string | null; published_at: string | null; lines: number;
}
interface Line {
  enrollment_id: string; course_offering_id: string | null;
  percentage: string | null; grade_label: string | null;
  is_pass: boolean | null; not_graded_reason: string | null;
  given_name: string; family_name: string | null; admission_no: string;
}

const STATUS_TONE: Record<string, 'good' | 'warning' | 'critical' | undefined> = {
  draft: 'warning', computed: 'warning', reviewed: undefined,
  published: 'good', superseded: 'critical',
};

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '—';

export default function ResultsPage() {
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [lines, setLines] = useState<Line[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    apiGet<Run[]>('/v1/results').then(setRuns).catch((e: Error) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  async function openRun(id: string) {
    setOpen(id);
    setLines(null);
    try {
      setLines(await apiGet<Line[]>(`/v1/results/${id}/lines`));
    } catch (e) { setError((e as Error).message); }
  }

  const current = runs?.find((r) => r.id === open) ?? null;

  return (
    <Shell>
      <PageHead
        title="Results"
        lede="Every run and what state it is in. A result becomes visible to a family only when it is published — which is a step a person takes, not a consequence of computing it."
      />

      {error ? <div className="note bad">{error}</div> : null}

      <Panel
        title={current ? 'Result lines' : 'Result runs'}
        hint={current
          ? 'A learner with no marks is a row saying so, not a missing row'
          : 'Computed, reviewed, published — in that order, by two different people'}
        actions={current ? (
          <button type="button" onClick={() => { setOpen(null); setLines(null); }}>
            Back to the runs
          </button>
        ) : null}
      >
        {current ? (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Learner</th>
                  <th className="opt">Admission no</th>
                  <th className="n">Percentage</th>
                  <th>Grade</th>
                  <th className="opt">Note</th>
                </tr>
              </thead>
              {lines ? (
                <tbody>
                  {lines.map((l) => (
                    <tr key={`${l.enrollment_id}-${l.course_offering_id ?? 'overall'}`}>
                      <td>{l.given_name} {l.family_name ?? ''}</td>
                      <td className="opt"><code>{l.admission_no}</code></td>
                      {/* The exact string from the database. A percentage that
                          has been through a float is no longer the mark that
                          was awarded. */}
                      <td className="n">{l.percentage ?? '—'}</td>
                      <td>
                        {l.grade_label
                          ? <Pill tone={l.is_pass === false ? 'critical' : 'good'}>
                              {l.grade_label}
                            </Pill>
                          : <Pill tone="warning">not graded</Pill>}
                      </td>
                      <td className="opt muted">{l.not_graded_reason ?? ''}</td>
                    </tr>
                  ))}
                </tbody>
              ) : <SkeletonRows rows={4} cols={5} />}
            </table>
          </div>
        ) : (
          <>
            <div className="scroll">
              <table>
                <thead>
                  <tr>
                    <th>Status</th>
                    <th className="n">Lines</th>
                    <th className="n opt">Computed</th>
                    <th className="n opt">Published</th>
                  </tr>
                </thead>
                {runs ? (
                  <tbody>
                    {runs.map((r) => (
                      <tr key={r.id} onClick={() => openRun(r.id)} style={{ cursor: 'pointer' }}>
                        <td><Pill tone={STATUS_TONE[r.status]}>{r.status}</Pill></td>
                        <td className="n">{r.lines}</td>
                        <td className="n opt muted">{when(r.computed_at)}</td>
                        <td className="n opt muted">{when(r.published_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                ) : <SkeletonRows rows={3} cols={4} />}
              </table>
            </div>
            {runs?.length === 0 ? (
              <Empty title="No result runs yet">
                A run is computed from the marks in a term, reviewed by a second
                person, and only then published.
              </Empty>
            ) : null}
          </>
        )}
        <div className="caption">
          <Icon.check />
          A correction supersedes a published run rather than editing it — the
          old report card stays retrievable, because a family may have acted on it.
        </div>
      </Panel>
    </Shell>
  );
}
