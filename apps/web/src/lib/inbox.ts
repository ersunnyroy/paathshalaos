/**
 * A person's own messages from the school, as the bell shows them (M43.1).
 */

export interface InboxItem {
  id: string; channel: string | null; body: string | null;
  about: string | null; sent_at: string; read_at: string | null;
}
export interface Inbox {
  items: InboxItem[]; unread: number;
  next: { beforeAt: string; beforeId: string } | null;
}

/**
 * One number on the bell: the office's waiting work plus unread messages.
 * Silent at zero, capped where a bigger number stops meaning anything.
 */
export function bellBadge(waiting: number, unread: number): string | null {
  const total = Math.max(0, Math.trunc(waiting) || 0) + Math.max(0, Math.trunc(unread) || 0);
  if (total <= 0) return null;
  return total > 99 ? '99+' : String(total);
}

/** What the bell says to a screen reader. */
export function bellLabel(waiting: number, unread: number): string {
  const parts = [
    unread > 0 ? `${unread} unread ${unread === 1 ? 'message' : 'messages'}` : '',
    waiting > 0 ? `${waiting} ${waiting === 1 ? 'thing needs' : 'things need'} attention` : '',
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : 'Nothing new';
}

/** A message cut to fit one row of the bell, on a word where there is one. */
export function preview(body: string | null, max = 90): string {
  const text = (body ?? '').replace(/\s+/g, ' ').trim();
  if (text === '') return 'A message with no text';
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * How long ago, in the words somebody would use. Past a week it is the date:
 * "23 days ago" makes the reader do the sum.
 */
export function ago(sentAt: string, now: number): string {
  const then = Date.parse(sentAt);
  if (Number.isNaN(then)) return '';
  const gone = now - then;
  if (gone < MINUTE) return 'Just now'; // also a clock a little ahead of ours
  if (gone < HOUR) return `${Math.floor(gone / MINUTE)} min ago`;
  if (gone < DAY) {
    const hours = Math.floor(gone / HOUR);
    return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
  }
  const days = Math.floor(gone / DAY);
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  return new Date(then).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

/** The same list with some messages shown as read, before the server confirms. */
export function withRead(inbox: Inbox, ids: readonly string[] | 'all', at: string): Inbox {
  let cleared = 0;
  const items = inbox.items.map((item) => {
    if (item.read_at !== null || (ids !== 'all' && !ids.includes(item.id))) return item;
    cleared += 1;
    return { ...item, read_at: at };
  });
  return {
    ...inbox, items,
    // "All" clears messages on pages not loaded too; the server's count is zero.
    unread: ids === 'all' ? 0 : Math.max(0, inbox.unread - cleared),
  };
}
