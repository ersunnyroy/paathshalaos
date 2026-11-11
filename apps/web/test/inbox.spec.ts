import { describe, expect, it } from 'vitest';
import { ago, bellBadge, bellLabel, preview, withRead, type Inbox, type InboxItem } from '../src/lib/inbox';

const item = (id: string, read: string | null = null): InboxItem =>
  ({ id, channel: 'in_app', body: id, about: null, sent_at: '2026-11-10T08:00:00Z', read_at: read });

describe('the number on the bell', () => {
  it('adds waiting work and unread messages, and is silent at nothing', () => {
    expect(bellBadge(0, 0)).toBeNull();
    expect(bellBadge(2, 0)).toBe('2');
    expect(bellBadge(0, 3)).toBe('3');
    expect(bellBadge(2, 3)).toBe('5');
  });
  it('caps at 99+ and not before', () => {
    expect(bellBadge(90, 9)).toBe('99');
    expect(bellBadge(90, 10)).toBe('99+');
  });
  it('ignores a count that is not a count', () => {
    expect(bellBadge(-4, 2)).toBe('2');
    expect(bellBadge(Number.NaN, 2)).toBe('2');
    expect(bellBadge(2, Number.NaN)).toBe('2');
    expect(bellBadge(1.9, 0)).toBe('1');
    expect(bellBadge(-1, -1)).toBeNull();
  });
  it('says it in words', () => {
    expect(bellLabel(0, 0)).toBe('Nothing new');
    expect(bellLabel(0, 1)).toBe('1 unread message');
    expect(bellLabel(1, 0)).toBe('1 thing needs attention');
    expect(bellLabel(3, 2)).toBe('2 unread messages, 3 things need attention');
  });
});

describe('a message in one row', () => {
  it('leaves a short message alone and tidies its spaces', () => {
    expect(preview('  School  closed\ntomorrow ')).toBe('School closed tomorrow');
    expect(preview('x'.repeat(90))).toBe('x'.repeat(90));
  });
  it('cuts a long one on a word', () => {
    expect(preview('The annual sports day is on Friday and children should come in house colours', 40))
      .toBe('The annual sports day is on Friday and…');
  });
  it('cuts mid-word when the last space is too far back', () => {
    expect(preview(`ab ${'x'.repeat(60)}`, 20)).toBe(`ab ${'x'.repeat(17)}…`);
    expect(preview('x'.repeat(91))).toBe(`${'x'.repeat(90)}…`);
  });
  it('says so when there is nothing to show', () => {
    expect(preview(null)).toBe('A message with no text');
    expect(preview('   ')).toBe('A message with no text');
  });
});

describe('how long ago', () => {
  const at = '2026-11-10T08:00:00Z';
  const now = Date.parse(at);
  const after = (ms: number) => ago(at, now + ms);
  it('uses the nearest plain unit', () => {
    expect(after(0)).toBe('Just now');
    expect(after(59_999)).toBe('Just now');
    expect(after(60_000)).toBe('1 min ago');
    expect(after(59 * 60_000 + 59_000)).toBe('59 min ago');
    expect(after(60 * 60_000)).toBe('1 hour ago');
    expect(after(2 * 3_600_000)).toBe('2 hours ago');
    expect(after(23 * 3_600_000 + 59 * 60_000)).toBe('23 hours ago');
    expect(after(24 * 3_600_000)).toBe('Yesterday');
    expect(after(48 * 3_600_000)).toBe('2 days ago');
    expect(after(7 * 86_400_000 - 1)).toBe('6 days ago');
  });
  it('gives the date once it is a week old', () => {
    expect(after(7 * 86_400_000)).toMatch(/10 Nov 2026/);
  });
  it('copes with a clock ahead of ours and a date that is not one', () => {
    expect(after(-5_000)).toBe('Just now');
    expect(ago('nonsense', now)).toBe('');
  });
});

describe('showing a message as read straight away', () => {
  const inbox: Inbox = { items: [item('a'), item('b', '2026-11-09T00:00:00Z'), item('c')], unread: 5, next: null };
  it('marks the named ones and takes them off the count', () => {
    const out = withRead(inbox, ['a'], 'NOW');
    expect(out.items.map((i) => i.read_at)).toEqual(['NOW', '2026-11-09T00:00:00Z', null]);
    expect(out.unread).toBe(4);
    expect(inbox.items[0]!.read_at).toBeNull();
  });
  it('does not count one that was already read, or go below zero', () => {
    expect(withRead(inbox, ['b'], 'NOW').unread).toBe(5);
    expect(withRead(inbox, ['b'], 'NOW').items[1]!.read_at).toBe('2026-11-09T00:00:00Z');
    expect(withRead({ ...inbox, unread: 1 }, ['a', 'c'], 'NOW').unread).toBe(0);
  });
  it('all of them clears the count, including pages not loaded', () => {
    const out = withRead(inbox, 'all', 'NOW');
    expect(out.unread).toBe(0);
    expect(out.items.map((i) => i.read_at)).toEqual(['NOW', '2026-11-09T00:00:00Z', 'NOW']);
  });
});
