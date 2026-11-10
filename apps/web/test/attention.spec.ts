import { describe, it, expect } from 'vitest';
import { attentionItems, attentionBadge, type TodayCounts } from '../src/lib/attention.ts';

const counts = (over: Partial<TodayCounts> = {}): TodayCounts => ({
  unmarked_sessions: 0, pending_corrections: 0, unreviewed_results: 0,
  failed_messages: 0, imports_awaiting_apply: 0, ...over,
});

describe('what is waiting on somebody', () => {
  it('is nothing when every count is zero, or before the counts arrive', () => {
    expect(attentionItems(counts(), null)).toEqual([]);
    expect(attentionItems(null, null)).toEqual([]);
    expect(attentionItems(undefined, null)).toEqual([]);
  });

  it('says how many and where to go', () => {
    expect(attentionItems(counts({ unmarked_sessions: 2 }), null)).toEqual([
      { key: 'unmarked_sessions', count: 2, href: '/attendance', label: '2 registers still open today' },
    ]);
  });

  it('uses the singular for one', () => {
    expect(attentionItems(counts({ failed_messages: 1 }), null)[0]!.label).toBe('1 message failed to send');
  });

  it('puts the most numerous first, and keeps a fixed order between ties', () => {
    const items = attentionItems(counts({
      unmarked_sessions: 1, pending_corrections: 4, unreviewed_results: 1, imports_awaiting_apply: 4,
    }), null);
    expect(items.map((i) => i.key)).toEqual([
      'pending_corrections', 'imports_awaiting_apply', 'unmarked_sessions', 'unreviewed_results',
    ]);
  });

  it('leaves out what this person has no screen for', () => {
    const teacher = new Set(['/today', '/attendance', '/results']);
    const items = attentionItems(counts({
      unmarked_sessions: 2, failed_messages: 5, imports_awaiting_apply: 1,
    }), teacher);
    expect(items.map((i) => i.key)).toEqual(['unmarked_sessions']);
  });

  it('shows everything to somebody who is shown every screen', () => {
    expect(attentionItems(counts({ unmarked_sessions: 2, failed_messages: 5 }), null)).toHaveLength(2);
  });

  it('ignores a count that is missing or is not a count', () => {
    const odd = { ...counts(), unmarked_sessions: -1, failed_messages: 2.5,
      unreviewed_results: Number.NaN, pending_corrections: '3' as unknown as number };
    delete (odd as Partial<TodayCounts>).imports_awaiting_apply;
    expect(attentionItems(odd, null)).toEqual([]);
  });
});

describe('the number on the bell', () => {
  it('is absent when nothing is waiting', () => {
    expect(attentionBadge([])).toBeNull();
  });
  it('counts things, not kinds of thing', () => {
    const items = attentionItems(counts({ unmarked_sessions: 2, failed_messages: 5 }), null);
    expect(attentionBadge(items)).toBe('7');
  });
  it('stops at 99+', () => {
    expect(attentionBadge(attentionItems(counts({ failed_messages: 99 }), null))).toBe('99');
    expect(attentionBadge(attentionItems(counts({ failed_messages: 100 }), null))).toBe('99+');
  });
});
