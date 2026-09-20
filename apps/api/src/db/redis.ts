/**
 * The Redis connection, built on first use (M30.2).
 *
 * Redis has been in `docker-compose.yml` and in the environment schema since
 * M0 and nothing has ever opened a connection to it. This is the first thing
 * that does, and what it is for is small and specific: a counter that has to be
 * shared between API instances. It is not a cache, not a session store and not
 * a queue, and this comment is here so that it does not quietly become all
 * three.
 *
 * ## Everything here assumes Redis can be absent
 *
 * The one thing that must not happen is an API that stops serving because a
 * cache is down. So the connection is lazy, its retry policy is bounded, and
 * the single caller treats every error as "answer from local memory instead".
 * A rate limiter is the right place for that trade: the worst case of failing
 * open is one integration's retry loop reaching the database, which is what the
 * limiter was invented to prevent and not what the product exists to do.
 */
import { Redis } from 'ioredis';
import { loadEnv } from '../config/env.ts';

let client: Redis | undefined;
let warned = false;

/**
 * Whether this process has a Redis client at all.
 *
 * Separate from "is Redis reachable", which nothing can answer synchronously
 * and which changes between one request and the next.
 */
export function redisConfigured(): boolean {
  return Boolean(loadEnv().REDIS_URL);
}

export function redis(): Redis {
  client ??= new Redis(loadEnv().REDIS_URL, {
    // Built on first use, connected on first command. A module that dials out
    // at import time fails before anything can catch it — the lesson the
    // mobile app's session module already carries.
    lazyConnect: true,
    // Bounded, and deliberately small. An unbounded retry against a Redis that
    // is genuinely gone turns every request into a queue of pending commands,
    // which is a slower and less honest outage than failing over to memory.
    maxRetriesPerRequest: 1,
    connectTimeout: 500,
    // The offline queue stays ON, and that is not the obvious choice.
    //
    // Turning it off looks like the cautious setting — "do not queue against a
    // dead server" — and with `lazyConnect` it means the FIRST command is
    // rejected before the connection has finished opening. Every command
    // therefore failed, every decision fell back to local memory, and the rate
    // limiter behaved exactly as it had before this milestone while reporting
    // success. The tests caught it only because one of them reads the Redis key
    // rather than the verdict.
    //
    // With the queue on, a command issued during connect waits for it, and
    // `maxRetriesPerRequest` is what stops it waiting for a server that is not
    // coming back.
    enableOfflineQueue: true,
    retryStrategy: (times: number) => Math.min(times * 200, 2_000),
  });
  client.on('error', (error: Error) => {
    // Once, not per command. A Redis outage otherwise writes a line per
    // request, which buries the thing that would tell you what broke.
    if (warned) return;
    warned = true;
    // eslint-disable-next-line no-console
    console.warn(`redis unavailable (${error.message}); `
      + 'rate limiting falls back to per-process counters');
  });
  return client;
}

/** Lets a later outage warn again, once it has been noticed the first time. */
export function forgetRedisWarning(): void { warned = false; }

export async function closeRedis(): Promise<void> {
  if (!client) return;
  const c = client;
  client = undefined;
  warned = false;
  try { await c.quit(); } catch { c.disconnect(); }
}
