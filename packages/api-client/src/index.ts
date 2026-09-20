/**
 * One API client, shared by the web app and the mobile app (M18.1).
 *
 * It exists for one reason the web app got away with ignoring and the mobile
 * app cannot: **refreshing a session**. The server has rotated refresh tokens
 * with reuse detection since M2.2 — present a token that has already been
 * rotated and the entire token family is revoked, deliberately, because that is
 * what a stolen token looks like. The web client never refreshed at all, so a
 * session simply died after the access token's ten minutes. On a phone that a
 * teacher opens twice a day, that is a sign-in every time.
 *
 * Rotation plus reuse detection makes one thing dangerous in a way that is easy
 * to miss: **two concurrent refreshes log the user out.** A screen that fires
 * three requests on mount, all of which 401, would call refresh three times
 * with the same token; the first rotates it, and the second and third look
 * exactly like an attacker replaying a stolen token. The family is revoked and
 * the teacher is signed out mid-register, with an audit row saying reuse was
 * detected. So refresh here is single-flight, and that is the property most of
 * the tests in this package are about.
 *
 * Storage is injected — `sessionStorage` in a browser, SecureStore on a device
 * — so none of this depends on a platform, and all of it is testable in Node.
 */

export interface Tokens {
  accessToken: string;
  refreshToken: string;
}

export interface TokenStore {
  read(): Promise<Tokens | null>;
  write(tokens: Tokens): Promise<void>;
  clear(): Promise<void>;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * The codes that mean "your access token is stale, ask for a new one".
 *
 * A closed list rather than "any 401", because most 401s are not refreshable
 * and retrying them is a second failed request plus a pointless refresh. In
 * particular `refresh_token_reused` must never trigger a refresh: the family is
 * already revoked and asking again is how a client turns one security event
 * into a loop.
 */
const REFRESHABLE = new Set(['grants_changed', 'invalid_token', 'missing_token']);

export interface ClientOptions {
  baseUrl: string;
  tenantId: string;
  store: TokenStore;
  /** Called once when the session is genuinely over. Send them to sign-in. */
  onSignedOut: (reason: string) => void;
  fetch?: typeof globalThis.fetch;
}

export interface Client {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
  /** Exposed for tests and for a deliberate refresh on app resume. */
  refresh(): Promise<boolean>;
}

export function createClient(options: ClientOptions): Client {
  const doFetch = options.fetch ?? globalThis.fetch;

  /**
   * The single-flight latch.
   *
   * While a refresh is running, every other caller awaits the SAME promise
   * rather than starting one of its own. Without this, a screen firing three
   * requests on mount presents the same rotated token three times and the
   * server — correctly — treats attempts two and three as a replay.
   */
  let inFlight: Promise<boolean> | null = null;

  async function refresh(): Promise<boolean> {
    if (inFlight) return inFlight;

    inFlight = (async () => {
      try {
        const tokens = await options.store.read();
        if (!tokens?.refreshToken) {
          options.onSignedOut('no_refresh_token');
          return false;
        }

        const response = await doFetch(`${options.baseUrl}/v1/auth/refresh`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            refreshToken: tokens.refreshToken,
            tenantId: options.tenantId,
          }),
        });

        const body = await readBody(response) as
          { data?: Tokens; error?: { code: string; message: string } } | undefined;

        if (!response.ok || !body?.data) {
          // Includes refresh_token_reused, which means the family is gone and
          // there is nothing left to try.
          await options.store.clear();
          options.onSignedOut(body?.error?.code ?? 'refresh_failed');
          return false;
        }

        await options.store.write(body.data);
        return true;
      } catch {
        // A network failure is NOT a sign-out. The token may still be perfectly
        // good; the user is in a lift. Signing them out here would mean losing
        // a queued register to a tunnel.
        return false;
      } finally {
        inFlight = null;
      }
    })();

    return inFlight;
  }

  async function request<T>(path: string, init: RequestInit, retry = true): Promise<T> {
    const tokens = await options.store.read();
    const response = await doFetch(`${options.baseUrl}${path}`, {
      ...init,
      headers: {
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(tokens?.accessToken ? { authorization: `Bearer ${tokens.accessToken}` } : {}),
        ...(init.headers ?? {}),
      },
    });

    const body = await readBody(response) as
      { data?: T; error?: { code: string; message: string } } | undefined;

    if (response.ok) return body?.data as T;

    const code = body?.error?.code ?? 'request_failed';

    // Exactly one retry. A second would be a loop against a server that has
    // made up its mind.
    if (response.status === 401 && retry && REFRESHABLE.has(code)) {
      const refreshed = await refresh();
      if (refreshed) return request<T>(path, init, false);
    }

    throw new ApiError(response.status, code,
      body?.error?.message ?? `The request failed (${response.status}).`);
  }

  return {
    get: <T>(path: string) => request<T>(path, { method: 'GET' }),
    post: <T>(path: string, body?: unknown) =>
      request<T>(path, {
        method: 'POST',
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    refresh,
  };
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { error: { code: 'bad_response', message: text.slice(0, 200) } };
  }
}

/** In-memory store: the reference implementation, and what the tests use. */
export class MemoryTokenStore implements TokenStore {
  constructor(private tokens: Tokens | null = null) {}
  async read(): Promise<Tokens | null> { return this.tokens; }
  async write(tokens: Tokens): Promise<void> { this.tokens = tokens; }
  async clear(): Promise<void> { this.tokens = null; }
}
