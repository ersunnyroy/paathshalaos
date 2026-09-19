'use client';

import { useEffect, useMemo, useState } from 'react';
import { Shell, PageHead } from '../shell';
import { Panel, Pill, SkeletonRows, Empty, Icon } from '@/components/ui';
import { apiGet } from '@/lib/api';

interface Recipient {
  id: string; status: string; channel: string | null;
  suppression_reason: string | null; rendered_body: string | null;
  created_at: string; given_name: string | null; family_name: string | null;
}

const STATUS_TONE: Record<string, 'good' | 'warning' | 'critical' | undefined> = {
  sent: 'good', delivered: 'good', read: 'good',
  queued: 'warning', suppressed: 'warning',
  failed: 'critical', undelivered: 'critical',
};

/**
 * Suppression reasons in the institute's words.
 *
 * The database stores a machine reason because it has to be matched on; a
 * screen that shows `no_consent_for_purpose` to an administrator has told them
 * nothing they can act on. This is the translation, and anything unmapped falls
 * through readable rather than blank.
 */
const REASON: Record<string, string> = {
  no_consent_for_purpose: 'Consent withdrawn for this kind of message',
  no_contact_for_channel: 'No phone or email on file for this channel',
  outside_wa_session: 'Outside WhatsApp’s 24-hour window, and no approved template',
  quiet_hours: 'Held back — outside the hours this school messages families',
  duplicate_in_window: 'Already told about this, recently',
  template_not_registered: 'The template is not registered with DLT',
};

const when = (iso: string) =>
  new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });

export default function MessagesPage() {
  const [rows, setRows] = useState<Recipient[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [only, setOnly] = useState<'all' | 'suppressed' | 'failed'>('all');

  useEffect(() => {
    apiGet<Recipient[]>('/v1/messages').then(setRows).catch((e: Error) => setError(e.message));
  }, []);

  const shown = useMemo(() => {
    if (!rows) return null;
    if (only === 'suppressed') return rows.filter((r) => r.status === 'suppressed');
    if (only === 'failed') return rows.filter((r) => r.status === 'failed' || r.status === 'undelivered');
    return rows;
  }, [rows, only]);

  const counts = useMemo(() => ({
    all: rows?.length ?? 0,
    suppressed: rows?.filter((r) => r.status === 'suppressed').length ?? 0,
    failed: rows?.filter((r) => r.status === 'failed' || r.status === 'undelivered').length ?? 0,
  }), [rows]);

  return (
    <Shell>
      <PageHead
        title="Messages"
        lede="Everything sent, and everything deliberately not sent — with the reason. A message that was withheld is a row here, not an absence."
      />

      {error ? <div className="note bad">{error}</div> : null}

      <Panel
        title="Recipients"
        hint="One row per person per learner — a guardian of three children gets three"
        actions={
          <div className="row">
            {([['all', 'All'], ['suppressed', 'Withheld'], ['failed', 'Failed']] as const)
              .map(([key, label]) => (
                <button key={key} type="button"
                        className={only === key ? 'primary' : ''}
                        onClick={() => setOnly(key)}>
                  {label} {counts[key] > 0 ? `(${counts[key]})` : ''}
                </button>
              ))}
          </div>
        }
      >
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>To</th>
                <th>Status</th>
                <th className="opt">Channel</th>
                <th>Why not sent</th>
                <th className="n opt">When</th>
              </tr>
            </thead>
            {shown ? (
              <tbody>
                {shown.map((r) => (
                  <tr key={r.id}>
                    <td>
                      {r.given_name ? `${r.given_name} ${r.family_name ?? ''}` : '—'}
                      {r.rendered_body ? (
                        <span className="sub" style={{ display: 'block' }}>
                          {r.rendered_body.slice(0, 90)}
                          {r.rendered_body.length > 90 ? '…' : ''}
                        </span>
                      ) : null}
                    </td>
                    <td><Pill tone={STATUS_TONE[r.status]}>{r.status}</Pill></td>
                    <td className="opt muted">{r.channel ?? '—'}</td>
                    <td className="sub">
                      {r.suppression_reason
                        ? REASON[r.suppression_reason] ?? r.suppression_reason
                        : ''}
                    </td>
                    <td className="n opt muted">{when(r.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            ) : <SkeletonRows rows={5} cols={5} />}
          </table>
        </div>
        {shown?.length === 0 ? (
          <Empty title={only === 'all' ? 'Nothing sent yet' : 'Nothing in this group'}>
            {only === 'all'
              ? 'Attendance and fee notifications appear here as they go out.'
              : 'Which is the answer you want.'}
          </Empty>
        ) : null}
        <div className="caption">
          <Icon.check />
          Consent is read per recipient at the moment of sending, not when the
          audience was built — so a parent who withdrew this morning is not
          messaged this afternoon.
        </div>
      </Panel>
    </Shell>
  );
}
