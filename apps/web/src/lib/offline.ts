/**
 * Attendance that survives losing the network (M17.2).
 *
 * The server side of AC-5 has been finished and tested since M6: idempotent
 * marks keyed on a client event id, six conflict paths, corrections for
 * anything past the bound. What was missing was a client that used any of it.
 * The attendance screen posted straight to the API with no client event id at
 * all, which means a retry on a flaky connection was a second mark rather than
 * a replay — the exact failure the server was built to absorb.
 *
 * So the screen now writes to a queue first and syncs second. That ordering is
 * the whole thing: a teacher taking a register in a basement classroom has
 * finished their job the moment the roll is in the queue, and whether the
 * network was there is our problem rather than theirs.
 *
 * The queue itself lives in `@paathshala/offline-queue` with no browser
 * dependency, so its conflict behaviour is tested in Node. This file is the two
 * browser-shaped holes it leaves: where the rows are kept, and how they travel.
 */
import {
  OfflineAttendanceQueue,
  type QueueStorage, type QueuedSession, type SyncTransport,
  type MarkInput, type RecordOutcome,
} from '@paathshala/offline-queue';

const DB_NAME = 'paathshala.attendance';
const STORE = 'queue';
const KEY = 'sessions';
const VERSION = 1;

/**
 * IndexedDB, not localStorage.
 *
 * A register for a large section is tens of kilobytes of JSON and localStorage
 * is a synchronous 5MB bucket shared with everything else on the origin — a
 * full one throws on write, and a throw here loses a teacher's morning. This
 * also keeps the writes off the main thread, which matters on the cheap Android
 * hardware these schools actually use.
 */
export class IndexedDbQueueStorage implements QueueStorage {
  private open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, VERSION);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE)) {
          request.result.createObjectStore(STORE);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('indexeddb open failed'));
    });
  }

  async read(): Promise<QueuedSession[]> {
    const db = await this.open();
    try {
      const value = await new Promise<unknown>((resolve, reject) => {
        const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(KEY);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('read failed'));
      });
      // Anything that is not an array is treated as an empty queue rather than
      // thrown on. A corrupt record must not be able to break the register
      // screen on every subsequent load — that turns one bad write into a
      // teacher who cannot mark attendance at all.
      return Array.isArray(value) ? (value as QueuedSession[]) : [];
    } finally {
      db.close();
    }
  }

  async write(sessions: QueuedSession[]): Promise<void> {
    const db = await this.open();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(sessions, KEY);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error('write failed'));
        tx.onabort = () => reject(tx.error ?? new Error('write aborted'));
      });
    } finally {
      db.close();
    }
  }
}

/** Posts a queued session at the real endpoint. Injected, so the queue stays pure. */
export function attendanceTransport(
  post: (path: string, body: unknown) => Promise<{ outcomes: RecordOutcome[] }>,
): SyncTransport {
  return {
    async sync(input) {
      return post(`/v1/attendance/sessions/${input.sessionId}/marks`, {
        records: input.records,
        deviceClock: input.deviceClock,
      });
    },
  };
}

/** The id that makes a retry a replay rather than a second mark. */
export function newClientEventId(): string {
  return crypto.randomUUID();
}

export function buildRecords(
  roll: Array<{ studentId: string; state: MarkInput['state'] }>,
): MarkInput[] {
  const at = new Date().toISOString();
  return roll.map((r) => ({
    clientEventId: newClientEventId(),
    studentId: r.studentId,
    state: r.state,
    deviceRecordedAt: at,
  }));
}

let singleton: OfflineAttendanceQueue | null = null;

export function attendanceQueue(
  post: (path: string, body: unknown) => Promise<{ outcomes: RecordOutcome[] }>,
): OfflineAttendanceQueue {
  singleton ??= new OfflineAttendanceQueue(
    new IndexedDbQueueStorage(), attendanceTransport(post));
  return singleton;
}

/** Test seam. */
export function resetAttendanceQueue(): void {
  singleton = null;
}

/**
 * Drains the queue now, and again whenever the browser says it is back.
 *
 * `navigator.onLine` is famously optimistic — it reports true for a captive
 * portal and for a connection that resolves DNS and nothing else — so it is
 * used only as a hint to try, never as permission to skip trying. A failed
 * flush leaves everything queued and costs one request.
 */
export function flushWhenOnline(
  queue: OfflineAttendanceQueue,
  onChange: (pending: number) => void,
): () => void {
  let stopped = false;

  const attempt = async () => {
    if (stopped) return;
    try { await queue.flush(); } catch { /* still queued; nothing is lost */ }
    if (!stopped) onChange(await queue.pendingCount());
  };

  void attempt();
  window.addEventListener('online', attempt);
  return () => {
    stopped = true;
    window.removeEventListener('online', attempt);
  };
}
