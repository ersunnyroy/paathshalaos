/**
 * The bus run's logic, lifted out of the screen so it can be tested.
 *
 * The screen cannot be verified from a container; this file can, and it holds
 * everything that could actually be wrong — what a tap does, what gets sent,
 * and what the driver is told afterwards.
 */
import type { BoardingInput, BoardingKind } from '@paathshala/offline-queue';

export interface ManifestRow {
  student_id: string;
  admission_no: string;
  given_name: string;
  family_name: string | null;
  stop_id: string;
  stop_name: string;
  sequence_no: number;
  pickup_time: string | null;
  drop_time: string | null;
  guardian_phone: string | null;
  boarded_today: BoardingKind | null;
}

/**
 * Nobody starts marked.
 *
 * The opposite of the register, and deliberately. A class is mostly present,
 * so a teacher marks the exceptions; a bus is empty until children get on it,
 * and pre-marking everyone boarded would mean a driver who forgets to tap has
 * told the school that a child who never arrived is on the bus.
 */
export function initialStates(
  rows: ManifestRow[],
): Record<string, BoardingKind | null> {
  return Object.fromEntries(rows.map((r) => [r.student_id, r.boarded_today]));
}

/**
 * What a tap does.
 *
 * Three states, in the order a driver meets them: on, not here, and the one
 * that matters — a child the school expected at this corner who was not there.
 * `no_show` is not a synonym for absent: absent is the office telling the
 * driver not to wait, and no_show is the driver telling the office to ring
 * the house.
 *
 * `alighted` is not in the cycle. It belongs to the drop run and is recorded
 * by direction, not by cycling through it on a pickup.
 */
const CYCLE: BoardingKind[] = ['boarded', 'absent', 'no_show'];

export function nextKind(current: BoardingKind | null): BoardingKind {
  if (current === null) return 'boarded';
  // A state outside the cycle — `alighted`, from an earlier drop run — gives
  // indexOf -1, and -1 + 1 is 0, so it starts the cycle at 'boarded'. That is
  // what it should do, and it falls out of the arithmetic.
  //
  // This had an `index < 0 ? 'boarded' : …` guard in front of it, with a
  // comment claiming the alternative was wrapping to the END of the cycle and
  // making the first tap mean "not at stop". Breaking the guard deliberately
  // failed no test, which is how the comment got read again: it was describing
  // a bug that arithmetic had never permitted. A guard that cannot be shown to
  // do anything is not defence in depth, it is a line that teaches the next
  // reader something untrue.
  return CYCLE[(CYCLE.indexOf(current) + 1) % CYCLE.length]!;
}

export const KIND_LABEL: Record<BoardingKind, string> = {
  boarded: 'On board',
  alighted: 'Got off',
  absent: 'Absent',
  no_show: 'Not at stop',
};

/**
 * Builds the events to queue.
 *
 * Only children the driver actually marked. An untouched row is not the same
 * as a child who is absent — it is a row the driver has not reached yet, and
 * sending it as anything would be inventing a fact about a child.
 *
 * The client event id is minted HERE, once, before anything touches the
 * network. It is keyed by child and direction and date rather than being
 * random per tap, so a driver who corrects a mark before the bus leaves
 * replaces the queued event instead of queueing a second one.
 */
export function eventsFor(
  rows: ManifestRow[],
  states: Record<string, BoardingKind | null>,
  routeId: string,
  direction: 'pickup' | 'drop',
  onDate: string,
  idFor: (key: string) => string,
  now: () => Date = () => new Date(),
): BoardingInput[] {
  const at = now().toISOString();
  return rows
    .filter((r) => states[r.student_id] != null
      && states[r.student_id] !== r.boarded_today)
    .map((r) => ({
      clientEventId: idFor(`${onDate}:${direction}:${r.student_id}`),
      studentId: r.student_id,
      routeId,
      stopId: r.stop_id,
      direction,
      kind: states[r.student_id]!,
      onDate,
      deviceRecordedAt: at,
    }));
}

/** What the driver is told after a send. */
export function summarise(
  result: { sent: number; replayed: number; failed: number },
  pending: number,
): { message: string; tone: 'ok' | 'warn' } {
  if (result.failed > 0) {
    // Not an error the driver has to act on. The run is recorded on the phone
    // and will go when there is signal; saying "failed" would invite a driver
    // to do it again on paper.
    return {
      message: `No signal. ${pending} ${pending === 1 ? 'mark is' : 'marks are'} `
        + 'saved on this phone and will send themselves.',
      tone: 'warn',
    };
  }
  const total = result.sent + result.replayed;
  if (total === 0) return { message: 'Nothing new to send.', tone: 'ok' };
  return {
    message: `${total} ${total === 1 ? 'mark' : 'marks'} sent.`,
    tone: 'ok',
  };
}

/** 07:10:00 to 07:10. Seconds on a pickup time are noise. */
export function hhmm(time: string | null): string {
  return time ? time.slice(0, 5) : '';
}

/** How many are on board, for the line above the list. */
export function tally(
  rows: ManifestRow[],
  states: Record<string, BoardingKind | null>,
): { onBoard: number; missing: number; unmarked: number } {
  let onBoard = 0, missing = 0, unmarked = 0;
  for (const row of rows) {
    const state = states[row.student_id] ?? null;
    if (state === 'boarded') onBoard += 1;
    else if (state === 'no_show') missing += 1;
    else if (state === null) unmarked += 1;
  }
  return { onBoard, missing, unmarked };
}

/**
 * A stable id from a stable key.
 *
 * Not `randomUUID` per tap: a driver who corrects a mark before the bus leaves
 * must replace the queued event, not queue a second one — and the server's
 * boarding table is append-only, so it would keep both. The key already
 * identifies the event uniquely (this child, this direction, this day), so the
 * id is derived from it and comes out the same every time.
 *
 * A UUID shape because the endpoint asks for one.
 */
export function stableId(key: string): string {
  let h1 = 0x811c9dc5, h2 = 0x01000193, h3 = 0x9e3779b9, h4 = 0x85ebca6b;
  for (let i = 0; i < key.length; i++) {
    const c = key.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
    h2 = Math.imul(h2 ^ (c + i), 2246822519) >>> 0;
    h3 = Math.imul(h3 ^ (c * 31), 3266489917) >>> 0;
    h4 = Math.imul(h4 ^ (c + h1), 668265263) >>> 0;
  }
  const hex = [h1, h2, h3, h4].map((n) => n.toString(16).padStart(8, '0')).join('');
  // Version 4, variant 10xx — a UUID by shape, so the endpoint's schema takes
  // it. Nothing about it is claimed to be random; it is meant to repeat.
  return [
    hex.slice(0, 8), hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    ((parseInt(hex[16]!, 16) & 0x3 | 0x8).toString(16)) + hex.slice(17, 20),
    hex.slice(20, 32),
  ].join('-');
}
