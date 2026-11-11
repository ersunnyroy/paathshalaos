import { describe, it, expect } from 'vitest';
import {
  columnOf, daysWaiting, offerDaysLeft, offerLapsed, flagFor, buildBoard, COLUMNS, type PipelineRow,
} from '../src/lib/admissions.ts';

const NOW = Date.parse('2026-11-10T06:00:00Z');
const ago = (days: number) => new Date(NOW - days * 86_400_000).toISOString();
const ahead = (days: number) => new Date(NOW + days * 86_400_000).toISOString();
const row = (over: Partial<PipelineRow> = {}): PipelineRow => ({
  kind: 'application', id: Math.random().toString(36).slice(2), name: 'Asha Rao',
  programme_name: 'CBSE', outcome: null, offer_expires_at: null,
  accepted_at: null, declined_at: null, enrolled: false, created_at: ago(1), ...over,
});

describe('which column a family is in', () => {
  it('follows the pipeline', () => {
    expect(columnOf(row({ kind: 'enquiry' }))).toBe('enquiry');
    expect(columnOf(row())).toBe('undecided');
    expect(columnOf(row({ outcome: 'offered' }))).toBe('offered');
    expect(columnOf(row({ outcome: 'waitlisted' }))).toBe('waitlisted');
    expect(columnOf(row({ outcome: 'offered', accepted_at: ago(1) }))).toBe('accepted');
    expect(columnOf(row({ outcome: 'offered', accepted_at: ago(1), enrolled: true }))).toBe('enrolled');
  });

  it('closes a family that declined or was not offered a place', () => {
    expect(columnOf(row({ outcome: 'offered', declined_at: ago(1) }))).toBe('closed');
    expect(columnOf(row({ outcome: 'rejected' }))).toBe('closed');
  });

  it('lets the latest thing that happened win', () => {
    // Offered, and the family has since said no: not "offer out".
    expect(columnOf(row({ outcome: 'offered', declined_at: ago(0) }))).toBe('closed');
    // On the roll beats everything, including a stale decline flag.
    expect(columnOf(row({ enrolled: true, declined_at: ago(3) }))).toBe('enrolled');
  });

  it('puts every family in a column that exists', () => {
    const ids = COLUMNS.map((c) => c.id);
    for (const r of [row(), row({ kind: 'enquiry' }), row({ outcome: 'something new' })]) {
      expect(ids).toContain(columnOf(r));
    }
  });
});

describe('how long a family has waited', () => {
  it('counts whole days', () => {
    expect(daysWaiting(ago(0), NOW)).toBe(0);
    expect(daysWaiting(new Date(NOW - 23 * 3_600_000).toISOString(), NOW)).toBe(0);
    expect(daysWaiting(ago(1), NOW)).toBe(1);
    expect(daysWaiting(ago(30), NOW)).toBe(30);
  });
  it('is never negative and never NaN', () => {
    expect(daysWaiting(ahead(2), NOW)).toBe(0);
    expect(daysWaiting('not a date', NOW)).toBe(0);
  });
});

describe('an offer running out', () => {
  it('counts down and goes negative once it has lapsed', () => {
    expect(offerDaysLeft(ahead(14), NOW)).toBe(14);
    expect(offerDaysLeft(new Date(NOW + 3_600_000).toISOString(), NOW)).toBe(1);   // an hour left is still today's
    expect(offerDaysLeft(new Date(NOW - 3_600_000).toISOString(), NOW)).toBe(0);
    expect(offerDaysLeft(ago(2), NOW)).toBe(-2);
    expect(offerDaysLeft(null, NOW)).toBeNull();
  });

  it('has lapsed the moment the deadline passes, whatever the day count rounds to', () => {
    const anHourAgo = new Date(NOW - 3_600_000).toISOString();
    expect(offerDaysLeft(anHourAgo, NOW)).toBe(0);          // rounds to "today"…
    expect(offerLapsed(anHourAgo, NOW)).toBe(true);          // …and has lapsed
    expect(offerLapsed(new Date(NOW + 3_600_000).toISOString(), NOW)).toBe(false);
    expect(offerLapsed(null, NOW)).toBe(false);
    expect(flagFor(row({ outcome: 'offered', offer_expires_at: anHourAgo }), 'offered', NOW))
      .toEqual({ text: 'Offer lapsed', tone: 'critical' });
    expect(flagFor(row({ outcome: 'offered', offer_expires_at: new Date(NOW + 3_600_000).toISOString() }), 'offered', NOW))
      .toEqual({ text: '1d to reply', tone: 'warning' });
  });
});

describe('when a card is flagged', () => {
  it('flags an enquiry nobody has followed up in a week, harder after two', () => {
    expect(flagFor(row({ kind: 'enquiry', created_at: ago(6) }), 'enquiry', NOW)).toBeNull();
    expect(flagFor(row({ kind: 'enquiry', created_at: ago(7) }), 'enquiry', NOW))
      .toEqual({ text: '7d, no form', tone: 'warning' });
    expect(flagFor(row({ kind: 'enquiry', created_at: ago(14) }), 'enquiry', NOW)?.tone).toBe('critical');
  });

  it('flags an application left undecided', () => {
    expect(flagFor(row({ created_at: ago(9) }), 'undecided', NOW)).toEqual({ text: '9d undecided', tone: 'warning' });
  });

  it('warns three days before an offer lapses and alarms once it has', () => {
    const offered = (expires: string | null) => row({ outcome: 'offered', offer_expires_at: expires });
    expect(flagFor(offered(ahead(4)), 'offered', NOW)).toBeNull();
    expect(flagFor(offered(ahead(3)), 'offered', NOW)).toEqual({ text: '3d to reply', tone: 'warning' });
    expect(flagFor(offered(ago(1)), 'offered', NOW)).toEqual({ text: 'Offer lapsed', tone: 'critical' });
    expect(flagFor(offered(null), 'offered', NOW)).toBeNull();
  });

  it('does not flag an offer for its age, only for its deadline', () => {
    expect(flagFor(row({ outcome: 'offered', offer_expires_at: ahead(10), created_at: ago(40) }), 'offered', NOW))
      .toBeNull();
  });

  it('never flags somebody on the roll or closed, however long ago', () => {
    expect(flagFor(row({ enrolled: true, created_at: ago(200) }), 'enrolled', NOW)).toBeNull();
    expect(flagFor(row({ declined_at: ago(100), created_at: ago(200) }), 'closed', NOW)).toBeNull();
  });
});

describe('the board', () => {
  it('has every column, in pipeline order, even when empty', () => {
    const board = buildBoard([], NOW);
    expect(board.columns.map((c) => c.id)).toEqual(COLUMNS.map((c) => c.id));
    expect(board.columns.every((c) => c.cards.length === 0)).toBe(true);
  });

  it('puts each family in exactly one column', () => {
    const rows = [
      row({ kind: 'enquiry' }), row(), row({ outcome: 'offered' }),
      row({ outcome: 'waitlisted' }), row({ accepted_at: ago(1), outcome: 'offered' }),
      row({ enrolled: true }), row({ declined_at: ago(1) }),
    ];
    const board = buildBoard(rows, NOW);
    expect(board.columns.map((c) => c.cards.length)).toEqual([1, 1, 1, 1, 1, 1, 1]);
    expect(board.columns.reduce((n, c) => n + c.cards.length, 0)).toBe(rows.length);
  });

  it('puts the longest-waiting family at the top of a working column', () => {
    const board = buildBoard([
      row({ name: 'New', created_at: ago(1) }),
      row({ name: 'Old', created_at: ago(12) }),
      row({ name: 'Middle', created_at: ago(5) }),
    ], NOW);
    expect(board.columns.find((c) => c.id === 'undecided')!.cards.map((c) => c.row.name))
      .toEqual(['Old', 'Middle', 'New']);
  });

  it('puts the newest at the top of "on the roll"', () => {
    const board = buildBoard([
      row({ name: 'Long ago', enrolled: true, created_at: ago(90) }),
      row({ name: 'This week', enrolled: true, created_at: ago(2) }),
    ], NOW);
    expect(board.columns.find((c) => c.id === 'enrolled')!.cards.map((c) => c.row.name))
      .toEqual(['This week', 'Long ago']);
  });
});
