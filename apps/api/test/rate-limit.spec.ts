/**
 * M30.2 — the rate limiter, off this process's memory.
 *
 * The counter used to live in a `Map` in the API process, and the file said so:
 * "two API instances behind a load balancer allow twice the configured rate...
 * the counter belongs in Redis when there is more than one instance". Redis had
 * been in the compose file and the environment schema since M0 with nothing
 * ever connecting to it, so "when" had no date on it.
 *
 * Three things have to be true for the move to be worth making, and each is
 * asserted below rather than assumed:
 *
 *   - the count is really in Redis, not in a local map that happens to agree;
 *   - the key expires, because a counter that never resets locks an integration
 *     out permanently and is invisible unless somebody goes looking in Redis;
 *   - a Redis outage degrades the limit rather than the API.
 */
// Loaded for its side effect: it reads the .env this suite's Redis url lives
// in, before anything below asks for one.
import './fixtures.ts';
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import {
  consume, consumeLocally, resetRateLimits, rateLimitKey,
} from '../src/modules/public-api/rate-limit.ts';
import { closeRedis } from '../src/db/redis.ts';
import { rateLimiterFallbacks } from '../src/common/telemetry/metrics.ts';
import { loadEnv } from '../src/config/env.ts';

/** A second client, so the assertions read Redis rather than the code's view of it. */
const inspector = new Redis(loadEnv().REDIS_URL, { lazyConnect: true });

const windowEnd = (now: number) => (Math.floor(Math.floor(now / 1000) / 60) + 1) * 60;
const keyFor = (k: string, now: number) => `paathshala:rl:${k}:${windowEnd(now)}`;

async function fallbackCount(): Promise<number> {
  const metric = await rateLimiterFallbacks.get();
  return metric.values[0]?.value ?? 0;
}

beforeEach(async () => { await resetRateLimits(); });

afterAll(async () => {
  await resetRateLimits();
  await closeRedis();
  inspector.disconnect();
});

describe('the count is shared, not local', () => {
  it('leaves the tally in Redis where another instance can see it', async () => {
    // The assertion that distinguishes this milestone from a refactor. A local
    // map would satisfy every behavioural test below and none of this one.
    const key = `k-${randomUUID()}`;
    const now = Date.now();
    await consume(key, 10, now);
    await consume(key, 10, now);
    await consume(key, 10, now);

    expect(await inspector.get(keyFor(key, now))).toBe('3');
    // ...and nothing fell back to memory while doing it. Without this the test
    // above passes against a limiter that never reached Redis at all — which
    // is precisely what happened on the first run.
    expect(await fallbackCount()).toBe(0);
  });

  it('gives the key an expiry, in the same step that creates it', async () => {
    // INCR and EXPIRE as two round trips leaves a window where the process dies
    // between them and the key never expires — a counter stuck at its limit,
    // which locks an integration out until somebody goes looking in Redis.
    const key = `k-${randomUUID()}`;
    const now = Date.now();
    await consume(key, 10, now);

    const ttl = await inspector.ttl(keyFor(key, now));
    expect(ttl).toBeGreaterThan(0);
    // The window is a minute; the key outlives it by a small margin and no more.
    expect(ttl).toBeLessThanOrEqual(65);
  });

  it('refuses past the limit and says when the window ends', async () => {
    const key = `k-${randomUUID()}`;
    const now = Date.now();
    for (let i = 0; i < 3; i += 1) {
      expect((await consume(key, 3, now)).allowed).toBe(true);
    }
    const refused = await consume(key, 3, now);
    expect(refused.allowed).toBe(false);
    expect(refused.remaining).toBe(0);
    expect(refused.resetAt).toBe(windowEnd(now));
  });

  it('starts again in the next window', async () => {
    const key = `k-${randomUUID()}`;
    const now = Date.now();
    for (let i = 0; i < 4; i += 1) await consume(key, 3, now);
    expect((await consume(key, 3, now)).allowed).toBe(false);
    // ...and a minute later it is a different key entirely.
    expect((await consume(key, 3, now + 61_000)).allowed).toBe(true);
  });

  it('counts each key separately', async () => {
    const a = `k-${randomUUID()}`;
    const b = `k-${randomUUID()}`;
    const now = Date.now();
    for (let i = 0; i < 3; i += 1) await consume(a, 3, now);
    expect((await consume(a, 3, now)).allowed).toBe(false);
    expect((await consume(b, 3, now)).allowed).toBe(true);
  });

  it('is cleared by the test seam, in Redis and not only in memory', async () => {
    // Found by a surviving mutation: making `resetRateLimits` clear only the
    // local map broke nothing, because every test here uses a fresh random
    // key. It is load-bearing all the same — `public-api.spec` counts against
    // the literal keys `key-1` and `key-2`, and two runs inside the same
    // minute would otherwise see the first run's tally and fail the second.
    // The dependency was real and invisible, which is the worst combination.
    const key = `k-${randomUUID()}`;
    const now = Date.now();
    for (let i = 0; i < 3; i += 1) await consume(key, 3, now);
    expect((await consume(key, 3, now)).allowed).toBe(false);

    await resetRateLimits();

    expect(await inspector.get(keyFor(key, now))).toBeNull();
    expect((await consume(key, 3, now)).allowed).toBe(true);
  });

  it('keys on the API key, not the client that owns it', async () => {
    // A client with three keys, one of which belongs to a runaway script.
    // Revoking that key is then the whole fix.
    expect(rateLimitKey({ apiKeyId: 'key-1' }))
      .not.toBe(rateLimitKey({ apiKeyId: 'key-2' }));
  });
});

describe('when Redis does not answer', () => {
  it('counts locally and keeps serving', async () => {
    // Forced through the real failure path rather than a stub: the counter key
    // is made the wrong type, so INCR errors exactly as it would against a
    // Redis that is down, and the catch block under test is the shipped one.
    const key = `k-${randomUUID()}`;
    const now = Date.now();
    await inspector.rpush(keyFor(key, now), 'not a counter');

    const before = await fallbackCount();
    const first = await consume(key, 2, now);
    expect(first.allowed).toBe(true);
    expect(first.limit).toBe(2);

    // A rate limiter that takes the API down when a cache is down has inverted
    // its own job. What it must NOT do is stop limiting altogether: the
    // fallback is the old per-instance behaviour, not an open door.
    await consume(key, 2, now);
    expect((await consume(key, 2, now)).allowed).toBe(false);

    // ...and the degradation is visible. A limit quietly doing something other
    // than what it says is the kind of thing nobody notices without a number.
    expect(await fallbackCount()).toBeGreaterThan(before);

    await inspector.del(keyFor(key, now));
  });

  it('the local counter it falls back to is the one it always was', async () => {
    // Identical semantics on both sides, which is the point of not changing the
    // algorithm in the same step as the storage: a fallback that counts
    // differently is a second set of bugs that only appear during an incident.
    const key = `k-${randomUUID()}`;
    const now = Date.now();
    for (let i = 0; i < 3; i += 1) {
      expect(consumeLocally(key, 3, now).allowed).toBe(true);
    }
    const refused = consumeLocally(key, 3, now);
    expect(refused.allowed).toBe(false);
    expect(refused.resetAt).toBe(windowEnd(now));

    // The seam clears this side too, asserted in the SAME window as the
    // refusal. Checking it a minute later proves nothing: the entry is
    // replaced when the window rolls, so the assertion passes whether or not
    // anything was cleared — which is how this mutation survived twice.
    await resetRateLimits();
    expect(consumeLocally(key, 3, now).allowed).toBe(true);

    // ...and the window still rolls on its own, on a key this test has not
    // already spent.
    const other = `k-${randomUUID()}`;
    for (let i = 0; i < 4; i += 1) consumeLocally(other, 3, now);
    expect(consumeLocally(other, 3, now).allowed).toBe(false);
    expect(consumeLocally(other, 3, now + 61_000).allowed).toBe(true);
  });
});
