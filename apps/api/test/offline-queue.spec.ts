/**
 * M6.3 — the client side of AC-5.
 *
 * Pure unit tests: storage and transport are injected, so the behaviour a
 * teacher actually experiences in a basement classroom is testable without a
 * device.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  OfflineAttendanceQueue, InMemoryQueueStorage, MAX_QUEUE_AGE_DAYS,
  type SyncTransport, type QueuedSession,
} from '../src/modules/attendance/offline-queue.ts';
import type { RecordOutcome, MarkInput } from '../src/modules/attendance/attendance.service.ts';

let storage: InMemoryQueueStorage;
let calls: Array<{ sessionId: string; records: MarkInput[] }>;

function transportReturning(
  outcomesFor: (records: MarkInput[]) => RecordOutcome[],
): SyncTransport {
  return {
    async sync(input) {
      calls.push({ sessionId: input.sessionId, records: input.records });
      return { outcomes: outcomesFor(input.records) };
    },
  };
}

const allApplied = (records: MarkInput[]): RecordOutcome[] =>
  records.map((r) => ({ clientEventId: r.clientEventId, status: 'applied', recordId: randomUUID() }));

function aSession(overrides: Partial<QueuedSession> = {}) {
  const records: MarkInput[] = [
    { clientEventId: randomUUID(), studentId: randomUUID(), state: 'present' },
    { clientEventId: randomUUID(), studentId: randomUUID(), state: 'absent' },
  ];
  return {
    localId: randomUUID(),
    serverSessionId: randomUUID(),
    sectionId: randomUUID(),
    sessionDate: new Date().toISOString().slice(0, 10),
    records,
    ...overrides,
  };
}

beforeEach(() => {
  storage = new InMemoryQueueStorage();
  calls = [];
});

describe('the pending badge', () => {
  it('counts queued sessions so a teacher is never unaware of unsynced work', async () => {
    const queue = new OfflineAttendanceQueue(storage, transportReturning(allApplied));
    expect(await queue.pendingCount()).toBe(0);

    await queue.enqueue(aSession());
    await queue.enqueue(aSession());
    // An invisible queue is how a day of attendance quietly disappears when a
    // phone is replaced.
    expect(await queue.pendingCount()).toBe(2);
  });

  it('drops to zero once everything is applied', async () => {
    const queue = new OfflineAttendanceQueue(storage, transportReturning(allApplied));
    await queue.enqueue(aSession());
    const result = await queue.flush();
    expect(result.synced).toBe(1);
    expect(await queue.pendingCount()).toBe(0);
    expect(await queue.all()).toHaveLength(0);
  });
});

describe('retries reuse the same client event ids', () => {
  it('never regenerates an id across attempts', async () => {
    let failOnce = true;
    const queue = new OfflineAttendanceQueue(storage, {
      async sync(input) {
        calls.push({ sessionId: input.sessionId, records: input.records });
        if (failOnce) {
          failOnce = false;
          throw new Error('network unreachable');
        }
        return { outcomes: allApplied(input.records) };
      },
    });

    const session = aSession();
    await queue.enqueue(session);

    const first = await queue.flush();
    expect(first.failed).toBe(1);
    // A transport failure must never consume the queue entry.
    expect(await queue.pendingCount()).toBe(1);

    const second = await queue.flush();
    expect(second.synced).toBe(1);

    // The same ids on both attempts. A retry that minted new ids would be a new
    // record to the server, and a flaky connection would double every class.
    expect(calls).toHaveLength(2);
    expect(calls[0]!.records.map((r) => r.clientEventId))
      .toEqual(calls[1]!.records.map((r) => r.clientEventId));
  });

  it('records the error for the teacher to see', async () => {
    const queue = new OfflineAttendanceQueue(storage, {
      async sync() { throw new Error('DNS failure'); },
    });
    await queue.enqueue(aSession());
    await queue.flush();

    const [entry] = await queue.all();
    expect(entry!.lastError).toMatch(/DNS failure/);
    expect(entry!.attempts).toBe(1);
  });
});

describe('conflicts stay visible until a human decides', () => {
  const conflicting = (records: MarkInput[]): RecordOutcome[] => [
    { clientEventId: records[0]!.clientEventId, status: 'applied', recordId: randomUUID() },
    {
      clientEventId: records[1]!.clientEventId, status: 'conflict', recordId: 'server-record-1',
      existing: { state: 'present', recordedByStaffId: 'other-teacher', recordedAt: '2026-09-18T04:00:00Z' },
      submitted: { state: 'absent' },
    },
  ];

  it('marks the session as needing attention rather than dropping it', async () => {
    const queue = new OfflineAttendanceQueue(storage, transportReturning(conflicting));
    const session = aSession();
    await queue.enqueue(session);

    const result = await queue.flush();
    expect(result.conflicted).toBe(1);

    const needing = await queue.needsAttention();
    expect(needing).toHaveLength(1);
    // An unresolved conflict that disappears is worse than one that nags.
    expect(needing[0]!.conflicts).toHaveLength(1);
    expect(needing[0]!.conflicts![0]).toMatchObject({ mine: 'absent', theirs: 'present' });
  });

  it('keeping theirs drops our version and clears the session', async () => {
    const queue = new OfflineAttendanceQueue(storage, transportReturning(conflicting));
    const session = aSession();
    await queue.enqueue(session);
    await queue.flush();

    const [entry] = await queue.needsAttention();
    await queue.resolveConflict(entry!.localId, entry!.conflicts![0]!.clientEventId, 'theirs');

    const remaining = await queue.all();
    // One record was applied, the conflicting one was abandoned, nothing is
    // left to resend.
    expect(remaining).toHaveLength(0);
  });

  it('keeping mine re-queues it for the next flush', async () => {
    const queue = new OfflineAttendanceQueue(storage, transportReturning(conflicting));
    const session = aSession();
    await queue.enqueue(session);
    await queue.flush();

    const [entry] = await queue.needsAttention();
    await queue.resolveConflict(entry!.localId, entry!.conflicts![0]!.clientEventId, 'mine');

    expect(await queue.pendingCount()).toBe(1);
    const [requeued] = await queue.all();
    expect(requeued!.state).toBe('pending');
    // Only the disputed record is resent. The one that was already applied left
    // the queue on the first flush, because the queue holds work still to do.
    expect(requeued!.records).toHaveLength(1);
    expect(requeued!.records[0]!.clientEventId).toBe(entry!.conflicts![0]!.clientEventId);
  });

  it('does not flush a session that is awaiting a decision', async () => {
    const queue = new OfflineAttendanceQueue(storage, transportReturning(conflicting));
    await queue.enqueue(aSession());
    await queue.flush();
    calls = [];

    await queue.flush();
    // Re-sending a session the teacher has not resolved would either replay
    // harmlessly or re-raise the same conflict; either way it is noise.
    expect(calls).toHaveLength(0);
  });
});

describe('correction outcomes are surfaced, not swallowed', () => {
  it('marks the session as needing attention when records went for approval', async () => {
    const queue = new OfflineAttendanceQueue(storage, transportReturning((records) =>
      records.map((r) => ({
        clientEventId: r.clientEventId, status: 'correction_requested',
        correctionId: randomUUID(), reason: 'The session was locked before this arrived.',
      })),
    ));
    await queue.enqueue(aSession());

    const result = await queue.flush();
    expect(result.corrections).toBe(1);
    // The teacher is told the records went for approval instead of being
    // applied, rather than the queue simply emptying.
    expect(await queue.needsAttention()).toHaveLength(1);
  });
});

describe('the seven-day bound', () => {
  it('identifies sessions the server will convert into corrections', async () => {
    const fixedNow = new Date('2026-09-18T10:00:00Z');
    const queue = new OfflineAttendanceQueue(
      storage, transportReturning(allApplied), () => fixedNow,
    );

    await queue.enqueue(aSession({ sessionDate: '2026-09-17' }));
    await queue.enqueue(aSession({ sessionDate: '2026-08-20' }));

    const stale = await queue.stale();
    expect(stale).toHaveLength(1);
    expect(stale[0]!.sessionDate).toBe('2026-08-20');
    expect(MAX_QUEUE_AGE_DAYS).toBe(7);
  });

  it('still attempts a stale session, because the server decides', async () => {
    const fixedNow = new Date('2026-09-18T10:00:00Z');
    const queue = new OfflineAttendanceQueue(
      storage, transportReturning(allApplied), () => fixedNow,
    );
    await queue.enqueue(aSession({ sessionDate: '2026-08-20' }));
    await queue.flush();

    // The client flags staleness for the UI; it does not refuse to send. One
    // place decides what happens to a late record, and it is the server.
    expect(calls).toHaveLength(1);
  });
});

describe('re-enqueueing the same session', () => {
  it('replaces rather than duplicating', async () => {
    const queue = new OfflineAttendanceQueue(storage, transportReturning(allApplied));
    const session = aSession();
    await queue.enqueue(session);
    await queue.enqueue({ ...session, records: [session.records[0]!] });

    const all = await queue.all();
    expect(all).toHaveLength(1);
    expect(all[0]!.records).toHaveLength(1);
  });
});
