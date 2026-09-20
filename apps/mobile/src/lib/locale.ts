/**
 * Which language this phone opens in (M29.2/M29.3).
 *
 * The server owns the answer — `GET /v1/locale` returns the chain M29.1
 * resolves — but the phone has to open in the right language *before* it has
 * heard from anybody, on a train, on the first frame. So the last known chain
 * is kept on the device.
 *
 * ## Why this is not in the read cache
 *
 * `CachedReader` refuses anything older than seven days, and that rule is
 * right for what it guards: a fee balance from March is not context, it is a
 * wrong number with a date beside it. A language is the opposite. It does not
 * become wrong with age — a parent who reads Tamil still reads Tamil after a
 * fortnight with no signal — and expiring it would drop them back into English
 * precisely when they are least able to go and fix it.
 *
 * So: stored without a bound, deliberately, and this comment is the reason
 * somebody does not later "fix the inconsistency" by moving it.
 */
import { expand } from './i18n.ts';

export interface LocaleStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

const KEY = 'paathshala.locale.chain';

export class LocaleStore {
  constructor(private readonly storage: LocaleStorage) {}

  /**
   * The last chain the server gave this phone, or an empty list.
   *
   * Every failure here is a miss, not a crash: a phone with a corrupted store
   * must open in English, not fail to open. The screen it would otherwise fail
   * on is the one a parent uses to find out their child was absent.
   */
  async remembered(): Promise<string[]> {
    try {
      const raw = await this.storage.getItem(KEY);
      if (!raw) return [];
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((t): t is string => typeof t === 'string' && t.length > 0);
    } catch {
      return [];
    }
  }

  async remember(chain: readonly string[]): Promise<void> {
    try {
      await this.storage.setItem(KEY, JSON.stringify([...chain]));
    } catch {
      // Losing the preference costs one English launch. Throwing costs the app.
    }
  }
}

/**
 * The chain to render with, from everything the phone knows.
 *
 * Order: what the server said this session, then what it said last time, then
 * what the phone's own settings suggest. The device locale is LAST among the
 * three and not first, which is the decision worth defending: a family that
 * told the school they read Tamil has said something deliberate, and a handset
 * bought second-hand with Hindi set on it has not. `expand` appends English.
 *
 * The device locale is still consulted, because a brand-new install that has
 * not signed in yet has nothing else — and showing the sign-in screen in the
 * language of the phone is a better first guess than English.
 */
export function readerChain(input: {
  fromServer?: readonly string[] | undefined;
  remembered?: readonly string[] | undefined;
  device?: string | null | undefined;
}): string[] {
  const candidates = [
    ...(input.fromServer ?? []),
    ...(input.remembered ?? []),
    ...(input.device ? [input.device] : []),
  ];
  return expand(candidates);
}
