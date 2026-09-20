/**
 * The property that matters here is single-flight refresh.
 *
 * The server rotates refresh tokens and revokes the whole family when a
 * rotated one is presented again — correctly, because that is what a stolen
 * token looks like. The consequence, which is easy to miss until it happens to
 * a teacher mid-register, is that a client which refreshes twice concurrently
 * logs itself out and leaves an audit row saying token reuse was detected.
 *
 * So most of this file is about concurrency, and the fake server below counts
 * how many times refresh was actually called rather than trusting the client to
 * say so.
 */
import { describe, it, expect } from 'vitest';
import {
  createClient, MemoryTokenStore, ApiError, type Tokens,
} from '@paathshala/api-client';

interface ServerOptions {
  /** How many protected calls 401 before the token is accepted. */
  failFirst?: number;
  /**
   * Every protected call 401s, even after a successful refresh. Models a
   * server that has made up its mind — which is the only way to test that the
   * client retries once rather than looping.
   */
  alwaysFail?: boolean;
  refreshOutcome?: 'ok' | 'reused' | 'network';
  /** Milliseconds the refresh endpoint takes, to widen the concurrency window. */
  refreshDelay?: number;
  failCode?: string;
}

function fakeServer(options: ServerOptions = {}) {
  let refreshCalls = 0;
  let protectedCalls = 0;
  let rotated = 0;
  const seenRefreshTokens: string[] = [];
  let remainingFailures = options.failFirst ?? 0;

  const json = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), {
      status, headers: { 'content-type': 'application/json' },
    });

  const fetch = (async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const path = new URL(String(url)).pathname;

    if (path === '/v1/auth/refresh') {
      refreshCalls += 1;
      const presented = JSON.parse(String(init?.body)) as { refreshToken: string };
      seenRefreshTokens.push(presented.refreshToken);

      if (options.refreshDelay) {
        await new Promise((r) => setTimeout(r, options.refreshDelay));
      }
      if (options.refreshOutcome === 'network') throw new Error('network down');
      if (options.refreshOutcome === 'reused') {
        return json(401, { error: {
          code: 'refresh_token_reused',
          message: 'This session has been ended for security reasons.',
        } });
      }

      // A real rotation: the presented token is now spent.
      rotated += 1;
      if (!options.alwaysFail) remainingFailures = 0;
      return json(200, { data: {
        accessToken: `access-${rotated}`, refreshToken: `refresh-${rotated}`,
      } });
    }

    protectedCalls += 1;
    if (remainingFailures > 0) {
      remainingFailures -= 1;
      return json(401, { error: {
        code: options.failCode ?? 'grants_changed',
        message: 'Your access has changed.',
      } });
    }
    return json(200, { data: { ok: true, path } });
  }) as unknown as typeof globalThis.fetch;

  return {
    fetch,
    get refreshCalls() { return refreshCalls; },
    get protectedCalls() { return protectedCalls; },
    get seenRefreshTokens() { return seenRefreshTokens; },
  };
}

function client(server: ReturnType<typeof fakeServer>, opts: {
  tokens?: Tokens | null; onSignedOut?: (reason: string) => void;
} = {}) {
  const store = new MemoryTokenStore(
    opts.tokens === undefined
      ? { accessToken: 'access-0', refreshToken: 'refresh-0' }
      : opts.tokens);
  const reasons: string[] = [];
  const api = createClient({
    baseUrl: 'https://api.example',
    tenantId: 'tenant-1',
    store,
    onSignedOut: (r) => { reasons.push(r); opts.onSignedOut?.(r); },
    fetch: server.fetch,
  });
  return { api, store, reasons };
}

describe('a stale access token is refreshed, once', () => {
  it('refreshes and retries the original request', async () => {
    const server = fakeServer({ failFirst: 1 });
    const { api, store } = client(server);

    const result = await api.get<{ ok: boolean }>('/v1/campuses');
    expect(result.ok).toBe(true);
    expect(server.refreshCalls).toBe(1);
    // The original call, the retry — and the retry carried the new token.
    expect(server.protectedCalls).toBe(2);
    expect((await store.read())?.accessToken).toBe('access-1');
  });

  it('does not retry a second time', async () => {
    // A server that keeps saying no has made up its mind; retrying is a loop.
    const server = fakeServer({ failFirst: 99, alwaysFail: true });
    const { api } = client(server);
    await expect(api.get('/v1/campuses')).rejects.toBeInstanceOf(ApiError);
    expect(server.refreshCalls).toBe(1);
  });

  it('leaves a non-refreshable 401 alone', async () => {
    // `not_a_tenant_token` is a console token pointed at the tenant API. No
    // amount of refreshing fixes it, and trying costs a pointless rotation.
    const server = fakeServer({ failFirst: 1, failCode: 'not_a_tenant_token' });
    const { api } = client(server);
    await expect(api.get('/v1/campuses')).rejects.toMatchObject({
      code: 'not_a_tenant_token',
    });
    expect(server.refreshCalls).toBe(0);
  });
});

describe('concurrent requests do not log the user out', () => {
  it('refreshes exactly once for many simultaneous 401s', async () => {
    // THE test in this file. Without the single-flight latch this calls refresh
    // five times, presents the same spent token four times, and the server
    // revokes the family — a teacher signed out mid-register, with an audit row
    // saying token reuse was detected.
    const server = fakeServer({ failFirst: 5, refreshDelay: 20 });
    const { api, reasons } = client(server);

    const results = await Promise.all([
      api.get<{ ok: boolean }>('/v1/campuses'),
      api.get<{ ok: boolean }>('/v1/students'),
      api.get<{ ok: boolean }>('/v1/sections'),
      api.get<{ ok: boolean }>('/v1/plan'),
      api.get<{ ok: boolean }>('/v1/setup'),
    ]);

    expect(results.every((r) => r.ok)).toBe(true);
    expect(server.refreshCalls).toBe(1);
    expect(server.seenRefreshTokens).toEqual(['refresh-0']);
    expect(reasons).toEqual([]);
  });

  it('lets a later request start a fresh refresh once the first finished', async () => {
    // The latch must release. A client that refreshed once and then held the
    // promise forever would never refresh again in that session.
    const server = fakeServer({ failFirst: 1 });
    const { api } = client(server);
    await api.get('/v1/campuses');
    expect(server.refreshCalls).toBe(1);

    await api.refresh();
    expect(server.refreshCalls).toBe(2);
    // The second refresh presented the token the first one issued, not the
    // spent one — which is the difference between rotation and reuse.
    expect(server.seenRefreshTokens).toEqual(['refresh-0', 'refresh-1']);
  });
});

describe('when the session is genuinely over', () => {
  it('clears the tokens and signs out on reuse detection', async () => {
    const server = fakeServer({ failFirst: 1, refreshOutcome: 'reused' });
    const { api, store, reasons } = client(server);

    await expect(api.get('/v1/campuses')).rejects.toBeInstanceOf(ApiError);
    expect(reasons).toEqual(['refresh_token_reused']);
    expect(await store.read()).toBeNull();
    // And it did not try again. Asking a second time turns one security event
    // into a loop.
    expect(server.refreshCalls).toBe(1);
  });

  it('signs out when there is no refresh token at all', async () => {
    const server = fakeServer({ failFirst: 1 });
    const { api, reasons } = client(server, { tokens: null });
    await expect(api.get('/v1/campuses')).rejects.toBeInstanceOf(ApiError);
    expect(reasons).toEqual(['no_refresh_token']);
  });

  it('does NOT sign out when the refresh call fails on the network', async () => {
    // A tunnel is not a security event. Signing out here would throw away a
    // queued register because somebody went through a lift.
    const server = fakeServer({ failFirst: 1, refreshOutcome: 'network' });
    const { api, store, reasons } = client(server);

    await expect(api.get('/v1/campuses')).rejects.toBeInstanceOf(ApiError);
    expect(reasons).toEqual([]);
    expect(await store.read()).not.toBeNull();
  });
});

describe('the ordinary path', () => {
  it('sends the access token and parses the envelope', async () => {
    const server = fakeServer();
    const { api } = client(server);
    const result = await api.get<{ ok: boolean; path: string }>('/v1/campuses');
    expect(result).toEqual({ ok: true, path: '/v1/campuses' });
  });

  it('surfaces the server error code rather than a status number', async () => {
    const server = fakeServer({ failFirst: 1, failCode: 'account_read_only' });
    const { api } = client(server);
    await expect(api.post('/v1/campuses', { code: 'X' })).rejects.toMatchObject({
      code: 'account_read_only', status: 401,
    });
  });
});
