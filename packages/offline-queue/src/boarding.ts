/**
 * The boarding queue.
 *
 * Deliberately NOT the attendance queue with a different payload.
 *
 * The milestone said boarding would use "the same offline queue and the same
 * conflict rules", and half of that was wrong. The offline guarantee is
 * identical and is the part that matters: the id is minted on the device
 * before anything touches the network, never regenerated, and a failed send
 * leaves the work in the queue rather than consuming it.
 *
 * The conflict rules have no meaning here. Two teachers marking the same child
 * present and absent is a disagreement a human has to settle, which is why
 * attendance carries conflicts, resolutions and a `needs_attention` state. A
 * boarding event is append-only: the same id twice is one event replayed, and
 * two different ids are two different things that happened — a child boarded,
 * and later got off. There is nothing to reconcile, so a queue that carried
 * conflict machinery here would carry fields that are always empty and invite
 * somebody to use them.
 *
 * Storage is injected, exactly as it is for attendance, so this is tested in
 * Node rather than only on a phone on a bus.
 */

export type BoardingKind = 'boarded' | 'alighted' | 'absent' | 'no_show';

export interface BoardingInput {
  /** Minted on the device before the first attempt. Never regenerated. */
  clientEventId: string;
  studentId: string;
  routeId: string;
  stopId?: string;
  vehicleId?: string;
  direction: 'pickup' | 'drop';
  kind: BoardingKind;
  onDate?: string;
  /** What the device believed the time was. Never trusted by the server. */
  deviceRecordedAt?: string;
}

export interface QueuedBoarding extends BoardingInput {
  queuedAt: string;
  attempts: number;
  lastError?: string;
}

export interface BoardingStorage {
  read(): Promise<QueuedBoarding[]>;
  write(events: QueuedBoarding[]): Promise<void>;
}

export interface BoardingTransport {
  send(events: BoardingInput[]): Promise<{ recorded: number; replayed: number }>;
}

export class OfflineBoardingQueue {
  constructor(
    private readonly storage: BoardingStorage,
    private readonly transport: BoardingTransport,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Records one tap.
   *
   * Idempotent on the client event id as well as on the server: a driver who
   * taps twice before the first send completes must not queue the child twice,
   * and re-recording a child whose state has changed replaces the queued event
   * rather than appending a second one — the bus has not left yet and only the
   * last answer is true.
   */
  async record(event: BoardingInput): Promise<void> {
    const events = await this.storage.read();
    const entry: QueuedBoarding = {
      ...event,
      queuedAt: this.now().toISOString(),
      attempts: 0,
    };
    const existing = events.findIndex((e) => e.clientEventId === event.clientEventId);
    if (existing >= 0) events[existing] = entry;
    else events.push(entry);
    await this.storage.write(events);
  }

  /** What the badge shows. An invisible queue is how a morning's run disappears. */
  async pendingCount(): Promise<number> {
    return (await this.storage.read()).length;
  }

  async all(): Promise<QueuedBoarding[]> {
    return this.storage.read();
  }

  /**
   * Sends everything held, in one call.
   *
   * One request rather than one per child: the shape that survives a tunnel is
   * "here is everything I have not managed to send yet", and a client looping
   * over a flaky link gets a partial result it cannot interpret.
   *
   * A replay is not a failure and must not read like one. The bus coming back
   * into signal and re-sending is the design working.
   */
  async flush(): Promise<{ sent: number; replayed: number; failed: number }> {
    const events = await this.storage.read();
    if (events.length === 0) return { sent: 0, replayed: 0, failed: 0 };

    const attempted = events.map((e) => ({ ...e, attempts: e.attempts + 1 }));
    try {
      const result = await this.transport.send(attempted.map(strip));
      // Everything reached the server — recorded or recognised as a replay.
      // Both are terminal, so the queue empties.
      await this.storage.write([]);
      return { sent: result.recorded, replayed: result.replayed, failed: 0 };
    } catch (err) {
      // Still queued, with the SAME ids. A transport failure must never consume
      // the queue: that is the one way a child who was marked absent at the
      // kerb silently becomes a child nobody looked for.
      const message = err instanceof Error ? err.message : 'send failed';
      await this.storage.write(attempted.map((e) => ({ ...e, lastError: message })));
      return { sent: 0, replayed: 0, failed: attempted.length };
    }
  }
}

function strip(event: QueuedBoarding): BoardingInput {
  const { queuedAt, attempts, lastError, ...input } = event;
  void queuedAt; void attempts; void lastError;
  return input;
}

/** In-memory storage: the tests use it, and it is the reference implementation. */
export class InMemoryBoardingStorage implements BoardingStorage {
  private events: QueuedBoarding[] = [];
  async read(): Promise<QueuedBoarding[]> {
    return structuredClone(this.events);
  }
  async write(events: QueuedBoarding[]): Promise<void> {
    this.events = structuredClone(events);
  }
}
