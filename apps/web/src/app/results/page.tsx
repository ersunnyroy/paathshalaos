'use client';

import { useCallback, useEffect, useState } from 'react';
import { Shell, PageHead } from '../shell';
import { Panel, Pill, SkeletonRows, Empty, Icon } from '@/components/ui';
import { apiGet, apiPost } from '@/lib/api';

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

interface Assessment {
  id: string; name: string; kind: string; status: string;
  max_marks: string; weight_percent: string; scheduled_on: string | null;
  course_offering_id: string; term_id: string;
  subject_name: string; class_name: string; section_name: string | null;
  marks_entered: number; learners: number;
}
interface SheetRow {
  enrollment_id: string; admission_no: string; roll_no: string | null;
  given_name: string; family_name: string | null;
  mark_id: string | null; marks_obtained: string | null;
  is_absent: boolean | null; is_exempt: boolean | null;
}
interface Scale { id: string; name: string; kind: string; published_at: string | null }
interface Section { id: string; section_name: string; class_name: string | null }
interface Term { id: string; label: string; academic_year_id: string }
interface RunRow {
  id: string; status: string; section_id: string; term_id: string;
  section_name: string; class_name: string | null; term_label: string;
  computed_at: string | null; published_at: string | null;
  line_count: number; card_count: number;
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
  const [said, setSaid] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [exams, setExams] = useState<Assessment[] | null>(null);
  const [sheetFor, setSheetFor] = useState<string | null>(null);
  const [sheet, setSheet] = useState<SheetRow[] | null>(null);
  const [entry, setEntry] = useState<Record<string, string>>({});
  const [scales, setScales] = useState<Scale[]>([]);
  const [sections, setSections] = useState<Section[]>([]);
  const [terms, setTerms] = useState<Term[]>([]);
  const [runRows, setRunRows] = useState<RunRow[] | null>(null);
  const [compute, setCompute] = useState({ sectionId: '', termId: '', gradingScaleId: '' });

  const load = useCallback(() => {
    apiGet<Run[]>('/v1/results').then(setRuns).catch((e: Error) => setError(e.message));
    apiGet<Assessment[]>('/v1/assessments').then(setExams).catch(() => setExams([]));
    apiGet<RunRow[]>('/v1/result-runs').then(setRunRows).catch(() => setRunRows([]));
    apiGet<Scale[]>('/v1/assessments/scales').then(setScales).catch(() => setScales([]));
    apiGet<Section[]>('/v1/sections').then(setSections).catch(() => setSections([]));
    apiGet<Term[]>('/v1/terms').then(setTerms).catch(() => setTerms([]));
  }, []);
  useEffect(load, [load]);

  async function act(fn: () => Promise<unknown>, done: string) {
    setBusy(true); setError(null); setSaid(null);
    try { await fn(); setSaid(done); load(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  async function openSheet(id: string) {
    setSheetFor(id); setSheet(null); setEntry({});
    try { setSheet(await apiGet<SheetRow[]>(`/v1/assessments/${id}/marks`)); }
    catch (e) { setError((e as Error).message); setSheet([]); }
  }

  const exam = exams?.find((a) => a.id === sheetFor) ?? null;

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
      {said ? <div className="note ok">{said}</div> : null}

      <Panel title="Exams and papers"
             hint="Marks go in while a paper is open. Locking it is one way —
                   a wrong mark is corrected, never re-entered">
        <table>
          <thead>
            <tr>
              <th>Paper</th><th>Class</th><th className="n">Out of</th>
              <th className="n">Marked</th><th>Status</th><th />
            </tr>
          </thead>
          {exams === null ? <SkeletonRows rows={3} cols={6} /> : (
            <tbody>
              {exams.map((a) => (
                <tr key={a.id} className={a.id === sheetFor ? 'on' : undefined}>
                  <td>
                    <strong>{a.name}</strong>
                    <span className="sub" style={{ display: 'block' }}>
                      {a.subject_name} · {a.kind}
                    </span>
                  </td>
                  <td>
                    {a.class_name}{a.section_name ? `-${a.section_name}` : ''}
                  </td>
                  <td className="n">{Number(a.max_marks)}</td>
                  <td className="n">{a.marks_entered} / {a.learners}</td>
                  <td>
                    <Pill tone={a.status === 'locked' ? 'good'
                      : a.status === 'open' ? 'warning' : undefined}>
                      {a.status}
                    </Pill>
                  </td>
                  <td className="n">
                    {a.status === 'draft' ? (
                      <button className="ghost" disabled={busy}
                              onClick={() => void act(
                                () => apiPost(`/v1/assessments/${a.id}/open`),
                                'Open for marks.')}>
                        Open
                      </button>
                    ) : null}
                    {a.status === 'open' ? (
                      <>
                        <button className="ghost" onClick={() => void openSheet(a.id)}>
                          Enter marks
                        </button>{' '}
                        <button className="ghost"
                                disabled={busy || a.marks_entered < a.learners}
                                title={a.marks_entered < a.learners
                                  ? 'Every learner needs a mark, an absence or an exemption first'
                                  : undefined}
                                onClick={() => void act(
                                  () => apiPost(`/v1/assessments/${a.id}/lock`),
                                  'Locked. Corrections are the path from here.')}>
                          Lock
                        </button>
                      </>
                    ) : null}
                    {a.status === 'locked' ? (
                      <button className="ghost" onClick={() => void openSheet(a.id)}>
                        See the marks
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          )}
        </table>
        {exams?.length === 0 ? (
          <Empty title="No papers set yet">
            An assessment carries a weight towards the term, which is what makes
            it part of a result rather than a number on its own.
          </Empty>
        ) : null}
      </Panel>

      {exam ? (
        <Panel title={`Marks — ${exam.name}`}
               hint={`Out of ${Number(exam.max_marks)}. An absence is not a zero:
                      a zero is a mark and drags the average down.`}
               actions={
                 <>
                   <button disabled={busy || exam.status !== 'open'}
                           onClick={() => void act(async () => {
                             const marks = Object.entries(entry)
                               .filter(([, v]) => v !== '')
                               .map(([enrollmentId, v]) => (
                                 v.toLowerCase() === 'a'
                                   ? { enrollmentId, absent: true }
                                   : v.toLowerCase() === 'e'
                                     ? { enrollmentId, exempt: true }
                                     : { enrollmentId, marks: Number(v) }));
                             if (marks.length === 0) throw new Error('Nothing to save.');
                             const out = await apiPost<{
                               outcomes: Array<{ outcome: string; reason?: string }>;
                             }>(`/v1/assessments/${exam.id}/marks`, { marks });
                             const bad = out.outcomes.filter((o) => o.outcome === 'rejected');
                             // One typo must not read as "nothing saved": the
                             // rest of the class went in.
                             setSaid(bad.length === 0
                               ? `Saved ${out.outcomes.length}.`
                               : `Saved ${out.outcomes.length - bad.length}. `
                                 + `${bad.length} not accepted — ${bad[0]?.reason ?? ''}`);
                             await openSheet(exam.id);
                             return out;
                           }, 'Saved.')}>
                     Save marks
                   </button>{' '}
                   <button className="ghost"
                           onClick={() => { setSheetFor(null); setSheet(null); }}>
                     Close
                   </button>
                 </>
               }>
          <table>
            <thead>
              <tr>
                <th className="n">Roll</th><th>Learner</th>
                <th className="n">Mark</th><th>Recorded</th>
              </tr>
            </thead>
            {sheet === null ? <SkeletonRows rows={5} cols={4} /> : (
              <tbody>
                {sheet.map((r) => (
                  <tr key={r.enrollment_id}>
                    <td className="n">{r.roll_no ?? '—'}</td>
                    <td>
                      <strong>
                        {r.given_name}{r.family_name ? ` ${r.family_name}` : ''}
                      </strong>
                      <span className="sub" style={{ display: 'block' }}>
                        {r.admission_no}
                      </span>
                    </td>
                    <td className="n">
                      <input type="text" style={{ width: 90, minWidth: 0 }}
                             disabled={exam.status !== 'open'}
                             placeholder="mark / A / E"
                             value={entry[r.enrollment_id]
                               ?? (r.is_absent ? 'A' : r.is_exempt ? 'E'
                                 : r.marks_obtained ?? '')}
                             onChange={(e) => setEntry(
                               (m) => ({ ...m, [r.enrollment_id]: e.target.value }))} />
                    </td>
                    <td>
                      {r.mark_id === null ? <span className="sub">Nothing yet</span>
                        : r.is_absent ? <Pill tone="warning">absent</Pill>
                        : r.is_exempt ? <Pill>exempt</Pill>
                        : <Pill tone="good">{Number(r.marks_obtained)}</Pill>}
                    </td>
                  </tr>
                ))}
              </tbody>
            )}
          </table>
        </Panel>
      ) : null}

      <Panel title="Compute a term result"
             hint="Computed by one person, checked by a second, published by a
                   third action — the three are not one button on purpose">
        <div className="row-form">
          <select value={compute.sectionId}
                  onChange={(e) => setCompute((f) => ({ ...f, sectionId: e.target.value }))}>
            <option value="">Class…</option>
            {sections.map((sec) => (
              <option key={sec.id} value={sec.id}>
                {sec.class_name ? `${sec.class_name} ` : ''}{sec.section_name}
              </option>
            ))}
          </select>
          <select value={compute.termId}
                  onChange={(e) => setCompute((f) => ({ ...f, termId: e.target.value }))}>
            <option value="">Term…</option>
            {terms.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
          </select>
          <select value={compute.gradingScaleId}
                  onChange={(e) => setCompute(
                    (f) => ({ ...f, gradingScaleId: e.target.value }))}>
            <option value="">Grading scale…</option>
            {scales.filter((sc) => sc.published_at).map((sc) => (
              <option key={sc.id} value={sc.id}>{sc.name}</option>
            ))}
          </select>
          <button disabled={busy || !compute.sectionId || !compute.termId
                            || !compute.gradingScaleId}
                  onClick={() => void act(
                    () => apiPost('/v1/result-runs', compute),
                    'Computed. Somebody else has to check it before it can be published.')}>
            Compute
          </button>
        </div>

        <table style={{ marginTop: 12 }}>
          <thead>
            <tr>
              <th>Class</th><th>Term</th><th className="n">Learners</th>
              <th>Stage</th><th />
            </tr>
          </thead>
          {runRows === null ? <SkeletonRows rows={2} cols={5} /> : (
            <tbody>
              {runRows.map((r) => (
                <tr key={r.id}>
                  <td>{r.class_name ? `${r.class_name} ` : ''}{r.section_name}</td>
                  <td>{r.term_label}</td>
                  <td className="n">{r.line_count}</td>
                  <td><Pill tone={STATUS_TONE[r.status]}>{r.status}</Pill></td>
                  <td className="n">
                    {r.status === 'computed' ? (
                      <button className="ghost" disabled={busy}
                              onClick={() => void act(
                                () => apiPost(`/v1/result-runs/${r.id}/review`),
                                'Reviewed.')}>
                        Review
                      </button>
                    ) : null}
                    {r.status === 'reviewed' ? (
                      <button className="ghost" disabled={busy}
                              onClick={() => void act(
                                () => apiPost(`/v1/result-runs/${r.id}/publish`),
                                'Published — families can see this now.')}>
                        Publish
                      </button>
                    ) : null}
                    {r.status === 'published' && r.card_count === 0 ? (
                      <button className="ghost" disabled={busy}
                              onClick={() => void act(
                                () => apiPost(`/v1/result-runs/${r.id}/report-cards`, {}),
                                'Report cards issued.')}>
                        Issue report cards
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          )}
        </table>
      </Panel>

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
