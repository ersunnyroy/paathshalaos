/**
 * M43.1 — a person's own messages, and saying they have read one.
 *
 * Two questions, asked of every surface: can somebody see or mark a message
 * that is not theirs, and does marking one read change anything but the one
 * fact it is meant to record.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import {
  createTenant, destroyTenants, createUser, destroyUsers, grantRole, purgeTestData,
  createPersonRaw, createLearnerRaw, linkGuardianRaw, makeTeacher,
  OWNER_URL, type TenantFixture, type UserFixture,
} from './fixtures.ts';
import { inboxService } from '../src/modules/messaging/inbox.service.ts';
import { familyService } from '../src/modules/family/family.service.ts';
import { withTenant } from '../src/db/tenant.ts';
import { pool } from '../src/db/pool.ts';
import { authPool } from '../src/db/auth-pool.ts';

const PASSWORD = 'correct-horse-battery';

let tenant: TenantFixture;
let other: TenantFixture;
let mumUser: UserFixture, dadUser: UserFixture, teacherUser: UserFixture;
let strangerUser: UserFixture, elsewhereUser: UserFixture;
let mumPerson = '', dadPerson = '', teacherPerson = '', elsewherePerson = '';
let childPerson = '';

// Row ids by the body they carry, so a test can name a message in words.
const ids: Record<string, string> = {};

const mum = () => ({ tenantId: tenant.orgId, actorId: mumUser.userId });
const dad = () => ({ tenantId: tenant.orgId, actorId: dadUser.userId });
const teacher = () => ({ tenantId: tenant.orgId, actorId: teacherUser.userId });
const stranger = () => ({ tenantId: tenant.orgId, actorId: strangerUser.userId });
const elsewhere = () => ({ tenantId: other.orgId, actorId: elsewhereUser.userId });

async function asOwner<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: OWNER_URL });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

const rowOf = (body: string) => asOwner(async (c) => {
  const { rows } = await c.query<{
    status: string; read_at: Date | null; rendered_body: string;
  }>('SELECT status, read_at, rendered_body FROM message_recipient WHERE id = $1', [ids[body]]);
  return rows[0]!;
});

beforeAll(async () => {
  await purgeTestData('%@inbox-test.example');
  tenant = await createTenant('INB');
  other = await createTenant('INB2');

  mumUser = await createUser('mum@inbox-test.example', PASSWORD);
  dadUser = await createUser('dad@inbox-test.example', PASSWORD);
  teacherUser = await createUser('teacher@inbox-test.example', PASSWORD);
  strangerUser = await createUser('stranger@inbox-test.example', PASSWORD);
  elsewhereUser = await createUser('parent@inbox2-test.example', PASSWORD);

  await grantRole(tenant.orgId, mumUser.userId, 'GUARDIAN', 'self', tenant.campusId);
  await grantRole(tenant.orgId, dadUser.userId, 'GUARDIAN', 'self', tenant.campusId);
  await grantRole(tenant.orgId, teacherUser.userId, 'TEACHER', 'campus', tenant.campusId);
  // A role and no person row: an account somebody forgot to link.
  await grantRole(tenant.orgId, strangerUser.userId, 'GUARDIAN', 'self', tenant.campusId);
  await grantRole(other.orgId, elsewhereUser.userId, 'GUARDIAN', 'self', other.campusId);

  mumPerson = await createPersonRaw(tenant.orgId, 'Kavita', { userAccountId: mumUser.userId });
  dadPerson = await createPersonRaw(tenant.orgId, 'Rajesh', { userAccountId: dadUser.userId });
  teacherPerson = (await makeTeacher(tenant.orgId, tenant.campusId, teacherUser.userId)).personId;
  elsewherePerson = await createPersonRaw(other.orgId, 'Far', { userAccountId: elsewhereUser.userId });

  const child = await createLearnerRaw(tenant.orgId, 'Aarav', 'INB-0001');
  childPerson = child.personId;
  await linkGuardianRaw(tenant.orgId, child.studentId, mumPerson);

  await asOwner(async (c) => {
    const request = async (t: TenantFixture, key: string) => {
      const template = await c.query<{ id: string }>(
        `INSERT INTO message_template (tenant_id, code, name, purpose)
         VALUES ($1, $2, 'Notice', 'core_education_service') RETURNING id`,
        [t.orgId, key]);
      const req = await c.query<{ id: string }>(
        `INSERT INTO message_request (tenant_id, campus_id, message_template_id,
                                      purpose, source_type, idempotency_key, status)
         VALUES ($1, $2, $3, 'core_education_service', 'manual', $4, 'completed')
         RETURNING id`, [t.orgId, t.campusId, template.rows[0]!.id, key]);
      return req.rows[0]!.id;
    };
    // One request per row: (request, person, subject) is unique, and several of
    // these go to the same person.
    const add = async (
      t: TenantFixture, person: string, body: string, status: string,
      at: string, subject: string | null = null,
    ) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO message_recipient (tenant_id, message_request_id, person_id,
                                        subject_person_id, channel, rendered_body,
                                        status, suppression_reason, created_at)
         VALUES ($1, $2, $3, $4, 'in_app', $5, $6, $7, $8::timestamptz) RETURNING id`,
        [t.orgId, await request(t, `inbox-${body}`), person, subject, body, status,
         status === 'suppressed' ? 'consent_withdrawn' : null, at]);
      ids[body] = rows[0]!.id;
    };
    await add(tenant, mumPerson, 'oldest', 'sent', '2026-11-01T08:00:00Z');
    await add(tenant, mumPerson, 'about-aarav', 'delivered', '2026-11-02T08:00:00Z', childPerson);
    await add(tenant, mumPerson, 'whatsapp-read', 'read', '2026-11-03T08:00:00Z');
    await add(tenant, mumPerson, 'failed', 'failed', '2026-11-04T08:00:00Z');
    await add(tenant, mumPerson, 'suppressed', 'suppressed', '2026-11-05T08:00:00Z');
    await add(tenant, mumPerson, 'pending', 'pending', '2026-11-06T08:00:00Z');
    // Three in the same microsecond: what a send to a family writes.
    for (const b of ['tie-a', 'tie-b', 'tie-c']) {
      await add(tenant, dadPerson, b, 'sent', '2026-11-07T08:00:00.123456Z');
    }
    await add(tenant, dadPerson, 'dad-early', 'sent', '2026-11-01T08:00:00Z');
    await add(tenant, teacherPerson, 'staff-notice', 'sent', '2026-11-02T09:00:00Z');
    await add(other, elsewherePerson, 'other-school', 'sent', '2026-11-02T09:00:00Z');
  });
});

afterAll(async () => {
  await destroyUsers([mumUser.userId, dadUser.userId, teacherUser.userId,
    strangerUser.userId, elsewhereUser.userId]);
  await destroyTenants([tenant.orgId, other.orgId]);
  await Promise.all([pool.end(), authPool.end()]);
});

describe('what is in my inbox', () => {
  it('is what arrived, newest first, and nothing that did not', async () => {
    const mine = await inboxService.mine(mum(), { limit: 50 });
    // failed, suppressed and pending never reached her.
    expect(mine.map((m) => m.body)).toEqual(['whatsapp-read', 'about-aarav', 'oldest']);
  });

  it('says which child a message is about', async () => {
    const mine = await inboxService.mine(mum(), { limit: 50 });
    expect(mine.find((m) => m.body === 'about-aarav')!.about).toBe('Aarav');
    expect(mine.find((m) => m.body === 'oldest')!.about).toBeNull();
  });

  it('does not hand a teacher the whole school’s messages', async () => {
    // Staff can read every recipient row; only the service's own filter makes
    // this an inbox.
    const mine = await inboxService.mine(teacher(), { limit: 50 });
    expect(mine.map((m) => m.body)).toEqual(['staff-notice']);
    expect(await inboxService.unread(teacher())).toBe(1);
  });

  it('is empty for an account with no person here', async () => {
    expect(await inboxService.mine(stranger(), { limit: 50 })).toEqual([]);
    expect(await inboxService.unread(stranger())).toBe(0);
    expect(await inboxService.markRead(stranger(), null)).toBe(0);
  });

  it('keeps the other school’s messages in the other school', async () => {
    expect((await inboxService.mine(elsewhere(), { limit: 50 })).map((m) => m.body))
      .toEqual(['other-school']);
  });

  it('pages without repeating or dropping rows written in the same instant', async () => {
    const first = await inboxService.mine(dad(), { limit: 2 });
    expect(first).toHaveLength(2);
    const last = first[1]!;
    // The cursor carries microseconds; a millisecond cursor would sit before
    // all three ties and the next page would start with a row already shown.
    expect(last.sent_at).toBe('2026-11-07T08:00:00.123456Z');
    const second = await inboxService.mine(dad(),
      { limit: 2, before: { sentAt: last.sent_at, id: last.id } });
    const third = await inboxService.mine(dad(), { limit: 2,
      before: { sentAt: second[1]!.sent_at, id: second[1]!.id } });
    const seen = [...first, ...second, ...third].map((m) => m.body);
    expect(seen).toHaveLength(4);
    expect([...seen].sort()).toEqual(['dad-early', 'tie-a', 'tie-b', 'tie-c']);
    expect(seen[3]).toBe('dad-early');
    expect(third).toEqual([]);
  });

  it('the family list no longer drops a message once WhatsApp says it was read', async () => {
    expect((await familyService.messages(mum())).map((m) => m.body))
      .toContain('whatsapp-read');
  });
});

describe('saying I have read one', () => {
  it('counts what is unread among what arrived', async () => {
    expect(await inboxService.unread(mum())).toBe(3);
  });

  it('marks one, once, and leaves the delivery record alone', async () => {
    expect(await inboxService.markRead(mum(), ids['about-aarav']!)).toBe(1);
    const row = await rowOf('about-aarav');
    expect(row.read_at).not.toBeNull();
    // The provider said "delivered". A tap in the app does not get to say otherwise.
    expect(row.status).toBe('delivered');
    expect(await inboxService.unread(mum())).toBe(2);
    expect(await inboxService.markRead(mum(), ids['about-aarav']!)).toBe(0);
    const mine = await inboxService.mine(mum(), { limit: 50 });
    expect(mine.find((m) => m.body === 'about-aarav')!.read_at).not.toBeNull();
    expect(mine.find((m) => m.body === 'oldest')!.read_at).toBeNull();
  });

  it('will not mark somebody else’s, in this school or another', async () => {
    expect(await inboxService.markRead(mum(), ids['tie-a']!)).toBe(0);
    expect((await rowOf('tie-a')).read_at).toBeNull();
    expect(await inboxService.markRead(mum(), ids['other-school']!)).toBe(0);
    expect((await rowOf('other-school')).read_at).toBeNull();
    // Staff see every row. They still cannot read a parent's message for them.
    expect(await inboxService.markRead(teacher(), ids['oldest']!)).toBe(0);
    expect((await rowOf('oldest')).read_at).toBeNull();
  });

  it('will not mark a message that never reached me', async () => {
    for (const body of ['failed', 'suppressed', 'pending']) {
      expect(await inboxService.markRead(mum(), ids[body]!)).toBe(0);
      expect((await rowOf(body)).read_at).toBeNull();
    }
  });

  it('marks all of mine and nobody else’s', async () => {
    expect(await inboxService.markRead(mum(), null)).toBe(2);
    expect(await inboxService.unread(mum())).toBe(0);
    expect(await inboxService.unread(dad())).toBe(4);
    expect(await inboxService.unread(teacher())).toBe(1);
    expect(await inboxService.unread(elsewhere())).toBe(1);
    for (const body of ['failed', 'suppressed', 'pending']) {
      expect((await rowOf(body)).read_at).toBeNull();
    }
  });
});

describe('the function is the only door', () => {
  it('a guardian cannot rewrite a message sent to them', async () => {
    // The reason this is a function and not an own-row UPDATE policy.
    const changed = await withTenant(dad(), async (db) => {
      const res = await db.query(
        `UPDATE message_recipient SET rendered_body = 'no fees due' WHERE id = $1`,
        [ids['tie-a']]);
      return res.rowCount;
    });
    expect(changed).toBe(0);
    expect((await rowOf('tie-a')).rendered_body).toBe('tie-a');
  });

  it('a guardian cannot set read_at directly either', async () => {
    const changed = await withTenant(dad(), async (db) => {
      const res = await db.query(
        'UPDATE message_recipient SET read_at = now() WHERE id = $1', [ids['tie-b']]);
      return res.rowCount;
    });
    expect(changed).toBe(0);
    expect((await rowOf('tie-b')).read_at).toBeNull();
  });

  it('is not executable by the platform role', async () => {
    const { rows } = await asOwner((c) => c.query<{ ok: boolean }>(
      `SELECT has_function_privilege('paathshala_platform',
                'mark_my_messages_read(uuid)', 'EXECUTE') AS ok`));
    expect(rows[0]!.ok).toBe(false);
  });
});
