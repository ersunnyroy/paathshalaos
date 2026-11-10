/**
 * The sums behind a learner's profile page (M41).
 *
 * Everything here answers a question an office actually asks at the counter —
 * how old is she, is he attending, what do they owe and is it late, who may
 * collect her — and each one has an answer that is easy to get subtly wrong.
 */

/** Age in whole years on a given day, from an ISO date of birth. */
export function ageOn(dateOfBirth: string | null, today: string): number | null {
  if (!dateOfBirth) return null;
  const [by, bm, bd] = dateOfBirth.split('-').map(Number);
  const [ty, tm, td] = today.split('-').map(Number);
  if (!by || !bm || !bd || !ty || !tm || !td) return null;
  // A birthday later this year has not happened yet.
  const had = tm > bm || (tm === bm && td >= bd);
  const age = ty - by - (had ? 0 : 1);
  return age >= 0 ? age : null;
}

export interface AttendanceSummary { present: number; absent: number; late: number; recorded: number }

/**
 * Attendance as a whole percentage, or null when nothing was recorded.
 *
 * Late counts as attended: the child was in school. Null rather than 0% for
 * an empty window, because "no register was taken" and "never came" are
 * different facts and only one of them is about the child.
 */
export function attendanceRate(a: AttendanceSummary): number | null {
  if (a.recorded <= 0) return null;
  return Math.round(((a.present + a.late) / a.recorded) * 100);
}

/** The tone a rate is shown in. 75% is the usual board eligibility line. */
export function attendanceTone(rate: number | null): 'good' | 'warning' | 'critical' | undefined {
  if (rate === null) return undefined;
  if (rate >= 90) return 'good';
  if (rate >= 75) return 'warning';
  return 'critical';
}

export interface FeeInvoice {
  id: string; invoice_no: string; status: string; due_on: string;
  total_paise: string; paid_paise: string; outstanding_paise: string;
}

/**
 * What is owed and how much of it is late, in paise strings.
 *
 * Summed as integers, never as floats. An invoice is overdue only when money
 * is still owed on it AND its due date has passed — due today is not late, and
 * a void or fully paid invoice is never late whatever its date.
 */
export function feeStanding(invoices: readonly FeeInvoice[], today: string) {
  let outstanding = 0n;
  let overdue = 0n;
  let overdueCount = 0;
  for (const invoice of invoices) {
    if (invoice.status === 'void') continue;
    const owed = BigInt(invoice.outstanding_paise);
    if (owed <= 0n) continue;
    outstanding += owed;
    if (invoice.due_on < today) { overdue += owed; overdueCount += 1; }
  }
  return {
    outstandingPaise: outstanding.toString(),
    overduePaise: overdue.toString(),
    overdueCount,
  };
}

export function invoiceIsOverdue(invoice: FeeInvoice, today: string): boolean {
  return invoice.status !== 'void' && BigInt(invoice.outstanding_paise) > 0n && invoice.due_on < today;
}

export interface GuardianLink {
  id: string; relationship: string; is_primary: boolean;
  can_view_academics: boolean; can_view_finance: boolean; can_pay: boolean;
  can_authorise_pickup: boolean; can_receive_notifications: boolean;
}

/**
 * What this guardian may do, in the office's words.
 *
 * Permissions are per link, not per child or per person: the same parent can
 * be allowed to collect one child and not another.
 */
export function guardianCan(link: GuardianLink): string[] {
  const out: string[] = [];
  if (link.can_authorise_pickup) out.push('Collect from school');
  if (link.can_view_academics) out.push('See results');
  if (link.can_view_finance) out.push('See fees');
  if (link.can_pay) out.push('Pay fees');
  if (link.can_receive_notifications) out.push('Gets messages');
  return out;
}

/** Guardians with the primary contact first, then by relationship. */
export function orderGuardians<T extends GuardianLink>(links: readonly T[]): T[] {
  return [...links].sort((a, b) =>
    Number(b.is_primary) - Number(a.is_primary) || a.relationship.localeCompare(b.relationship));
}
