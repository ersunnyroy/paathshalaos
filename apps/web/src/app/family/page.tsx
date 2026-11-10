'use client';

import Link from 'next/link';
import { Shell, PageHead } from '../shell';
import { Panel, Empty, Pill, Avatar } from '@/components/ui';
import { rupees } from '@/lib/api';
import { useApiQuery } from '@/lib/query';
import { localIsoDate } from '@/lib/dates';
import { clockLabel } from '@/lib/timetable';
import {
  attendanceRate, attendanceTone, feeStanding, invoiceIsOverdue,
  type AttendanceSummary, type FeeInvoice,
} from '@/lib/learner';

/**
 * A parent's home (M44, web).
 *
 * What a parent opens the product for, in the order they ask it: is my child
 * in school, what do I owe, when is the bus, what did the school say. One card
 * per child, because a parent with two children has two answers to each.
 *
 * Every figure comes from the `family` routes, which return a guardian's own
 * children and nothing else, and each link's permissions are honoured rather
 * than worked around: a guardian who may not see fees is told so, and no fee
 * request is made for that child at all.
 *
 * Fees cannot be paid here yet. That needs the payment gateway (M26), and a
 * "Pay now" button that does nothing would be worse than saying so.
 */

interface Child {
  id: string; admission_no: string; given_name: string; family_name: string | null;
  section_name: string | null; class_name: string | null;
  can_view_academics: boolean; can_view_finance: boolean;
}
interface Attendance extends AttendanceSummary { days: Array<{ on_date: string; state: string }> }
interface Fees { outstanding_paise: string; next_due_on: string | null; invoices: FeeInvoice[] }
interface Transport {
  route_code: string; route_name: string; stop_name: string;
  pickup_time: string | null; drop_time: string | null; vehicle_registration: string | null;
}
interface Message { id: string; channel: string; body: string; sent_at: string }

const day = (iso: string | null) =>
  iso ? new Date(`${iso.slice(0, 10)}T00:00:00`).toLocaleDateString('en-IN', { dateStyle: 'medium' }) : '—';
const when = (iso: string) =>
  new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
const STATE_TONE: Record<string, 'good' | 'warning' | 'critical' | undefined> = {
  present: 'good', late: 'warning', absent: 'critical',
};

export default function FamilyPage() {
  const children = useApiQuery<Child[]>('/v1/family/children');
  const messages = useApiQuery<Message[]>('/v1/family/messages');

  return (
    <Shell>
      <PageHead title="My children"
                lede="Attendance, fees, the bus and what the school has sent you. Only your own children are ever shown here." />

      {children.isError ? <div className="note bad">{children.error.message}</div> : null}

      {children.data && children.data.length === 0 ? (
        <Panel title="My children">
          <Empty title="No child is linked to your account yet">
            Ask the school office to link you as a guardian. Until they do, there is nothing we are allowed to show you.
          </Empty>
        </Panel>
      ) : null}

      <div className="children">
        {(children.data ?? []).map((child) => <ChildCard key={child.id} child={child} />)}
      </div>

      <Panel title="From the school" hint="Notices and messages sent to you.">
        {!messages.data ? <div className="body sub">Loading…</div>
          : messages.data.length === 0 ? <Empty title="Nothing from the school yet" />
          : (
            <ul className="feed">
              {messages.data.map((m) => (
                <li key={m.id}>
                  <p>{m.body}</p>
                  <span className="sub">{when(m.sent_at)}</span>
                </li>
              ))}
            </ul>
          )}
      </Panel>
    </Shell>
  );
}

function ChildCard({ child }: { child: Child }) {
  const today = localIsoDate();
  const name = [child.given_name, child.family_name].filter(Boolean).join(' ');
  const attendance = useApiQuery<Attendance>(`/v1/family/children/${child.id}/attendance`);
  // Not asked for at all when this link does not allow it. Asking and hiding
  // the answer would still be the school's fee data crossing the network to
  // somebody it was not shared with.
  const fees = useApiQuery<Fees>(child.can_view_finance ? `/v1/family/children/${child.id}/fees` : null);
  const transport = useApiQuery<Transport | null>(`/v1/family/children/${child.id}/transport`);

  const rate = attendance.data ? attendanceRate(attendance.data) : null;
  const todays = attendance.data?.days.find((d) => d.on_date === today) ?? null;
  const recent = (attendance.data?.days ?? []).slice(0, 7);
  const standing = fees.data ? feeStanding(fees.data.invoices, today) : null;
  const unpaid = (fees.data?.invoices ?? [])
    .filter((i) => i.status !== 'void' && BigInt(i.outstanding_paise) > 0n);

  return (
    <section className="panel child">
      <header>
        <span className="who2">
          <span className="big-avatar"><Avatar name={name} /></span>
          <span>
            <h2>{name}</h2>
            <span className="hint">
              {child.class_name ? `${child.class_name} ${child.section_name ?? ''}`.trim() : 'Not enrolled'} · {child.admission_no}
            </span>
          </span>
        </span>
        <Link className="btn" href={`/students/${child.id}`}>Full record</Link>
      </header>

      <div className="child-grid">
        <div>
          <h3>Today</h3>
          {attendance.isLoading ? <p className="sub">Loading…</p>
            : todays ? <Pill tone={STATE_TONE[todays.state]}>{todays.state.replace(/_/g, ' ')}</Pill>
            : <p className="sub">The register has not been taken yet.</p>}
          <p className="fact">
            {rate === null ? 'No register in the last 30 days.'
              : <><strong>{rate}%</strong> attendance in the last 30 days, {attendance.data?.absent ?? 0} absent</>}
            {rate !== null && attendanceTone(rate) === 'critical'
              ? <> <Pill tone="critical">below 75%</Pill></> : null}
          </p>
          {recent.length > 0 ? (
            <span className="chips">
              {recent.map((d) => (
                <span key={d.on_date} title={`${day(d.on_date)}: ${d.state}`}
                      className={`chip dot-${d.state}`}>
                  {new Date(`${d.on_date}T00:00:00`).toLocaleDateString('en-IN', { weekday: 'short' })}
                </span>
              ))}
            </span>
          ) : null}
        </div>

        <div>
          <h3>Fees</h3>
          {!child.can_view_finance ? (
            <p className="sub">Fee details for {child.given_name} are not shared with you. The school office can change that.</p>
          ) : fees.isLoading ? <p className="sub">Loading…</p>
            : unpaid.length === 0 ? <Pill tone="good">Nothing to pay</Pill>
            : (
              <>
                <p className="fact">
                  <strong>{rupees(standing!.outstandingPaise)}</strong> to pay
                  {standing!.overdueCount > 0
                    ? <> <Pill tone="critical">{rupees(standing!.overduePaise)} overdue</Pill></> : null}
                </p>
                <ul className="lines">
                  {unpaid.map((i) => (
                    <li key={i.id}>
                      <span>{i.invoice_no} · due {day(i.due_on)}</span>
                      <span>
                        {rupees(i.outstanding_paise)}
                        {invoiceIsOverdue(i, today) ? <> <Pill tone="critical">overdue</Pill></> : null}
                      </span>
                    </li>
                  ))}
                </ul>
                <p className="sub">Pay at the school office for now. Paying online is being built.</p>
              </>
            )}
        </div>

        <div>
          <h3>Bus</h3>
          {transport.isLoading ? <p className="sub">Loading…</p>
            : !transport.data ? <p className="sub">Not on a school bus.</p>
            : (
              <>
                <p className="fact"><strong>{transport.data.stop_name}</strong> · {transport.data.route_name}</p>
                <p className="sub">
                  Pickup {transport.data.pickup_time ? clockLabel(transport.data.pickup_time) : '—'},
                  drop {transport.data.drop_time ? clockLabel(transport.data.drop_time) : '—'}
                  {transport.data.vehicle_registration ? ` · ${transport.data.vehicle_registration}` : ''}
                </p>
              </>
            )}
        </div>
      </div>
    </section>
  );
}
