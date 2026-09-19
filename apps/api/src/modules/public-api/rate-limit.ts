/**
 * Per-key request ceiling.
 *
 * A fixed window, counted in this process's memory. Both of those are
 * compromises and both are written down rather than discovered later:
 *
 *   **In memory** means the limit is per instance. Two API instances behind a
 *   load balancer allow twice the configured rate. That is acceptable for what
 *   this is actually protecting against — one integration's retry loop hammering
 *   the database — and wrong for anything security-shaped. The counter belongs
 *   in Redis when there is more than one instance; the interface below is the
 *   shape that swap takes, so the change is this file and nothing else.
 *
 *   **A fixed window** lets a client spend its whole budget at the end of one
 *   window and again at the start of the next, so the true worst case is twice
 *   the rate across a window boundary. A sliding log fixes it at the cost of
 *   keeping every timestamp. Not worth it here, and stated so nobody reports it
 *   as a bug.
 */
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

interface Window { count: number; resetAt: number }

const windows = new Map<string, Window>();

/** Bounded so a long-running process cannot accumulate a window per dead key. */
const MAX_TRACKED = 10_000;

export function consume(key: string, limitPerMinute: number, now = Date.now()): RateVerdict {
  const second = Math.floor(now / 1000);
  const resetAt = (Math.floor(second / 60) + 1) * 60;

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
  const remaining = Math.max(0, limitPerMinute - window.count);
  return { allowed: window.count <= limitPerMinute, limit: limitPerMinute, remaining, resetAt };
}

/** Test seam. Never called in production code. */
export function resetRateLimits(): void {
  windows.clear();
}
