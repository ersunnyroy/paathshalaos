/**
 * The attendance vocabulary, as the queue needs it.
 *
 * Declared here rather than imported from the API, because this package is the
 * thing that runs where the server does not: a browser with no connection, and
 * later a phone in a classroom with one bar. It has no dependency on Nest, on
 * `pg`, on React Native, on SQLite or on `fetch` — storage and transport are
 * injected — which is what makes the conflict behaviour testable in Node rather
 * than only on a device in a basement classroom.
 *
 * These types are checked against the server's own by a test in the API package
 * (`offline-queue-contract.spec.ts`), so a drift between the two fails a build
 * rather than a sync.
 */

export type AttendanceState = 'present' | 'absent' | 'late' | 'excused' | 'half_day';

export interface MarkInput {
  /** Generated on the device, before the record could reach a server. */
  clientEventId: string;
  studentId: string;
  state: AttendanceState;
  minutesLate?: number;
  /** What the device believed the time was. Never trusted by the server. */
  deviceRecordedAt?: string;
}

export type RecordOutcome =
  | { clientEventId: string; status: 'applied'; recordId: string }
  | { clientEventId: string; status: 'already_applied'; recordId: string }
  | {
      clientEventId: string;
      status: 'conflict';
      recordId: string;
      /** Who marked it first, and when the server recorded that. */
      existing: {
        state: AttendanceState;
        recordedByStaffId: string | null;
        recordedAt: string;
      };
      submitted: { state: AttendanceState };
    }
  | {
      clientEventId: string;
      status: 'correction_requested';
      correctionId: string;
      reason: string;
    }
  | { clientEventId: string; status: 'rejected'; reason: string };
