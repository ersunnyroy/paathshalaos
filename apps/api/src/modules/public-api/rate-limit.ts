/**
 * Per-key request ceiling, counted in Redis (M30.2).
 *
 * This used to count in the process's own memory, with the consequence written
 * down at the top of the file: two API instances behind a load balancer allowed
 * twice the configured rate, and the comment said the counter belonged in Redis
 * "when there is more than one instance". Redis has been in the compose file
 * and the environment schema since M0 and nothing had ever connected to it, so
 * "when" had no date on it.
 *
 * The window is still FIXED, and that is deliberate. A client can still spend
 * its whole budget at the end of one window and again at the start of the next,
 * so the true worst case remains twice the rate across a boundary. A sliding
 * log would fix it and it is not fixed here, because changing where a counter
 * lives and how it counts in one step produces a bug nobody can locate: the two
 * implementations below have identical semantics, which is the whole point of
 * having a fallback.
 *
 * ## Failing open, on purpose
 *
 * If Redis is unreachable the count falls back to this process's memory — not
 * to refusing, and not to allowing everything. A rate limiter that takes the
 * API down when a cache is down has inverted its own job. The cost of the
 * fallback is exactly the old behaviour (per-instance limits), which was
 * considered acceptable for years, and it is visible: `rateLimiterFallbacks`
 * counts it, because a degradation nobody can see is one nobody fixes.
 *
 * This is the right trade HERE and would be wrong for anything security-shaped.
 * What this protects against is one integration's retry loop hammering the
 * database. It is not an authorisation control and must never be used as one.
 */
import { redis, redisConfigured } from '../../db/redis.ts';
import { rateLimiterFallbacks } from '../../common/telemetry/metrics.ts';

export interface RateVerdict {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Unix seconds when the current window ends — the Retry-After the client gets. */
  resetAt: number;
}

/**
 * What the counter counts against.
 *
 * The KEY, not the client. A client with three keys, one of which belongs to a
 * runaway script, should not have its other two throttled by that script's
 * loop — and when the script is found, revoking its key is the whole fix.
 *
 * Extracted rather than written inline in the guard so that it is a decision
 * with a name and a test, instead of one identifier among several that a
 * refactor could swap without anything noticing.
 */
export function rateLimitKey(identity: { apiKeyId: string }): string {
  return identity.apiKeyId;
}

/** The end of the minute `now` falls in, as unix seconds. */
function windowEnd(now: number): number {
  return (Math.floor(Math.floor(now / 1000) / 60) + 1) * 60;
}

function verdict(count: number, limitPerMinute: number, resetAt: number): RateVerdict {
  return {
    allowed: count <= limitPerMinute,
    limit: limitPerMinute,
    remaining: Math.max(0, limitPerMinute - count),
    resetAt,
  };
}

// ---------------------------------------------------------------------------
// The fallback: this process's own memory
// ---------------------------------------------------------------------------

interface Window { count: number; resetAt: number }

const windows = new Map<string, Window>();

/** Bounded so a long-running process cannot accumulate a window per dead key. */
const MAX_TRACKED = 10_000;

export function consumeLocally(
  key: string, limitPerMinute: number, now = Date.now(),
): RateVerdict {
  const second = Math.floor(now / 1000);
  const resetAt = windowEnd(now);

  let window = windows.get(key);
  if (!window || window.resetAt !== resetAt) {
    if (windows.size >= MAX_TRACKED) {
      for (const [k, w] of windows) if (w.resetAt <= second) windows.delete(k);
      // Still full: every tracked window is live, so the process is genuinely
      // serving that many keys. Allow rather than refuse — a memory ceiling is
      // not a reason to start rejecting a paying institute's traffic.
      if (windows.size >= MAX_TRACKED) {
        return { allowed: true, limit: limitPerMinute, remaining: limitPerMinute, resetAt };
      }
    }
    window = { count: 0, resetAt };
    windows.set(key, window);
  }

  window.count += 1;
  return verdict(window.count, limitPerMinute, resetAt);
}

// ---------------------------------------------------------------------------
// The counter that is actually shared
// ---------------------------------------------------------------------------

/**
 * INCR and EXPIREAT in one script, because they must not be two round trips.
 *
 * Between a bare INCR and a separate EXPIRE there is a window in which the
 * process dies and leaves a key with no expiry — a counter that never resets,
 * which locks an integration out permanently and is invisible until somebody
 * goes looking in Redis. The script makes the pair atomic.
 *
 * EXPIREAT rather than EXPIRE: the key dies when its window ends, not sixty
 * seconds after whichever request happened to create it. The slack keeps the
 * key alive slightly past the boundary so that clock skew between instances
 * cannot resurrect a window somebody has already been charged for.
 */
const SCRIPT = `
  local n = redis.call('INCR', KEYS[1])
  if n == 1 then redis.call('EXPIREAT', KEYS[1], tonumber(ARGV[1]) + 5) end
  return n
`;

/**
 * Counts one request against a key, shared across every instance.
 *
 * Any failure — Redis down, script error, a timeout — falls back to this
 * process's memory and is counted. It never throws: the caller is a guard on
 * the request path, and a guard that can throw for an infrastructure reason is
 * an outage waiting for a deploy.
 */
export async function consume(
  key: string, limitPerMinute: number, now = Date.now(),
): Promise<RateVerdict> {
  const resetAt = windowEnd(now);
  if (!redisConfigured()) return consumeLocally(key, limitPerMinute, now);

  try {
    const count = await redis().eval(
      SCRIPT, 1, `paathshala:rl:${key}:${resetAt}`, String(resetAt)) as number;
    return verdict(Number(count), limitPerMinute, resetAt);
  } catch {
    rateLimiterFallbacks.inc();
    return consumeLocally(key, limitPerMinute, now);
  }
}

/**
 * Test seam. Never called in production code.
 *
 * Clears BOTH counters. A reset that emptied only the local map left the shared
 * one holding a previous test's requests, which is the kind of cross-test
 * coupling that shows up as one suite failing when another is run first.
 */
export async function resetRateLimits(): Promise<void> {
  windows.clear();
  if (!redisConfigured()) return;
  try {
    const keys = await redis().keys('paathshala:rl:*');
    if (keys.length > 0) await redis().del(...keys);
  } catch {
    // Nothing to clear if it is not reachable.
  }
}
