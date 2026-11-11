/**
 * Telling guardians their child was marked absent (M43.2): what the button
 * on the register says before and after it is pressed.
 */

export interface NoticeStatus {
  absent: number; toTell: number; noGuardian: number; notices: number;
  /** Children still to tell for whom no consent to these notices is on record. */
  noConsent: number;
}

export interface TemplateRow {
  code: string; purpose: string;
  versions: Array<{ channel: string; approval_status: string }>;
}

/**
 * The template an absence notice is sent from: the school's first
 * attendance template that has an approved in-app wording. Null when there is
 * none — the school has to write and approve the words before anything goes
 * out under its name.
 */
export function noticeTemplate(templates: readonly TemplateRow[]): string | null {
  const found = templates.find((t) => t.purpose === 'attendance_notifications'
    && t.versions.some((v) => v.channel === 'in_app' && v.approval_status === 'approved'));
  return found?.code ?? null;
}

const children = (n: number) => `${n} ${n === 1 ? 'child' : 'children'}`;

export interface NoticeLine { text: string; canSend: boolean; tone: 'warning' | 'good' | undefined }

/** What the register says about its absentees' guardians. Null: say nothing. */
export function noticeLine(status: NoticeStatus | null | undefined): NoticeLine | null {
  if (!status || status.absent <= 0) return null;
  const unreachable = status.noGuardian > 0
    ? ` ${children(status.noGuardian)} ${status.noGuardian === 1 ? 'has' : 'have'} no guardian on file and cannot be told.`
    : '';
  // Nobody has been asked. Nothing can go until somebody is, and pressing a
  // button that sends nothing teaches people the button does not work.
  const unasked = status.noConsent > 0
    ? ` No consent for attendance notices is on record for ${children(status.noConsent)}; record it under Consent first.`
    : '';
  if (status.toTell > 0 && status.noConsent >= status.toTell) {
    return {
      text: `${children(status.absent)} marked absent.${unasked}${unreachable}`,
      canSend: false, tone: 'warning',
    };
  }
  if (status.toTell > 0) {
    return {
      text: `${children(status.absent)} marked absent. The guardians of ${
        status.toTell === status.absent ? (status.absent === 1 ? 'that child' : 'all of them') : status.toTell
      } have not been told yet.${unasked}${unreachable}`,
      canSend: true, tone: 'warning',
    };
  }
  const told = status.absent - status.noGuardian;
  if (told <= 0) {
    return { text: `${children(status.absent)} marked absent.${unreachable}`, canSend: false, tone: 'warning' };
  }
  return {
    text: `${children(status.absent)} marked absent. Their guardians have been told.${unreachable}`,
    canSend: false, tone: 'good',
  };
}

export interface SendResult {
  sent: number; suppressed: number; failed: number;
  outcomes?: Array<{ outcome: string; reason?: string }>;
}

/** What happened, counting what did not go as plainly as what did. */
export function sentLine(result: SendResult): string {
  // "Asked not to" is only true of somebody who was asked.
  const unasked = (result.outcomes ?? [])
    .filter((o) => o.outcome === 'suppressed' && o.reason === 'no_consent').length;
  const refused = Math.max(0, result.suppressed - unasked);
  const parts = [
    `${result.sent} ${result.sent === 1 ? 'guardian' : 'guardians'} told.`,
    unasked > 0 ? `${unasked} not sent: no consent on record.` : '',
    refused > 0 ? `${refused} not sent: they have asked not to get these.` : '',
    result.failed > 0 ? `${result.failed} could not be sent — try again.` : '',
  ];
  return parts.filter(Boolean).join(' ');
}
