/**
 * M9.1–M9.3 — templates, dispatch, and AC-8.
 *
 * AC-8: withdrawn consent is never messaged, and a guardian of three children
 * gets three correct messages.
 *
 * Both halves are tested against the DISPATCHER rather than against a helper,
 * because both failures happen at dispatch: consent read too early, and
 * recipients deduplicated by phone number.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import {
  createTenant, destroyTenants, createUser, destroyUsers, grantRole, purgeTestData,
  createPersonRaw, createLearnerRaw, linkGuardianRaw, publishNotice,
  OWNER_URL, type TenantFixture, type UserFixture,
} from './fixtures.ts';
import {
  templateService, render, variablesIn,
} from '../src/modules/messaging/template.service.ts';
import {
  dispatchService, type SendProvider,
} from '../src/modules/messaging/dispatch.service.ts';
import { withTenant } from '../src/db/tenant.ts';
import { pool } from '../src/db/pool.ts';
import { authPool } from '../src/db/auth-pool.ts';

let tenant: TenantFixture;
let admin: UserFixture;
let guardianUser: UserFixture;
let noticeId: string;
let guardianPersonId: string;
/** Three children of the one guardian — the second half of AC-8. */
let children: Array<{ studentId: string; personId: string; name: string }> = [];
let attendanceTemplateId: string;
let marketingTemplateId: string;

const PASSWORD = 'correct-horse-battery';

beforeAll(async () => {
  await purgeTestData('%@msg-test.example');
  tenant = await createTenant('MSG');

  admin = await createUser('admin@msg-test.example', PASSWORD);
  guardianUser = await createUser('parent@msg-test.example', PASSWORD);
  await grantRole(tenant.orgId, admin.userId, 'ORG_OWNER', 'organization', null);
  await grantRole(tenant.orgId, guardianUser.userId, 'GUARDIAN', 'self', tenant.campusId);

  guardianPersonId = await createPersonRaw(tenant.orgId, 'Lakshmi', {
    userAccountId: guardianUser.userId, familyName: 'Rao',
  });
  await asOwner((c) => c.query(
    `INSERT INTO contact_method (tenant_id, person_id, kind, value, is_primary, opt_in_state)
     VALUES ($1, $2, 'whatsapp', '+919876500001', true, 'opted_in'),
            ($1, $2, 'phone', '+919876500001', true, 'opted_in')`,
    [tenant.orgId, guardianPersonId],
  ));

  noticeId = await publishNotice(`msg-notice-${randomUUID().slice(0, 8)}`);

  for (const name of ['Aarav', 'Diya', 'Kabir']) {
    const learner = await createLearnerRaw(tenant.orgId, name, `MSG-${name}`);
    await linkGuardianRaw(tenant.orgId, learner.studentId, guardianPersonId);
    const personId = await asOwner(async (c) => {
      const r = await c.query<{ person_id: string }>(
        `SELECT person_id FROM student WHERE id = $1`, [learner.studentId]);
      return r.rows[0]!.person_id;
    });
    children.push({ studentId: learner.studentId, personId, name });
  }

  // Consent for attendance notifications, given by the guardian, for each child.
  for (const child of children) {
    await giveConsent(child.personId, 'attendance_notifications');
  }

  const attendance = await templateService.create(admin_(), {
    code: 'attendance.absent', name: 'Absence notice',
    purpose: 'attendance_notifications',
  });
  attendanceTemplateId = attendance.id;
  const waVersion = await templateService.addVersion(admin_(), {
    templateId: attendanceTemplateId, channel: 'whatsapp',
    body: 'Dear {{guardian_name}}, {{learner_name}} was absent on {{date}}.',
    waTemplateName: 'absence_notice', waLanguage: 'en',
  });
  await templateService.approve(admin_(), waVersion.id);
  const smsVersion = await templateService.addVersion(admin_(), {
    templateId: attendanceTemplateId, channel: 'sms',
    body: '{{learner_name}} was absent on {{date}}. - School',
    dltEntityId: '1101', dltTemplateId: '1107', senderHeader: 'SCHOOL',
  });
  await templateService.approve(admin_(), smsVersion.id);

  const marketing = await templateService.create(admin_(), {
    code: 'marketing.summer', name: 'Summer camp', purpose: 'marketing',
  });
  marketingTemplateId = marketing.id;
  const mkt = await templateService.addVersion(admin_(), {
    templateId: marketingTemplateId, channel: 'whatsapp',
    body: 'Hello {{guardian_name}}, our summer camp is open.',
    waTemplateName: 'summer_camp', waLanguage: 'en',
  });
  await templateService.approve(admin_(), mkt.id);
});

afterAll(async () => {
  await destroyUsers([admin.userId, guardianUser.userId]);
  await destroyTenants([tenant.orgId]);
  await Promise.all([pool.end(), authPool.end()]);
});

const admin_ = () => ({ tenantId: tenant.orgId, actorId: admin.userId });
const guardian = () => ({ tenantId: tenant.orgId, actorId: guardianUser.userId });

async function asOwner<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: OWNER_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function giveConsent(personId: string, purpose: string): Promise<string> {
  return asOwner(async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO consent_record
         (tenant_id, person_id, given_by_person_id, purpose, basis, notice_version_id, channel)
       VALUES ($1, $2, $3, $4, 'consent', $5, 'app') RETURNING id`,
      [tenant.orgId, personId, guardianPersonId, purpose, noticeId],
    );
    return rows[0]!.id;
  });
}

async function withdrawConsent(personId: string, purpose: string): Promise<void> {
  await asOwner((c) => c.query(
    `UPDATE consent_record SET withdrawn_at = now(), withdrawn_reason = 'Asked to stop.'
      WHERE person_id = $1 AND purpose = $2 AND withdrawn_at IS NULL`,
    [personId, purpose],
  ));
}

/** A provider that records what it was asked to send, and can be told to fail. */
function recordingProvider(opts: { failOn?: string[] } = {}): SendProvider & {
  sent: Array<{ channel: string; to: string; body: string; dlt?: string | null }>;
} {
  const sent: Array<{ channel: string; to: string; body: string; dlt?: string | null }> = [];
  return {
    name: 'test-provider',
    sent,
    async send(input) {
      if (opts.failOn?.includes(input.channel)) {
        throw new Error(`${input.channel}_unavailable`);
      }
      // ?? null rather than passing undefined through: the recorder's shape
      // says `string | null`, and with exactOptionalPropertyTypes those are
      // genuinely different. The test was only compiling because test files
      // were excluded from the typecheck.
      sent.push({ channel: input.channel, to: input.to, body: input.body,
        dlt: input.dltTemplateId ?? null });
      return { providerMessageId: `pm_${randomUUID()}` };
    },
  };
}

const absenceAudience = () => children.map((child) => ({
  personId: guardianPersonId,
  subjectPersonId: child.personId,
  variables: { guardian_name: 'Lakshmi', learner_name: child.name, date: '2026-09-18' },
}));

describe('templates', () => {
  it('derives the variable list from the body', () => {
    expect(variablesIn('Hi {{a}}, see {{b}} and {{ a }}.')).toEqual(['a', 'b']);
  });

  it('a missing variable is an error, not an empty space', () => {
    // The alternative is a parent receiving the literal "{{learner_name}}",
    // which is the thing people screenshot.
    let thrown: unknown;
    try {
      render('Dear {{guardian_name}}, {{learner_name}} was absent.',
        { guardian_name: 'Lakshmi' });
    } catch (e) { thrown = e; }
    const body = (thrown as { getResponse(): { error: { code: string; message: string } } })
      .getResponse().error;
    expect(body.code).toBe('missing_variables');
    // The message names the variable, because "a variable is missing" sends the
    // next person hunting through the template.
    expect(body.message).toMatch(/learner_name/);

    expect(render('Dear {{guardian_name}}.', { guardian_name: 'Lakshmi' }))
      .toBe('Dear Lakshmi.');
  });

  it('an SMS version cannot be approved without its DLT registration', async () => {
    // An Indian operator rejects an unregistered template outright. An
    // "approved" one without the ids looks ready and is not.
    const t = await templateService.create(admin_(), {
      code: `no-dlt-${randomUUID().slice(0, 8)}`, name: 'No DLT',
      purpose: 'fee_notifications',
    });
    const v = await templateService.addVersion(admin_(), {
      templateId: t.id, channel: 'sms', body: 'Your fee is due.',
    });
    await expect(templateService.approve(admin_(), v.id))
      .rejects.toThrow(/template_version_sms_needs_dlt/i);
  });

  it('a WhatsApp version cannot be approved without its Meta template name', async () => {
    const t = await templateService.create(admin_(), {
      code: `no-wa-${randomUUID().slice(0, 8)}`, name: 'No WA',
      purpose: 'fee_notifications',
    });
    const v = await templateService.addVersion(admin_(), {
      templateId: t.id, channel: 'whatsapp', body: 'Your fee is due.',
    });
    await expect(templateService.approve(admin_(), v.id))
      .rejects.toThrow(/template_version_whatsapp_needs_name/i);
  });

  it('an approved version is frozen', async () => {
    // The DLT registration is against a specific body; editing it means the
    // registration no longer describes what is sent.
    const version = await withTenant(admin_(), (db) =>
      templateService.approvedVersion(db, attendanceTemplateId, 'sms', ['en-IN']));
    await expect(
      asOwner((c) => c.query(
        `UPDATE message_template_version SET body = 'Something else' WHERE id = $1`,
        [version!.id])),
    ).rejects.toThrow(/frozen/i);
    await expect(
      asOwner((c) => c.query(
        `DELETE FROM message_template_version WHERE id = $1`, [version!.id])),
    ).rejects.toThrow(/cannot be deleted/i);
  });

  it('falls back down the chain when the preferred locale has no approved version', async () => {
    const version = await withTenant(admin_(), (db) =>
      templateService.approvedVersion(db, attendanceTemplateId, 'sms', ['hi-IN', 'en-IN']));
    // A parent who set Hindi should still learn their child was absent.
    expect(version).toBeDefined();
    expect(version!.locale).toBe('en-IN');
  });
});

describe('AC-8 — a three-child guardian gets three correct messages', () => {
  let requestId: string;
  let provider: ReturnType<typeof recordingProvider>;

  it('sends one message per child, not one per phone number', async () => {
    // The optimisation that breaks this looks like a bug fix: "we were sending
    // three messages to the same number". The parent then hears about one child
    // and never about the other two.
    provider = recordingProvider();
    const queued = await dispatchService.queue(admin_(), {
      templateCode: 'attendance.absent', idempotencyKey: `abs-${randomUUID()}`,
      sourceType: 'attendance_session',
    });
    requestId = queued.requestId;

    const { outcomes } = await dispatchService.dispatch(admin_(), {
      requestId, audience: absenceAudience(), provider,
    });

    expect(outcomes.length).toBe(3);
    expect(outcomes.every((o) => o.outcome === 'sent')).toBe(true);
    expect(provider.sent.length).toBe(3);
  });

  it('each message names the right child', async () => {
    const bodies = provider.sent.map((s) => s.body);
    for (const child of children) {
      expect(bodies.filter((b) => b.includes(child.name)).length).toBe(1);
    }
  });

  it('all three go to the one guardian', async () => {
    expect(new Set(provider.sent.map((s) => s.to)).size).toBe(1);
    const recipients = await withTenant(admin_(), (db) =>
      dispatchService.recipientsFor(db, requestId));
    expect(new Set(recipients.map((r) => r.person_id)).size).toBe(1);
    expect(new Set(recipients.map((r) => r.subject_person_id)).size).toBe(3);
  });

  it('re-dispatching the same request sends nothing more', async () => {
    const again = recordingProvider();
    await dispatchService.dispatch(admin_(), {
      requestId, audience: absenceAudience(), provider: again,
    });
    expect(again.sent.length).toBe(0);
  });

  it('queueing with the same idempotency key is the same request', async () => {
    const key = `dup-${randomUUID()}`;
    const first = await dispatchService.queue(admin_(), {
      templateCode: 'attendance.absent', idempotencyKey: key, sourceType: 'test',
    });
    const second = await dispatchService.queue(admin_(), {
      templateCode: 'attendance.absent', idempotencyKey: key, sourceType: 'test',
    });
    expect(second.requestId).toBe(first.requestId);
    expect(second.alreadyQueued).toBe(true);
  });
});

describe('AC-8 — withdrawn consent is never messaged', () => {
  it('suppresses the withdrawn child and still messages the others', async () => {
    // The specific failure this catches: consent evaluated when the audience was
    // built, not when the message was sent. A parent who withdraws at 9am is
    // still messaged by the 9:05 job.
    await withdrawConsent(children[1]!.personId, 'attendance_notifications');

    const provider = recordingProvider();
    const queued = await dispatchService.queue(admin_(), {
      templateCode: 'attendance.absent', idempotencyKey: `wd-${randomUUID()}`,
      sourceType: 'attendance_session',
    });
    const { outcomes } = await dispatchService.dispatch(admin_(), {
      requestId: queued.requestId, audience: absenceAudience(), provider,
    });

    const suppressed = outcomes.filter((o) => o.outcome === 'suppressed');
    expect(suppressed.length).toBe(1);
    expect(suppressed[0]!.subjectPersonId).toBe(children[1]!.personId);
    expect(suppressed[0]!.reason).toBe('consent_withdrawn');

    expect(provider.sent.length).toBe(2);
    expect(provider.sent.some((s) => s.body.includes(children[1]!.name))).toBe(false);
  });

  it('the suppression is RECORDED, with the reason', async () => {
    // "We have no record of messaging you" is a much weaker answer than "we
    // recorded a suppression because consent was withdrawn on the 4th", and the
    // second is the one a regulator asks for.
    const rows = await asOwner(async (c) => {
      const r = await c.query<{ suppression_reason: string }>(
        `SELECT suppression_reason FROM message_recipient
          WHERE status = 'suppressed' AND subject_person_id = $1`,
        [children[1]!.personId]);
      return r.rows;
    });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.suppression_reason === 'consent_withdrawn')).toBe(true);
  });

  it('the table itself refuses a suppression with no reason', async () => {
    // The dispatcher always supplies one, but the dispatcher is not the only
    // thing that will ever write here. "We suppressed it" without "why" is the
    // record that cannot answer a regulator, so the rule belongs in the table.
    const queued = await dispatchService.queue(admin_(), {
      templateCode: 'attendance.absent', idempotencyKey: `raw-${randomUUID()}`,
      sourceType: 'test',
    });
    await expect(
      asOwner((c) => c.query(
        `INSERT INTO message_recipient
           (tenant_id, message_request_id, person_id, subject_person_id, status)
         VALUES ($1, $2, $3, $4, 'suppressed')`,
        [tenant.orgId, queued.requestId, guardianPersonId, children[0]!.personId])),
    ).rejects.toThrow(/message_recipient_suppressed_has_reason/i);

    // And the reverse: a reason on a row that WAS sent is equally wrong, because
    // it reads as a suppression that somehow also went out.
    await expect(
      asOwner((c) => c.query(
        `INSERT INTO message_recipient
           (tenant_id, message_request_id, person_id, subject_person_id, status,
            suppression_reason)
         VALUES ($1, $2, $3, $4, 'sent', 'consent_withdrawn')`,
        [tenant.orgId, queued.requestId, guardianPersonId, children[1]!.personId])),
    ).rejects.toThrow(/message_recipient_suppressed_has_reason/i);
  });

  it('withdrawing between queueing and dispatching still suppresses', async () => {
    // The sharpest form of the same thing: the audience is assembled while
    // consent holds and the withdrawal lands before the send.
    const queued = await dispatchService.queue(admin_(), {
      templateCode: 'attendance.absent', idempotencyKey: `race-${randomUUID()}`,
      sourceType: 'attendance_session',
    });
    const audience = absenceAudience();

    await withdrawConsent(children[2]!.personId, 'attendance_notifications');

    const provider = recordingProvider();
    const { outcomes } = await dispatchService.dispatch(admin_(), {
      requestId: queued.requestId, audience, provider,
    });
    const forChild = outcomes.find((o) => o.subjectPersonId === children[2]!.personId)!;
    expect(forChild.outcome).toBe('suppressed');
    expect(provider.sent.some((s) => s.body.includes(children[2]!.name))).toBe(false);
  });

  it('never messaged means never sent — no consent at all is also a suppression', async () => {
    const provider = recordingProvider();
    const queued = await dispatchService.queue(admin_(), {
      templateCode: 'marketing.summer', idempotencyKey: `mkt-${randomUUID()}`,
      sourceType: 'campaign',
    });
    const { outcomes } = await dispatchService.dispatch(admin_(), {
      requestId: queued.requestId,
      audience: [{ personId: guardianPersonId, variables: { guardian_name: 'Lakshmi' } }],
      provider,
    });
    expect(outcomes[0]).toMatchObject({ outcome: 'suppressed', reason: 'no_consent' });
    expect(provider.sent.length).toBe(0);
  });

  it('a muted purpose suppresses without touching consent', async () => {
    // Muting is a preference, not a withdrawal. Conflating them means "please
    // stop texting me about the camp" reads as revoking the legal basis for
    // everything.
    const code = `fee-${randomUUID().slice(0, 8)}`;
    const t = await templateService.create(admin_(), {
      code, name: 'Fee due', purpose: 'fee_notifications',
    });
    const v = await templateService.addVersion(admin_(), {
      templateId: t.id, channel: 'whatsapp', body: 'Fees are due.',
      waTemplateName: 'fee_due', waLanguage: 'en',
    });
    await templateService.approve(admin_(), v.id);

    await giveConsent(guardianPersonId, 'fee_notifications');
    await asOwner((c) => c.query(
      `INSERT INTO communication_preference (tenant_id, person_id, purpose, muted)
       VALUES ($1, $2, 'fee_notifications', true)`,
      [tenant.orgId, guardianPersonId],
    ));

    const provider = recordingProvider();
    const request = await dispatchService.queue(admin_(), {
      templateCode: code, idempotencyKey: `fee-${randomUUID()}`, sourceType: 'invoice',
    });
    const { outcomes } = await dispatchService.dispatch(admin_(), {
      requestId: request.requestId,
      audience: [{ personId: guardianPersonId, variables: {} }],
      provider,
    });
    expect(outcomes[0]).toMatchObject({ outcome: 'suppressed', reason: 'muted' });
    expect(provider.sent.length).toBe(0);

    // And the consent record is untouched — the parent has not revoked anything.
    const consent = await asOwner(async (c) => {
      const r = await c.query<{ withdrawn_at: string | null }>(
        `SELECT withdrawn_at FROM consent_record
          WHERE person_id = $1 AND purpose = 'fee_notifications'`,
        [guardianPersonId]);
      return r.rows[0]!;
    });
    expect(consent.withdrawn_at).toBeNull();
  });

  it('core education service is not consent-gated', async () => {
    // A fee receipt is not marketing. Withdrawing optional consent must not
    // break the contract the family is actually in.
    const verdict = await withTenant(admin_(), async (db) => {
      const r = await db.query<{ verdict: string }>(
        `SELECT may_message($1::uuid, $2::uuid, 'core_education_service') AS verdict`,
        [children[1]!.personId, guardianPersonId]);
      return r.rows[0]!.verdict;
    });
    expect(verdict).toBe('ok');
  });
});

describe('fallback and delivery', () => {
  it('falls back from WhatsApp to SMS and records both attempts', async () => {
    const provider = recordingProvider({ failOn: ['whatsapp'] });
    const queued = await dispatchService.queue(admin_(), {
      templateCode: 'attendance.absent', idempotencyKey: `fb-${randomUUID()}`,
      sourceType: 'attendance_session',
    });
    const { outcomes } = await dispatchService.dispatch(admin_(), {
      requestId: queued.requestId,
      audience: [{
        personId: guardianPersonId, subjectPersonId: children[0]!.personId,
        variables: { guardian_name: 'Lakshmi', learner_name: 'Aarav', date: '2026-09-18' },
      }],
      provider,
    });

    expect(outcomes[0]).toMatchObject({ outcome: 'sent', channel: 'sms' });
    expect(provider.sent[0]!.dlt).toBe('1107');

    const attempts = await asOwner(async (c) => {
      const r = await c.query<{ channel: string; provider_status: string }>(
        `SELECT a.channel, a.provider_status FROM message_attempt a
           JOIN message_recipient r ON r.id = a.message_recipient_id
          WHERE r.message_request_id = $1 ORDER BY a.attempt_no`,
        [queued.requestId]);
      return r.rows;
    });
    // Both attempts are on the record. "I never got it" is usually right about
    // something, and this is where you look.
    expect(attempts.map((a) => `${a.channel}:${a.provider_status}`))
      .toEqual(['whatsapp:failed', 'sms:sent']);
  });

  it('a delivery receipt advances the status', async () => {
    const provider = recordingProvider();
    const queued = await dispatchService.queue(admin_(), {
      templateCode: 'attendance.absent', idempotencyKey: `dr-${randomUUID()}`,
      sourceType: 'attendance_session',
    });
    await dispatchService.dispatch(admin_(), {
      requestId: queued.requestId,
      audience: [{
        personId: guardianPersonId, subjectPersonId: children[0]!.personId,
        variables: { guardian_name: 'Lakshmi', learner_name: 'Aarav', date: '2026-09-18' },
      }],
      provider,
    });

    const messageId = await asOwner(async (c) => {
      const r = await c.query<{ provider_message_id: string }>(
        `SELECT a.provider_message_id FROM message_attempt a
           JOIN message_recipient r ON r.id = a.message_recipient_id
          WHERE r.message_request_id = $1`, [queued.requestId]);
      return r.rows[0]!.provider_message_id;
    });

    const first = await dispatchService.recordReceipt(admin_(), {
      provider: 'test-provider', providerMessageId: messageId,
      providerEventId: `evt-${randomUUID()}`, status: 'delivered',
      rawBody: '{"status":"delivered"}', signatureValid: true,
    });
    expect(first.processed).toBe(true);

    const status = await asOwner(async (c) => {
      const r = await c.query<{ status: string }>(
        `SELECT status FROM message_recipient WHERE message_request_id = $1`,
        [queued.requestId]);
      return r.rows[0]!.status;
    });
    expect(status).toBe('delivered');
  });

  it('a duplicate receipt is a no-op', async () => {
    const eventId = `evt-${randomUUID()}`;
    const messageId = await asOwner(async (c) => {
      const r = await c.query<{ provider_message_id: string }>(
        `SELECT provider_message_id FROM message_attempt
          WHERE provider_message_id IS NOT NULL LIMIT 1`);
      return r.rows[0]!.provider_message_id;
    });
    const first = await dispatchService.recordReceipt(admin_(), {
      provider: 'test-provider', providerMessageId: messageId,
      providerEventId: eventId, status: 'delivered', rawBody: '{}', signatureValid: true,
    });
    const second = await dispatchService.recordReceipt(admin_(), {
      provider: 'test-provider', providerMessageId: messageId,
      providerEventId: eventId, status: 'delivered', rawBody: '{}', signatureValid: true,
    });
    expect(first.processed).toBe(true);
    expect(second).toMatchObject({ processed: false, reason: 'duplicate_event' });
  });

  it('a receipt with an invalid signature is stored and NOT acted on', async () => {
    const messageId = await asOwner(async (c) => {
      const r = await c.query<{ provider_message_id: string }>(
        `SELECT a.provider_message_id FROM message_attempt a
           JOIN message_recipient r ON r.id = a.message_recipient_id
          WHERE r.status = 'sent' AND a.provider_message_id IS NOT NULL LIMIT 1`);
      return r.rows[0]?.provider_message_id;
    });
    if (!messageId) return;

    const result = await dispatchService.recordReceipt(admin_(), {
      provider: 'test-provider', providerMessageId: messageId,
      providerEventId: `bad-${randomUUID()}`, status: 'failed',
      rawBody: '{"forged":true}', signatureValid: false,
    });
    expect(result).toMatchObject({ processed: false, reason: 'invalid_signature' });

    const stored = await asOwner(async (c) => {
      const r = await c.query(
        `SELECT id FROM delivery_receipt WHERE signature_valid = false`);
      return r.rows.length;
    });
    expect(stored).toBeGreaterThan(0);
  });

  it('a late receipt never moves a message backwards', async () => {
    // Providers deliver receipts out of order routinely. A late 'sent' arriving
    // after 'read' would erase the knowledge that the parent opened it.
    const messageId = await asOwner(async (c) => {
      const r = await c.query<{ provider_message_id: string }>(
        `SELECT a.provider_message_id FROM message_attempt a
           JOIN message_recipient r ON r.id = a.message_recipient_id
          WHERE r.status = 'delivered' AND a.provider_message_id IS NOT NULL LIMIT 1`);
      return r.rows[0]!.provider_message_id;
    });

    await dispatchService.recordReceipt(admin_(), {
      provider: 'test-provider', providerMessageId: messageId,
      providerEventId: `read-${randomUUID()}`, status: 'read',
      rawBody: '{}', signatureValid: true,
    });
    await dispatchService.recordReceipt(admin_(), {
      provider: 'test-provider', providerMessageId: messageId,
      providerEventId: `late-${randomUUID()}`, status: 'sent',
      rawBody: '{}', signatureValid: true,
    });

    const status = await asOwner(async (c) => {
      const r = await c.query<{ status: string }>(
        `SELECT r.status FROM message_recipient r
           JOIN message_attempt a ON a.message_recipient_id = r.id
          WHERE a.provider_message_id = $1`, [messageId]);
      return r.rows[0]!.status;
    });
    expect(status).toBe('read');
  });
});

describe('who can see messages', () => {
  it('a guardian sees what was addressed to them, including suppressions', async () => {
    // A second parent, with a message of their own, so this test can tell
    // "sees their own" apart from "sees everything". Without them the tenant has
    // one guardian and a policy widened to the whole tenant looks identical.
    const otherPersonId = await createPersonRaw(tenant.orgId, 'Other', {
      familyName: 'Parent',
    });
    const queued = await dispatchService.queue(admin_(), {
      templateCode: 'attendance.absent', idempotencyKey: `other-${randomUUID()}`,
      sourceType: 'test',
    });
    await asOwner((c) => c.query(
      `INSERT INTO message_recipient
         (tenant_id, message_request_id, person_id, subject_person_id, status)
       VALUES ($1, $2, $3, $4, 'sent')`,
      [tenant.orgId, queued.requestId, otherPersonId, children[0]!.personId],
    ));

    const seen = await withTenant(guardian(), async (db) => {
      const r = await db.query<{ status: string; person_id: string }>(
        'SELECT status, person_id FROM message_recipient');
      return r.rows;
    });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.some((s) => s.status === 'suppressed')).toBe(true);
    // The whole point: their own, and nobody else's.
    expect(seen.every((s) => s.person_id === guardianPersonId)).toBe(true);
    expect(seen.some((s) => s.person_id === otherPersonId)).toBe(false);
  });

  it('a guardian cannot see the dispatch bookkeeping', async () => {
    const requests = await withTenant(guardian(), async (db) => {
      const r = await db.query('SELECT id FROM message_request');
      return r.rows.length;
    });
    expect(requests).toBe(0);
  });

  it('a guardian cannot write a message record', async () => {
    const affected = await withTenant(guardian(), async (db) => {
      const r = await db.query(`UPDATE message_recipient SET status = 'sent'`);
      return r.rowCount;
    }).catch(() => 0);
    expect(affected).toBe(0);
  });
});
