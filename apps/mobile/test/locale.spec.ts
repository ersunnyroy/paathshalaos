/**
 * M29.2 — the language the phone opens in.
 *
 * Two behaviours, both about what happens when the server is not there.
 */
import { describe, it, expect } from 'vitest';
import { LocaleStore, readerChain, type LocaleStorage } from '../src/lib/locale.ts';

function memory(initial: Record<string, string> = {}): LocaleStorage & {
  store: Record<string, string>;
} {
  const store = { ...initial };
  return {
    store,
    async getItem(k) { return store[k] ?? null; },
    async setItem(k, v) { store[k] = v; },
  };
}

const broken = (): LocaleStorage => ({
  async getItem() { throw new Error('keychain unavailable'); },
  async setItem() { throw new Error('disk full'); },
});

describe('remembering a language', () => {
  it('survives a restart with no signal', async () => {
    const storage = memory();
    await new LocaleStore(storage).remember(['ta-IN', 'hi-IN', 'en-IN']);
    expect(await new LocaleStore(storage).remembered())
      .toEqual(['ta-IN', 'hi-IN', 'en-IN']);
  });

  it('has no expiry, unlike the read cache', async () => {
    // Deliberate, and the one thing most likely to be "fixed" later. A fee
    // balance goes wrong with age; a language does not. Expiring it would drop
    // a Tamil-reading parent into English after a fortnight with no signal —
    // exactly when they are least able to go and change it back.
    const storage = memory({
      'paathshala.locale.chain': JSON.stringify(['ta-IN', 'en-IN']),
    });
    expect(await new LocaleStore(storage).remembered()).toEqual(['ta-IN', 'en-IN']);
  });

  it('treats a corrupted store as a miss, not a crash', async () => {
    // The screen this would otherwise take down is the one a parent opens to
    // find out their child was absent.
    for (const raw of ['not json', '{"a":1}', '[1,2,3]', '']) {
      const storage = memory({ 'paathshala.locale.chain': raw });
      expect(await new LocaleStore(storage).remembered()).toEqual([]);
    }
    expect(await new LocaleStore(broken()).remembered()).toEqual([]);
    await expect(new LocaleStore(broken()).remember(['hi-IN'])).resolves.toBeUndefined();
  });
});

describe('which chain the screen renders with', () => {
  it('prefers what the school was told over what the handset is set to', async () => {
    // A family that told the school they read Tamil has said something
    // deliberate. A second-hand phone with Hindi on it has not.
    const chain = readerChain({ fromServer: ['ta-IN'], device: 'hi-IN' });
    expect(chain[0]).toBe('ta-IN');
    expect(chain).toContain('hi-IN');
  });

  it('falls back to the last answer when the server is unreachable', () => {
    expect(readerChain({ remembered: ['bn-IN', 'en-IN'], device: 'en-US' })[0]).toBe('bn-IN');
  });

  it('uses the handset only when nothing else is known', () => {
    // A fresh install at the sign-in screen has nothing else, and the phone's
    // own language is a better first guess than English.
    expect(readerChain({ device: 'hi-IN' })[0]).toBe('hi-IN');
  });

  it('always ends somewhere', () => {
    expect(readerChain({})).toEqual(['en-IN']);
    expect(readerChain({ device: null }).at(-1)).toBe('en-IN');
  });
});
