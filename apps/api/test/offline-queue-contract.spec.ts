/**
 * The shared queue and the server must agree, or attendance is lost silently.
 *
 * `packages/offline-queue` declares the attendance vocabulary itself rather
 * than importing it from here, because it runs where this package does not —
 * a browser with no connection, and a phone in a classroom with one bar. The
 * cost of that independence is that the two can drift, and the failure mode of
 * drift is the worst one this product has: a teacher marks a register, the
 * queue posts a shape the server does not recognise, and the day is gone.
 *
 * So the two are checked against each other. The type assertions below fail the
 * typecheck; the runtime ones fail the suite. Both, because a contract enforced
 * only at compile time is a contract that a `skipLibCheck` or an `any` at the
 * boundary quietly removes.
 */
import { describe, it, expect } from 'vitest';
import type {
  AttendanceState as ServerState,
  MarkInput as ServerMark,
  RecordOutcome as ServerOutcome,
} from '../src/modules/attendance/attendance.service.ts';
import type {
  AttendanceState as QueueState,
  MarkInput as QueueMark,
  RecordOutcome as QueueOutcome,
  BoardingKind as QueueBoardingKind,
} from '@paathshala/offline-queue';
import type { BoardingKind as ServerBoardingKind }
  from '../src/modules/transport/transport.service.ts';

/** Compile-time equality. `Equal<A, B>` is true only if the types are identical. */
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
function assertEqual<T extends true>(_?: T): void { /* type-level only */ }

assertEqual<Equal<ServerState, QueueState>>();
assertEqual<Equal<ServerMark, QueueMark>>();
assertEqual<Equal<ServerOutcome, QueueOutcome>>();
assertEqual<Equal<ServerBoardingKind, QueueBoardingKind>>();

/**
 * The runtime half.
 *
 * Reads the outcome statuses the SERVICE can actually produce out of its own
 * source, and checks the queue branches on all of them. A status added to the
 * server and not handled here falls through the queue's filters into
 * "everything synced", which is the silent-loss case.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const serviceSource = readFileSync(
  fileURLToPath(new URL('../src/modules/attendance/attendance.service.ts', import.meta.url)),
  'utf8');
const queueSource = readFileSync(
  fileURLToPath(new URL('../../../packages/offline-queue/src/queue.ts', import.meta.url)),
  'utf8');
const transportSource = readFileSync(
  fileURLToPath(new URL('../src/modules/transport/transport.controller.ts', import.meta.url)),
  'utf8');
const boardingSource = readFileSync(
  fileURLToPath(new URL('../../../packages/offline-queue/src/boarding.ts', import.meta.url)),
  'utf8');

describe('the queue and the server speak the same language', () => {
  it('handles every outcome status the server can return', () => {
    const declared = [...serviceSource.matchAll(/status:\s*'([a-z_]+)'/g)]
      .map((m) => m[1]!);
    const statuses = [...new Set(declared)];

    // Sanity: if this regex ever stops matching, the test below passes
    // vacuously and proves nothing.
    expect(statuses.length).toBeGreaterThanOrEqual(5);
    expect(statuses).toContain('conflict');

    for (const status of statuses) {
      expect(queueSource, `the queue never mentions the "${status}" outcome`)
        .toContain(`'${status}'`);
    }
  });

  it('sends a boarding payload the endpoint will actually accept', () => {
    // The endpoint's schema rejects unknown keys, so a field the queue sends
    // and the controller does not name is a 422 on a bus with no signal —
    // which is to say, a morning's run lost. Compared against the controller
    // rather than the service because the controller is what validates.
    const accepted = new Set(
      [...transportSource.matchAll(/^\s{4}(\w+): [a-zA-Z]/gm)].map((m) => m[1]!));
    expect(accepted.size).toBeGreaterThanOrEqual(7);

    const sent = [...boardingSource.matchAll(/^\s{2}(\w+)\??:/gm)].map((m) => m[1]!)
      // Bookkeeping the queue keeps for itself; `strip` removes it before send.
      .filter((f) => !['queuedAt', 'attempts', 'lastError'].includes(f));

    for (const field of new Set(sent)) {
      expect(accepted, `the endpoint does not accept "${field}"`).toContain(field);
    }
  });

  it('keeps the client event id as the idempotency key on both sides', () => {
    // The whole basis of a safe retry. If either side stopped keying on it, a
    // flaky connection would double every class rather than replaying it.
    expect(serviceSource).toContain('clientEventId');
    expect(queueSource).toContain('clientEventId');
    expect(queueSource).not.toMatch(/clientEventId\s*[:=]\s*randomUUID/);
    // And on the bus, where the same retry produces the same event.
    expect(boardingSource).toContain('clientEventId');
    expect(boardingSource).not.toMatch(/clientEventId\s*[:=]\s*randomUUID/);
  });
});
