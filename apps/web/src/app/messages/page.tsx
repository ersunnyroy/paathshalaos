'use client';

import { useEffect, useMemo, useState } from 'react';
import { Shell, PageHead } from '../shell';
import { Panel, Pill, SkeletonRows, Empty, Icon } from '@/components/ui';
import { apiGet, apiPost } from '@/lib/api';

interface Recipient {
  id: string; status: string; channel: string | null;
  suppression_reason: string | null; rendered_body: string | null;
  created_at: string; given_name: string | null; family_name: string | null;
}

interface Template {
  id: string; code: string; name: string; purpose: string;
  versions: Array<{
    id: string; channel: string; locale: string | null;
    approval_status: string; body: string;
  }>;
}
interface Section { id: string; section_name: string; class_name: string | null }

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
  const [templates, setTemplates] = useState<Template[] | null>(null);
  const [sections, setSections] = useState<Section[]>([]);
  const [send, setSend] = useState({ templateCode: '', sectionId: '' });
  const [said, setSaid] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    apiGet<Recipient[]>('/v1/messages').then(setRows).catch((e: Error) => setError(e.message));
    apiGet<Template[]>('/v1/messaging/templates').then(setTemplates)
      .catch(() => setTemplates([]));
    apiGet<Section[]>('/v1/sections').then(setSections).catch(() => setSections([]));
  }, [reload]);

  async function act(fn: () => Promise<unknown>, done: string) {
    setBusy(true); setError(null); setSaid(null);
    try { await fn(); setSaid(done); setReload((n) => n + 1); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  /**
   * Only templates with an approved version can be sent.
   *
   * An unapproved template in the picker is an error a school discovers after
   * pressing send to four hundred families. In India an SMS template is
   * registered with DLT before it can go out at all, so "written" and "allowed
   * to go out" are genuinely different states.
   */
  const sendable = (templates ?? []).filter(
    (t) => t.versions.some((v) => v.approval_status === 'approved'));

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
      {said ? <div className="note ok">{said}</div> : null}

      <div className="note" style={{ marginBottom: 16 }}>
        <strong>There is no SMS or WhatsApp gateway yet.</strong>{' '}
        Messages reach families in the parent app. That is a real delivery —
        and a fabricated SMS receipt would not be, which is why nothing here
        pretends to send one.
      </div>

      <Panel title="Send to a class"
             hint="Consent is checked per family at the moment of sending, not
                   when this list was built">
        <div className="row-form">
          <select value={send.templateCode}
                  onChange={(e) => setSend((f) => ({ ...f, templateCode: e.target.value }))}>
            <option value="">Template…</option>
            {sendable.map((t) => (
              <option key={t.id} value={t.code}>{t.name}</option>
            ))}
          </select>
          <select value={send.sectionId}
                  onChange={(e) => setSend((f) => ({ ...f, sectionId: e.target.value }))}>
            <option value="">Class…</option>
            {sections.map((sec) => (
              <option key={sec.id} value={sec.id}>
                {sec.class_name ? `${sec.class_name} ` : ''}{sec.section_name}
              </option>
            ))}
          </select>
          <button disabled={busy || !send.templateCode || !send.sectionId}
                  onClick={() => void act(async () => {
                    const out = await apiPost<{
                      sent: number; suppressed: number; failed: number;
                    }>('/v1/messaging/send', {
                      templateCode: send.templateCode,
                      idempotencyKey: `web-${send.templateCode}-${send.sectionId}-${Date.now()}`,
                      audience: { kind: 'section', sectionId: send.sectionId },
                    });
                    // The count, not a tick. "Sent to 38, 2 withheld" is the
                    // answer; "sent" is a screen that hides two families.
                    setSaid(`Sent to ${out.sent}. ${out.suppressed} withheld, `
                      + `${out.failed} failed.`);
                    return out;
                  }, 'Sent.')}>
            Send
          </button>
          {templates !== null && sendable.length === 0 ? (
            <span className="sub">
              No template has an approved version yet.
            </span>
          ) : null}
        </div>
      </Panel>

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
