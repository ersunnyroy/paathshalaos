'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { apiPost } from '@/lib/api';
import { apiKey, useApiQuery } from '@/lib/query';
import { actionKey } from '@/lib/dates';
import {
  noticeLine, noticeTemplate, sentLine, type NoticeStatus, type SendResult, type TemplateRow,
} from '@/lib/absence';

/**
 * Under a saved register: who is absent, and a button that tells their
 * guardians. It tells each guardian once — pressing it again after another
 * child is marked absent tells only the new one.
 *
 * `version` changes whenever the register is saved, so the count is asked
 * again rather than trusted from before the save.
 */
export function AbsenceNotices({ sessionId, version }: { sessionId: string; version: string }) {
  const path = `/v1/messaging/absence-notices/${sessionId}?v=${encodeURIComponent(version)}`;
  // Asked afresh every time the register is opened: consent recorded on
  // another screen changes the answer, and a remembered "nobody can be told"
  // is the wrong thing to show the person who just fixed it.
  const status = useApiQuery<NoticeStatus>(path, { staleTime: 0, refetchOnMount: 'always' });
  const templates = useApiQuery<TemplateRow[]>('/v1/messaging/templates');
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  // One key per press that is allowed to send; made when the button is shown
  // enabled, so a double click is one send.
  const [key, setKey] = useState(() => actionKey(`absent-${sessionId}`));

  const line = noticeLine(status.data);
  if (!line) return null;
  const template = templates.data ? noticeTemplate(templates.data) : null;

  async function send() {
    if (!template) return;
    setBusy(true); setSaid(null);
    try {
      const result = await apiPost<SendResult>('/v1/messaging/send', {
        templateCode: template, idempotencyKey: key,
        audience: { kind: 'absentees', attendanceSessionId: sessionId },
      });
      setSaid({ tone: result.failed > 0 ? 'bad' : 'ok', text: sentLine(result) });
      setKey(actionKey(`absent-${sessionId}`));
    } catch (e) {
      setSaid({ tone: 'bad', text: (e as Error).message });
    } finally {
      setBusy(false);
      await client.invalidateQueries({ queryKey: apiKey(path) });
    }
  }

  return (
    <div className={`note absence-notices${line.tone === 'good' ? ' ok' : ''}`}>
      <span>{said?.tone === 'ok' ? said.text : line.text}</span>
      {said?.tone === 'bad' ? <span className="why">{said.text}</span> : null}
      {line.canSend ? (
        template ? (
          <button type="button" className="primary" disabled={busy} onClick={() => void send()}>
            {busy ? 'Sending…' : 'Tell their guardians'}
          </button>
        ) : templates.data ? (
          <span className="why">
            No absence notice has been written and approved yet. Add one under
            Messages (purpose: attendance) and this button appears.
          </span>
        ) : null
      ) : null}
    </div>
  );
}
