/**
 * Fee notices as the fee desk words them (M43.3): what a payment did, and
 * what the overdue-reminder line says before and after it is pressed.
 */

export interface ReminderStatus {
  overdue: number; toRemind: number; noConsent: number; noGuardian: number;
  notices: number; templateCode: string | null;
}

const children = (n: number) => `${n} ${n === 1 ? 'child has' : 'children have'}`;
const families = (n: number) => `${n} ${n === 1 ? 'child' : 'children'}`;

export interface ReminderLine { text: string; canSend: boolean }

/** What the fee desk says about reminding. Null when nothing is overdue. */
export function reminderLine(status: ReminderStatus | null | undefined): ReminderLine | null {
  if (!status || status.overdue <= 0) return null;
  const head = `${children(status.overdue)} overdue fees.`;
  const unshared = status.noGuardian > 0
    ? ` For ${families(status.noGuardian)} the fees are not shared with any guardian, so nobody can be reminded.`
    : '';
  if (status.toRemind <= 0) {
    // Everybody reachable has been reminded today — unless nobody is reachable.
    const reachable = status.overdue - status.noGuardian;
    return {
      text: `${head}${reachable > 0 ? ' Their guardians have been reminded today.' : ''}${unshared}`,
      canSend: false,
    };
  }
  if (!status.templateCode) {
    return {
      text: `${head} No fee reminder has been written and approved yet — add one under Messages (purpose: fee notifications).${unshared}`,
      canSend: false,
    };
  }
  const unasked = status.noConsent > 0
    ? ` No consent for fee messages is on record for ${families(status.noConsent)}; record it under Consent first.`
    : '';
  if (status.noConsent >= status.toRemind) {
    return { text: `${head}${unasked}${unshared}`, canSend: false };
  }
  return {
    text: `${head} The guardians of ${status.toRemind - status.noConsent} can be reminded now.${unasked}${unshared}`,
    canSend: true,
  };
}

export interface ReminderResult {
  sent: number; suppressed: number; failed: number;
  outcomes?: Array<{ outcome: string; reason?: string }>;
}

/** What happened, counting what did not go as plainly as what did. */
export function remindedLine(result: ReminderResult): string {
  const unasked = (result.outcomes ?? [])
    .filter((o) => o.outcome === 'suppressed' && o.reason === 'no_consent').length;
  const refused = Math.max(0, result.suppressed - unasked);
  return [
    `${result.sent} ${result.sent === 1 ? 'reminder' : 'reminders'} sent.`,
    unasked > 0 ? `${unasked} not sent: no consent on record.` : '',
    refused > 0 ? `${refused} not sent: they have asked not to get these.` : '',
    result.failed > 0 ? `${result.failed} could not be sent — try again.` : '',
  ].filter(Boolean).join(' ');
}

/** What the counter is told after taking a payment. */
export function paymentLine(result: { receiptNo?: string; guardiansTold?: number }): string {
  const receipt = result.receiptNo ? `Receipt ${result.receiptNo} issued.` : 'Payment recorded.';
  const told = result.guardiansTold ?? 0;
  return told > 0
    ? `${receipt} ${told} ${told === 1 ? 'guardian' : 'guardians'} told.`
    : receipt;
}
