/**
 * The register's logic, lifted out of the screen so it can be tested.
 *
 * The screen that uses this cannot be verified from a container; this file
 * can, and it holds everything that could actually be wrong — which state a
 * row ends up in, what gets sent, and what the teacher is told afterwards.
 */
import type { AttendanceState, MarkInput } from '@paathshala/offline-queue';

export interface Learner {
  id: string;
  given_name: string;
  family_name: string | null;
  admission_no: string;
  enrollment_id: string | null;
}

/**
 * Everyone starts present.
 *
 * That is what a register is: a teacher marks the exceptions. Starting blank
 * and requiring a tap per child turns a two-minute job into a five-minute one
 * and guarantees half-finished registers.
 */
export function initialMarks(roll: Learner[]): Record<string, AttendanceState> {
  return Object.fromEntries(roll.map((l) => [l.id, 'present' as AttendanceState]));
}

/** Tapping a row cycles through the states a teacher actually uses. */
const CYCLE: AttendanceState[] = ['present', 'absent', 'late', 'excused'];

export function nextState(current: AttendanceState): AttendanceState {
  const index = CYCLE.indexOf(current);
  return CYCLE[(index + 1) % CYCLE.length]!;
}

/**
 * Builds the records to queue.
 *
 * Only enrolled learners: a child on the class list without an enrollment row
 * has no session to be marked against, and sending them produces a rejection
 * the teacher can do nothing about.
 *
 * The client event id is minted HERE, once, before anything touches the
 * network — the basis of a safe retry, and the thing the web client was
 * missing until M17.
 */
export function recordsFor(
  roll: Learner[],
  marks: Record<string, AttendanceState>,
  newId: () => string,
  now: () => Date = () => new Date(),
): MarkInput[] {
  const at = now().toISOString();
  return roll
    .filter((l) => l.enrollment_id)
    .map((l) => ({
      clientEventId: newId(),
      studentId: l.id,
      state: marks[l.id] ?? 'present',
      deviceRecordedAt: at,
    }));
}

export interface FlushSummary {
  synced: number; conflicted: number; corrections: number; failed: number;
}

/**
 * What to tell the teacher, in words that say what happened to their work.
 *
 * "Saved" when it is on the phone and "Recorded" when the school has it are
 * different facts, and a message that blurs them is how somebody discovers a
 * week later that a day never arrived.
 */
export function summarise(
  result: FlushSummary, pending: number, marked: number,
): { message: string; tone: 'ok' | 'warn' } {
  if (result.conflicted > 0) {
    return {
      message: 'Saved. Some marks clash with what another device recorded — '
        + 'open the register again to choose.',
      tone: 'warn',
    };
  }
  if (result.corrections > 0) {
    return {
      message: 'Saved, and sent for approval. This date is past the point where '
        + 'attendance can be changed directly.',
      tone: 'warn',
    };
  }
  if (pending > 0 || result.failed > 0) {
    return {
      message: `Saved on this phone. ${marked} marks will be sent when you are `
        + 'back online.',
      tone: 'ok',
    };
  }
  return { message: `${marked} recorded.`, tone: 'ok' };
}
