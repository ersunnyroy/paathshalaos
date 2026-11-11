/**
 * The half of attendance that had no route (M34.2).
 *
 * M32 gave thirteen modules a write surface and recorded the lesson that a
 * service test cannot prove anybody can call the service. It missed this one,
 * and a method-level sweep found it: attendance was reachable only through the
 * reporting controller — open a session, sync marks, read records — and five of
 * its service methods had no caller anywhere in `src/`.
 *
 * Two of them are the ones that matter:
 *
 *   **`lockSession`.** Locking is what makes a correction necessary rather than
 *   an edit. AC-5's entire conflict model is written in terms of locked
 *   sessions, and no school could lock one.
 *
 *   **The correction workflow.** A late offline sync into a locked session
 *   creates a `pending` correction — the service does that itself, and has
 *   since M6. Nothing could list those rows and nothing could decide them, so
 *   they accumulated for ever and the learner's attendance stayed wrong. The
 *   index `attendance_correction_pending_idx` has existed since 0021 for a
 *   query nobody had written, and `rejection_reason` had never been set by any
 *   code at all.
 *
 * Everything an author could lie about comes from the session, not the body —
 * M32's lesson, applied to the routes it did not reach.
 */
import { Controller, Get, Post, Body, Param } from '@nestjs/common';
import { z } from 'zod';
import { attendanceService } from './attendance.service.ts';
import { withTenant } from '../../db/tenant.ts';
import { currentScope } from '../../common/scope.ts';
import { ApiError } from '../../common/errors.ts';

const uuid = z.string().uuid();
const STATES = ['present', 'absent', 'late', 'excused', 'half_day'] as const;

/**
 * Who is asking, as a member of staff.
 *
 * Asked of the database rather than taken from the request. A `lockedBy` or an
 * `approverStaffId` in a body is a field a client can set to somebody else's
 * name, which is the hole M32 closed in admissions and payments and which is
 * worth closing before it is opened.
 */
async function currentStaffId(): Promise<string> {
  const id = await withTenant(currentScope(), async (db) => {
    const { rows } = await db.query<{ staff_id: string | null }>(
      'SELECT app_current_staff_id() AS staff_id');
    return rows[0]?.staff_id ?? null;
  });
  if (!id) {
    throw ApiError.make('permission_error', 'not_staff',
      'Only a member of staff can decide this, and this login is not attached '
      + 'to a staff record.');
  }
  return id;
}

@Controller('v1/attendance')
export class AttendanceController {
  /**
   * The register is done.
   *
   * Distinct from locking: submitting says a teacher has finished, locking says
   * the period is closed. A school that only had locking would have to choose
   * between an editable register for ever and one closed the moment it was
   * taken.
   */
  @Post('sessions/:id/submit')
  async submit(@Param('id') id: string) {
    const sessionId = uuid.safeParse(id);
    if (!sessionId.success) throw ApiError.fromZod(sessionId.error);
    return { data: await attendanceService.submitSession(currentScope(), sessionId.data) };
  }

  /**
   * The period is closed.
   *
   * After this nothing changes a mark except an approved correction, which is
   * the point — and which is why the queue below had to exist before this route
   * could honestly be offered.
   */
  @Post('sessions/:id/lock')
  async lock(@Param('id') id: string) {
    const sessionId = uuid.safeParse(id);
    if (!sessionId.success) throw ApiError.fromZod(sessionId.error);
    await attendanceService.lockSession(
      currentScope(), sessionId.data, await currentStaffId());
    return { data: { locked: true } };
  }

  /** The queue. Everything a late sync left behind, oldest first. */
  @Get('corrections')
  async corrections() {
    return { data: await attendanceService.pendingCorrections(currentScope()) };
  }

  /**
   * Asking for a mark to be changed.
   *
   * A reason is required by the service, not by politeness: the correction row
   * is the evidence of what was changed and why, and "it always said absent" is
   * a thing families dispute years later.
   */
  @Post('corrections')
  async request(@Body() body: unknown) {
    const parsed = z.object({
      recordId: uuid,
      toState: z.enum(STATES),
      reason: z.string().min(1).max(2000),
    }).safeParse(body);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);

    return {
      data: {
        id: await attendanceService.requestCorrectionFor(currentScope(), {
          ...parsed.data,
          // Not from the body. The requester is whoever is signed in.
          requestedBy: await currentStaffId(),
        }),
      },
    };
  }

  @Post('corrections/:id/approve')
  async approve(@Param('id') id: string) {
    const correctionId = uuid.safeParse(id);
    if (!correctionId.success) throw ApiError.fromZod(correctionId.error);
    await attendanceService.approveCorrection(currentScope(), {
      correctionId: correctionId.data,
      approverStaffId: await currentStaffId(),
    });
    return { data: { approved: true } };
  }

  @Post('corrections/:id/reject')
  async reject(@Param('id') id: string, @Body() body: unknown) {
    const correctionId = uuid.safeParse(id);
    if (!correctionId.success) throw ApiError.fromZod(correctionId.error);
    const parsed = z.object({ reason: z.string().min(1).max(2000) }).safeParse(body);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);

    await attendanceService.rejectCorrection(currentScope(), {
      correctionId: correctionId.data, reason: parsed.data.reason,
    });
    return { data: { rejected: true } };
  }
}
