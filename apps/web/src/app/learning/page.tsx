'use client';

/**
 * Classwork (M28).
 *
 * The screen is built around one number: how many pieces of work are waiting
 * to be marked. Everything else on the page is reachable from it, because that
 * is the state a teacher opens this in — not "let me browse my lessons".
 *
 * There is no marks column that belongs to this page. A graded assignment is
 * an assessment, the grade box writes a mark through the assessment module,
 * and the number shown back comes from `mark`. If that ever looks like an
 * awkward round trip, it is the round trip that keeps homework on the report
 * card.
 */
import { useCallback, useEffect, useState } from 'react';
import { Shell, PageHead } from '../shell';
import { Empty, Panel, Pill, SkeletonRows, Tile } from '@/components/ui';
import { apiGet, apiPost } from '@/lib/api';

interface Offering {
  id: string; subject_name: string; class_group_name: string;
  section_name: string | null; term_label: string; is_mine: boolean;
  assignment_count: number; awaiting_count: number;
}
interface Assignment {
  id: string; title: string; instructions: string | null;
  due_at: string | null; accepts_late: boolean; submission_kind: string;
  status: 'draft' | 'published' | 'closed';
  assessment_id: string | null; max_marks: string | null;
  submitted_count: number; returned_count: number;
}
interface Submission {
  id: string; assignment_id: string; enrollment_id: string; student_id: string;
  body_text: string | null; submitted_at: string; is_late: boolean;
  status: 'submitted' | 'returned'; feedback: string | null;
  marks_obtained: string | null;
}
interface Lesson {
  id: string; title: string; summary: string | null;
  sequence_no: number | null; taught_on: string | null;
  status: 'draft' | 'published' | 'archived'; resource_count: number;
}

const label = (o: Offering) =>
  `${o.class_group_name}${o.section_name ? `-${o.section_name}` : ''} · ${o.subject_name}`;

/** A deadline a teacher can read at a glance, not an ISO string. */
function due(at: string | null): { text: string; tone?: 'warning' | 'critical' } {
  if (!at) return { text: 'No deadline' };
  const ms = new Date(at).getTime() - Date.now();
  const days = Math.round(ms / 86_400_000);
  if (ms < 0) return { text: `Closed ${Math.abs(days) || 0}d ago`, tone: 'critical' };
  if (days === 0) return { text: 'Due today', tone: 'warning' };
  if (days === 1) return { text: 'Due tomorrow', tone: 'warning' };
  return { text: `Due in ${days}d` };
}

export default function LearningPage() {
  const [offerings, setOfferings] = useState<Offering[] | null>(null);
  const [offeringId, setOfferingId] = useState('');
  const [assignments, setAssignments] = useState<Assignment[] | null>(null);
  const [lessons, setLessons] = useState<Lesson[] | null>(null);
  const [openId, setOpenId] = useState('');
  const [subs, setSubs] = useState<Submission[] | null>(null);
  const [marks, setMarks] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);

  useEffect(() => {
    apiGet<Offering[]>('/v1/learning/offerings')
      .then((rows) => {
        setOfferings(rows);
        // Open on whichever class has work waiting. A picker that defaults to
        // the alphabetically first class makes the teacher find the one that
        // needs them.
        const first = [...rows].sort((a, b) => b.awaiting_count - a.awaiting_count)[0];
        setOfferingId((current) => current || first?.id || '');
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  const loadOffering = useCallback(() => {
    if (!offeringId) return;
    setAssignments(null); setLessons(null); setOpenId(''); setSubs(null);
    apiGet<Assignment[]>(`/v1/learning/offerings/${offeringId}/assignments`)
      .then(setAssignments).catch((e: Error) => { setAssignments([]); setError(e.message); });
    apiGet<Lesson[]>(`/v1/learning/offerings/${offeringId}/lessons`)
      .then(setLessons).catch(() => setLessons([]));
  }, [offeringId]);

  useEffect(() => { loadOffering(); }, [loadOffering]);

  const open = useCallback((a: Assignment) => {
    setOpenId(a.id); setSubs(null); setMarks({}); setNotes({}); setSaid(null);
    apiGet<Submission[]>(`/v1/learning/assignments/${a.id}/submissions`)
      .then(setSubs).catch((e: Error) => { setSubs([]); setError(e.message); });
  }, []);

  const current = (assignments ?? []).find((a) => a.id === openId);
  const mine = offerings?.find((o) => o.id === offeringId);
  const waiting = (offerings ?? []).reduce((n, o) => n + o.awaiting_count, 0);

  async function publish(a: Assignment) {
    setBusy(true); setError(null);
    try {
      await apiPost(`/v1/learning/assignments/${a.id}/publish`);
      loadOffering();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  async function grade() {
    if (!current || !subs) return;
    setBusy(true); setError(null); setSaid(null);
    try {
      const grades = subs
        .filter((s) => marks[s.enrollment_id] !== undefined || notes[s.enrollment_id])
        .map((s) => ({
          enrollmentId: s.enrollment_id,
          ...(marks[s.enrollment_id] ? { marks: Number(marks[s.enrollment_id]) } : {}),
          ...(notes[s.enrollment_id] ? { feedback: notes[s.enrollment_id] } : {}),
        }));
      if (grades.length === 0) { setSaid('Nothing to send.'); return; }
      const out = await apiPost<{ returned: number; outcomes: Array<{ outcome: string; reason?: string }> }>(
        `/v1/learning/assignments/${current.id}/grade`, { grades });
      const refused = out.outcomes.filter((o) => o.outcome === 'rejected');
      // A rejection is per-child and must not read as "nothing saved": the
      // rest of the class went through.
      setSaid(refused.length === 0
        ? `Returned ${out.returned}.`
        : `Returned ${out.returned}. ${refused.length} not accepted — ${refused[0]?.reason ?? ''}`);
      open(current);
      loadOffering();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <Shell>
      <PageHead title="Classwork"
                lede="Lessons, homework, and what is waiting to be marked." />

      {error ? <div className="note bad">{error}</div> : null}

      <div className="tiles">
        <Tile label="Waiting to be marked" value={String(waiting)}
              describe="Handed in, not yet returned"
              tone={waiting > 0 ? 'warning' : 'good'}
              loading={offerings === null} />
        <Tile label="Your classes"
              value={String((offerings ?? []).filter((o) => o.is_mine).length)}
              describe="Where you set the work" loading={offerings === null} />
        <Tile label="Assignments" value={String(mine?.assignment_count ?? 0)}
              describe="In this class" loading={offerings === null} />
        <Tile label="Lessons" value={String(lessons?.length ?? 0)}
              describe="In this class" loading={lessons === null} />
      </div>

      <Panel
        title="Homework"
        hint="A maximum mark is what makes it count towards the term"
        actions={
          <select value={offeringId} onChange={(e) => setOfferingId(e.target.value)}>
            {(offerings ?? []).map((o) => (
              <option key={o.id} value={o.id}>
                {label(o)}{o.awaiting_count > 0 ? ` — ${o.awaiting_count} waiting` : ''}
              </option>
            ))}
          </select>
        }
      >
        <table>
          <thead>
            <tr>
              <th>Assignment</th><th>Due</th><th>Marks</th>
              <th className="num">In</th><th className="num">Returned</th><th />
            </tr>
          </thead>
          {assignments === null ? <SkeletonRows rows={4} cols={6} /> : (
            <tbody>
              {assignments.map((a) => {
                const d = due(a.due_at);
                return (
                  <tr key={a.id} onClick={() => open(a)}
                      className={a.id === openId ? 'on' : undefined}
                      style={{ cursor: 'pointer' }}>
                    <td>
                      <strong>{a.title}</strong>
                      <span className="sub" style={{ display: 'block' }}>
                        {a.status === 'draft' ? 'Draft — nobody can see this yet'
                          : a.status === 'closed' ? 'Closed' : 'Published'}
                        {a.accepts_late ? '' : ' · no late work'}
                      </span>
                    </td>
                    <td>{d.tone ? <Pill tone={d.tone}>{d.text}</Pill> : d.text}</td>
                    <td>
                      {a.max_marks
                        ? <>Out of {a.max_marks}</>
                        : <span className="sub">Practice — no marks</span>}
                    </td>
                    <td className="num">{a.submitted_count}</td>
                    <td className="num">{a.returned_count}</td>
                    <td className="num">
                      {a.status === 'draft' && mine?.is_mine ? (
                        <button className="ghost" disabled={busy}
                                onClick={(e) => { e.stopPropagation(); void publish(a); }}>
                          Publish
                        </button>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          )}
        </table>
        {assignments?.length === 0 ? (
          <Empty title="No homework set for this class">
            An assignment with a maximum mark becomes part of the term result.
            One without is practice, and is never counted.
          </Empty>
        ) : null}
      </Panel>

      {current ? (
        <Panel
          title={`Marking — ${current.title}`}
          hint={current.max_marks
            ? `Out of ${current.max_marks}. These marks go to the report card.`
            : 'Practice work. Feedback only — there is nowhere for a number to go.'}
          actions={mine?.is_mine
            ? <button disabled={busy || subs === null} onClick={() => void grade()}>
                {busy ? 'Sending…' : 'Return marked work'}
              </button>
            : <span className="sub">You can see this class; you do not set its work.</span>}
        >
          {said ? <div className="note" style={{ margin: '0 0 12px' }}>{said}</div> : null}
          <table>
            <thead>
              <tr>
                <th>Handed in</th><th>Work</th>
                {current.max_marks ? <th className="num">Mark</th> : null}
                <th>Feedback</th><th>State</th>
              </tr>
            </thead>
            {subs === null ? <SkeletonRows rows={3} cols={5} /> : (
              <tbody>
                {subs.map((s) => (
                  <tr key={s.id}>
                    <td>
                      {new Date(s.submitted_at).toLocaleString()}
                      {s.is_late ? <> <Pill tone="warning">Late</Pill></> : null}
                    </td>
                    <td className="sub">{s.body_text ?? '—'}</td>
                    {current.max_marks ? (
                      <td className="num">
                        <input type="number" min={0} max={Number(current.max_marks)}
                               style={{ width: 80 }}
                               disabled={!mine?.is_mine}
                               value={marks[s.enrollment_id] ?? s.marks_obtained ?? ''}
                               onChange={(e) => setMarks(
                                 (m) => ({ ...m, [s.enrollment_id]: e.target.value }))} />
                      </td>
                    ) : null}
                    <td>
                      <input type="text" placeholder="A sentence they can act on"
                             disabled={!mine?.is_mine}
                             value={notes[s.enrollment_id] ?? s.feedback ?? ''}
                             onChange={(e) => setNotes(
                               (n) => ({ ...n, [s.enrollment_id]: e.target.value }))} />
                    </td>
                    <td>
                      {s.status === 'returned'
                        ? <Pill tone="good">Returned</Pill>
                        : <Pill>Waiting</Pill>}
                    </td>
                  </tr>
                ))}
              </tbody>
            )}
          </table>
          {subs?.length === 0 ? (
            <Empty title="Nothing handed in yet">
              {current.status === 'draft'
                ? 'This assignment is still a draft, so nobody can see it.'
                : 'Published. Submissions will appear here as they arrive.'}
            </Empty>
          ) : null}
        </Panel>
      ) : null}

      <Panel title="Lessons" hint="Published lessons are visible to the class">
        <table>
          <thead><tr><th className="num">#</th><th>Lesson</th><th>Taught</th><th>State</th></tr></thead>
          {lessons === null ? <SkeletonRows rows={3} cols={4} /> : (
            <tbody>
              {lessons.map((l) => (
                <tr key={l.id}>
                  <td className="num">{l.sequence_no ?? '—'}</td>
                  <td>
                    <strong>{l.title}</strong>
                    {l.summary ? <span className="sub" style={{ display: 'block' }}>{l.summary}</span> : null}
                  </td>
                  <td>{l.taught_on ?? <span className="sub">Not yet</span>}</td>
                  <td>{l.status === 'published'
                    ? <Pill tone="good">Published</Pill>
                    : <Pill>{l.status === 'draft' ? 'Draft' : 'Archived'}</Pill>}</td>
                </tr>
              ))}
            </tbody>
          )}
        </table>
        {lessons?.length === 0 ? (
          <Empty title="No lessons recorded for this class">
            A lesson is a title, where it sits in the sequence, and whatever you
            want the class to have. Drafts stay yours until you publish them.
          </Empty>
        ) : null}
      </Panel>
    </Shell>
  );
}
