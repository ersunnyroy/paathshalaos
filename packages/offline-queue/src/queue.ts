import type { AttendanceState, MarkInput, RecordOutcome } from './types.ts';

/**
 * The client-side offline queue.
 *
 * Shared by every client: the web app today, the React Native app when it
 * lands. It has NO dependency on React Native, IndexedDB, SQLite or fetch —
 * storage and transport are injected — which is what makes the conflict
 * behaviour testable in Node rather than only on a device in a basement
 * classroom.
 */

export interface QueuedSession {
  /** Client-generated, so a session can be queued before the server knows of it. */
  localId: string;
  serverSessionId: string;
  sectionId: string;
  sessionDate: string;
  records: MarkInput[];
  queuedAt: string;
  attempts: number;
  lastError?: string;
  state: 'draft' | 'pending' | 'syncing' | 'synced' | 'needs_attention';
  conflicts?: Array<{
    clientEventId: string;
    mine: AttendanceState;
    theirs: AttendanceState;
    theirRecordId: string;
  }>;
}

/** Whatever the platform provides: SQLite on device, a Map in tests. */
export interface QueueStorage {
  read(): Promise<QueuedSession[]>;
  write(sessions: QueuedSession[]): Promise<void>;
}

export interface SyncTransport {
  sync(input: {
    sessionId: string;
    records: MarkInput[];
    deviceClock: string;
  }): Promise<{ outcomes: RecordOutcome[] }>;
}

export const MAX_QUEUE_AGE_DAYS = 7;

export class OfflineAttendanceQueue {
  constructor(
    private readonly storage: QueueStorage,
    private readonly transport: SyncTransport,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Queues a submitted session.
   *
   * The client_event_id is generated HERE, before any network call, and never
   * regenerated on retry. That is the whole basis of idempotency: a retry that
   * minted a new id would be a new record to the server, and a flaky connection
   * would silently double every class.
   */
  async enqueue(session: Omit<QueuedSession, 'queuedAt' | 'attempts' | 'state'>): Promise<void> {
    const sessions = await this.storage.read();
    const existing = sessions.findIndex((s) => s.localId === session.localId);
    const entry: QueuedSession = {
      ...session,
      queuedAt: this.now().toISOString(),
      attempts: 0,
      state: 'pending',
    };
    if (existing >= 0) sessions[existing] = entry;
    else sessions.push(entry);
    await this.storage.write(sessions);
  }

  /**
   * What the badge shows. A teacher must never be unaware they are holding
   * unsynced work — an invisible queue is how a day of attendance quietly
   * disappears when a phone is replaced.
   */
  async pendingCount(): Promise<number> {
    const sessions = await this.storage.read();
    return sessions.filter((s) => s.state === 'pending' || s.state === 'syncing').length;
  }

  async needsAttention(): Promise<QueuedSession[]> {
    const sessions = await this.storage.read();
    return sessions.filter((s) => s.state === 'needs_attention');
  }

  /** Sessions past the bound, which the server will convert into corrections. */
  async stale(): Promise<QueuedSession[]> {
    const cutoff = this.now().getTime() - MAX_QUEUE_AGE_DAYS * 86_400_000;
    const sessions = await this.storage.read();
    return sessions.filter(
      (s) => s.state === 'pending' && Date.parse(s.sessionDate) < cutoff,
    );
  }

  /**
   * Drains the queue. Returns what happened per session so the UI can show it.
   *
   * A session is only removed from the queue once every record in it reached a
   * terminal outcome. Anything needing a human decision stays visible as
   * `needs_attention` rather than being dropped — an unresolved conflict that
   * disappears is worse than one that nags.
   */
  async flush(): Promise<{
    synced: number; conflicted: number; corrections: number; failed: number;
  }> {
    const sessions = await this.storage.read();
    let synced = 0, conflicted = 0, corrections = 0, failed = 0;

    for (const session of sessions) {
      if (session.state !== 'pending') continue;

      session.state = 'syncing';
      session.attempts += 1;

      try {
        const { outcomes } = await this.transport.sync({
          sessionId: session.serverSessionId,
          records: session.records,
          deviceClock: this.now().toISOString(),
        });

        const conflicts = outcomes.filter(
          (o): o is Extract<RecordOutcome, { status: 'conflict' }> => o.status === 'conflict',
        );
        const correctionOutcomes = outcomes.filter((o) => o.status === 'correction_requested');
        const rejected = outcomes.filter((o) => o.status === 'rejected');

        // Records that reached a settled outcome leave the queue. The queue
        // holds work that still needs doing, so resolving the last conflict
        // empties it instead of leaving already-applied records to be replayed
        // on the next flush.
        const settled = new Set(
          outcomes
            .filter((o) => o.status === 'applied' || o.status === 'already_applied'
              || o.status === 'correction_requested')
            .map((o) => o.clientEventId),
        );
        session.records = session.records.filter((r) => !settled.has(r.clientEventId));

        if (conflicts.length > 0) {
          session.state = 'needs_attention';
          session.conflicts = conflicts.map((c) => ({
            clientEventId: c.clientEventId,
            mine: c.submitted.state,
            theirs: c.existing.state,
            theirRecordId: c.recordId,
          }));
          conflicted += 1;
        } else if (correctionOutcomes.length > 0 || rejected.length > 0) {
          // Not an error, and not silently fine either: the teacher is told the
          // records went for approval instead of being applied.
          session.state = 'needs_attention';
          corrections += correctionOutcomes.length > 0 ? 1 : 0;
          failed += rejected.length > 0 && correctionOutcomes.length === 0 ? 1 : 0;
        } else {
          session.state = 'synced';
          synced += 1;
        }
      } catch (err) {
        // Still pending, so the next flush retries with the SAME client event
        // ids. A transport failure must never consume the queue entry.
        session.state = 'pending';
        session.lastError = err instanceof Error ? err.message : 'sync failed';
        failed += 1;
      }
    }

    await this.storage.write(sessions.filter((s) => s.state !== 'synced'));
    return { synced, conflicted, corrections, failed };
  }

  /** The teacher picks a side on a conflict; the chosen value re-enters the queue. */
  async resolveConflict(
    localId: string,
    clientEventId: string,
    keep: 'mine' | 'theirs',
  ): Promise<void> {
    const sessions = await this.storage.read();
    const session = sessions.find((s) => s.localId === localId);
    if (!session) return;

    session.conflicts = (session.conflicts ?? []).filter(
      (c) => c.clientEventId !== clientEventId,
    );

    if (keep === 'theirs') {
      // Drop our version entirely rather than resubmitting it.
      session.records = session.records.filter((r) => r.clientEventId !== clientEventId);
    }

    if ((session.conflicts?.length ?? 0) === 0) {
      session.state = session.records.length > 0 ? 'pending' : 'synced';
    }
    await this.storage.write(sessions.filter((s) => s.state !== 'synced'));
  }

  async all(): Promise<QueuedSession[]> {
    return this.storage.read();
  }
}

/** An in-memory storage, used by the tests and as the reference implementation. */
export class InMemoryQueueStorage implements QueueStorage {
  private sessions: QueuedSession[] = [];
  async read(): Promise<QueuedSession[]> {
    return structuredClone(this.sessions);
  }
  async write(sessions: QueuedSession[]): Promise<void> {
    this.sessions = structuredClone(sessions);
  }
}
