/**
 * What is waiting on a person (M40: the bell in the top bar).
 *
 * The same five counts the dashboard lists under "Needs attention", turned
 * into something that follows a member of staff to every screen. Each count is
 * already limited by row-level security to what this person may see — a
 * teacher's "registers still open" is their own classes.
 *
 * An item is offered only if the screen that deals with it is one this person
 * is shown. A count they can do nothing about is not a notification; it is a
 * number that never goes away, and it teaches people to ignore the bell.
 */

export interface TodayCounts {
  unmarked_sessions: number; pending_corrections: number;
  unreviewed_results: number; failed_messages: number;
  imports_awaiting_apply?: number;
}

export interface AttentionItem { key: string; label: string; count: number; href: string }

const SOURCES: Array<{
  key: keyof TodayCounts; href: string; one: string; many: string;
}> = [
  { key: 'unmarked_sessions', href: '/attendance', one: 'register still open today', many: 'registers still open today' },
  { key: 'pending_corrections', href: '/attendance', one: 'attendance correction to approve', many: 'attendance corrections to approve' },
  { key: 'unreviewed_results', href: '/results', one: 'result run to review', many: 'result runs to review' },
  { key: 'failed_messages', href: '/messages', one: 'message failed to send', many: 'messages failed to send' },
  { key: 'imports_awaiting_apply', href: '/imports', one: 'import previewed and not applied', many: 'imports previewed and not applied' },
];

/**
 * The items to show, most numerous first.
 *
 * `allowed` is the set of screens this person is shown, or null for all of
 * them. A count that is missing, zero, negative or not a whole number is left
 * out rather than shown as "NaN things waiting".
 */
export function attentionItems(counts: TodayCounts | null | undefined, allowed: ReadonlySet<string> | null): AttentionItem[] {
  if (!counts) return [];
  return SOURCES
    .map((source, order) => ({ source, order, count: counts[source.key] }))
    .filter((entry): entry is typeof entry & { count: number } =>
      typeof entry.count === 'number' && Number.isInteger(entry.count) && entry.count > 0
      && (allowed === null || allowed.has(entry.source.href)))
    .sort((a, b) => b.count - a.count || a.order - b.order)
    .map(({ source, count }) => ({
      key: source.key, count, href: source.href,
      label: `${count} ${count === 1 ? source.one : source.many}`,
    }));
}

/** The number on the bell: how many things, not how many kinds. Capped for display. */
export function attentionBadge(items: readonly AttentionItem[]): string | null {
  const total = items.reduce((n, item) => n + item.count, 0);
  if (total <= 0) return null;
  return total > 99 ? '99+' : String(total);
}
