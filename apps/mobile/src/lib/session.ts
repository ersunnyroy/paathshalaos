/**
 * The app's one client and one queue, bound to this device.
 *
 * Everything here is wiring. The behaviour is in the shared packages: refresh
 * with a single-flight latch in `@paathshala/api-client`, conflict handling in
 * `@paathshala/offline-queue`, both tested in Node. This file exists so the
 * screens never construct either of them and never see a native module.
 */
import * as SecureStore from 'expo-secure-store';
import Constants from 'expo-constants';
import { createClient, type Client, type Tokens } from '@paathshala/api-client';
import {
  OfflineAttendanceQueue, OfflineBoardingQueue,
} from '@paathshala/offline-queue';
import {
  SecureTokenStore, AsyncQueueStorage, AsyncBoardingStorage, AsyncCacheStorage,
} from './storage.ts';
import { resolveApiUrl } from './api-url.ts';
import { CachedReader } from './cache.ts';
import { SchoolStore, apiUrlForHost, type School } from './school.ts';
import { LocaleStore, readerChain } from './locale.ts';
import { translator, english, type Translator } from './i18n.ts';

/**
 * Read from the build, not hard-coded.
 *
 * A school's API lives wherever their deployment is, and a bundle with a URL
 * baked into it is a bundle per school. In development the address is derived
 * from the dev server the phone already connected to — see resolveApiUrl.
 */
function extra(): { apiUrl?: string; tenantId?: string } {
  return (Constants.expoConfig?.extra ?? {}) as { apiUrl?: string; tenantId?: string };
}
/**
 * Everything below is built on FIRST USE, not on import.
 *
 * It used to run at module scope, and that was wrong in a way that cost an
 * evening: constructing a keychain-backed store, an HTTP client and a queue as
 * a side effect of importing a file means any failure in any of them happens
 * before React exists. What the phone shows then is
 * `[runtime not ready]: TypeError: Object is not a function` with no file, no
 * line and no stack — the app is dead before anything can catch it.
 *
 * Built lazily, the same failure happens inside a screen, inside an error
 * boundary, with a message somebody can act on.
 */
/**
 * The school this phone is set up for, held in memory once read.
 *
 * Set by the school picker at first run and by the root layout on every launch
 * afterwards, so nothing below has to know where it came from.
 */
let _school: School | null = null;

export function currentSchool(): School | null { return _school; }
export function setSchool(school: School | null): void {
  _school = school;
  // The client captured the old base URL, so it has to be rebuilt.
  _api = undefined;
}

export async function loadSchool(): Promise<School | null> {
  const { default: AsyncStorage } = await import(
    '@react-native-async-storage/async-storage');
  _school = await new SchoolStore(AsyncStorage).read();
  return _school;
}

export async function rememberSchool(school: School): Promise<void> {
  const { default: AsyncStorage } = await import(
    '@react-native-async-storage/async-storage');
  await new SchoolStore(AsyncStorage).write(school);
  setSchool(school);
}

/**
 * Asks a host which school it is, before anybody signs in.
 *
 * The same public lookup the web sign-in screen uses. A host that is not
 * registered returns nothing, and the picker says so rather than leaving
 * somebody staring at a spinner.
 */
export async function resolveSchool(host: string): Promise<School | null> {
  const base = apiUrlForHost(host, extra().apiUrl);
  const response = await fetch(
    `${base}/v1/brand?host=${encodeURIComponent(host)}`,
    { headers: { accept: 'application/json' } });
  if (!response.ok) return null;
  const body = await response.json().catch(() => undefined) as
    { data?: { tenantId: string; name: string; logoUrl: string | null;
               primaryColour: string | null; supportEmail: string | null;
               supportPhone: string | null } | null } | undefined;
  const brand = body?.data;
  if (!brand) return null;
  return {
    host, tenantId: brand.tenantId, name: brand.name, logoUrl: brand.logoUrl,
    primaryColour: brand.primaryColour, supportEmail: brand.supportEmail,
    supportPhone: brand.supportPhone,
  };
}

export function apiUrl(): string {
  // A configured apiUrl still wins — it is how a development build points at a
  // laptop — then the school's own host, then the dev-server fallback.
  const configured = extra().apiUrl;
  if (configured) return configured.replace(/\/+$/, '');
  if (_school) return apiUrlForHost(_school.host);
  return resolveApiUrl(undefined, Constants.expoConfig?.hostUri);
}

export function tenantId(): string {
  return _school?.tenantId ?? extra().tenantId ?? '';
}

let _tokenStore: SecureTokenStore | undefined;
export function tokenStore(): SecureTokenStore {
  _tokenStore ??= new SecureTokenStore(SecureStore);
  return _tokenStore;
}

let signedOut: (reason: string) => void = () => undefined;

/** The root layout registers what to do when a session genuinely ends. */
export function onSignedOut(handler: (reason: string) => void): void {
  signedOut = handler;
}

let _api: Client | undefined;
export function api(): Client {
  _api ??= createClient({
    baseUrl: apiUrl(),
    tenantId: tenantId(),
    store: tokenStore(),
    onSignedOut: (reason) => signedOut(reason),
  });
  return _api;
}

let _queue: OfflineAttendanceQueue | undefined;
/**
 * Async because AsyncStorage is imported here rather than at the top of the
 * file. It is a community native module, not part of the Expo SDK proper, so
 * whether Expo Go contains it is not something this app controls — and a
 * module that throws while being imported takes the whole app down before
 * React exists. Imported inside the function, the same failure surfaces in the
 * screen that needed it, inside the error boundary.
 */
export async function queue(): Promise<OfflineAttendanceQueue> {
  const { default: AsyncStorage } = await import(
    '@react-native-async-storage/async-storage');
  _queue ??= new OfflineAttendanceQueue(
    new AsyncQueueStorage(AsyncStorage),
    {
      async sync(input) {
        return api().post(`/v1/attendance/sessions/${input.sessionId}/marks`, {
          records: input.records,
          deviceClock: input.deviceClock,
        });
      },
    },
  );
  return _queue;
}

/**
 * The language to render in, and the language the server says to render in.
 *
 * `readerLocale()` is synchronous and never waits, because it is called from a
 * render: the first frame after launch draws in whatever the phone remembered
 * last time, and `refreshLocale()` corrects it once the server answers. The
 * alternative — awaiting the chain before drawing anything — is a blank screen
 * on a train, in aid of a language the phone already knew.
 */
let _chain: string[] = ['en-IN'];
let _t: Translator = english;

export function readerLocale(): Translator { return _t; }

function useChain(chain: readonly string[]): Translator {
  _chain = [...chain];
  _t = translator(_chain);
  return _t;
}

async function localeStore(): Promise<LocaleStore> {
  const { default: AsyncStorage } = await import(
    '@react-native-async-storage/async-storage');
  return new LocaleStore(AsyncStorage);
}

/** What this phone remembered. Called on launch, before any request. */
export async function loadLocale(deviceLocale?: string | null): Promise<Translator> {
  const store = await localeStore();
  return useChain(readerChain({
    remembered: await store.remembered(),
    device: deviceLocale ?? null,
  }));
}

/**
 * Asks the server, and remembers the answer.
 *
 * A failure is not an error: the phone keeps the language it had. Losing a
 * parent's language because the network was down would be a worse outcome than
 * any staleness it prevents — the chain does not go wrong with age.
 */
export async function refreshLocale(): Promise<Translator> {
  try {
    const answer = await api().get<{ chain?: string[] }>('/v1/locale');
    if (!answer.chain?.length) return _t;
    const next = useChain(readerChain({ fromServer: answer.chain }));
    await (await localeStore()).remember(_chain);
    return next;
  } catch {
    return _t;
  }
}

/** Sets this family's own language, then re-reads it from the server. */
export async function setMyLocale(locale: string): Promise<Translator> {
  await api().post('/v1/locale/me', { locale });
  return refreshLocale();
}

/**
 * The roles this account holds in this school, from the server.
 *
 * Asked rather than read out of the token: the token's claims are what the
 * client was given, and a client that decides what it can do from its own
 * copy of them is a client that decides. Every answer here is still checked
 * again by the API on every request — this only picks a screen.
 */
export async function myRoles(): Promise<string[]> {
  const me = await api().get<{ roles?: string[] }>('/v1/me');
  return me.roles ?? [];
}

let _boarding: OfflineBoardingQueue | undefined;
/**
 * The bus run's queue. Async for the same reason as the register's.
 *
 * One request per flush rather than one per child, because the shape that
 * survives a tunnel is "here is everything I have not managed to send yet".
 */
export async function boardingQueue(): Promise<OfflineBoardingQueue> {
  const { default: AsyncStorage } = await import(
    '@react-native-async-storage/async-storage');
  _boarding ??= new OfflineBoardingQueue(
    new AsyncBoardingStorage(AsyncStorage),
    {
      async send(events) {
        return api().post('/v1/transport/boardings', { events });
      },
    },
  );
  return _boarding;
}

let _cache: CachedReader | undefined;
/**
 * The parent app's read-through cache.
 *
 * Reads, not writes: the register's queue holds work that has not reached the
 * server, and this holds the server's last answer so a screen is not blank on
 * a train. Merging them would give reads a retry loop and writes an expiry.
 */
export async function cache(): Promise<CachedReader> {
  const { default: AsyncStorage } = await import(
    '@react-native-async-storage/async-storage');
  _cache ??= new CachedReader(new AsyncCacheStorage(AsyncStorage));
  return _cache;
}

/**
 * Signs in and stores the pair.
 *
 * Deliberately not routed through `api.post`: there is no session yet, so the
 * refresh machinery has nothing to refresh and a 401 here means the password
 * was wrong, not that a token went stale.
 */
export async function signIn(email: string, password: string): Promise<void> {
  const response = await fetch(`${apiUrl()}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password, tenantId: tenantId() }),
  });
  const body = await response.json().catch(() => undefined) as
    { data?: Tokens; error?: { message: string } } | undefined;

  if (!response.ok || !body?.data) {
    // The API says the same thing for "no such account" and "wrong password",
    // and so does this. Distinguishing them is an account-existence oracle.
    throw new Error(body?.error?.message ?? 'Those details were not accepted.');
  }
  await tokenStore().write(body.data);
}

export async function signOut(): Promise<void> {
  await tokenStore().clear();
}
