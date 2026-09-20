/**
 * M29.1 — the language chain.
 *
 * `organization.locale` was added in migration 0002 and, until this milestone,
 * was read by nothing. Every locale decision in the product resolved to a
 * hard-coded `'en-IN'`, which had a consequence nobody had written down: a
 * school that does not operate in English could not send messages at all. Its
 * templates were approved in its own language, the dispatcher looked for
 * English ones, found none, and wrote `no_approved_template` against every
 * parent — a total failure that reports itself as a per-recipient suppression.
 *
 * So the load-bearing test here is `a Hindi-medium school reaches its parents`.
 * Everything else is the boundary work around it.
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
  chain, normalise, isTeachingLocale, endonymOf, DEFAULT_LOCALE, TEACHING_LOCALES,
} from '../src/modules/i18n/locales.ts';
import { localeService } from '../src/modules/i18n/locale.service.ts';
import { templateService } from '../src/modules/messaging/template.service.ts';
import { dispatchService, type SendProvider } from '../src/modules/messaging/dispatch.service.ts';
import { withTenant } from '../src/db/tenant.ts';
import { pool } from '../src/db/pool.ts';
import { authPool } from '../src/db/auth-pool.ts';

const PASSWORD = 'correct-horse-battery';

let tenant: TenantFixture;
let admin: UserFixture;
let guardianUser: UserFixture;
let guardianPersonId: string;
let learnerPersonId: string;
let noticeId: string;
let templateId: string;

async function asOwner<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: OWNER_URL });
  await client.connect();
  try { return await fn(client); } finally { await client.end(); }
}

const admin_ = () => ({ tenantId: tenant.orgId, actorId: admin.userId });

/** A provider that records the body it was handed, so the language is visible. */
function recordingProvider(): SendProvider & { sent: Array<{ channel: string; body: string }> } {
  const sent: Array<{ channel: string; body: string }> = [];
  return {
    name: 'test-provider',
    sent,
    async send(input) {
      sent.push({ channel: input.channel, body: input.body });
      return { providerMessageId: `pm_${randomUUID()}` };
    },
  };
}

async function setPreference(personId: string, purpose: string, locale: string | null) {
  await asOwner((c) => c.query(
    `INSERT INTO communication_preference (tenant_id, person_id, purpose, locale)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (tenant_id, person_id, purpose)
       DO UPDATE SET locale = EXCLUDED.locale, updated_at = now()`,
    [tenant.orgId, personId, purpose, locale],
  ));
}

async function clearPreferences() {
  await asOwner((c) => c.query(
    `DELETE FROM communication_preference WHERE tenant_id = $1`, [tenant.orgId]));
}

/** Sends one absence message and returns what the provider saw. */
async function sendAbsence(): Promise<{
  body: string | undefined; recipientLocale: string | null; reason: string | undefined;
}> {
  const provider = recordingProvider();
  const queued = await dispatchService.queue(admin_(), {
    templateCode: 'attendance.absent',
    idempotencyKey: `i18n-${randomUUID()}`,
    sourceType: 'test',
  });
  const { outcomes } = await dispatchService.dispatch(admin_(), {
    requestId: queued.requestId,
    provider,
    audience: [{
      personId: guardianPersonId,
      subjectPersonId: learnerPersonId,
      variables: { learner_name: 'Aarav', date: '2026-09-18' },
    }],
  });
  const recipientLocale = await asOwner(async (c) => {
    const { rows } = await c.query<{ locale: string | null }>(
      `SELECT locale FROM message_recipient WHERE message_request_id = $1`, [queued.requestId]);
    return rows[0]?.locale ?? null;
  });
  return {
    body: provider.sent[0]?.body,
    recipientLocale,
    reason: outcomes[0]?.reason,
  };
}

beforeAll(async () => {
  await purgeTestData('%@i18n-test.example');
  tenant = await createTenant('I18N');

  // The whole point: a school that does not operate in English.
  await asOwner((c) => c.query(
    `UPDATE organization SET locale = 'hi-IN' WHERE id = $1`, [tenant.orgId]));

  admin = await createUser('admin@i18n-test.example', PASSWORD);
  guardianUser = await createUser('parent@i18n-test.example', PASSWORD);
  await grantRole(tenant.orgId, admin.userId, 'ORG_OWNER', 'organization', null);
  await grantRole(tenant.orgId, guardianUser.userId, 'GUARDIAN', 'self', tenant.campusId);

  guardianPersonId = await createPersonRaw(tenant.orgId, 'Sunita', {
    userAccountId: guardianUser.userId, familyName: 'Verma',
  });
  await asOwner((c) => c.query(
    `INSERT INTO contact_method (tenant_id, person_id, kind, value, is_primary, opt_in_state)
     VALUES ($1, $2, 'phone', '+919876511111', true, 'opted_in')`,
    [tenant.orgId, guardianPersonId],
  ));

  const learner = await createLearnerRaw(tenant.orgId, 'Aarav', 'I18N-1');
  learnerPersonId = learner.personId;
  await linkGuardianRaw(tenant.orgId, learner.studentId, guardianPersonId, { isPrimary: true });

  noticeId = await publishNotice(`i18n-notice-${randomUUID().slice(0, 8)}`);
  await asOwner((c) => c.query(
    `INSERT INTO consent_record
       (tenant_id, person_id, given_by_person_id, purpose, basis, notice_version_id, channel)
     VALUES ($1, $2, $3, 'attendance_notifications', 'consent', $4, 'app')`,
    [tenant.orgId, learnerPersonId, guardianPersonId, noticeId],
  ));

  const template = await templateService.create(admin_(), {
    code: 'attendance.absent', name: 'Absence notice',
    purpose: 'attendance_notifications',
  });
  templateId = template.id;
});

afterAll(async () => {
  await destroyUsers([admin.userId, guardianUser.userId]);
  await destroyTenants([tenant.orgId]);
  await Promise.all([pool.end(), authPool.end()]);
});

describe('the chain, as a function', () => {
  it('is ordered, deduplicated, and always ends in the default', () => {
    expect(chain('hi-IN', 'en-IN')).toEqual(['hi-IN', 'en-IN']);
    expect(chain('hi-IN')).toEqual(['hi-IN', DEFAULT_LOCALE]);
    expect(chain('hi-IN', 'hi-IN', null, undefined)).toEqual(['hi-IN', DEFAULT_LOCALE]);
    // The default is appended, not promoted: a person who asked for Hindi does
    // not get English first because English is the fallback.
    expect(chain('ta-IN', 'hi-IN')[0]).toBe('ta-IN');
  });

  it('never comes back empty', () => {
    // `locale = ANY('{}')` matches nothing, so an empty chain would stop a
    // school's messages entirely — the exact failure this module exists to end.
    expect(chain()).toEqual([DEFAULT_LOCALE]);
    expect(chain(null, undefined, '', '   ')).toEqual([DEFAULT_LOCALE]);
    expect(chain('!!not a locale!!')).toEqual([DEFAULT_LOCALE]);
  });

  it('keeps a well-formed tag it has never heard of', () => {
    // Bhojpuri is not in the Eighth Schedule. A school that registered its
    // templates under it must still reach its parents; silently dropping the
    // tag would route them to English past templates that exist.
    expect(isTeachingLocale('bho-IN')).toBe(false);
    expect(chain('bho-IN')).toEqual(['bho-IN', DEFAULT_LOCALE]);
  });

  it('canonicalises case, separator, and a bare language', () => {
    expect(normalise('hi_in')).toBe('hi-IN');
    expect(normalise('HI-in')).toBe('hi-IN');
    // Every locale column in this database was populated with a region, so a
    // bare `hi` would match no row anywhere.
    expect(normalise('hi')).toBe('hi-IN');
    expect(normalise('  ta  ')).toBe('ta-IN');
    expect(normalise('english')).toBeUndefined();
    expect(normalise(42 as unknown as string)).toBeUndefined();
  });

  it('prints a language in its own script where the spelling is known', () => {
    expect(endonymOf('hi-IN')).toBe('हिन्दी');
    expect(endonymOf('ta-IN')).toBe('தமிழ்');
    // Where it is not, the English name rather than an invented spelling.
    expect(endonymOf('sat-IN')).toBe('Santali');
    expect(endonymOf('bho-IN')).toBe('bho-IN');
  });

  it('offers English and the twenty-two Eighth Schedule languages', () => {
    expect(TEACHING_LOCALES).toHaveLength(23);
    expect(TEACHING_LOCALES.map((l) => l.tag)).toContain('en-IN');
    expect(new Set(TEACHING_LOCALES.map((l) => l.tag)).size).toBe(23);
    // Every tag in the picker survives its own normaliser. A list entry the
    // chain would discard is an option that silently does nothing.
    for (const l of TEACHING_LOCALES) expect(normalise(l.tag)).toBe(l.tag);
  });
});

describe('the chain, against the database', () => {
  it('reads the school it is asked about, not a default', async () => {
    const locale = await withTenant(admin_(), (db) => localeService.forOrganization(db));
    expect(locale).toBe('hi-IN');
  });

  it('falls to the school when a person has said nothing', async () => {
    await clearPreferences();
    const resolved = await withTenant(admin_(), (db) =>
      localeService.chainFor(db, guardianPersonId, 'attendance_notifications'));
    expect(resolved).toEqual(['hi-IN', 'en-IN']);
  });

  it("a person's own preference outranks the school", async () => {
    await clearPreferences();
    await setPreference(guardianPersonId, 'attendance_notifications', 'ta-IN');
    const resolved = await withTenant(admin_(), (db) =>
      localeService.chainFor(db, guardianPersonId, 'attendance_notifications'));
    expect(resolved).toEqual(['ta-IN', 'hi-IN', 'en-IN']);
  });

  it('honours a locale they set against a different purpose', async () => {
    // A language belongs to the reader, not to the subject. The schema keys the
    // preference per purpose, which is a shape this has to live with: a parent
    // who chose Bengali for fee reminders reads Bengali about attendance too.
    await clearPreferences();
    await setPreference(guardianPersonId, 'fee_notifications', 'bn-IN');
    const resolved = await withTenant(admin_(), (db) =>
      localeService.chainFor(db, guardianPersonId, 'attendance_notifications'));
    expect(resolved).toEqual(['bn-IN', 'hi-IN', 'en-IN']);
  });

  it('keeps every language they have stated, the sent purpose first', async () => {
    // Not just the best match: somebody who chose Tamil for attendance and
    // Bengali for fees has told us twice which languages they read. Falling
    // from a missing Tamil template to the school's Hindi, past their own
    // Bengali, would prefer an assumption to a statement.
    await clearPreferences();
    await setPreference(guardianPersonId, 'fee_notifications', 'bn-IN');
    await setPreference(guardianPersonId, 'attendance_notifications', 'ta-IN');
    const resolved = await withTenant(admin_(), (db) =>
      localeService.chainFor(db, guardianPersonId, 'attendance_notifications'));
    expect(resolved[0]).toBe('ta-IN');
    expect(resolved).toEqual(['ta-IN', 'bn-IN', 'hi-IN', 'en-IN']);
  });

  it('puts the most recently stated language first among the rest', async () => {
    // Found by a surviving mutation: dropping `updated_at DESC` from the
    // ordering broke nothing, because no test had ever set two locales under
    // purposes other than the one being sent. Recency is the signal that
    // matters — a parent who switched to Tamil last week reads Tamil, and
    // alphabetical order by purpose is an arbitrary answer dressed as one.
    await clearPreferences();
    await setPreference(guardianPersonId, 'fee_notifications', 'bn-IN');
    await setPreference(guardianPersonId, 'marketing', 'ta-IN');
    await asOwner((c) => c.query(
      `UPDATE communication_preference SET updated_at = now() - interval '30 days'
        WHERE tenant_id = $1 AND purpose = 'fee_notifications'`, [tenant.orgId]));
    const resolved = await withTenant(admin_(), (db) =>
      localeService.chainFor(db, guardianPersonId, 'attendance_notifications'));
    // `fee_notifications` sorts before `marketing`; recency says otherwise.
    expect(resolved).toEqual(['ta-IN', 'bn-IN', 'hi-IN', 'en-IN']);
  });
});

describe('a Hindi-medium school reaches its parents', () => {
  it('adds a template version in the school language when none is named', async () => {
    // The registrar types Hindi into the box and names no locale. Before M29.1
    // the row was labelled `en-IN` and was then unreachable to every Hindi
    // reader, because the lookup matches the label and not the letters.
    const version = await templateService.addVersion(admin_(), {
      templateId, channel: 'sms',
      body: '{{learner_name}} आज अनुपस्थित था ({{date}})।',
      dltEntityId: '1101', dltTemplateId: '1107', senderHeader: 'SCHOOL',
    });
    expect(version.locale).toBe('hi-IN');
    await templateService.approve(admin_(), version.id);
  });

  it('sends in Hindi to a parent who has stated no preference', async () => {
    await clearPreferences();
    const { body, recipientLocale, reason } = await sendAbsence();
    // The old code suppressed this recipient outright.
    expect(reason).not.toBe('no_approved_template');
    expect(body).toMatch(/अनुपस्थित/);
    expect(recipientLocale).toBe('hi-IN');
  });

  it('sends in Hindi even to a parent who asked for a language nobody wrote', async () => {
    // Odia requested, no Odia template approved. The school's Hindi is a far
    // better answer than English, and is what the chain's middle link buys.
    await clearPreferences();
    await setPreference(guardianPersonId, 'attendance_notifications', 'or-IN');
    const { body, recipientLocale } = await sendAbsence();
    expect(body).toMatch(/अनुपस्थित/);
    // The record says what was actually sent, not what was asked for: a row
    // claiming Odia cannot answer "what did we say to them".
    expect(recipientLocale).toBe('hi-IN');
  });

  it('sends the parent their own language once it exists', async () => {
    const tamil = await templateService.addVersion(admin_(), {
      templateId, channel: 'sms', locale: 'ta-IN',
      body: '{{learner_name}} இன்று வரவில்லை ({{date}}).',
      dltEntityId: '1101', dltTemplateId: '1108', senderHeader: 'SCHOOL',
    });
    await templateService.approve(admin_(), tamil.id);

    await clearPreferences();
    await setPreference(guardianPersonId, 'attendance_notifications', 'ta-IN');
    const { body, recipientLocale } = await sendAbsence();
    expect(body).toMatch(/வரவில்லை/);
    expect(recipientLocale).toBe('ta-IN');
  });

  it('picks by the caller\'s order, not by what was approved most recently', async () => {
    // Both Hindi and Tamil are approved by now. Order decides, and the chain's
    // order is the caller's — which is what makes the middle link work at all.
    const hindiFirst = await withTenant(admin_(), (db) =>
      templateService.approvedVersion(db, templateId, 'sms', ['hi-IN', 'ta-IN', 'en-IN']));
    expect(hindiFirst?.locale).toBe('hi-IN');
    const tamilFirst = await withTenant(admin_(), (db) =>
      templateService.approvedVersion(db, templateId, 'sms', ['ta-IN', 'hi-IN', 'en-IN']));
    expect(tamilFirst?.locale).toBe('ta-IN');
  });

  it('an empty chain still finds the default rather than nothing', async () => {
    // A caller cannot reach this through `chain()`, which never returns empty.
    // The floor exists because `locale = ANY('{}')` matches no row, and a send
    // that silently matches nothing is the failure mode M29.1 removed.
    const english = await templateService.addVersion(admin_(), {
      templateId, channel: 'email', locale: 'en-IN',
      body: '{{learner_name}} was absent on {{date}}.',
    });
    await templateService.approve(admin_(), english.id);
    const found = await withTenant(admin_(), (db) =>
      templateService.approvedVersion(db, templateId, 'email', []));
    expect(found?.locale).toBe('en-IN');
  });
});
