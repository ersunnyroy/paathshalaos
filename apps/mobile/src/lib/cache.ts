/**
 * Reads that survive no signal (M21.2).
 *
 * The register's queue is a WRITE queue: work the teacher has done that has
 * not reached the server. A parent app needs the opposite — the server's last
 * answer, held so the screen is not blank on a train. The two are not the same
 * machinery and merging them would give reads a retry loop and writes an expiry.
 *
 * The rule this file exists to enforce: **cached is never shown as live**.
 * Every read comes back with when it was fetched and whether that was now. A
 * parent looking at "you owe ₹10,000" the day after they paid it has been
 * told something false, and the only defence is that the screen says, plainly
 * and not in a footnote, that this is what the school said on Tuesday.
 */

export interface CacheStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

export interface Fresh<T> {
  data: T;
  /** When the server actually answered. */
  asOf: string;
  /** False means this came off the disk, not off the network. */
  live: boolean;
}

/**
 * How old a cached answer may be before it is not offered at all.
 *
 * Seven days rather than forever. A fee balance from March is not context, it
 * is a wrong number with a date next to it, and a parent who has changed
 * schools should not still be shown the old one. Past the bound the screen
 * says it has nothing rather than showing something stale.
 */
export const MAX_CACHE_AGE_DAYS = 7;

interface Entry<T> { data: T; asOf: string }

export class CachedReader {
  constructor(
    private readonly storage: CacheStorage,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Fetches, and falls back to the last good answer.
   *
   * A network failure is not an error here — it is the ordinary case this
   * exists for. Anything else the fetcher throws (a 403, a 404, a refusal) is
   * NOT swallowed: a parent whose access was withdrawn must not keep seeing
   * their cached copy of a child's marks because the server said no and this
   * quietly served the disk instead.
   */
  async read<T>(
    key: string,
    fetcher: () => Promise<T>,
    isOffline: (error: unknown) => boolean = looksOffline,
  ): Promise<Fresh<T> | null> {
    try {
      const data = await fetcher();
      const asOf = this.now().toISOString();
      await this.write(key, { data, asOf });
      return { data, asOf, live: true };
    } catch (error) {
      if (!isOffline(error)) throw error;
      const held = await this.peek<T>(key);
      return held ? { ...held, live: false } : null;
    }
  }

  /** The held answer, if there is one and it is not past the bound. */
  async peek<T>(key: string): Promise<{ data: T; asOf: string } | null> {
    let raw: string | null;
    try {
      raw = await this.storage.getItem(`paathshala.cache.${key}`);
    } catch {
      // A read that throws is a cache miss, not a crash. One bad write must
      // not make a screen permanently unopenable.
      return null;
    }
    if (!raw) return null;
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return null; }
    if (!isEntry(parsed)) return null;

    const age = this.now().getTime() - Date.parse(parsed.asOf);
    if (!Number.isFinite(age) || age < 0) return null;
    if (age > MAX_CACHE_AGE_DAYS * 86_400_000) return null;
    return parsed as Entry<T>;
  }

  private async write<T>(key: string, entry: Entry<T>): Promise<void> {
    try {
      await this.storage.setItem(`paathshala.cache.${key}`, JSON.stringify(entry));
    } catch {
      // Storage full, or a quota. The answer is already on screen and live;
      // failing the read because we could not also save it would be worse.
    }
  }
}

function isEntry(value: unknown): value is Entry<unknown> {
  return typeof value === 'object' && value !== null
    && 'data' in value && 'asOf' in value
    && typeof (value as { asOf: unknown }).asOf === 'string';
}

/**
 * Is this the network, or is it the server saying no?
 *
 * React Native's fetch throws a TypeError with this message when there is no
 * connection; the shared client throws an ApiError-shaped object with a status
 * when the server answered. Anything carrying a status came from a server and
 * is therefore an answer, not an outage — including a 500, which is a real
 * failure a parent should see rather than have papered over with Tuesday's
 * balance.
 */
export function looksOffline(error: unknown): boolean {
  if (typeof error === 'object' && error !== null && 'status' in error
    && typeof (error as { status: unknown }).status === 'number') {
    return false;
  }
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /network request failed|failed to fetch|network error|timeout|timed out/i
    .test(message);
}

/** "Fetched a moment ago" / "as of yesterday, 4:15 pm" — for the stamp. */
export function asOfLabel(asOf: string, now: Date = new Date()): string {
  const then = new Date(asOf);
  const minutes = Math.floor((now.getTime() - then.getTime()) / 60_000);
  if (!Number.isFinite(minutes) || minutes < 0) return 'just now';
  if (minutes < 2) return 'just now';
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? 'day' : 'days'} ago`;
}
