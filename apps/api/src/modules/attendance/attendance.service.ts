import { withTenant, type TenantScope, type TenantClient } from '../../db/tenant.ts';
import { auditService } from '../audit/audit.service.ts';
import { syncOutcomes } from '../../common/telemetry/metrics.ts';
import { outboxService } from '../events/outbox.service.ts';
import { ApiError } from '../../common/errors.ts';

export type AttendanceState = 'present' | 'absent' | 'late' | 'excused' | 'half_day';

export interface MarkInput {
  /** Generated on the device, before the record could reach a server. */
  clientEventId: string;
  studentId: string;
  state: AttendanceState;
  minutesLate?: number;
  /** What the device believed the time was. Never trusted. */
  deviceRecordedAt?: string;
}

export type RecordOutcome =
  | { clientEventId: string; status: 'applied'; recordId: string }
  | { clientEventId: string; status: 'already_applied'; recordId: string }
  | {
      clientEventId: string; status: 'conflict'; recordId: string;
      existing: { state: AttendanceState; recordedByStaffId: string | null; recordedAt: string };
      submitted: { state: AttendanceState };
    }
  | { clientEventId: string; status: 'correction_requested'; correctionId: string; reason: string }
  | { clientEventId: string; status: 'rejected'; reason: string };

export interface SyncResult {
  sessionId: string;
  outcomes: RecordOutcome[];
  absentEnrollmentIds: string[];
  serverTime: string;
}

/**
 * How long a session may sit unsynced on a device before it stops being a
 * normal write. Past this, the month may be closed and results published, so a
 * late arrival becomes a correction for a human to approve rather than a silent
 * rewrite of a settled record.
 */
const MAX_OFFLINE_AGE_DAYS = 7;

/** More than this from server time and the device clock is not believable. */
const MAX_CLOCK_SKEW_HOURS = 12;

export const attendanceService = {
  async openSession(
    scope: TenantScope,
    input: {
      sectionId: string; sessionDate: string; academicYearId: string;
      courseOfferingId?: string; periodNo?: number; mode?: 'day' | 'subject' | 'device';
      markedByStaffId?: string;
    },
  ): Promise<{ id: string; status: string }> {
    return withTenant(scope, async (db) => {
      const { rows } = await db.query<{ id: string; status: string }>(
        `INSERT INTO attendance_session
           (tenant_id, section_id, course_offering_id, academic_year_id,
            session_date, period_no, mode, marked_by_staff_id)
         VALUES (app_current_tenant_id(), $1, $2, $3, $4::date, $5, COALESCE($6, 'subject'), $7)
         ON CONFLICT (tenant_id, section_id, session_date,
                      COALESCE(period_no, -1),
                      COALESCE(course_offering_id, '00000000-0000-0000-0000-000000000000'::uuid))
         DO UPDATE SET updated_at = now()
         RETURNING id, status`,
        [input.sectionId, input.courseOfferingId ?? null, input.academicYearId,
         input.sessionDate, input.periodNo ?? null, input.mode ?? null,
         input.markedByStaffId ?? null],
      );
      if (!rows[0]) {
        throw ApiError.make('permission_error', 'staff_only',
          'Only staff may open an attendance session.');
      }
      return rows[0];
    });
  },

  /**
   * AC-5. The sync endpoint.
   *
   * Takes a batch a device may have been holding for days and decides, per
   * record, what happens. Every branch is explicit; nothing is resolved by
   * last-write-wins, because "the last device to reconnect decides" is not a
   * rule anybody would agree to if it were stated out loud.
   */
  async sync(
    scope: TenantScope,
    input: {
      sessionId: string;
      records: MarkInput[];
      recordedByStaffId?: string;
      deviceClock?: string;
    },
  ): Promise<SyncResult> {
    const result = await withTenant(scope, async (db) => {
      const sessionRows = await db.query<{
        id: string; status: string; session_date: string; section_id: string;
        academic_year_id: string;
      }>(
        `SELECT id, status, session_date::text, section_id, academic_year_id
           FROM attendance_session WHERE id = $1`,
        [input.sessionId],
      );
      const session = sessionRows.rows[0];
      if (!session) {
        throw ApiError.make('not_found', 'session_not_found', 'Attendance session not found.');
      }

      const serverNow = await db.query<{ now: string }>('SELECT now()::text AS now');
      const serverTime = serverNow.rows[0]!.now;

      // Path 4: an implausible device clock never affects stored times. It is
      // kept on the row for forensics and reported so the app can tell the
      // teacher their device clock is wrong.
      const clockSkewHours = input.deviceClock
        ? Math.abs(Date.parse(input.deviceClock) - Date.parse(serverTime)) / 3_600_000
        : 0;
      const clockIsImplausible = clockSkewHours > MAX_CLOCK_SKEW_HOURS;

      const ageDays =
        (Date.parse(serverTime.slice(0, 10)) - Date.parse(session.session_date)) / 86_400_000;
      const tooOld = ageDays > MAX_OFFLINE_AGE_DAYS;

      const outcomes: RecordOutcome[] = [];
      const absentEnrollmentIds: string[] = [];

      for (const record of input.records) {
        // Path 5: resolve the enrollment that was active on the SESSION DATE,
        // not the one active now. A learner who transferred while the device was
        // offline had their absence in the old section, and that is where it
        // belongs.
        const enrollment = await this.enrollmentOnDate(
          db, record.studentId, session.session_date, session.academic_year_id,
        );
        if (!enrollment) {
          outcomes.push({
            clientEventId: record.clientEventId, status: 'rejected',
            reason: 'No enrollment for this learner on the session date.',
          });
          continue;
        }

        // Paths 2 and 3: a locked session, or one too old to write into, becomes
        // a correction request a human approves. The teacher is told what
        // happened and what will happen next, rather than the record vanishing.
        if (session.status === 'locked' || tooOld) {
          const reason = session.status === 'locked'
            ? 'The session was locked before this arrived.'
            : `The session is older than ${MAX_OFFLINE_AGE_DAYS} days.`;
          const correction = await this.requestCorrection(db, {
            sessionId: session.id,
            enrollmentId: enrollment.id,
            toState: record.state,
            reason,
            origin: 'late_offline_sync',
            requestedBy: input.recordedByStaffId,
          });
          outcomes.push({
            clientEventId: record.clientEventId, status: 'correction_requested',
            correctionId: correction, reason,
          });
          continue;
        }

        // Path 1: a replayed batch. The unique index on client_event_id turns
        // the second arrival into a no-op, which is the overwhelmingly common
        // case and not a conflict at all.
        const inserted = await db.query<{ id: string }>(
          `INSERT INTO attendance_record
             (tenant_id, attendance_session_id, enrollment_id, state, minutes_late,
              source, client_event_id, device_recorded_at, recorded_by_staff_id)
           VALUES (app_current_tenant_id(), $1, $2, $3, $4, 'app', $5, $6::timestamptz, $7)
           -- Bare ON CONFLICT, with no target, on purpose. There are TWO unique
           -- indexes this can hit: client_event_id (a replay) and
           -- (session, enrollment) (somebody else marked this learner first).
           -- Naming only the first made the second raise instead of returning
           -- zero rows, so a genuine conflict crashed the batch rather than
           -- being reported. Both now fall through to the branch below, which
           -- works out which happened.
           ON CONFLICT DO NOTHING
           RETURNING id`,
          [session.id, enrollment.id, record.state, record.minutesLate ?? null,
           record.clientEventId,
           clockIsImplausible ? null : record.deviceRecordedAt ?? null,
           input.recordedByStaffId ?? null],
        );

        if (inserted.rows[0]) {
          outcomes.push({
            clientEventId: record.clientEventId, status: 'applied',
            recordId: inserted.rows[0].id,
          });
          if (record.state === 'absent') absentEnrollmentIds.push(enrollment.id);
          continue;
        }

        // Nothing inserted, and there are three distinct reasons why. They are
        // queried separately and in a fixed order, because an `OR ... LIMIT 1`
        // returns whichever row the planner reached first — and the two cases
        // want opposite answers.
        const byEvent = await db.query<{
          id: string; state: AttendanceState; enrollment_id: string;
          recorded_by_staff_id: string | null; recorded_at: string;
        }>(
          `SELECT id, state, enrollment_id, recorded_by_staff_id, recorded_at::text
             FROM attendance_record WHERE client_event_id = $1`,
          [record.clientEventId],
        );
        const sameEvent = byEvent.rows[0];

        if (sameEvent) {
          if (sameEvent.enrollment_id === enrollment.id) {
            // The ordinary replay: this exact event is already stored.
            outcomes.push({
              clientEventId: record.clientEventId, status: 'already_applied',
              recordId: sameEvent.id,
            });
          } else {
            // A client bug: the same event id submitted for two different
            // learners. Reporting "already applied" here would point at the
            // OTHER learner's record and silently drop this one's attendance —
            // the worst possible outcome, because it looks like success.
            outcomes.push({
              clientEventId: record.clientEventId, status: 'rejected',
              reason: 'This client event id is already used for a different learner. ' +
                'The device must generate one id per record.',
            });
          }
          continue;
        }

        const byEnrollment = await db.query<{
          id: string; state: AttendanceState; client_event_id: string | null;
          recorded_by_staff_id: string | null; recorded_at: string;
        }>(
          `SELECT id, state, client_event_id, recorded_by_staff_id, recorded_at::text
             FROM attendance_record
            WHERE attendance_session_id = $1 AND enrollment_id = $2`,
          [session.id, enrollment.id],
        );
        const prior = byEnrollment.rows[0];
        if (!prior) {
          outcomes.push({
            clientEventId: record.clientEventId, status: 'rejected',
            reason: 'The record could not be written and no prior record was found.',
          });
          continue;
        }

        // Path 3. Last-write-wins is wrong here: two people marked the same
        // learner and only one of them was right. The server keeps what is
        // already stored and hands both values back so the teacher decides.
        outcomes.push({
          clientEventId: record.clientEventId,
          status: 'conflict',
          recordId: prior.id,
          existing: {
            state: prior.state,
            recordedByStaffId: prior.recorded_by_staff_id,
            recordedAt: prior.recorded_at,
          },
          submitted: { state: record.state },
        });
      }

      const applied = outcomes.filter((o) => o.status === 'applied').length;
      if (applied > 0) {
        await outboxService.emit(db, {
          eventType: 'attendance.marked',
          aggregateType: 'attendance_session',
          aggregateId: session.id,
          payload: {
            attendanceSessionId: session.id,
            sectionId: session.section_id,
            sessionDate: session.session_date,
            appliedCount: applied,
            absentEnrollmentIds,
          },
        });
      }

      // Counted by outcome, once per record. A rise in `conflict` after a
      // release means the sync contract changed under devices that have not
      // updated — and those devices are holding a teacher's register.
      for (const outcome of outcomes) {
        syncOutcomes.inc({ kind: 'attendance', outcome: outcome.status });
      }

      return { sessionId: session.id, outcomes, absentEnrollmentIds, serverTime, clockIsImplausible };
    });

    if (result.clockIsImplausible) {
      await auditService.record({
        tenantId: scope.tenantId,
        actorUserId: scope.actorId,
        action: 'attendance.device_clock_rejected',
        resourceType: 'attendance_session',
        resourceId: input.sessionId,
        classification: 'INTERNAL',
        after: { deviceClock: input.deviceClock, serverTime: result.serverTime },
      });
    }

    return {
      sessionId: result.sessionId,
      outcomes: result.outcomes,
      absentEnrollmentIds: result.absentEnrollmentIds,
      serverTime: result.serverTime,
    };
  },

  async submitSession(
    scope: TenantScope,
    sessionId: string,
  ): Promise<{ id: string; status: string }> {
    return withTenant(scope, async (db) => {
      const { rows } = await db.query<{ id: string; status: string }>(
        `UPDATE attendance_session
            SET status = 'submitted', submitted_at = now()
          WHERE id = $1 AND status = 'open'
          RETURNING id, status`,
        [sessionId],
      );
      if (!rows[0]) {
        throw ApiError.make('conflict', 'session_not_open', 'That session is not open.');
      }
      return rows[0];
    });
  },

  /** Locking is what closes a month. After it, only corrections can change anything. */
  async lockSession(
    scope: TenantScope,
    sessionId: string,
    lockedByStaffId: string,
  ): Promise<void> {
    await withTenant(scope, async (db) => {
      const { rows } = await db.query<{ id: string }>(
        `UPDATE attendance_session
            SET status = 'locked', locked_at = now(), locked_by_staff_id = $2,
                submitted_at = COALESCE(submitted_at, now())
          WHERE id = $1 AND status <> 'locked'
          RETURNING id`,
        [sessionId, lockedByStaffId],
      );
      if (!rows[0]) {
        throw ApiError.make('conflict', 'already_locked', 'That session is already locked.');
      }
    });

    await auditService.record({
      tenantId: scope.tenantId,
      actorUserId: scope.actorId,
      action: 'attendance.session_locked',
      resourceType: 'attendance_session',
      resourceId: sessionId,
      classification: 'INTERNAL',
    });
  },

  /**
   * Resolves the enrollment active on a given date.
   *
   * `ended_on` is inclusive of the last day attended, so a learner who
   * transferred on the 12th was still enrolled on the 12th.
   */
  async enrollmentOnDate(
    db: TenantClient,
    studentId: string,
    onDate: string,
    academicYearId: string,
  ): Promise<{ id: string; section_id: string } | undefined> {
    const { rows } = await db.query<{ id: string; section_id: string }>(
      `SELECT id, section_id FROM enrollment
        WHERE student_id = $1
          AND academic_year_id = $3
          AND enrolled_on <= $2::date
          AND (ended_on IS NULL OR ended_on >= $2::date)
        ORDER BY enrolled_on DESC
        LIMIT 1`,
      [studentId, onDate, academicYearId],
    );
    return rows[0];
  },

  async requestCorrection(
    db: TenantClient,
    input: {
      recordId?: string | undefined;
      sessionId?: string | undefined;
      enrollmentId?: string | undefined;
      toState: AttendanceState;
      reason: string;
      origin?: 'manual' | 'late_offline_sync' | 'device_import' | undefined;
      requestedBy?: string | undefined;
    },
  ): Promise<string> {
    const fromState = input.recordId
      ? (await db.query<{ state: string }>(
          'SELECT state FROM attendance_record WHERE id = $1', [input.recordId],
        )).rows[0]?.state ?? null
      : null;

    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO attendance_correction
         (tenant_id, attendance_record_id, attendance_session_id, enrollment_id,
          from_state, to_state, reason, origin, requested_by)
       VALUES (app_current_tenant_id(), $1, $2, $3, $4, $5, $6, COALESCE($7, 'manual'), $8)
       RETURNING id`,
      [input.recordId ?? null, input.sessionId ?? null, input.enrollmentId ?? null,
       fromState, input.toState, input.reason, input.origin ?? null, input.requestedBy ?? null],
    );
    return rows[0]!.id;
  },

  /** A correction requested against an existing record, by a human. */
  async requestCorrectionFor(
    scope: TenantScope,
    input: {
      recordId: string; toState: AttendanceState; reason: string;
      requestedBy?: string | undefined;
    },
  ): Promise<string> {
    if (!input.reason.trim()) {
      throw ApiError.make('validation_error', 'reason_required',
        'A correction must record why.');
    }
    return withTenant(scope, (db) => this.requestCorrection(db, input));
  },

  /**
   * Approving applies the new state to the record — or creates the record, when
   * the correction came from a late sync into a locked session and no record
   * existed. The correction row keeps what it used to be either way.
   */
  async approveCorrection(
    scope: TenantScope,
    input: { correctionId: string; approverStaffId: string },
  ): Promise<void> {
    await withTenant(scope, async (db) => {
      const { rows } = await db.query<{
        id: string; attendance_record_id: string | null; attendance_session_id: string | null;
        enrollment_id: string | null; to_state: AttendanceState; status: string;
      }>(
        `SELECT id, attendance_record_id, attendance_session_id, enrollment_id, to_state, status
           FROM attendance_correction WHERE id = $1`,
        [input.correctionId],
      );
      const correction = rows[0];
      if (!correction) {
        throw ApiError.make('not_found', 'correction_not_found', 'Correction not found.');
      }
      if (correction.status !== 'pending') {
        throw ApiError.make('conflict', 'correction_not_pending',
          'That correction has already been decided.');
      }

      if (correction.attendance_record_id) {
        await db.query(
          'UPDATE attendance_record SET state = $2 WHERE id = $1',
          [correction.attendance_record_id, correction.to_state],
        );
      } else if (correction.attendance_session_id && correction.enrollment_id) {
        await db.query(
          `INSERT INTO attendance_record
             (tenant_id, attendance_session_id, enrollment_id, state, source)
           VALUES (app_current_tenant_id(), $1, $2, $3, 'app')
           ON CONFLICT (tenant_id, attendance_session_id, enrollment_id)
           DO UPDATE SET state = EXCLUDED.state`,
          [correction.attendance_session_id, correction.enrollment_id, correction.to_state],
        );
      }

      await db.query(
        `UPDATE attendance_correction
            SET status = 'approved', approved_by = $2, approved_at = now()
          WHERE id = $1`,
        [input.correctionId, input.approverStaffId],
      );
    });

    await auditService.record({
      tenantId: scope.tenantId,
      actorUserId: scope.actorId,
      action: 'attendance.correction_approved',
      resourceType: 'attendance_correction',
      resourceId: input.correctionId,
      classification: 'INTERNAL',
    });
  },

  async recordsForSession(
    scope: TenantScope,
    sessionId: string,
  ): Promise<Array<{ id: string; enrollment_id: string; state: string; recorded_at: string }>> {
    return withTenant(scope, async (db) => {
      const { rows } = await db.query<{
        id: string; enrollment_id: string; state: string; recorded_at: string;
      }>(
        `SELECT id, enrollment_id, state, recorded_at::text
           FROM attendance_record WHERE attendance_session_id = $1 ORDER BY recorded_at`,
        [sessionId],
      );
      return rows;
    });
  },
};
