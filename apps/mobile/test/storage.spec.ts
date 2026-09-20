/**
 * The device bindings, exercised without a device.
 *
 * These are the only two places this app touches native storage, and the
 * failures worth catching are the ones that only happen on a phone: a keychain
 * that throws instead of returning null, a half-written session, a "sign out"
 * that leaves a credential behind, JSON that comes back as something other
 * than what went in.
 *
 * Nothing here renders. The screens are thin by design and the logic they use
 * lives in shared packages with their own suites — which is what keeps the
 * part of this app that cannot be verified from a container small enough to
 * check by eye.
 */
import { describe, it, expect } from 'vitest';
import {
  SecureTokenStore, AsyncQueueStorage,
  type SecureStoreModule, type AsyncStorageModule,
} from '../src/lib/storage.ts';
import {
  initialMarks, nextState, recordsFor, summarise, type Learner,
} from '../src/lib/register.ts';
import type { AttendanceState } from '@paathshala/offline-queue';
import { resolveApiUrl } from '../src/lib/api-url.ts';
import {
  normaliseHost, apiUrlForHost, SchoolStore,
} from '../src/lib/school.ts';

function fakeSecureStore(options: {
  initial?: Record<string, string>;
  throwOnRead?: boolean;
  failDeleteOf?: string;
} = {}) {
  const values = new Map(Object.entries(options.initial ?? {}));
  const module: SecureStoreModule = {
    async getItemAsync(key) {
      if (options.throwOnRead) throw new Error('keychain is locked');
      return values.get(key) ?? null;
    },
    async setItemAsync(key, value) { values.set(key, value); },
    async deleteItemAsync(key) {
      if (key === options.failDeleteOf) throw new Error('delete failed');
      values.delete(key);
    },
  };
  return { module, values };
}

function fakeAsyncStorage(initial?: string) {
  const values = new Map<string, string>();
  if (initial !== undefined) values.set('paathshala.attendance.queue', initial);
  const module: AsyncStorageModule = {
    async getItem(key) { return values.get(key) ?? null; },
    async setItem(key, value) { values.set(key, value); },
  };
  return { module, values };
}

const tokens = { accessToken: 'access-1', refreshToken: 'refresh-1' };

describe('tokens live in the keychain', () => {
  it('round-trips a session', async () => {
    const { module } = fakeSecureStore();
    const store = new SecureTokenStore(module);
    await store.write(tokens);
    expect(await store.read()).toEqual(tokens);
  });

  it('treats half a session as no session', async () => {
    // An access token with no refresh token is a client that sends a stale
    // credential it can never renew — every request 401s, forever, with no
    // path out except reinstalling the app.
    const { module } = fakeSecureStore({ initial: { 'paathshala.access': 'access-1' } });
    expect(await new SecureTokenStore(module).read()).toBeNull();
  });

  it('treats a locked keychain as signed out rather than crashing', async () => {
    // Happens for real: a device where the user removed their passcode after
    // enrolling biometrics. Throwing here crashes the app on launch with no
    // way out; signing in again works.
    const { module } = fakeSecureStore({ throwOnRead: true });
    expect(await new SecureTokenStore(module).read()).toBeNull();
  });

  it('refuses to store a credential past the secure-store limit', async () => {
    // Storing a truncated refresh token is worse than refusing one: it fails to
    // authenticate AND is indistinguishable from a stolen token, so the user is
    // signed out with a security warning for a bug of ours.
    const { module, values } = fakeSecureStore();
    await expect(new SecureTokenStore(module).write({
      accessToken: 'a'.repeat(3000), refreshToken: 'refresh-1',
    })).rejects.toThrow(/secure-store limit/);
    expect(values.size).toBe(0);
  });

  it('clears the refresh token even when clearing the access token fails', async () => {
    // A "sign out" that leaves a usable refresh token on the device is not a
    // sign out. Both deletes are attempted regardless of the other.
    const { module, values } = fakeSecureStore({
      initial: { 'paathshala.access': 'a', 'paathshala.refresh': 'r' },
      failDeleteOf: 'paathshala.access',
    });
    await new SecureTokenStore(module).clear();
    expect(values.has('paathshala.refresh')).toBe(false);
  });
});

describe('the register queue survives the app being killed', () => {
  it('round-trips queued sessions', async () => {
    const { module } = fakeAsyncStorage();
    const storage = new AsyncQueueStorage(module);
    const queued = [{
      localId: 'l1', serverSessionId: 's1', sectionId: 'sec1',
      sessionDate: '2026-09-20', records: [], queuedAt: new Date().toISOString(),
      attempts: 0, state: 'pending' as const,
    }];
    await storage.write(queued);
    expect(await storage.read()).toEqual(queued);
  });

  it('starts empty rather than throwing on corrupt data', async () => {
    // One bad write must not make the register unusable on every launch.
    for (const corrupt of ['not json at all', '{"not":"an array"}', '42']) {
      const { module } = fakeAsyncStorage(corrupt);
      await expect(new AsyncQueueStorage(module).read()).resolves.toEqual([]);
    }
  });

  it('starts empty on a fresh install', async () => {
    const { module } = fakeAsyncStorage();
    expect(await new AsyncQueueStorage(module).read()).toEqual([]);
  });

  it('keeps the queue out of the keychain', async () => {
    // Deliberate: a register is a class list, not a credential, and secure
    // storage is size-limited in a way a register would hit. The test is here
    // so that "just put it all in SecureStore" fails rather than ships.
    // A plain path, not a URL: this app's tsconfig pulls in the DOM lib, so
    // `URL` here is the DOM's rather than Node's, and the two are structurally
    // different enough that neither readFileSync nor fileURLToPath accepts it.
    const { readFileSync } = await import('node:fs');
    const { dirname, join } = await import('node:path');
    const here = dirname(import.meta.url.replace('file://', ''));
    const source = readFileSync(join(here, '..', 'src', 'lib', 'storage.ts'), 'utf8');
    const queueSection = source.slice(source.indexOf('class AsyncQueueStorage'));
    expect(queueSection).not.toContain('SecureStore');
    expect(queueSection).not.toContain('secure.');
  });
});

describe('the register, without a screen', () => {
  const roll: Learner[] = [
    { id: 'a', given_name: 'Asha', family_name: 'R', admission_no: '1', enrollment_id: 'e1' },
    { id: 'b', given_name: 'Bharat', family_name: null, admission_no: '2', enrollment_id: 'e2' },
    { id: 'c', given_name: 'Chitra', family_name: 'S', admission_no: '3', enrollment_id: null },
  ];

  it('starts everyone present', () => {
    expect(initialMarks(roll)).toEqual({ a: 'present', b: 'present', c: 'present' });
  });

  it('cycles a row through the states a teacher uses, and back', () => {
    let state: AttendanceState = 'present';
    const seen: AttendanceState[] = [state];
    for (let i = 0; i < 4; i += 1) { state = nextState(state); seen.push(state); }
    expect(seen).toEqual(['present', 'absent', 'late', 'excused', 'present']);
  });

  it('leaves out a learner with no enrollment', () => {
    // Chitra is on the class list without an enrollment row: she has no session
    // to be marked against, and sending her produces a rejection the teacher
    // can do nothing about.
    let n = 0;
    const records = recordsFor(roll, initialMarks(roll), () => `id-${(n += 1)}`);
    expect(records.map((r) => r.studentId)).toEqual(['a', 'b']);
  });

  it('gives every record its own client event id', () => {
    let n = 0;
    const records = recordsFor(roll, initialMarks(roll), () => `id-${(n += 1)}`);
    expect(new Set(records.map((r) => r.clientEventId)).size).toBe(records.length);
  });

  it('tells the teacher what actually happened to their work', () => {
    // "Saved on this phone" and "recorded" are different facts. A message that
    // blurs them is how somebody finds out a week later that a day never
    // arrived at the school.
    const none = { synced: 0, conflicted: 0, corrections: 0, failed: 0 };

    expect(summarise({ ...none, synced: 1 }, 0, 32).message).toBe('32 recorded.');
    expect(summarise({ ...none, failed: 1 }, 1, 32).message).toMatch(/on this phone/);
    expect(summarise({ ...none, conflicted: 1 }, 0, 32)).toMatchObject({ tone: 'warn' });
    expect(summarise({ ...none, corrections: 1 }, 0, 32).message).toMatch(/approval/);

    // A conflict outranks everything else: it is the only one needing a decision.
    expect(summarise({ synced: 1, conflicted: 1, corrections: 1, failed: 1 }, 0, 32)
      .message).toMatch(/clash/);
  });
});

describe('finding the API without anybody typing an IP', () => {
  it('takes the host from the dev server the phone already reached', () => {
    // The phone connected to Metro over the network it is on; that host is the
    // machine running the API too. Asking a person to find their own LAN IP and
    // keep it in sync with their router is a setup step that mostly goes wrong.
    expect(resolveApiUrl(undefined, '192.168.1.14:8081')).toBe('http://192.168.1.14:3001');
  });

  it('copes with a scheme, a path, and no port', () => {
    expect(resolveApiUrl(undefined, 'http://192.168.1.14:8081')).toBe('http://192.168.1.14:3001');
    expect(resolveApiUrl(undefined, '192.168.1.14:8081/_expo')).toBe('http://192.168.1.14:3001');
    expect(resolveApiUrl(undefined, 'chatty-otter.tunnel.dev')).toBe('http://chatty-otter.tunnel.dev:3001');
  });

  it('never turns localhost into an address a phone would believe', () => {
    // On a device, localhost is the device. Rewriting it to http://localhost is
    // no worse than the alternative and is correct on a simulator, which is the
    // only place hostUri says localhost.
    expect(resolveApiUrl(undefined, 'localhost:8081')).toBe('http://localhost:3001');
    expect(resolveApiUrl(undefined, '127.0.0.1:8081')).toBe('http://localhost:3001');
    expect(resolveApiUrl(undefined, undefined)).toBe('http://localhost:3001');
  });

  it('lets an explicit setting win, because production is not a laptop', () => {
    expect(resolveApiUrl('https://api.school.example', '192.168.1.14:8081'))
      .toBe('https://api.school.example');
    // And a trailing slash does not become a double slash in every path.
    expect(resolveApiUrl('https://api.school.example/', '192.168.1.14:8081'))
      .toBe('https://api.school.example');
  });
});

describe('the dependency set matches the SDK', () => {
  it('pins every native package to what Expo Go actually contains', async () => {
    /*
     * Written after breaking the app twice with the same mistake.
     *
     * Expo Go is a fixed binary: it contains ONE compiled version of each
     * native module. Installing a different version of the JavaScript side —
     * `npm view <pkg> version` gives the newest published, not the one the SDK
     * pins — leaves JS calling into native code that is not there. The app
     * bundles perfectly and dies at startup with something unhelpful; the one
     * that cost an evening was `TypeError: Object is not a function` from
     * async-storage 3.x against Expo Go's 2.2.0.
     *
     * `expo install` would prevent this, and could not reach Expo's API from
     * the environment these versions were chosen in. `bundledNativeModules.json`
     * ships inside the expo package and is the same mapping, offline.
     */
    const { readFileSync } = await import('node:fs');
    const { dirname, join } = await import('node:path');
    const root = join(dirname(import.meta.url.replace('file://', '')), '..');

    const read = (p: string) => JSON.parse(readFileSync(join(root, p), 'utf8')) as
      Record<string, Record<string, string>>;

    const bundled = read('node_modules/expo/bundledNativeModules.json') as
      unknown as Record<string, string>;
    const declared = read('package.json')['dependencies']!;

    // Sanity: an empty or unreadable manifest would make this pass vacuously.
    expect(Object.keys(bundled).length).toBeGreaterThan(20);
    expect(bundled['expo-router']).toBeTruthy();

    const drifted = Object.entries(declared)
      .filter(([name]) => bundled[name] !== undefined)
      .filter(([name, range]) => range !== bundled[name])
      .map(([name, range]) => `${name}: declared ${range}, SDK pins ${bundled[name]}`);

    expect(drifted, 'run `npx expo install --fix`, or copy the pinned ranges')
      .toEqual([]);
  });
});

describe('finding which school this phone belongs to (M19.4)', () => {
  it('accepts what a teacher would actually type', () => {
    // A box labelled "your school's address" gets all of these, and refusing
    // any of them is a support call.
    for (const typed of [
      'stjosephs.paathshala.app',
      'https://stjosephs.paathshala.app',
      'https://stjosephs.paathshala.app/',
      'https://stjosephs.paathshala.app/sign-in',
      '  StJosephs.Paathshala.App  ',
      'stjosephs.paathshala.app.',
    ]) {
      expect(normaliseHost(typed), typed).toBe('stjosephs.paathshala.app');
    }
  });

  it('refuses what is not an address', () => {
    // A bare word would be sent off to resolve something meaningless, and the
    // teacher would get a network error instead of "that is not an address".
    for (const bad of ['', '   ', 'my school', 'stjosephs', 'http://', '...', '-x.example']) {
      expect(normaliseHost(bad), bad).toBeNull();
    }
  });

  it('derives the API from the school address', () => {
    // Asking a teacher for an API URL is asking the wrong person a question
    // they cannot answer.
    expect(apiUrlForHost('stjosephs.paathshala.app'))
      .toBe('https://stjosephs.paathshala.app');
    // A development override still wins, without a trailing slash.
    expect(apiUrlForHost('stjosephs.paathshala.app', 'http://192.168.1.14:3001/'))
      .toBe('http://192.168.1.14:3001');
  });

  it('remembers the school across launches, and refuses a half-written one', async () => {
    const { module } = fakeAsyncStorage();
    const store = new SchoolStore(module);
    expect(await store.read()).toBeNull();

    const school = {
      host: 'stjosephs.paathshala.app', tenantId: 't-1', name: 'St Joseph\'s',
      logoUrl: null, primaryColour: '#14B8A6', supportEmail: null, supportPhone: null,
    };
    await store.write(school);
    expect(await store.read()).toEqual(school);

    // A record missing its tenant id would otherwise produce an app that looks
    // configured and is pointed at nothing.
    await module.setItem('paathshala.school', JSON.stringify({ host: 'x.example' }));
    expect(await store.read()).toBeNull();

    await module.setItem('paathshala.school', 'not json');
    expect(await store.read()).toBeNull();
  });
});
