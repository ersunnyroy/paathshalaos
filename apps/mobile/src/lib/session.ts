/**
 * The app's one client and one queue, bound to this device.
 *
 * Everything here is wiring. The behaviour is in the shared packages: refresh
 * with a single-flight latch in `@paathshala/api-client`, conflict handling in
 * `@paathshala/offline-queue`, both tested in Node. This file exists so the
 * screens never construct either of them and never see a native module.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import Constants from 'expo-constants';
import { createClient, type Client, type Tokens } from '@paathshala/api-client';
import { OfflineAttendanceQueue } from '@paathshala/offline-queue';
import { SecureTokenStore, AsyncQueueStorage } from './storage.ts';
import { resolveApiUrl } from './api-url.ts';

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
export function apiUrl(): string {
  return resolveApiUrl(extra().apiUrl, Constants.expoConfig?.hostUri);
}

export function tenantId(): string {
  return extra().tenantId ?? '';
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
export function queue(): OfflineAttendanceQueue {
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
