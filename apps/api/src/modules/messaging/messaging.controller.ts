/**
 * Sending a message (M32.3).
 *
 * M9 built templates, DLT registration, consent checks, channel fallback,
 * quiet hours, delivery receipts and a dispatch audit — 119 tests — and the
 * product had `GET /v1/messages` and no way to send one. `dispatchService` had
 * no caller in `src/`.
 *
 * **There is no SMS or WhatsApp gateway**, and this controller does not
 * pretend otherwise. `inAppOnlyProvider` refuses every channel that needs one,
 * M9's fallback chain lands the message on `in_app`, and the family sees it in
 * the parent app — a real delivery. Buying a gateway is M26. A provider that
 * returned a fabricated message id for an SMS would make `delivery_receipt` a
 * fiction, and a school would find out when nobody came to the meeting.
 *
 * The audience is assembled here and the consent decision is NOT. `may_message`
 * is evaluated per recipient at dispatch time, inside the transaction, because
 * a parent who opted out between the list being built and the send happening
 * has opted out.
 */
import { Controller, Get, Post, Body, Param, Query } from '@nestjs/common';
import { z } from 'zod';
import { dispatchService, type Audience } from './dispatch.service.ts';
import { inboxService } from './inbox.service.ts';
import { absenceService, ABSENCE_SOURCE } from './absence.service.ts';
import { feeNoticeService, REMINDER_SOURCE } from './fee-notice.service.ts';
import { templateService } from './template.service.ts';
import { inAppOnlyProvider } from './providers.ts';
import { withTenant } from '../../db/tenant.ts';
import { currentScope } from '../../common/scope.ts';
import { ApiError } from '../../common/errors.ts';

const uuid = z.string().uuid();

const templateBody = z.object({
  code: z.string().min(1).max(60),
  name: z.string().min(1).max(200),
  // 0035's set, which is DPDP's vocabulary rather than a marketer's: consent
  // is recorded per purpose, and `may_message` reads the same values.
  purpose: z.enum(['core_education_service', 'attendance_notifications',
                   'fee_notifications', 'photo_publication', 'transport_tracking',
                   'third_party_assessment', 'marketing']),
});

const versionBody = z.object({
  templateId: uuid,
  channel: z.enum(['sms', 'whatsapp', 'email', 'push', 'in_app']),
  locale: z.string().max(10).optional(),
  body: z.string().min(1).max(4000),
  dltEntityId: z.string().max(60).optional(),
  dltTemplateId: z.string().max(60).optional(),
  senderHeader: z.string().max(20).optional(),
  waTemplateName: z.string().max(120).optional(),
  waLanguage: z.string().max(10).optional(),
});

const sendBody = z.object({
  templateCode: z.string().min(1).max(60),
  // The client's own id for this send. Two taps on a flaky connection are one
  // message, and this is what makes that true.
  idempotencyKey: z.string().min(8).max(200),
  campusId: uuid.optional(),
  variables: z.record(z.string()).optional(),
  /** Everyone, or the guardians of one section, or a named list. */
  audience: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('section'), sectionId: uuid }),
    z.object({ kind: z.literal('people'), personIds: z.array(uuid).min(1).max(500) }),
    // The guardians of the children marked absent in one register who have
    // not been told yet. Pressing it twice sends nothing the second time.
    z.object({ kind: z.literal('absentees'), attendanceSessionId: uuid }),
  ]),
});

const inboxQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
  // Both or neither: half a cursor is a different page from the one asked for.
  beforeAt: z.string().datetime({ offset: true }).optional(),
  beforeId: uuid.optional(),
}).refine((q) => (q.beforeAt === undefined) === (q.beforeId === undefined), {
  message: 'beforeAt and beforeId go together', path: ['beforeAt'],
});

@Controller('v1/messaging')
export class MessagingController {
  /**
   * The caller's own messages (M43.1). Nothing under `inbox` takes a person
   * from the request: whose inbox it is comes from the session.
   *
   * These sit on this controller rather than one of their own only because
   * `app.module.ts` could not be written from the session that built them.
   */
  @Get('inbox')
  async inbox(@Query() query: unknown) {
    const parsed = inboxQuery.safeParse(query);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    const { limit, beforeAt, beforeId } = parsed.data;
    const scope = currentScope();
    const items = await inboxService.mine(scope, {
      limit,
      before: beforeAt && beforeId ? { sentAt: beforeAt, id: beforeId } : undefined,
    });
    const last = items[items.length - 1];
    return {
      data: {
        items,
        unread: await inboxService.unread(scope),
        // A full page may have more behind it; a short one cannot.
        next: items.length === limit && last
          ? { beforeAt: last.sent_at, beforeId: last.id } : null,
      },
    };
  }

  @Get('inbox/unread')
  async inboxUnread() {
    return { data: { unread: await inboxService.unread(currentScope()) } };
  }

  @Post('inbox/read-all')
  async inboxReadAll() {
    return { data: { changed: await inboxService.markRead(currentScope(), null) } };
  }

  @Post('inbox/:id/read')
  async inboxRead(@Param('id') id: string) {
    const parsed = uuid.safeParse(id);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    return { data: { changed: await inboxService.markRead(currentScope(), parsed.data) } };
  }

  @Get('templates')
  async templates() {
    return {
      data: await withTenant(currentScope(), async (db) => {
        const { rows } = await db.query(
          `SELECT t.id, t.code, t.name, t.purpose,
                  COALESCE(json_agg(json_build_object(
                    'id', v.id, 'channel', v.channel, 'locale', v.locale,
                    'approval_status', v.approval_status, 'body', v.body
                  ) ORDER BY v.created_at) FILTER (WHERE v.id IS NOT NULL), '[]')
                    AS versions
             FROM message_template t
             LEFT JOIN message_template_version v ON v.message_template_id = t.id
            GROUP BY t.id
            ORDER BY t.name`);
        return rows;
      }),
    };
  }

  @Post('templates')
  async createTemplate(@Body() body: unknown) {
    const parsed = templateBody.safeParse(body);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    return { data: await templateService.create(currentScope(), parsed.data) };
  }

  @Post('templates/versions')
  async addVersion(@Body() body: unknown) {
    const parsed = versionBody.safeParse(body);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    return { data: await templateService.addVersion(currentScope(), parsed.data) };
  }

  /**
   * Approval is what makes a version sendable.
   *
   * Kept as its own step rather than folded into creation: in India an SMS
   * template is registered with DLT before it can be used, so "written" and
   * "allowed to go out" are genuinely different states and a school that
   * conflates them gets its messages rejected by the carrier.
   */
  @Post('templates/versions/:id/approve')
  async approveVersion(@Param('id') id: string) {
    const versionId = uuid.safeParse(id);
    if (!versionId.success) throw ApiError.fromZod(versionId.error);
    await templateService.approve(currentScope(), versionId.data);
    return { data: { approved: true } };
  }

  @Post('templates/versions/:id/reject')
  async rejectVersion(@Param('id') id: string, @Body() body: unknown) {
    const versionId = uuid.safeParse(id);
    if (!versionId.success) throw ApiError.fromZod(versionId.error);
    const parsed = z.object({ reason: z.string().min(1).max(2000) }).safeParse(body);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    await templateService.reject(currentScope(), versionId.data, parsed.data.reason);
    return { data: { rejected: true } };
  }

  /**
   * For one register: how many are absent, and how many of their guardians
   * are still to be told (M43.2). What the "Tell the parents" button reads.
   */
  @Get('absence-notices/:sessionId')
  async absenceNotices(@Param('sessionId') sessionId: string) {
    const parsed = uuid.safeParse(sessionId);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    return {
      data: await withTenant(currentScope(),
        (db) => absenceService.status(db, parsed.data)),
    };
  }

  /**
   * Overdue fees: how many children, and how many of their guardians have not
   * been reminded today (M43.3).
   */
  @Get('fee-reminders')
  async feeReminders() {
    return { data: await feeNoticeService.reminderStatus(currentScope()) };
  }

  /**
   * Reminds the guardians of every child with overdue fees, once per guardian
   * per child per day. Pressing it again the same day sends nothing.
   */
  @Post('fee-reminders')
  async sendFeeReminders(@Body() body: unknown) {
    const parsed = z.object({ idempotencyKey: z.string().min(8).max(200) }).safeParse(body);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    const scope = currentScope();
    const status = await feeNoticeService.reminderStatus(scope);
    if (!status.templateCode) {
      throw ApiError.make('validation_error', 'no_reminder_template',
        'No fee reminder has been written and approved yet. Add a template '
        + 'with the purpose "fee notifications" under Messages first.');
    }
    const audience = await withTenant(scope, (db) => feeNoticeService.reminderAudience(db));
    if (audience.length === 0) {
      throw ApiError.make('validation_error', 'nobody_left_to_remind',
        'Nobody is left to remind today: either nothing is overdue, the '
        + 'guardians have already been reminded today, or the fees are not '
        + 'shared with any guardian.');
    }
    const queued = await dispatchService.queue(scope, {
      templateCode: status.templateCode,
      idempotencyKey: parsed.data.idempotencyKey,
      sourceType: REMINDER_SOURCE,
    });
    const { outcomes } = await dispatchService.dispatch(scope, {
      requestId: queued.requestId, audience, provider: inAppOnlyProvider,
    });
    return {
      data: {
        requestId: queued.requestId,
        sent: outcomes.filter((o) => o.outcome === 'sent').length,
        suppressed: outcomes.filter((o) => o.outcome === 'suppressed').length,
        failed: outcomes.filter((o) => o.outcome === 'failed').length,
        outcomes,
      },
    };
  }

  /**
   * Queue a message and send it.
   *
   * One call, because a school pressing "send to Class IX parents" means one
   * thing, and a two-step where the second half can be forgotten produces
   * queued messages nobody ever dispatches. The idempotency key makes the
   * retry safe.
   *
   * What comes back is per recipient, including the suppressions, because
   * "sent to 38 of 40, two have opted out of service messages" is the answer
   * the sender needs and "sent" is not.
   */
  @Post('send')
  async send(@Body() body: unknown) {
    const parsed = sendBody.safeParse(body);
    if (!parsed.success) throw ApiError.fromZod(parsed.error);
    const scope = currentScope();
    const { audience: spec, variables } = parsed.data;

    const audience = await withTenant(scope, async (db) => {
      if (spec.kind === 'people') {
        return spec.personIds.map<Audience>((personId) => ({
          personId, variables: variables ?? {},
        }));
      }
      if (spec.kind === 'absentees') {
        const pending = await absenceService.audience(db, spec.attendanceSessionId);
        // The child's name and the day come from the register, and win over
        // anything the caller sent under the same names.
        return pending.map((member) => ({
          ...member, variables: { ...(variables ?? {}), ...member.variables },
        }));
      }
      // The guardians of the learners in a section, each message being ABOUT
      // their own child — `subjectPersonId` is what makes the consent check
      // and the `{{name}}` variable resolve per family rather than per send.
      const { rows } = await db.query<{
        guardian_person_id: string; subject_person_id: string; child_name: string;
      }>(
        `SELECT gl.guardian_person_id, p.id AS subject_person_id,
                p.given_name AS child_name
           FROM enrollment e
           JOIN student st ON st.id = e.student_id
           JOIN person p ON p.id = st.person_id
           JOIN guardian_link gl ON gl.student_id = st.id
                                AND gl.effective_to IS NULL
                                AND gl.effective_from <= CURRENT_DATE
          WHERE e.section_id = $1::uuid AND e.status = 'active'`,
        [spec.sectionId]);
      return rows.map<Audience>((r) => ({
        personId: r.guardian_person_id,
        subjectPersonId: r.subject_person_id,
        variables: { ...(variables ?? {}), name: r.child_name },
      }));
    });

    if (audience.length === 0 && spec.kind === 'absentees') {
      // Not an error to press the button twice. Say why nothing went.
      throw ApiError.make('validation_error', 'nobody_left_to_tell',
        'Nobody is left to tell: either nobody is marked absent in this '
        + 'register, their guardians have already been told, or no guardian '
        + 'is linked to them.');
    }
    if (audience.length === 0) {
      throw ApiError.make('validation_error', 'empty_audience',
        'Nobody would receive this. Check the section has learners with '
        + 'guardians linked.');
    }

    const queued = await dispatchService.queue(scope, {
      templateCode: parsed.data.templateCode,
      idempotencyKey: parsed.data.idempotencyKey,
      ...(spec.kind === 'absentees'
        ? { sourceType: ABSENCE_SOURCE, sourceId: spec.attendanceSessionId }
        : { sourceType: 'manual' }),
      ...(parsed.data.campusId ? { campusId: parsed.data.campusId } : {}),
    });

    const { outcomes } = await dispatchService.dispatch(scope, {
      requestId: queued.requestId,
      audience,
      provider: inAppOnlyProvider,
    });

    return {
      data: {
        requestId: queued.requestId,
        alreadyQueued: queued.alreadyQueued,
        sent: outcomes.filter((o) => o.outcome === 'sent').length,
        suppressed: outcomes.filter((o) => o.outcome === 'suppressed').length,
        failed: outcomes.filter((o) => o.outcome === 'failed').length,
        outcomes,
      },
    };
  }

  /**
   * The exact text each person was sent, or the reason they were not.
   *
   * Not a narrower `outcomes`. That route answers "did it arrive" — statuses,
   * providers, error codes, the operational view. This answers "what did you
   * say to them", which is the question a guardian asks under the DPDP Act and
   * the one a school has to be able to answer without reconstructing it from a
   * template and a set of variables. Reconstruction is not evidence: the
   * template may have been revised since.
   *
   * `rendered_body` is null for a suppressed recipient, and that is correct —
   * nothing was rendered because nothing was sent, and `suppression_reason`
   * carries the answer instead.
   */
  @Get('requests/:id/recipients')
  async recipients(@Param('id') id: string) {
    const requestId = uuid.safeParse(id);
    if (!requestId.success) throw ApiError.fromZod(requestId.error);
    return {
      data: await withTenant(currentScope(), (db) =>
        dispatchService.recipientsFor(db, requestId.data)),
    };
  }

  /** Who a past send reached, and who it did not. */
  @Get('requests/:id/outcomes')
  async outcomes(@Param('id') id: string, @Query('limit') limit?: string) {
    const requestId = uuid.safeParse(id);
    if (!requestId.success) throw ApiError.fromZod(requestId.error);
    const cap = z.coerce.number().int().min(1).max(500).default(200)
      .safeParse(limit ?? undefined);
    if (!cap.success) throw ApiError.fromZod(cap.error);

    return {
      data: await withTenant(currentScope(), async (db) => {
        const { rows } = await db.query(
          `SELECT r.id, r.person_id, p.given_name, p.family_name,
                  r.subject_person_id, r.locale,
                  r.status, r.suppression_reason,
                  a.channel, a.provider, a.provider_status, a.error_code, a.sent_at
             FROM message_recipient r
             JOIN person p ON p.id = r.person_id
             LEFT JOIN LATERAL (
               SELECT at.channel, at.provider, at.provider_status, at.error_code,
                      at.sent_at
                 FROM message_attempt at
                WHERE at.message_recipient_id = r.id
                ORDER BY at.attempt_no DESC LIMIT 1) a ON true
            WHERE r.message_request_id = $1::uuid
            ORDER BY p.given_name
            LIMIT $2`,
          [requestId.data, cap.data]);
        return rows;
      }),
    };
  }
}
