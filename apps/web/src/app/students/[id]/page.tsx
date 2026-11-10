'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Shell } from '../../shell';
import { Panel, Empty, Pill, Avatar, Tile, SkeletonRows } from '@/components/ui';
import { rupees } from '@/lib/api';
import { useApiQuery } from '@/lib/query';
import {
  ageOn, attendanceRate, attendanceTone, feeStanding, invoiceIsOverdue,
  guardianCan, orderGuardians, guardianName,
  type AttendanceSummary, type FeeInvoice, type GuardianLink,
} from '@/lib/learner';
import { localIsoDate } from '@/lib/dates';
import { homeFor } from '@/lib/nav';

/**
 * One learner, on one page (M41).
 *
 * Until now a learner was a row in a roster, and answering "is she attending,
 * what do they owe, who may collect her" meant four screens and a search on
 * each. Everything here already had an endpoint; none of it had a page.
 *
 * Every read goes through the same row-level security as the lists, so this
 * page cannot show a teacher a child outside their sections — the profile
 * simply does not load. The medical and emergency details are different: that
 * read is written to the audit log, so it happens only when somebody asks for
 * it, never as a side effect of opening the page.
 */

interface Learner {
  id: string; admission_no: string; lifecycle_status: string;
  given_name: string; family_name: string | null; date_of_birth: string | null;
  section_name: string | null; class_name: string | null;
}
interface Attendance extends AttendanceSummary { days: Array<{ on_date: string; state: string }> }
interface Fees { outstanding_paise: string; next_due_on: string | null; invoices: FeeInvoice[] }
interface ResultRun {
  result_run_id: string; term_label: string | null; published_at: string | null;
  lines: Array<{
    subject: string | null; percentage: string | null; grade_label: string | null;
    is_pass: boolean | null; not_graded_reason: string | null;
  }>;
}
interface Work {
  assignment_id: string; title: string; subject_name: string; due_at: string | null;
  submitted_at: string | null; is_late: boolean | null;
  marks_obtained: string | null; max_marks: string | null;
}
interface Transport {
  route_code: string; route_name: string; stop_name: string;
  pickup_time: string | null; drop_time: string | null; vehicle_registration: string | null;
}
interface Emergency {
  blood_group: string | null; medical_note: string | null; accommodations: string | null;
  emergency_contact_name: string | null; emergency_contact_phone: string | null;
}

type Tab = 'overview' | 'attendance' | 'fees' | 'results' | 'classwork' | 'guardians';
const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'attendance', label: 'Attendance' },
  { id: 'fees', label: 'Fees' },
  { id: 'results', label: 'Results' },
  { id: 'classwork', label: 'Classwork' },
  { id: 'guardians', label: 'Guardians' },
];

const day = (iso: string | null) =>
  iso ? new Date(`${iso.slice(0, 10)}T00:00:00`).toLocaleDateString('en-IN', { dateStyle: 'medium' }) : '—';
const STATE_TONE: Record<string, 'good' | 'warning' | 'critical' | undefined> = {
  present: 'good', late: 'warning', absent: 'critical', excused: undefined,
};

export default function LearnerPage() {
  const { id } = useParams<{ id: string }>();
  const [tab, setTab] = useState<Tab>('overview');
  const [showEmergency, setShowEmergency] = useState(false);
  const today = localIsoDate();

  const me = useApiQuery<{ roles: string[] }>('/v1/me');
  // A parent reaches this page from their children, not from a roster, and
  // the medical panel is the office's: the route refuses a guardian anyway.
  const parent = homeFor(me.data?.roles ?? []) === '/family';
  const learner = useApiQuery<Learner>(`/v1/students/${id}`);
  const ready = learner.isSuccess;
  const attendance = useApiQuery<Attendance>(ready ? `/v1/family/children/${id}/attendance` : null);
  const fees = useApiQuery<Fees>(ready ? `/v1/family/children/${id}/fees` : null);
  const guardians = useApiQuery<GuardianLink[]>(ready ? `/v1/students/${id}/guardians` : null);
  const transport = useApiQuery<Transport | null>(ready ? `/v1/family/children/${id}/transport` : null);
  const results = useApiQuery<ResultRun[]>(ready && tab === 'results' ? `/v1/family/children/${id}/results` : null);
  const work = useApiQuery<Work[]>(ready && tab === 'classwork' ? `/v1/learning/students/${id}/work` : null);
  const emergency = useApiQuery<Emergency>(ready && showEmergency ? `/v1/students/${id}/emergency` : null);

  if (learner.isError) {
    return (
      <Shell>
        <Panel title="Learner">
          <Empty title="This learner is not available">
            They may have left, or they are not in a class you can see.{' '}
            <Link href="/students">Back to learners</Link>
          </Empty>
        </Panel>
      </Shell>
    );
  }

  const l = learner.data;
  const name = l ? [l.given_name, l.family_name].filter(Boolean).join(' ') : '';
  const age = l ? ageOn(l.date_of_birth, today) : null;
  const rate = attendance.data ? attendanceRate(attendance.data) : null;
  const standing = fees.data ? feeStanding(fees.data.invoices, today) : null;
  const links = guardians.data ? orderGuardians(guardians.data) : null;

  return (
    <Shell>
      <div className="profile-head">
        {parent
          ? <Link href="/family" className="back">← My children</Link>
          : <Link href="/students" className="back">← Learners</Link>}
        <div className="who">
          <span className="big-avatar"><Avatar name={name || '…'} /></span>
          <div>
            <h1>{name || ' '}</h1>
            <p>
              {l ? (
                <>
                  {l.admission_no}
                  {l.class_name ? ` · ${l.class_name} ${l.section_name ?? ''}`.trimEnd() : ' · Not enrolled'}
                  {age !== null ? ` · ${age} years` : ''}
                </>
              ) : 'Loading…'}
            </p>
          </div>
          {l ? (
            <Pill tone={l.lifecycle_status === 'enrolled' ? 'good' : undefined}>
              {l.lifecycle_status.replace(/_/g, ' ')}
            </Pill>
          ) : null}
        </div>
      </div>

      <div className="console-tabs" role="tablist" aria-label="Learner sections">
        {TABS.map((t) => (
          <button key={t.id} role="tab" type="button" aria-selected={tab === t.id}
                  onClick={() => setTab(t.id)}>{t.label}</button>
        ))}
      </div>

      {tab === 'overview' ? (
        <>
          <div className="tiles" style={{ marginTop: 16 }}>
            <Tile label="Attendance" describe="Last 30 days, late counted as present"
                  loading={attendance.isLoading}
                  value={rate === null ? 'No register' : `${rate}%`}
                  tone={attendanceTone(rate)} />
            <Tile label="Days absent" describe="Last 30 days" loading={attendance.isLoading}
                  value={String(attendance.data?.absent ?? 0)}
                  tone={(attendance.data?.absent ?? 0) > 3 ? 'warning' : undefined} />
            <Tile label="Fees outstanding" describe={fees.data?.next_due_on ? `Next due ${day(fees.data.next_due_on)}` : 'Nothing due'}
                  loading={fees.isLoading}
                  value={standing ? rupees(standing.outstandingPaise) : '—'} />
            <Tile label="Overdue" describe={standing && standing.overdueCount > 0
                    ? `${standing.overdueCount} invoice${standing.overdueCount === 1 ? '' : 's'} past the due date`
                    : 'Nothing past its due date'}
                  loading={fees.isLoading}
                  value={standing ? rupees(standing.overduePaise) : '—'}
                  tone={standing && standing.overdueCount > 0 ? 'critical' : 'good'} />
          </div>

          <div className="two-up">
            <Panel title="Details">
              <dl className="facts">
                <div><dt>Admission no.</dt><dd>{l?.admission_no ?? '—'}</dd></div>
                <div><dt>Class</dt><dd>{l?.class_name ? `${l.class_name} ${l.section_name ?? ''}` : 'Not enrolled'}</dd></div>
                <div><dt>Date of birth</dt><dd>{day(l?.date_of_birth ?? null)}{age !== null ? ` (${age})` : ''}</dd></div>
                <div><dt>Status</dt><dd>{l?.lifecycle_status.replace(/_/g, ' ') ?? '—'}</dd></div>
              </dl>
            </Panel>

            <Panel title="Transport">
              {transport.isLoading ? <div className="body sub">Loading…</div>
                : transport.data ? (
                  <dl className="facts">
                    <div><dt>Route</dt><dd>{transport.data.route_code} · {transport.data.route_name}</dd></div>
                    <div><dt>Stop</dt><dd>{transport.data.stop_name}</dd></div>
                    <div><dt>Pickup / drop</dt><dd>{transport.data.pickup_time?.slice(0, 5) ?? '—'} / {transport.data.drop_time?.slice(0, 5) ?? '—'}</dd></div>
                    <div><dt>Vehicle</dt><dd>{transport.data.vehicle_registration ?? '—'}</dd></div>
                  </dl>
                ) : <Empty title="Not on a school bus" />}
            </Panel>
          </div>

{parent ? null : (
          <Panel title="Medical and emergency"
                 hint="Restricted. Opening this is recorded against your name in the audit log.">
            {!showEmergency ? (
              <div className="body">
                <button onClick={() => setShowEmergency(true)}>Show medical and emergency details</button>
              </div>
            ) : emergency.isLoading ? <div className="body sub">Loading…</div>
              : emergency.isError ? <div className="note bad" style={{ margin: 16 }}>{emergency.error.message}</div>
              : (
                <dl className="facts">
                  <div><dt>Emergency contact</dt><dd>{emergency.data?.emergency_contact_name ?? 'Not recorded'}</dd></div>
                  <div><dt>Phone</dt><dd>{emergency.data?.emergency_contact_phone ?? 'Not recorded'}</dd></div>
                  <div><dt>Blood group</dt><dd>{emergency.data?.blood_group ?? 'Not recorded'}</dd></div>
                  <div><dt>Medical note</dt><dd>{emergency.data?.medical_note ?? 'None'}</dd></div>
                  <div><dt>Accommodations</dt><dd>{emergency.data?.accommodations ?? 'None'}</dd></div>
                </dl>
              )}
          </Panel>
          )}
        </>
      ) : null}

      {tab === 'attendance' ? (
        <Panel title="Attendance" hint="The last 30 days. One row per school day a register was taken.">
          {attendance.data && attendance.data.days.length === 0
            ? <Empty title="No register in the last 30 days" />
            : (
              <div className="scroll"><table>
                <thead><tr><th>Date</th><th>Marked</th></tr></thead>
                {attendance.data ? (
                  <tbody>
                    {attendance.data.days.map((d) => (
                      <tr key={d.on_date}>
                        <td>{day(d.on_date)}</td>
                        <td><Pill tone={STATE_TONE[d.state]}>{d.state.replace(/_/g, ' ')}</Pill></td>
                      </tr>
                    ))}
                  </tbody>
                ) : <SkeletonRows cols={2} />}
              </table></div>
            )}
        </Panel>
      ) : null}

      {tab === 'fees' ? (
        <Panel title="Fees" hint="Every invoice raised for this learner.">
          {fees.data && fees.data.invoices.length === 0
            ? <Empty title="No invoices yet" />
            : (
              <div className="scroll"><table>
                <thead><tr>
                  <th>Invoice</th><th>Due</th><th>Status</th>
                  <th className="num">Total</th><th className="num opt">Paid</th><th className="num">Owed</th>
                </tr></thead>
                {fees.data ? (
                  <tbody>
                    {fees.data.invoices.map((i) => {
                      const late = invoiceIsOverdue(i, today);
                      return (
                        <tr key={i.id}>
                          <td><strong>{i.invoice_no}</strong></td>
                          <td>{day(i.due_on)}</td>
                          <td>
                            <Pill tone={i.status === 'paid' ? 'good' : late ? 'critical' : i.status === 'void' ? undefined : 'warning'}>
                              {late ? 'overdue' : i.status.replace(/_/g, ' ')}
                            </Pill>
                          </td>
                          <td className="num">{rupees(i.total_paise)}</td>
                          <td className="num opt">{rupees(i.paid_paise)}</td>
                          <td className="num"><strong>{rupees(i.outstanding_paise)}</strong></td>
                        </tr>
                      );
                    })}
                  </tbody>
                ) : <SkeletonRows cols={6} />}
              </table></div>
            )}
        </Panel>
      ) : null}

      {tab === 'results' ? (
        results.data && results.data.length === 0
          ? <Panel title="Results"><Empty title="No published results yet" /></Panel>
          : (results.data ?? []).map((run) => (
            <Panel key={run.result_run_id} title={run.term_label ?? 'Result'}
                   hint={run.published_at ? `Published ${day(run.published_at)}` : undefined}>
              <div className="scroll"><table>
                <thead><tr><th>Subject</th><th className="num">Percentage</th><th>Grade</th><th>Outcome</th></tr></thead>
                <tbody>
                  {run.lines.map((line, index) => (
                    <tr key={`${line.subject ?? 'overall'}-${index}`}>
                      <td>{line.subject ?? <strong>Overall</strong>}</td>
                      <td className="num">{line.percentage ? `${line.percentage}%` : '—'}</td>
                      <td>{line.grade_label ?? '—'}</td>
                      <td>
                        {line.not_graded_reason
                          ? <span className="sub">{line.not_graded_reason.replace(/_/g, ' ')}</span>
                          : line.is_pass === null ? '—'
                            : <Pill tone={line.is_pass ? 'good' : 'critical'}>{line.is_pass ? 'pass' : 'not passed'}</Pill>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table></div>
            </Panel>
          ))
      ) : null}

      {tab === 'classwork' ? (
        <Panel title="Classwork" hint="Assignments set for this learner's class.">
          {work.data && work.data.length === 0
            ? <Empty title="Nothing set at the moment" />
            : (
              <div className="scroll"><table>
                <thead><tr><th>Work</th><th>Subject</th><th>Due</th><th>Handed in</th><th className="num">Marks</th></tr></thead>
                {work.data ? (
                  <tbody>
                    {work.data.map((w) => (
                      <tr key={w.assignment_id}>
                        <td><strong>{w.title}</strong></td>
                        <td>{w.subject_name}</td>
                        <td>{day(w.due_at)}</td>
                        <td>
                          {w.submitted_at
                            ? <Pill tone={w.is_late ? 'warning' : 'good'}>{w.is_late ? 'late' : 'on time'}</Pill>
                            : <span className="sub">Not yet</span>}
                        </td>
                        <td className="num">{w.marks_obtained ? `${w.marks_obtained} / ${w.max_marks ?? '—'}` : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                ) : <SkeletonRows cols={5} />}
              </table></div>
            )}
        </Panel>
      ) : null}

      {tab === 'guardians' ? (
        <Panel title="Guardians" hint="Who is linked to this learner, and what each link allows.">
          {links && links.length === 0
            ? <Empty title="No guardian linked">Link one from Access, or through an import.</Empty>
            : (
              <div className="scroll"><table>
                <thead><tr><th>Guardian</th><th>May</th></tr></thead>
                {links ? (
                  <tbody>
                    {links.map((g) => {
                      const can = guardianCan(g);
                      return (
                        <tr key={g.id}>
                          <td>
                            <strong>{guardianName(g) ?? 'Name not shown to you'}</strong>
                            {g.is_primary ? <> <Pill tone="good">primary contact</Pill></> : null}
                            <span className="sub" style={{ display: 'block', textTransform: 'capitalize' }}>
                              {g.relationship.replace(/_/g, ' ')}
                            </span>
                          </td>
                          <td>
                            {can.length === 0
                              ? <span className="sub">Linked, with no permissions</span>
                              : <span className="chips">{can.map((c) => (
                                  <span key={c} className={`chip${c === 'Collect from school' ? ' on' : ''}`}>{c}</span>
                                ))}</span>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                ) : <SkeletonRows cols={2} rows={2} />}
              </table></div>
            )}
        </Panel>
      ) : null}
    </Shell>
  );
}
