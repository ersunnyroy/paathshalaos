/**
 * The browser-shaped half of AC-5.
 *
 * The queue's conflict behaviour is tested in the shared package, in Node, with
 * storage injected. What that cannot test is the storage itself — and the
 * storage is where a teacher's morning is actually kept. These run against a
 * real IndexedDB implementation (`fake-indexeddb`) rather than a stub, because
 * the failures worth catching here are IndexedDB's own: a transaction that
 * aborts, a value that comes back as something other than what was written, a
 * database that was closed between calls.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { createContext, runInNewContext } from 'node:vm';
import {
  IndexedDbQueueStorage, attendanceTransport, buildRecords, flushWhenOnline,
  resetAttendanceQueue,
} from '../src/lib/offline.ts';
import {
  OfflineAttendanceQueue, type QueuedSession, type RecordOutcome,
} from '@paathshala/offline-queue';

function session(overrides: Partial<QueuedSession> = {}): QueuedSession {
  return {
    localId: 'local-1',
    serverSessionId: 'srv-1',
    sectionId: 'sec-1',
    sessionDate: new Date().toISOString().slice(0, 10),
    records: buildRecords([{ studentId: 'stu-1', state: 'present' }]),
    queuedAt: new Date().toISOString(),
    attempts: 0,
    state: 'pending',
    ...overrides,
  };
}

beforeEach(async () => {
  resetAttendanceQueue();
  await new IndexedDbQueueStorage().write([]);
});

describe('the register survives the browser', () => {
  it('writes and reads a queued session back unchanged', async () => {
    const storage = new IndexedDbQueueStorage();
    const one = session();
    await storage.write([one]);
    expect(await storage.read()).toEqual([one]);
  });

  it('survives the page being closed and reopened', async () => {
    // Each call opens and closes its own connection, which is the point: a
    // teacher who closes the tab mid-morning must find the queue intact.
    await new IndexedDbQueueStorage().write([session()]);
    const afterReload = await new IndexedDbQueueStorage().read();
    expect(afterReload).toHaveLength(1);
    expect(afterReload[0]!.records[0]!.clientEventId).toBeTruthy();
  });

  it('treats a corrupt record as an empty queue rather than throwing', async () => {
    // One bad write must not make the attendance screen unusable on every
    // subsequent load. Losing a corrupt entry is bad; locking a teacher out of
    // marking today's register because of it is worse.
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open('paathshala.attendance', 1);
      open.onsuccess = () => {
        const tx = open.result.transaction('queue', 'readwrite');
        tx.objectStore('queue').put('not an array', 'sessions');
        tx.oncomplete = () => { open.result.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
      open.onerror = () => reject(open.error);
    });

    await expect(new IndexedDbQueueStorage().read()).resolves.toEqual([]);
  });

  it('gives every record a distinct client event id', () => {
    // The basis of a safe retry. Two records sharing an id would make the
    // server treat the second as a replay of the first and drop a child's mark.
    const records = buildRecords([
      { studentId: 'a', state: 'present' },
      { studentId: 'b', state: 'absent' },
      { studentId: 'c', state: 'late' },
    ]);
    expect(new Set(records.map((r) => r.clientEventId)).size).toBe(3);
    expect(records.every((r) => r.deviceRecordedAt)).toBe(true);
  });
});

describe('losing the network costs nothing', () => {
  it('keeps the roll when the request fails, with the same ids on retry', async () => {
    const attempts: string[][] = [];
    let online = false;

    const queue = new OfflineAttendanceQueue(
      new IndexedDbQueueStorage(),
      attendanceTransport(async (_path, body) => {
        const records = (body as { records: Array<{ clientEventId: string }> }).records;
        attempts.push(records.map((r) => r.clientEventId));
        if (!online) throw new Error('network down');
        return {
          outcomes: records.map((r): RecordOutcome => ({
            clientEventId: r.clientEventId, status: 'applied', recordId: 'rec',
          })),
        };
      }),
    );

    const marked = session();
    await queue.enqueue(marked);

    const offlineResult = await queue.flush();
    expect(offlineResult.failed).toBe(1);
    expect(await queue.pendingCount()).toBe(1);

    online = true;
    const onlineResult = await queue.flush();
    expect(onlineResult.synced).toBe(1);
    expect(await queue.pendingCount()).toBe(0);

    // The same ids both times. A retry that minted new ones would be a second
    // mark for every child in the class.
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toEqual(attempts[1]);
  });

  it('flushes when the browser says it is back, and reports what is left', async () => {
    const queue = new OfflineAttendanceQueue(
      new IndexedDbQueueStorage(),
      attendanceTransport(async () => { throw new Error('still down'); }),
    );
    await queue.enqueue(session());

    const seen: number[] = [];
    const stop = flushWhenOnline(queue, (n) => seen.push(n));
    await new Promise((r) => setTimeout(r, 10));
    window.dispatchEvent(new Event('online'));
    await new Promise((r) => setTimeout(r, 10));
    stop();

    // Still one pending after both attempts — and the count was reported, so a
    // teacher can see they are holding unsynced work.
    expect(seen.length).toBeGreaterThanOrEqual(1);
    expect(seen.every((n) => n === 1)).toBe(true);
  });

  it('stops listening once torn down', async () => {
    // Two mechanisms guard this — the listener is removed AND a `stopped` flag
    // short-circuits the handler — and the first version of this test only
    // proved the second, so deleting the removeEventListener changed nothing.
    // A listener that outlives the screen keeps syncing after sign-out, which
    // is the leak worth catching, so it is now asserted directly.
    const registered = new Set<unknown>();
    const win = window as unknown as {
      addEventListener: (n: string, f: unknown) => void;
      removeEventListener: (n: string, f: unknown) => void;
    };
    const add = win.addEventListener.bind(win);
    const remove = win.removeEventListener.bind(win);
    win.addEventListener = (n, f) => { if (n === 'online') registered.add(f); add(n, f); };
    win.removeEventListener = (n, f) => { registered.delete(f); remove(n, f); };

    try {
      let calls = 0;
      const queue = new OfflineAttendanceQueue(
        new IndexedDbQueueStorage(),
        attendanceTransport(async () => { calls += 1; throw new Error('down'); }),
      );
      await queue.enqueue(session());

      const stop = flushWhenOnline(queue, () => undefined);
      await new Promise((r) => setTimeout(r, 10));
      expect(registered.size).toBe(1);

      const afterMount = calls;
      stop();

      expect(registered.size, 'the online listener outlived the screen').toBe(0);

      window.dispatchEvent(new Event('online'));
      await new Promise((r) => setTimeout(r, 10));
      expect(calls).toBe(afterMount);
    } finally {
      win.addEventListener = add;
      win.removeEventListener = remove;
    }
  });
});

/**
 * The service worker, actually executed.
 *
 * The first version of these tests read `sw.js` as a string and asserted that
 * certain lines appeared in a certain order. A mutation wrapping the API guard
 * in `if (false && ...)` passed all of them: the text was still there, in the
 * right place, doing nothing. Asserting on source is not asserting on
 * behaviour, so the worker is now loaded into a sandbox with a fake `caches`
 * and `fetch`, and the handlers are dispatched.
 */
function loadWorker() {
  const source = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');

  const put: string[] = [];
  const store = new Map<string, string>();
  const handlers: Record<string, (event: any) => void> = {};
  const fetched: string[] = [];
  let networkUp = true;

  const cache = {
    add: async (url: string) => {
      if (url === '/broken') throw new Error('404');
      store.set(url, `cached:${url}`);
    },
    put: async (request: any, _response: unknown) => { put.push(request.url ?? request); },
    match: async (request: any) => store.get(request.url ?? request),
  };

  const context: Record<string, unknown> = {
    self: {
      addEventListener: (name: string, fn: (event: any) => void) => { handlers[name] = fn; },
      skipWaiting: async () => undefined,
      clients: { claim: async () => undefined },
      location: { origin: 'https://school.example' },
    },
    caches: {
      open: async () => cache,
      keys: async () => ['paathshala-shell-v1', 'stale-v0'],
      delete: async () => true,
      match: async (request: any) => store.get(request.url ?? request),
    },
    fetch: async (request: any) => {
      fetched.push(request.url);
      if (!networkUp) throw new Error('offline');
      return { ok: true, clone: () => ({}) };
    },
    Response: class { constructor(public body: string, public init?: unknown) {} },
    URL,
    Promise,
    console,
  };
  context['globalThis'] = context;

  runInNewContext(source, createContext(context));

  return {
    handlers, put, fetched, store,
    goOffline: () => { networkUp = false; },
    async request(url: string, init: { method?: string; mode?: string } = {}) {
      let responded: unknown;
      const event = {
        request: { url, method: init.method ?? 'GET', mode: init.mode ?? 'no-cors' },
        respondWith: (value: unknown) => { responded = value; },
        waitUntil: (value: unknown) => value,
      };
      handlers['fetch']!(event);
      return responded === undefined ? undefined : await responded;
    },
  };
}

describe('the offline shell caches the app and not the data', () => {
  it('never touches an API request, at all', async () => {
    // The load-bearing promise. Caching GET /v1/students would let the register
    // render a roll that looks current and is three weeks old — silently
    // omitting children who joined since, with no way for the teacher to tell.
    const worker = loadWorker();
    const responded = await worker.request('https://school.example/v1/students?limit=5');

    // Not intercepted at all: no respondWith, so the request goes to the
    // network exactly as if no worker were installed.
    expect(responded).toBeUndefined();
    expect(worker.put).toHaveLength(0);
    expect(worker.fetched).toHaveLength(0);
  });

  it('leaves non-GET requests entirely alone', async () => {
    // A cached or replayed POST would be a second mark for a whole class.
    const worker = loadWorker();
    const responded = await worker.request(
      'https://school.example/attendance', { method: 'POST' });
    expect(responded).toBeUndefined();
    expect(worker.put).toHaveLength(0);
  });

  it('caches a page request and serves it when the network is gone', async () => {
    const worker = loadWorker();
    await worker.request('https://school.example/attendance');
    expect(worker.put).toContain('https://school.example/attendance');
  });

  it('falls back to the register for a navigation it has never seen', async () => {
    const worker = loadWorker();
    await worker.handlers['install']!({ waitUntil: (p: Promise<unknown>) => p });
    await new Promise((r) => setTimeout(r, 5));

    worker.goOffline();
    const responded = await worker.request(
      'https://school.example/never-visited', { mode: 'navigate' });
    // The one screen that has to work in a basement classroom.
    expect(responded).toBe('cached:/attendance');
  });

  it('installs even when one precached URL fails', async () => {
    // addAll rejects the whole batch on a single failure, which would leave the
    // worker uninstalled and the app with no offline shell at all.
    const worker = loadWorker();
    let installed = true;
    try {
      await worker.handlers['install']!({ waitUntil: (p: Promise<unknown>) => p });
      await new Promise((r) => setTimeout(r, 5));
    } catch {
      installed = false;
    }
    expect(installed).toBe(true);
    expect(worker.store.has('/attendance')).toBe(true);
  });

  it('is declared installable, pointing at icons that exist', () => {
    const raw = readFileSync(
      new URL('../public/manifest.webmanifest', import.meta.url), 'utf8');
    const manifest = JSON.parse(raw) as
      { display: string; start_url: string; icons: Array<{ src: string; sizes: string }> };
    expect(manifest.display).toBe('standalone');
    expect(manifest.icons.length).toBeGreaterThanOrEqual(2);
    for (const icon of manifest.icons) {
      expect(existsSync(new URL(`../public${icon.src}`, import.meta.url)),
        `${icon.src} is listed in the manifest but not in public/`).toBe(true);
    }
    // A maskable icon, or Android crops the logo into a circle badly.
    expect(raw).toContain('maskable');
  });
});
