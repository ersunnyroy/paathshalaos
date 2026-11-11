'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { apiPost } from '@/lib/api';
import { apiKey, useApiQuery } from '@/lib/query';
import { actionKey } from '@/lib/dates';
import { ConfirmButton } from '@/components/confirm';
import {
  remindedLine, reminderLine, type ReminderResult, type ReminderStatus,
} from '@/lib/reminder';

const PATH = '/v1/messaging/fee-reminders';

/**
 * On the fee desk: how many children have overdue fees, and a button that
 * reminds their guardians. Once per guardian per child per day, and it asks
 * twice before sending, because a reminder about money cannot be unsent.
 *
 * `version` changes when a payment is recorded, so the count is asked again.
 */
export function FeeReminders({ version }: { version: number }) {
  const path = `${PATH}?v=${version}`;
  const status = useApiQuery<ReminderStatus>(path, { staleTime: 0, refetchOnMount: 'always' });
  const client = useQueryClient();
  const [said, setSaid] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const [key, setKey] = useState(() => actionKey('fee-reminder'));

  const line = reminderLine(status.data);
  if (!line) return null;

  async function send() {
    setSaid(null);
    try {
      const result = await apiPost<ReminderResult>(PATH, { idempotencyKey: key });
      setSaid({ tone: result.failed > 0 ? 'bad' : 'ok', text: remindedLine(result) });
      setKey(actionKey('fee-reminder'));
    } catch (e) {
      setSaid({ tone: 'bad', text: (e as Error).message });
    } finally {
      await client.invalidateQueries({ queryKey: apiKey(path) });
    }
  }

  return (
    <div className="note absence-notices">
      <span>{said?.tone === 'ok' ? said.text : line.text}</span>
      {said?.tone === 'bad' ? <span className="why">{said.text}</span> : null}
      {line.canSend ? (
        <ConfirmButton label="Remind their guardians"
                       confirmLabel={`Send ${status.data?.notices ?? ''} reminders?`}
                       onConfirm={send} />
      ) : null}
    </div>
  );
}
