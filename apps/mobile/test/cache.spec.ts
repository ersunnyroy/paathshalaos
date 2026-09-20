/**
 * Reads that survive no signal — and the lies they must not tell.
 *
 * The whole file is one argument: a parent shown a stale number without being
 * told it is stale has been told something false. Every test is a way that
 * could happen.
 */
import { describe, it, expect } from 'vitest';
import {
  CachedReader, asOfLabel, looksOffline, MAX_CACHE_AGE_DAYS,
  type CacheStorage,
} from '../src/lib/cache.ts';

class Memory implements CacheStorage {
  items = new Map<string, string>();
  failReads = false;
  failWrites = false;
  async getItem(key: string): Promise<string | null> {
    if (this.failReads) throw new Error('storage unavailable');
    return this.items.get(key) ?? null;
  }
  async setItem(key: string, value: string): Promise<void> {
    if (this.failWrites) throw new Error('quota exceeded');
    this.items.set(key, value);
  }
}

const offline = () => new TypeError('Network request failed');
const at = (iso: string) => () => new Date(iso);

describe('a live read', () => {
  it('returns the server’s answer and says it is live', async () => {
    const reader = new CachedReader(new Memory(), at('2026-09-20T09:00:00Z'));
    const got = await reader.read('fees', async () => ({ owed: '1000000' }));
    expect(got).toEqual({
      data: { owed: '1000000' }, asOf: '2026-09-20T09:00:00.000Z', live: true,
    });
  });

  it('holds it for later', async () => {
    const storage = new Memory();
    const reader = new CachedReader(storage, at('2026-09-20T09:00:00Z'));
    await reader.read('fees', async () => ({ owed: '1000000' }));
    expect(await reader.peek('fees'))
      .toEqual({ data: { owed: '1000000' }, asOf: '2026-09-20T09:00:00.000Z' });
  });

  it('still answers when the write fails', async () => {
    // Storage full. The answer is on screen and it is live; failing the read
    // because we could not also save it would be the worse trade.
    const storage = new Memory();
    storage.failWrites = true;
    const reader = new CachedReader(storage, at('2026-09-20T09:00:00Z'));
    expect((await reader.read('fees', async () => 1))?.live).toBe(true);
  });
});

describe('no signal', () => {
  it('serves the held answer and does NOT call it live', async () => {
    const storage = new Memory();
    let clock = new Date('2026-09-20T09:00:00Z');
    const reader = new CachedReader(storage, () => clock);
    await reader.read('fees', async () => ({ owed: '1000000' }));

    clock = new Date('2026-09-21T09:00:00Z');
    const got = await reader.read('fees', async () => { throw offline(); });

    // This is the load-bearing assertion in the file. `live: false` is what
    // makes the screen say "as of yesterday" instead of quietly showing a
    // balance the parent may already have paid.
    expect(got).toEqual({
      data: { owed: '1000000' }, asOf: '2026-09-20T09:00:00.000Z', live: false,
    });
  });

  it('returns nothing when it has never had an answer', async () => {
    const reader = new CachedReader(new Memory());
    expect(await reader.read('fees', async () => { throw offline(); })).toBeNull();
  });

  it('refuses an answer older than the bound', async () => {
    // A fee balance from March is not context, it is a wrong number with a
    // date next to it.
    const storage = new Memory();
    let clock = new Date('2026-09-20T09:00:00Z');
    const reader = new CachedReader(storage, () => clock);
    await reader.read('fees', async () => 1);

    clock = new Date(clock.getTime() + (MAX_CACHE_AGE_DAYS + 1) * 86_400_000);
    expect(await reader.read('fees', async () => { throw offline(); })).toBeNull();
  });

  it('keeps an answer that is inside the bound', async () => {
    const storage = new Memory();
    let clock = new Date('2026-09-20T09:00:00Z');
    const reader = new CachedReader(storage, () => clock);
    await reader.read('fees', async () => 1);

    clock = new Date(clock.getTime() + (MAX_CACHE_AGE_DAYS - 1) * 86_400_000);
    expect((await reader.read('fees', async () => { throw offline(); }))?.live)
      .toBe(false);
  });
});

describe('the server saying no', () => {
  it('does not paper over a refusal with the cache', async () => {
    // A parent whose access was withdrawn must not keep seeing their cached
    // copy of a child's marks because the server said 403 and this quietly
    // served the disk instead.
    const storage = new Memory();
    const reader = new CachedReader(storage, at('2026-09-20T09:00:00Z'));
    await reader.read('results', async () => ['a mark']);

    await expect(reader.read('results', async () => {
      throw Object.assign(new Error('Not found.'), { status: 404 });
    })).rejects.toThrow('Not found.');
  });

  it('does not paper over a server error either', async () => {
    const reader = new CachedReader(new Memory());
    await expect(reader.read('fees', async () => {
      throw Object.assign(new Error('Something went wrong.'), { status: 500 });
    })).rejects.toThrow();
  });
});

describe('telling the two apart', () => {
  it('knows the shapes a dead network arrives in', () => {
    for (const e of [new TypeError('Network request failed'),
                     new TypeError('Failed to fetch'),
                     new Error('Network Error'),
                     new Error('The request timed out.')]) {
      expect(looksOffline(e), e.message).toBe(true);
    }
  });

  it('treats anything with a status as an answer', () => {
    for (const status of [400, 403, 404, 429, 500, 503]) {
      expect(looksOffline(Object.assign(new Error('x'), { status }))).toBe(false);
    }
  });

  it('does not mistake a message mentioning the network for an outage', () => {
    // A server that answered, in words that happen to contain the word. The
    // status is what decides, and it is checked first.
    expect(looksOffline(Object.assign(
      new Error('Network request failed'), { status: 502 }))).toBe(false);
  });
});

describe('a corrupted or hostile cache', () => {
  it('treats unparseable content as a miss', async () => {
    const storage = new Memory();
    storage.items.set('paathshala.cache.fees', '{not json');
    expect(await new CachedReader(storage).peek('fees')).toBeNull();
  });

  it('treats a wrong shape as a miss', async () => {
    const storage = new Memory();
    storage.items.set('paathshala.cache.fees', '{"data":1}');
    expect(await new CachedReader(storage).peek('fees')).toBeNull();
  });

  it('treats an answer dated in the future as a miss', async () => {
    // A phone whose clock was wrong when the answer was saved, or moved after.
    // Serving it would print "as of in 3 days" next to a balance.
    const storage = new Memory();
    storage.items.set('paathshala.cache.fees',
      JSON.stringify({ data: 1, asOf: '2027-01-01T00:00:00Z' }));
    expect(await new CachedReader(storage, at('2026-09-20T09:00:00Z'))
      .peek('fees')).toBeNull();
  });

  it('treats a storage failure as a miss, not a crash', async () => {
    const storage = new Memory();
    storage.failReads = true;
    expect(await new CachedReader(storage).peek('fees')).toBeNull();
  });

  it('keeps one screen’s answer out of another’s', async () => {
    const storage = new Memory();
    const reader = new CachedReader(storage);
    await reader.read('fees:child-1', async () => 'aarav');
    await reader.read('fees:child-2', async () => 'diya');
    expect((await reader.peek('fees:child-1'))?.data).toBe('aarav');
    expect((await reader.peek('fees:child-2'))?.data).toBe('diya');
  });
});

describe('the stamp on the screen', () => {
  const now = new Date('2026-09-20T12:00:00Z');
  it('reads as a person would say it', () => {
    expect(asOfLabel('2026-09-20T11:59:30Z', now)).toBe('just now');
    expect(asOfLabel('2026-09-20T11:30:00Z', now)).toBe('30 minutes ago');
    expect(asOfLabel('2026-09-20T09:00:00Z', now)).toBe('3 hours ago');
    expect(asOfLabel('2026-09-20T11:00:00Z', now)).toBe('1 hour ago');
    expect(asOfLabel('2026-09-18T12:00:00Z', now)).toBe('2 days ago');
    expect(asOfLabel('2026-09-19T12:00:00Z', now)).toBe('1 day ago');
  });

  it('does not say a time in the future', () => {
    expect(asOfLabel('2026-09-20T13:00:00Z', now)).toBe('just now');
  });
});
