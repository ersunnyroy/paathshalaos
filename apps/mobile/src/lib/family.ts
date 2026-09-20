/**
 * The parent app's logic, lifted out of the screens so it can be tested.
 *
 * Money and dates, mostly — which is to say, the two things this app can be
 * wrong about in a way a parent would notice and be right to be angry about.
 */

export interface Child {
  id: string;
  admission_no: string;
  given_name: string;
  family_name: string | null;
  section_name: string | null;
  class_name: string | null;
  can_view_academics: boolean;
  can_view_finance: boolean;
}

export type Tab = 'attendance' | 'fees' | 'work' | 'results' | 'bus';

/**
 * Which tabs this parent gets.
 *
 * Driven by the permissions the school set, so a parent who may not see the
 * fees does not get a tab that opens onto an empty list — which reads as "you
 * owe nothing" and is a different, worse lie than "this is not yours to see".
 * The database refuses the rows either way; this is about not asking.
 */
export function tabsFor(child: Child): Tab[] {
  const tabs: Tab[] = ['attendance'];
  if (child.can_view_finance) tabs.push('fees');
  // Homework sits under the same permission as results, and before it: a
  // parent opens this app on a weekday evening to find out what is due, and
  // once a term to look at a report card.
  if (child.can_view_academics) tabs.push('work', 'results');
  tabs.push('bus');
  return tabs;
}

/**
 * Paise to rupees, in Indian digit grouping.
 *
 * ₹1,00,000 — not ₹100,000. A lakh is grouped in twos after the first three
 * digits, and a product that calls itself India-first and prints Western
 * grouping on a fee receipt is telling on itself.
 *
 * Takes a string and never becomes a number on the way through — but not for
 * the reason the first version of this comment gave.
 *
 * It said `12500.10` as a JSON double is 12500.099999999999, which is true of
 * a NUMBER arriving in JSON and has nothing to do with this function, whose
 * input is already exact integer paise. Routing those through
 * `Number(paise) / 100` and `toFixed(2)` gives the same answer as the string
 * path for every value below 2^53 paise; the two first disagree at
 * 9007199254740993 paise, which is about ₹90 trillion. Breaking the string
 * handling deliberately failed no test, which is how the comment got read
 * again — it was borrowing a real hazard from somewhere else to justify itself.
 *
 * What IS true: the string path has no rounding step, so it is exact at every
 * magnitude, and the float path is exact until it silently is not. "A school
 * will never bill that much" is a fact about today's customers rather than
 * about this code, and the exact version costs nothing. The boundary is in the
 * tests so the claim that remains is one somebody can check.
 */
export function rupees(paise: string): string {
  const negative = paise.startsWith('-');
  const digits = (negative ? paise.slice(1) : paise).replace(/\D/g, '') || '0';
  const padded = digits.padStart(3, '0');
  const whole = padded.slice(0, -2);
  const fraction = padded.slice(-2);

  // Last three, then twos. The reduce would be shorter and this is the version
  // somebody can check against a fee receipt.
  let grouped: string;
  if (whole.length <= 3) {
    grouped = whole;
  } else {
    const last3 = whole.slice(-3);
    const rest = whole.slice(0, -3);
    const pairs: string[] = [];
    for (let i = rest.length; i > 0; i -= 2) {
      pairs.unshift(rest.slice(Math.max(0, i - 2), i));
    }
    grouped = `${pairs.join(',')},${last3}`;
  }
  return `${negative ? '-' : ''}₹${grouped}.${fraction}`;
}

export interface AttendanceSummary {
  days: Array<{ on_date: string; state: string }>;
  present: number; absent: number; late: number; recorded: number;
}

/**
 * The one number a parent looks for, and the honest way to say nothing.
 *
 * `null` when no day has been recorded, not 0 and not 100. A child whose
 * school has not marked a register yet has neither perfect attendance nor
 * none, and a screen that picks either is inventing a fact.
 */
export function attendanceRate(summary: AttendanceSummary): number | null {
  if (summary.recorded === 0) return null;
  // Late counts as present. A child who was in school was in school, and a
  // rate that punishes a bus running late is a rate parents learn to ignore.
  return Math.round(((summary.present + summary.late) / summary.recorded) * 100);
}

export interface Fees {
  outstanding_paise: string;
  next_due_on: string | null;
  invoices: Array<{
    id: string; invoice_no: string; status: string; due_on: string;
    total_paise: string; paid_paise: string; outstanding_paise: string;
  }>;
}

export type FeeState =
  | { kind: 'clear' }
  | { kind: 'due'; days: number }
  | { kind: 'overdue'; days: number };

/**
 * Where the fees stand, as a state rather than a colour.
 *
 * Overdue is stated plainly and without decoration. A school chasing a family
 * for money through a red banner on a phone is the school's choice to make in
 * words it writes, not something this app should dramatise on its behalf.
 */
export function feeState(fees: Fees, today: Date = new Date()): FeeState {
  if (BigInt(fees.outstanding_paise || '0') === 0n || !fees.next_due_on) {
    return { kind: 'clear' };
  }
  const due = Date.parse(`${fees.next_due_on}T00:00:00Z`);
  const now = Date.parse(`${today.toISOString().slice(0, 10)}T00:00:00Z`);
  const days = Math.round((due - now) / 86_400_000);
  return days < 0 ? { kind: 'overdue', days: -days } : { kind: 'due', days };
}

/** A name a parent would recognise, not a database row. */
export function childName(child: Child): string {
  return `${child.given_name}${child.family_name ? ` ${child.family_name}` : ''}`;
}

/** "Class IX A", or the part of it that exists. */
export function childClass(child: Child): string | null {
  const parts = [child.class_name, child.section_name].filter(Boolean);
  return parts.length > 0 ? parts.join(' ') : null;
}

export const ATTENDANCE_LABEL: Record<string, string> = {
  present: 'Present',
  absent: 'Absent',
  late: 'Late',
  excused: 'Excused',
};
