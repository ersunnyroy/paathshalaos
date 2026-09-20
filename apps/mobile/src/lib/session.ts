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

/**
 * Read from the build, not hard-coded.
 *
 * A school's API lives wherever their deployment is, and a bundle with a URL
 * baked into it is a bundle per school.
 */
const extra = (Constants.expoConfig?.extra ?? {}) as {
  apiUrl?: string; tenantId?: string;
};
export const API_URL = extra.apiUrl ?? 'http://localhost:3001';
export const TENANT_ID = extra.tenantId ?? '';

export const tokenStore = new SecureTokenStore(SecureStore);

let signedOut: (reason: string) => void = () => undefined;

/** The root layout registers what to do when a session genuinely ends. */
export function onSignedOut(handler: (reason: string) => void): void {
  signedOut = handler;
}

export const api: Client = createClient({
  baseUrl: API_URL,
  tenantId: TENANT_ID,
  store: tokenStore,
  onSignedOut: (reason) => signedOut(reason),
});

export const queue = new OfflineAttendanceQueue(
  new AsyncQueueStorage(AsyncStorage),
  {
    async sync(input) {
      return api.post(`/v1/attendance/sessions/${input.sessionId}/marks`, {
        records: input.records,
        deviceClock: input.deviceClock,
      });
    },
  },
);

/**
 * Signs in and stores the pair.
 *
 * Deliberately not routed through `api.post`: there is no session yet, so the
 * refresh machinery has nothing to refresh and a 401 here means the password
 * was wrong, not that a token went stale.
 */
export async function signIn(email: string, password: string): Promise<void> {
  const response = await fetch(`${API_URL}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password, tenantId: TENANT_ID }),
  });
  const body = await response.json().catch(() => undefined) as
    { data?: Tokens; error?: { message: string } } | undefined;

  if (!response.ok || !body?.data) {
    // The API says the same thing for "no such account" and "wrong password",
    // and so does this. Distinguishing them is an account-existence oracle.
    throw new Error(body?.error?.message ?? 'Those details were not accepted.');
  }
  await tokenStore.write(body.data);
}

export async function signOut(): Promise<void> {
  await tokenStore.clear();
}
