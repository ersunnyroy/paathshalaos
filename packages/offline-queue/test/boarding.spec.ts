/**
 * The boarding queue, against the failures that matter on a bus.
 *
 * Every test here is a sentence about a child: one who was marked and must not
 * be marked twice, one whose state changed before the bus left, and one whose
 * absence must survive a tunnel. A queue that loses the third is how a child
 * standing at a kerb becomes a child nobody looked for.
 */
import { describe, it, expect } from 'vitest';
import {
  OfflineBoardingQueue, InMemoryBoardingStorage,
  type BoardingInput, type BoardingTransport,
} from '../src/boarding.ts';

const EVENT = (over: Partial<BoardingInput> = {}): BoardingInput => ({
  clientEventId: 'evt-1',
  studentId: 'child-1',
  routeId: 'route-1',
  direction: 'pickup',
  kind: 'boarded',
  ...over,
});

function transport(behaviour: 'ok' | 'throw' | 'replay' = 'ok') {
  const seen: BoardingInput[][] = [];
  const t: BoardingTransport = {
    async send(events) {
      seen.push(events);
      if (behaviour === 'throw') throw new Error('Network request failed');
      return behaviour === 'replay'
        ? { recorded: 0, replayed: events.length }
        : { recorded: events.length, replayed: 0 };
    },
  };
  return { t, seen };
}

describe('recording at the kerb', () => {
  it('holds the tap before anything touches the network', async () => {
    const storage = new InMemoryBoardingStorage();
    const { t, seen } = transport();
    const queue = new OfflineBoardingQueue(storage, t);

    await queue.record(EVENT());

    // Recorded, and nothing sent. A driver's job is finished the moment the
    // tap is in the queue; whether there was signal is our problem.
    expect(await queue.pendingCount()).toBe(1);
    expect(seen).toHaveLength(0);
  });

  it('does not queue the same tap twice', async () => {
    const storage = new InMemoryBoardingStorage();
    const queue = new OfflineBoardingQueue(storage, transport().t);

    await queue.record(EVENT());
    await queue.record(EVENT());

    expect(await queue.pendingCount()).toBe(1);
  });

  it('lets a correction replace what is queued', async () => {
    // The driver marked a child absent, then the child ran up to the bus. The
    // bus has not left; only the last answer is true.
    const storage = new InMemoryBoardingStorage();
    const queue = new OfflineBoardingQueue(storage, transport().t);

    await queue.record(EVENT({ kind: 'absent' }));
    await queue.record(EVENT({ kind: 'boarded' }));

    const held = await queue.all();
    expect(held).toHaveLength(1);
    expect(held[0]!.kind).toBe('boarded');
  });

  it('keeps two different children apart', async () => {
    const storage = new InMemoryBoardingStorage();
    const queue = new OfflineBoardingQueue(storage, transport().t);

    await queue.record(EVENT());
    await queue.record(EVENT({ clientEventId: 'evt-2', studentId: 'child-2' }));

    expect(await queue.pendingCount()).toBe(2);
  });
});

describe('sending', () => {
  it('sends the whole queue in one call', async () => {
    const storage = new InMemoryBoardingStorage();
    const { t, seen } = transport();
    const queue = new OfflineBoardingQueue(storage, t);

    await queue.record(EVENT());
    await queue.record(EVENT({ clientEventId: 'evt-2', studentId: 'child-2' }));
    const result = await queue.flush();

    // One request, not two. A client looping over a flaky link gets a partial
    // result it has no way to interpret.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toHaveLength(2);
    expect(result).toEqual({ sent: 2, replayed: 0, failed: 0 });
    expect(await queue.pendingCount()).toBe(0);
  });

  it('sends nothing when there is nothing to send', async () => {
    const { t, seen } = transport();
    const queue = new OfflineBoardingQueue(new InMemoryBoardingStorage(), t);
    expect(await queue.flush()).toEqual({ sent: 0, replayed: 0, failed: 0 });
    expect(seen).toHaveLength(0);
  });

  it('treats a replay as done, not as a failure', async () => {
    // The bus came back into signal and re-sent. That is the design working,
    // and a client that treated it as a failure would retry for ever.
    const storage = new InMemoryBoardingStorage();
    const queue = new OfflineBoardingQueue(storage, transport('replay').t);

    await queue.record(EVENT());
    const result = await queue.flush();

    expect(result).toEqual({ sent: 0, replayed: 1, failed: 0 });
    expect(await queue.pendingCount()).toBe(0);
  });

  it('never strips the queue on a transport failure', async () => {
    const storage = new InMemoryBoardingStorage();
    const queue = new OfflineBoardingQueue(storage, transport('throw').t);

    await queue.record(EVENT({ kind: 'no_show' }));
    const result = await queue.flush();

    expect(result).toEqual({ sent: 0, replayed: 0, failed: 1 });
    // This is the one that matters: a child marked as not at their stop, whose
    // record was eaten by a failed request, is a child nobody looks for.
    expect(await queue.pendingCount()).toBe(1);
    expect((await queue.all())[0]!.kind).toBe('no_show');
    expect((await queue.all())[0]!.lastError).toBe('Network request failed');
  });

  it('retries with the SAME id after a failure', async () => {
    const storage = new InMemoryBoardingStorage();
    const failing = transport('throw');
    const queue = new OfflineBoardingQueue(storage, failing.t);
    await queue.record(EVENT());
    await queue.flush();

    const working = transport();
    const retry = new OfflineBoardingQueue(storage, working.t);
    await retry.flush();

    // A retry that minted a new id would be a new event to the server, and a
    // tunnel would double every child on the bus.
    expect(working.seen[0]![0]!.clientEventId).toBe('evt-1');
    expect(await retry.pendingCount()).toBe(0);
  });

  it('counts attempts so a stuck queue is visible', async () => {
    const storage = new InMemoryBoardingStorage();
    const queue = new OfflineBoardingQueue(storage, transport('throw').t);
    await queue.record(EVENT());
    await queue.flush();
    await queue.flush();
    expect((await queue.all())[0]!.attempts).toBe(2);
  });

  it('sends the payload the server takes, and nothing else', async () => {
    const storage = new InMemoryBoardingStorage();
    const { t, seen } = transport();
    const queue = new OfflineBoardingQueue(storage, t);
    await queue.record(EVENT({ stopId: 'stop-1', vehicleId: 'bus-1' }));
    await queue.flush();

    // The bookkeeping is ours. Sending it would fail the endpoint's schema,
    // which rejects unknown keys.
    expect(Object.keys(seen[0]![0]!).sort()).toEqual([
      'clientEventId', 'direction', 'kind', 'routeId', 'stopId', 'studentId',
      'vehicleId',
    ]);
  });
});
