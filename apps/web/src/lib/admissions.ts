/**
 * The admissions pipeline as a board (M48).
 *
 * The list answers "what happens next for this family". The board answers the
 * question an admissions head actually opens the screen with: where is
 * everybody, and who has been sitting in one place too long.
 *
 * Every family is in exactly one column. The order of the checks below is the
 * rule: what has happened most recently wins, so a family that accepted an
 * offer is "accepted" whatever else is true of them.
 */

export interface PipelineRow {
  kind: 'enquiry' | 'application';
  id: string; name: string;
  programme_name: string | null;
  outcome: string | null;
  offer_expires_at: string | null;
  accepted_at: string | null; declined_at: string | null;
  enrolled: boolean; created_at: string;
}

export type ColumnId = 'enquiry' | 'undecided' | 'offered' | 'waitlisted' | 'accepted' | 'enrolled' | 'closed';

export const COLUMNS: Array<{ id: ColumnId; title: string; hint: string }> = [
  { id: 'enquiry', title: 'Enquiry', hint: 'No form yet' },
  { id: 'undecided', title: 'To decide', hint: 'Waiting on us' },
  { id: 'offered', title: 'Offer out', hint: 'Waiting on the family' },
  { id: 'waitlisted', title: 'Waitlist', hint: 'No place yet' },
  { id: 'accepted', title: 'Accepted', hint: 'Not yet on the roll' },
  { id: 'enrolled', title: 'On the roll', hint: 'Admitted through here' },
  { id: 'closed', title: 'Closed', hint: 'Declined or not offered' },
];

export function columnOf(row: PipelineRow): ColumnId {
  if (row.enrolled) return 'enrolled';
  if (row.declined_at) return 'closed';
  if (row.accepted_at) return 'accepted';
  if (row.outcome === 'offered') return 'offered';
  if (row.outcome === 'waitlisted') return 'waitlisted';
  if (row.outcome === 'rejected') return 'closed';
  return row.kind === 'enquiry' ? 'enquiry' : 'undecided';
}

/** Whole days since this family first appeared. Never negative: a clock that is a little off is not time travel. */
export function daysWaiting(createdAt: string, now: number): number {
  const then = Date.parse(createdAt);
  if (Number.isNaN(then)) return 0;
  return Math.max(0, Math.floor((now - then) / 86_400_000));
}

/** Whether an offer's deadline has passed. Asked of the instant, not of a rounded day count. */
export function offerLapsed(expiresAt: string | null, now: number): boolean {
  if (!expiresAt) return false;
  const at = Date.parse(expiresAt);
  return !Number.isNaN(at) && at <= now;
}

/**
 * Whole days until an offer lapses, rounded up; negative once it has. Null
 * when the offer has no expiry.
 *
 * Not to be used to decide WHETHER it has lapsed: an offer that ran out an
 * hour ago is a fraction of a day past, which rounds up to zero — "lapses
 * today" for something that already has. `offerLapsed` answers that.
 */
export function offerDaysLeft(expiresAt: string | null, now: number): number | null {
  if (!expiresAt) return null;
  const at = Date.parse(expiresAt);
  if (Number.isNaN(at)) return null;
  const days = Math.ceil((at - now) / 86_400_000);
  return days === 0 ? 0 : days;   // Math.ceil(-0.04) is -0, which prints as "0" and is not < 0
}

export interface Card {
  row: PipelineRow;
  days: number;
  /** Shown on the card when somebody should act: stale, expiring or lapsed. */
  flag: { text: string; tone: 'warning' | 'critical' } | null;
}

/**
 * When a card is flagged.
 *
 * Only columns where the delay is somebody's to fix. A family on the roll for
 * 200 days is not late; an enquiry nobody has rung back in a week is.
 */
export function flagFor(row: PipelineRow, column: ColumnId, now: number): Card['flag'] {
  const days = daysWaiting(row.created_at, now);
  if (column === 'offered') {
    if (offerLapsed(row.offer_expires_at, now)) return { text: 'Offer lapsed', tone: 'critical' };
    const left = offerDaysLeft(row.offer_expires_at, now);
    if (left !== null && left <= 3) return { text: left === 0 ? 'Lapses today' : `${left}d to reply`, tone: 'warning' };
    return null;
  }
  if (column === 'enquiry' && days >= 7) return { text: `${days}d, no form`, tone: days >= 14 ? 'critical' : 'warning' };
  if (column === 'undecided' && days >= 7) return { text: `${days}d undecided`, tone: days >= 14 ? 'critical' : 'warning' };
  if (column === 'accepted' && days >= 7) return { text: 'Accepted, not enrolled', tone: 'warning' };
  return null;
}

export interface Board { columns: Array<{ id: ColumnId; title: string; hint: string; cards: Card[] }> }

/**
 * Everybody, in their column, longest-waiting first.
 *
 * Oldest first because the top of a column is what gets looked at, and the
 * family that has waited longest is the one being forgotten. On the roll and
 * closed are newest first instead: there the recent ones are the news.
 */
export function buildBoard(rows: readonly PipelineRow[], now: number): Board {
  const byColumn = new Map<ColumnId, Card[]>(COLUMNS.map((c) => [c.id, []]));
  for (const row of rows) {
    const column = columnOf(row);
    byColumn.get(column)!.push({ row, days: daysWaiting(row.created_at, now), flag: flagFor(row, column, now) });
  }
  return {
    columns: COLUMNS.map((c) => {
      const cards = byColumn.get(c.id)!;
      const newestFirst = c.id === 'enrolled' || c.id === 'closed';
      cards.sort((a, b) => (newestFirst ? a.days - b.days : b.days - a.days)
        || a.row.name.localeCompare(b.row.name));
      return { ...c, cards };
    }),
  };
}
