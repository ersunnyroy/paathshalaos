/**
 * M9.2 and M9.3 — dispatch, delivery tracking, and AC-8.
 *
 * **AC-8, stated plainly:** withdrawn consent is never messaged, and a guardian
 * of three children gets three correct messages.
 *
 * Both halves are easy to get wrong in the same way — by optimising. The first
 * fails when an audience is computed at queue time and consent is checked there:
 * a parent who withdraws at 9am is still messaged by the 9:05 job, and the
 * system has a perfectly good log showing it had consent when the list was
 * built. So consent is re-read HERE, per recipient, at the moment of sending.
 *
 * The second fails when recipients are deduplicated by phone number, which is
 * the obvious thing to do and looks like a bug fix ("we were sending three
 * messages to the same number"). The parent then learns about one child and not
 * the other two. The unique index is per (person, subject) precisely so that
 * optimisation cannot be applied by accident.
 *
 * A third rule that is not in the acceptance criteria but belongs here: a
 * message that is NOT sent is recorded as suppressed, with the reason. "We did
 * not message you because you withdrew consent on the 4th" is the answer a
 * regulator asks for, and an absent row cannot give it.
 */
import { withTenant, type TenantScope, type TenantClient } from '../../db/tenant.ts';
import { ApiError } from '../../common/errors.ts';
import { auditService } from '../audit/audit.service.ts';
import { outboxService } from '../events/outbox.service.ts';
import { templateService, render, type Channel, type Purpose } from './template.service.ts';

export interface Audience {
  personId: string;
  /** The learner the message is about. Omitted for a message about the recipient. */
  subjectPersonId?: string;
  variables: Record<string, string>;
}

export interface SendProvider {
  name: string;
  send(input: {
    channel: Channel; to: string; body: string;
    dltTemplateId?: string | null; senderHeader?: string | null;
    waTemplateName?: string | null;
  }): Promise<{ providerMessageId: string }>;
}

export interface DispatchOutcome {
  personId: string;
  subjectPersonId: string | null;
  outcome: 'sent' | 'suppressed' | 'failed';
  channel?: Channel;
  reason?: string;
}

/** Channel order when the preferred one fails. In-app never fails, so it is last. */
const FALLBACK_ORDER: Record<Channel, Channel[]> = {
  whatsapp: ['whatsapp', 'sms', 'in_app'],
  sms: ['sms', 'whatsapp', 'in_app'],
  email: ['email', 'in_app'],
  push: ['push', 'sms', 'in_app'],
  in_app: ['in_app'],
};

const CONTACT_KIND: Record<Channel, string | null> = {
  sms: 'phone', whatsapp: 'whatsapp', email: 'email', push: null, in_app: null,
};

export const dispatchService = {
  /**
   * Queues a request. Idempotent on the caller's key: a retried job is the same
   * request, which is the difference between a delayed notification and two
   * notifications.
   */
  async queue(
    scope: TenantScope,
    input: {
      templateCode: string; idempotencyKey: string;
      sourceType: string; sourceId?: string; campusId?: string;
      requestedByStaffId?: string;
    },
  ): Promise<{ requestId: string; alreadyQueued: boolean }> {
    return withTenant(scope, async (db) => {
      const template = await templateService.byCode(db, input.templateCode);
      if (!template) {
        throw ApiError.make('not_found', 'template_not_found',
          `No template with code ${input.templateCode}.`);
      }

      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO message_request
           (tenant_id, campus_id, message_template_id, purpose, source_type, source_id,
            idempotency_key, requested_by)
         VALUES (app_current_tenant_id(), $1::uuid, $2::uuid, $3, $4, $5::uuid, $6, $7::uuid)
         ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
         RETURNING id`,
        [input.campusId ?? null, template.id, template.purpose, input.sourceType,
         input.sourceId ?? null, input.idempotencyKey, input.requestedByStaffId ?? null],
      );
      if (rows[0]) return { requestId: rows[0].id, alreadyQueued: false };

      const existing = await db.query<{ id: string }>(
        'SELECT id FROM message_request WHERE idempotency_key = $1', [input.idempotencyKey],
      );
      return { requestId: existing.rows[0]!.id, alreadyQueued: true };
    });
  },

  /**
   * Sends one request to an audience.
   *
   * Consent is evaluated per recipient, HERE, however stale the audience is.
   */
  async dispatch(
    scope: TenantScope,
    input: {
      requestId: string; audience: Audience[]; provider: SendProvider;
      now?: Date;
    },
  ): Promise<{ outcomes: DispatchOutcome[] }> {
    const outcomes = await withTenant(scope, async (db) => {
      const found = await db.query<{
        id: string; message_template_id: string; purpose: Purpose; status: string;
      }>(
        `SELECT id, message_template_id, purpose, status
           FROM message_request WHERE id = $1::uuid FOR UPDATE`,
        [input.requestId],
      );
      const request = found.rows[0];
      if (!request) {
        throw ApiError.make('not_found', 'request_not_found', 'Message request not found.');
      }
      if (request.status === 'cancelled') {
        throw ApiError.make('conflict', 'request_cancelled',
          'That request was cancelled.');
      }
      if (request.status === 'completed') {
        // A replay. The recipients already exist and their unique index would
        // refuse duplicates anyway; returning what happened is more useful than
        // an error.
        return dispatchService.outcomesFor(db, request.id);
      }

      await db.query(
        `UPDATE message_request SET status = 'dispatching' WHERE id = $1::uuid`,
        [request.id],
      );

      const results: DispatchOutcome[] = [];
      for (const member of input.audience) {
        await db.query('SAVEPOINT recipient_row');
        try {
          const result = await dispatchOne(db, {
            request, member, provider: input.provider, now: input.now ?? new Date(),
          });
          await db.query('RELEASE SAVEPOINT recipient_row');
          results.push(result);
        } catch (error) {
          await db.query('ROLLBACK TO SAVEPOINT recipient_row');
          results.push({
            personId: member.personId,
            subjectPersonId: member.subjectPersonId ?? null,
            outcome: 'failed',
            reason: error instanceof Error ? error.message : 'unknown_error',
          });
        }
      }

      await db.query(
        `UPDATE message_request SET status = 'completed', completed_at = now()
          WHERE id = $1::uuid`,
        [request.id],
      );

      await outboxService.emit(db, {
        eventType: 'messages.dispatched',
        aggregateType: 'message_request',
        aggregateId: request.id,
        payload: {
          requestId: request.id,
          sent: results.filter((r) => r.outcome === 'sent').length,
          suppressed: results.filter((r) => r.outcome === 'suppressed').length,
          failed: results.filter((r) => r.outcome === 'failed').length,
        },
      });

      return results;
    });

    const suppressed = outcomes.filter((o) => o.outcome === 'suppressed');
    if (suppressed.length > 0) {
      await auditService.record({
        tenantId: scope.tenantId,
        actorUserId: scope.actorId,
        action: 'messages.suppressed',
        resourceType: 'message_request',
        resourceId: input.requestId,
        classification: 'SENSITIVE',
        after: { count: suppressed.length, reasons: [...new Set(suppressed.map((s) => s.reason))] },
      });
    }

    return { outcomes };
  },

  /**
   * A provider delivery receipt. Deduped on the provider's own event id and
   * stored raw before anything is interpreted — the same discipline as payment
   * webhooks, for the same reason: a provider that does not get a 200 sends it
   * again, often several times at once.
   */
  async recordReceipt(
    scope: TenantScope,
    input: {
      provider: string; providerMessageId: string; providerEventId?: string;
      status: string; errorCode?: string; rawBody: string; signatureValid?: boolean;
    },
  ): Promise<{ processed: boolean; reason?: string }> {
    return withTenant(scope, async (db) => {
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO delivery_receipt
           (tenant_id, provider, provider_message_id, provider_event_id, status,
            error_code, raw_body, signature_valid)
         VALUES (app_current_tenant_id(), $1, $2, $3::text, $4, $5::text, $6, $7::boolean)
         -- The index is partial (a receipt without an event id cannot be
         -- deduped), so the predicate has to be named for inference to use it.
         ON CONFLICT (provider, provider_event_id) WHERE provider_event_id IS NOT NULL
           DO NOTHING
         RETURNING id`,
        [input.provider, input.providerMessageId, input.providerEventId ?? null,
         input.status, input.errorCode ?? null, input.rawBody,
         input.signatureValid ?? null],
      );
      if (!rows[0] && input.providerEventId) {
        return { processed: false, reason: 'duplicate_event' };
      }
      if (input.signatureValid === false) {
        // Stored for investigation, never acted on.
        return { processed: false, reason: 'invalid_signature' };
      }

      const mapped = mapProviderStatus(input.status);
      if (!mapped) return { processed: false, reason: 'status_not_handled' };

      const attempt = await db.query<{ message_recipient_id: string }>(
        `SELECT message_recipient_id FROM message_attempt
          WHERE provider = $1 AND provider_message_id = $2`,
        [input.provider, input.providerMessageId],
      );
      if (!attempt.rows[0]) return { processed: false, reason: 'unknown_message' };

      await db.query(
        `UPDATE message_attempt
            SET provider_status = $3, error_code = COALESCE($4::text, error_code)
          WHERE provider = $1 AND provider_message_id = $2`,
        [input.provider, input.providerMessageId, input.status, input.errorCode ?? null],
      );

      // A receipt never moves a recipient BACKWARDS. Providers deliver receipts
      // out of order routinely, and a late 'sent' arriving after 'read' would
      // otherwise erase the knowledge that the parent opened it.
      await db.query(
        `UPDATE message_recipient
            SET status = $2, updated_at = now()
          WHERE id = $1::uuid
            AND array_position(ARRAY['pending','sent','delivered','read'], status)
                < array_position(ARRAY['pending','sent','delivered','read'], $2::text)`,
        [attempt.rows[0].message_recipient_id, mapped],
      );
      if (mapped === 'failed') {
        await db.query(
          `UPDATE message_recipient SET status = 'failed', updated_at = now()
            WHERE id = $1::uuid AND status IN ('pending', 'sent')`,
          [attempt.rows[0].message_recipient_id],
        );
      }

      await db.query(
        `UPDATE delivery_receipt SET processed_at = now() WHERE id = $1::uuid`,
        [rows[0]!.id],
      );
      return { processed: true };
    });
  },

  async outcomesFor(db: TenantClient, requestId: string): Promise<DispatchOutcome[]> {
    const { rows } = await db.query<{
      person_id: string; subject_person_id: string | null; status: string;
      channel: Channel | null; suppression_reason: string | null;
    }>(
      `SELECT person_id, subject_person_id, status, channel, suppression_reason
         FROM message_recipient WHERE message_request_id = $1::uuid
        ORDER BY created_at`,
      [requestId],
    );
    return rows.map((r) => ({
      personId: r.person_id,
      subjectPersonId: r.subject_person_id,
      outcome: r.status === 'suppressed' ? 'suppressed'
        : r.status === 'failed' ? 'failed' : 'sent',
      ...(r.channel ? { channel: r.channel } : {}),
      ...(r.suppression_reason ? { reason: r.suppression_reason } : {}),
    }));
  },

  async recipientsFor(db: TenantClient, requestId: string): Promise<Array<{
    person_id: string; subject_person_id: string | null; status: string;
    channel: Channel | null; rendered_body: string | null; suppression_reason: string | null;
  }>> {
    const { rows } = await db.query<{
      person_id: string; subject_person_id: string | null; status: string;
      channel: Channel | null; rendered_body: string | null; suppression_reason: string | null;
    }>(
      `SELECT person_id, subject_person_id, status, channel, rendered_body, suppression_reason
         FROM message_recipient WHERE message_request_id = $1::uuid
        ORDER BY subject_person_id NULLS FIRST, person_id`,
      [requestId],
    );
    return rows;
  },
};

async function dispatchOne(
  db: TenantClient,
  ctx: {
    request: { id: string; message_template_id: string; purpose: Purpose };
    member: Audience;
    provider: SendProvider;
    now: Date;
  },
): Promise<DispatchOutcome> {
  const { request, member, provider } = ctx;
  const subjectId = member.subjectPersonId ?? member.personId;

  // ---- AC-8. Read now, not when the audience was assembled. ----
  const verdict = await db.query<{ verdict: string }>(
    'SELECT may_message($1::uuid, $2::uuid, $3) AS verdict',
    [subjectId, member.personId, request.purpose],
  );
  const permission = verdict.rows[0]!.verdict;
  if (permission !== 'ok') {
    await suppress(db, request.id, member, permission);
    return {
      personId: member.personId,
      subjectPersonId: member.subjectPersonId ?? null,
      outcome: 'suppressed',
      reason: permission,
    };
  }

  const preference = await db.query<{
    preferred_channel: Channel | null; locale: string | null;
  }>(
    `SELECT preferred_channel, locale FROM communication_preference
      WHERE person_id = $1::uuid AND purpose = $2`,
    [member.personId, request.purpose],
  );
  const preferred = preference.rows[0]?.preferred_channel ?? 'whatsapp';
  const locale = preference.rows[0]?.locale ?? 'en-IN';

  const contacts = await db.query<{ id: string; kind: string; value: string; opt_in_state: string }>(
    `SELECT id, kind, value, opt_in_state FROM contact_method
      WHERE person_id = $1::uuid AND deleted_at IS NULL
      ORDER BY is_primary DESC`,
    [member.personId],
  );

  let attemptNo = 0;
  let lastError = 'no_channel_available';

  // The recipient row exists before the first attempt, so a crash mid-send
  // leaves a pending row to investigate rather than nothing at all.
  const recipient = await db.query<{ id: string }>(
    `INSERT INTO message_recipient
       (tenant_id, message_request_id, person_id, subject_person_id, locale)
     VALUES (app_current_tenant_id(), $1::uuid, $2::uuid, $3::uuid, $4)
     ON CONFLICT (message_request_id, person_id,
                  COALESCE(subject_person_id, '00000000-0000-0000-0000-000000000000'::uuid))
       DO NOTHING
     RETURNING id`,
    [request.id, member.personId, member.subjectPersonId ?? null, locale],
  );
  if (!recipient.rows[0]) {
    // Already dispatched to this person about this subject in this request.
    return {
      personId: member.personId,
      subjectPersonId: member.subjectPersonId ?? null,
      outcome: 'sent',
      reason: 'already_dispatched',
    };
  }
  const recipientId = recipient.rows[0].id;

  for (const channel of FALLBACK_ORDER[preferred]) {
    const version = await templateService.approvedVersion(
      db, request.message_template_id, channel, locale,
    );
    if (!version) { lastError = 'no_approved_template'; continue; }

    const kind = CONTACT_KIND[channel];
    const contact = kind ? contacts.rows.find((c) => c.kind === kind) : undefined;
    if (kind && !contact) { lastError = 'no_contact_method'; continue; }
    if (contact?.opt_in_state === 'opted_out') { lastError = 'channel_opted_out'; continue; }

    // WhatsApp outside the 24-hour session window: only an approved template
    // may go. Ours always is — the check is here so that when free-form
    // messages are added, the window is already being consulted.
    if (channel === 'whatsapp') {
      const session = await db.query<{ within: boolean }>(
        `SELECT (last_inbound_at > now() - interval '24 hours') AS within
           FROM whatsapp_session WHERE person_id = $1::uuid`,
        [member.personId],
      );
      const within = session.rows[0]?.within ?? false;
      if (!within && !version.wa_template_name) {
        lastError = 'outside_session_window'; continue;
      }
    }

    let body: string;
    try {
      body = render(version.body, member.variables);
    } catch {
      // A template whose variables the caller did not supply must not go out
      // half-filled. It is a fault in this request, not in the channel, so
      // falling through to SMS would send the same broken text again.
      lastError = 'missing_variables';
      break;
    }

    attemptNo += 1;
    try {
      const sent = await provider.send({
        channel,
        to: contact?.value ?? member.personId,
        body,
        dltTemplateId: version.dlt_template_id,
        senderHeader: version.sender_header,
        waTemplateName: version.wa_template_name,
      });

      await db.query(
        `INSERT INTO message_attempt
           (tenant_id, message_recipient_id, attempt_no, channel, fallback_from,
            provider, provider_message_id, provider_status)
         VALUES (app_current_tenant_id(), $1::uuid, $2::integer, $3, $4::text, $5, $6, 'sent')`,
        [recipientId, attemptNo, channel,
         attemptNo > 1 ? preferred : null, provider.name, sent.providerMessageId],
      );
      await db.query(
        `UPDATE message_recipient
            SET status = 'sent', channel = $2, contact_method_id = $3::uuid,
                rendered_body = $4, updated_at = now()
          WHERE id = $1::uuid`,
        [recipientId, channel, contact?.id ?? null, body],
      );

      return {
        personId: member.personId,
        subjectPersonId: member.subjectPersonId ?? null,
        outcome: 'sent',
        channel,
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : 'provider_error';
      await db.query(
        `INSERT INTO message_attempt
           (tenant_id, message_recipient_id, attempt_no, channel, fallback_from,
            provider, provider_status, error_detail)
         VALUES (app_current_tenant_id(), $1::uuid, $2::integer, $3, $4::text, $5,
                 'failed', $6)`,
        [recipientId, attemptNo, channel,
         attemptNo > 1 ? preferred : null, provider.name, lastError],
      );
      // and fall through to the next channel
    }
  }

  await db.query(
    `UPDATE message_recipient SET status = 'failed', updated_at = now()
      WHERE id = $1::uuid`,
    [recipientId],
  );
  return {
    personId: member.personId,
    subjectPersonId: member.subjectPersonId ?? null,
    outcome: 'failed',
    reason: lastError,
  };
}

/**
 * Records that a message was deliberately NOT sent, and why.
 *
 * The row is the evidence. An absent row proves nothing, and "we have no record
 * of messaging you" is a much weaker answer than "we recorded a suppression
 * because your consent was withdrawn".
 */
async function suppress(
  db: TenantClient, requestId: string, member: Audience, reason: string,
): Promise<void> {
  await db.query(
    `INSERT INTO message_recipient
       (tenant_id, message_request_id, person_id, subject_person_id, status,
        suppression_reason)
     VALUES (app_current_tenant_id(), $1::uuid, $2::uuid, $3::uuid, 'suppressed', $4)
     ON CONFLICT (message_request_id, person_id,
                  COALESCE(subject_person_id, '00000000-0000-0000-0000-000000000000'::uuid))
       DO NOTHING`,
    [requestId, member.personId, member.subjectPersonId ?? null, reason],
  );
}

/** Provider vocabularies differ; ours does not. */
function mapProviderStatus(status: string):
  'sent' | 'delivered' | 'read' | 'failed' | undefined {
  const normalised = status.toLowerCase();
  if (['delivered', 'delivrd', 'success'].includes(normalised)) return 'delivered';
  if (['read', 'seen'].includes(normalised)) return 'read';
  if (['sent', 'submitted', 'accepted'].includes(normalised)) return 'sent';
  if (['failed', 'undelivered', 'undeliv', 'rejected', 'expired'].includes(normalised)) {
    return 'failed';
  }
  return undefined;
}
