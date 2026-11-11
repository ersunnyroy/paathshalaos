/**
 * The two places this app touches a device, and nothing else does.
 *
 * Everything with real logic in it — the offline queue's conflict handling, the
 * client's single-flight refresh — lives in shared packages that know nothing
 * about phones and are tested in Node. What is left is binding those to the two
 * native stores, and that binding is where the device-specific mistakes are:
 * a keychain read that throws instead of returning null, a value that silently
 * truncates, JSON that comes back as a string when it went in as an object.
 *
 * So both adapters take their native module as an argument. The default export
 * binds the real one; the tests pass a fake and exercise the failure modes that
 * only happen on a device.
 */
import type { TokenStore, Tokens } from '@paathshala/api-client';
import type {
  QueueStorage, QueuedSession, BoardingStorage, QueuedBoarding,
} from '@paathshala/offline-queue';

/** The slice of `expo-secure-store` used here. */
export interface SecureStoreModule {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
}

/** The slice of `@react-native-async-storage/async-storage` used here. */
export interface AsyncStorageModule {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

const ACCESS_KEY = 'paathshala.access';
const REFRESH_KEY = 'paathshala.refresh';

/**
 * expo-secure-store warns above this and behaviour past it is platform-defined.
 *
 * Our tokens are nowhere near it — a refresh token is 43 characters and an
 * access token a few hundred — so exceeding it means something has gone wrong
 * upstream, and storing a truncated credential is far worse than refusing:
 * a truncated refresh token fails to authenticate AND cannot be distinguished
 * from a stolen one, so the user is signed out with a security warning.
 */
const SECURE_STORE_LIMIT = 2048;

/**
 * Tokens in the keychain, not in AsyncStorage.
 *
 * AsyncStorage is plain unencrypted files in the app sandbox — readable on a
 * rooted phone and, on Android, included in the automatic cloud backup unless
 * it is explicitly excluded. A refresh token is a long-lived credential for a
 * school's records; it belongs behind the platform's secure element.
 */
export class SecureTokenStore implements TokenStore {
  constructor(private readonly secure: SecureStoreModule) {}

  async read(): Promise<Tokens | null> {
    try {
      const [accessToken, refreshToken] = await Promise.all([
        this.secure.getItemAsync(ACCESS_KEY),
        this.secure.getItemAsync(REFRESH_KEY),
      ]);
      // Both or nothing. Half a session is a client that sends a stale access
      // token it can never refresh, and every request 401s forever.
      return accessToken && refreshToken ? { accessToken, refreshToken } : null;
    } catch {
      // A locked keychain, a corrupt entry, a device with no biometric set up
      // after one was enrolled. Treated as signed out rather than thrown:
      // signing in again works, and an exception here would crash the app on
      // launch with no way out.
      return null;
    }
  }

  async write(tokens: Tokens): Promise<void> {
    if (tokens.accessToken.length > SECURE_STORE_LIMIT
      || tokens.refreshToken.length > SECURE_STORE_LIMIT) {
      throw new Error('Refusing to store a credential past the secure-store limit.');
    }
    await this.secure.setItemAsync(ACCESS_KEY, tokens.accessToken);
    await this.secure.setItemAsync(REFRESH_KEY, tokens.refreshToken);
  }

  async clear(): Promise<void> {
    // Settled, not all: if one delete fails the other must still happen, or a
    // "sign out" leaves a usable refresh token on the device.
    await Promise.allSettled([
      this.secure.deleteItemAsync(ACCESS_KEY),
      this.secure.deleteItemAsync(REFRESH_KEY),
    ]);
  }
}

const QUEUE_KEY = 'paathshala.attendance.queue';

/**
 * The register queue in AsyncStorage.
 *
 * Not the keychain: this is a class list, not a credential, and secure storage
 * is size-limited in a way a register would hit. Not SQLite either — the queue
 * is read and written whole, so a document is the honest shape, and adding a
 * database would be a schema to migrate on a device we cannot reach.
 */
export class AsyncQueueStorage implements QueueStorage {
  constructor(private readonly store: AsyncStorageModule) {}

  async read(): Promise<QueuedSession[]> {
    try {
      const raw = await this.store.getItem(QUEUE_KEY);
      if (!raw) return [];
      const parsed: unknown = JSON.parse(raw);
      // Anything that is not an array is treated as an empty queue rather than
      // thrown on, for the same reason as the web adapter: one bad write must
      // not make the register unusable on every subsequent launch.
      return Array.isArray(parsed) ? (parsed as QueuedSession[]) : [];
    } catch {
      return [];
    }
  }

  async write(sessions: QueuedSession[]): Promise<void> {
    await this.store.setItem(QUEUE_KEY, JSON.stringify(sessions));
  }
}

const BOARDING_KEY = 'paathshala.boarding.queue';

/**
 * The bus run's queue, in its own AsyncStorage key.
 *
 * Separate from the register's, not merged with it. A phone in a classroom and
 * a phone on a bus are usually different phones, but when they are the same
 * one, a single document means a driver's flush rewrites the teacher's queue —
 * and the reader that came back empty after a bad write would empty both.
 */
export class AsyncBoardingStorage implements BoardingStorage {
  constructor(private readonly store: AsyncStorageModule) {}

  async read(): Promise<QueuedBoarding[]> {
    try {
      const raw = await this.store.getItem(BOARDING_KEY);
      if (!raw) return [];
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as QueuedBoarding[]) : [];
    } catch {
      return [];
    }
  }

  async write(events: QueuedBoarding[]): Promise<void> {
    await this.store.setItem(BOARDING_KEY, JSON.stringify(events));
  }
}

/**
 * The parent app's read cache, in its own AsyncStorage key space.
 *
 * `CachedReader` namespaces per screen already; this adapter exists so the
 * cache uses the same injected-module shape as everything else that touches a
 * device, and so a storage failure here is a cache miss rather than a crash.
 */
export class AsyncCacheStorage {
  constructor(private readonly store: AsyncStorageModule) {}
  async getItem(key: string): Promise<string | null> {
    return this.store.getItem(key);
  }
  async setItem(key: string, value: string): Promise<void> {
    await this.store.setItem(key, value);
  }
}
