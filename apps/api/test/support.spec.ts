/**
 * M9.8 — support tickets, the knowledge base and guided setup.
 *
 * The three things worth testing here are the three that are easy to get wrong
 * in ways nobody notices until a parent does:
 *
 *   A guardian must see their own tickets and nobody else's, and must never see
 *   an internal note on their own thread.
 *
 *   The first-response clock must stop on a reply the requester can READ, not on
 *   a note between staff.
 *
 *   Guided setup must reflect the database, so a step cannot read "done" while
 *   the thing it describes does not exist.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import {
  createTenant, destroyTenants, createUser, destroyUsers, grantRole, purgeTestData,
  createPersonRaw, createLearnerRaw, linkGuardianRaw,
  OWNER_URL, type TenantFixture, type UserFixture,
} from './fixtures.ts';
import { withTenant } from '../src/db/tenant.ts';
import { pool } from '../src/db/pool.ts';
import { authPool } from '../src/db/auth-pool.ts';
import { ticketService, SLA_HOURS, TRANSITIONS } from '../src/modules/support/ticket.service.ts';
import { kbService } from '../src/modules/support/kb.service.ts';
import {
  onboardingService, stepsAreInDependencyOrder,
} from '../src/modules/support/onboarding.service.ts';

const PASSWORD = 'correct-horse-battery';

let tenant: TenantFixture;
let other: TenantFixture;
let agent: UserFixture;
let guardian: UserFixture;
let guardianTwo: UserFixture;
let otherOwner: UserFixture;

let agentScope: { tenantId: string; actorId: string };
let guardianScope: { tenantId: string; actorId: string };
let guardianTwoScope: { tenantId: string; actorId: string };
let otherScope: { tenantId: string; actorId: string };
let guardianPersonId: string;

async function withOwnerDb<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: OWNER_URL });
  await client.connect();
  try { return await fn(client); } finally { await client.end(); }
}

/** Links a user account to a person, which is what makes them a principal. */
async function linkAccount(personId: string, userId: string): Promise<void> {
  await withOwnerDb((c) => c.query(
    'UPDATE person SET user_account_id = $2 WHERE id = $1', [personId, userId]));
}

beforeAll(async () => {
  await purgeTestData('%@sup-test.example');
  tenant = await createTenant('SUP');
  other = await createTenant('SUPX');

  agent = await createUser('agent@sup-test.example', PASSWORD);
  guardian = await createUser('parent@sup-test.example', PASSWORD);
  guardianTwo = await createUser('parent2@sup-test.example', PASSWORD);
  otherOwner = await createUser('other@sup-test.example', PASSWORD);

  await grantRole(tenant.orgId, agent.userId, 'SUPPORT_AGENT');
  await grantRole(other.orgId, otherOwner.userId, 'ORG_OWNER');

  // Guardians are principals via person.user_account_id, the same projection
  // every other guardian-scoped policy reads.
  const agentPerson = await createPersonRaw(tenant.orgId, 'Asha', { familyName: 'Agent' });
  await linkAccount(agentPerson, agent.userId);

  guardianPersonId = await createPersonRaw(tenant.orgId, 'Rekha', { familyName: 'Parent' });
  await linkAccount(guardianPersonId, guardian.userId);

  const guardianTwoPerson = await createPersonRaw(tenant.orgId, 'Vikram', { familyName: 'Parent' });
  await linkAccount(guardianTwoPerson, guardianTwo.userId);

  const learner = await createLearnerRaw(tenant.orgId, 'Riya', 'SUP-0001');
  await linkGuardianRaw(tenant.orgId, learner.studentId, guardianPersonId);

  agentScope = { tenantId: tenant.orgId, actorId: agent.userId };
  guardianScope = { tenantId: tenant.orgId, actorId: guardian.userId };
  guardianTwoScope = { tenantId: tenant.orgId, actorId: guardianTwo.userId };
  otherScope = { tenantId: other.orgId, actorId: otherOwner.userId };
});

afterAll(async () => {
  await destroyUsers([agent.userId, guardian.userId, guardianTwo.userId, otherOwner.userId]);
  await destroyTenants([tenant.orgId, other.orgId]);
  await pool.end();
  await authPool.end();
});

/* ========================================================================== */
/* Who can see a ticket                                                       */
/* ========================================================================== */

describe('ticket visibility', () => {
  it('shows a guardian their own ticket and not another parent\'s', async () => {
    const mine = await ticketService.raise(guardianScope, {
      subject: 'Fee receipt not received', body: 'I paid on the 3rd.',
      category: 'fees_and_payments',
    });
    await ticketService.raise(guardianTwoScope, {
      subject: 'App will not open', body: 'It closes on launch.',
      category: 'app_or_login',
    });

    const visible = await ticketService.list(guardianScope);
    expect(visible.map((t) => t.id)).toEqual([mine.id]);

    // And the other parent's ticket is not merely absent from the list — it is
    // unreadable by id, which is the thing a guessed URL would try.
    const theirs = (await ticketService.list(guardianTwoScope))[0]!;
    await expect(ticketService.get(guardianScope, theirs.id))
      .rejects.toMatchObject({ response: { error: { code: 'ticket_not_found' } } });
  });

  it('shows a support agent the whole queue', async () => {
    const all = await ticketService.list(agentScope);
    expect(all.length).toBeGreaterThanOrEqual(2);
  });

  it('shows one tenant nothing of another', async () => {
    expect(await ticketService.list(otherScope)).toHaveLength(0);
  });

  it('never shows an internal note to the requester', async () => {
    const ticket = await ticketService.raise(guardianScope, {
      subject: 'Bus route change', body: 'Has the stop moved?', category: 'other',
    });

    await ticketService.reply(agentScope, {
      ticketId: ticket.id, body: 'Parent has called twice this week.', internal: true,
    });
    await ticketService.reply(agentScope, {
      ticketId: ticket.id, body: 'The stop moved to the corner of MG Road.',
    });

    const asGuardian = await ticketService.thread(guardianScope, ticket.id);
    const bodies = asGuardian.filter((i) => i.kind === 'message').map((i) => i.body);
    expect(bodies).toContain('The stop moved to the corner of MG Road.');
    // The note is filtered by the POLICY, not by this query. A parent reading
    // "has called twice this week" cannot be unsent.
    expect(bodies).not.toContain('Parent has called twice this week.');

    const asAgent = await ticketService.thread(agentScope, ticket.id);
    expect(asAgent.filter((i) => i.kind === 'message').map((i) => i.body))
      .toContain('Parent has called twice this week.');
  });

  it('refuses a guardian who tries to write an internal note', async () => {
    const ticket = await ticketService.raise(guardianScope, {
      subject: 'Uniform sizes', body: 'Which size for class 4?', category: 'other',
    });
    await expect(ticketService.reply(guardianScope, {
      ticketId: ticket.id, body: 'sneaky', internal: true,
    })).rejects.toMatchObject({
      response: { error: { code: 'internal_note_requires_staff' } },
    });
  });
});

/* ========================================================================== */
/* The SLA clock                                                              */
/* ========================================================================== */

describe('the first-response clock', () => {
  it('stamps both deadlines from the priority at creation', async () => {
    const urgent = await ticketService.raise(guardianScope, {
      subject: 'Cannot pay online', body: 'The payment page errors.',
      category: 'fees_and_payments', priority: 'urgent',
    });
    const hours = (from: string, to: string) =>
      (Date.parse(to) - Date.parse(from)) / 3_600_000;

    // Literals, not SLA_HOURS. Asserting against the same constant the code
    // reads makes the test move whenever the promise does, so it can only ever
    // pass — which a mutation multiplying every window by ten proved by
    // sailing through it. These numbers are the commitment; changing them
    // should require changing this line and noticing.
    expect(hours(urgent.created_at, urgent.first_response_due_at)).toBeCloseTo(4, 1);
    expect(hours(urgent.created_at, urgent.resolution_due_at)).toBeCloseTo(24, 1);
    expect(SLA_HOURS.urgent).toEqual({ response: 4, resolution: 24 });
  });

  it('does not stop on an internal note', async () => {
    const ticket = await ticketService.raise(guardianScope, {
      subject: 'Report card missing', body: 'Term 1 is not showing.',
      category: 'results',
    });
    await ticketService.reply(agentScope, {
      ticketId: ticket.id, body: 'Checking with the class teacher.', internal: true,
    });

    // The clock is still running: nobody has answered the parent.
    const after = await ticketService.get(agentScope, ticket.id);
    expect(after.first_responded_at).toBeNull();
  });

  it('stops on the first reply the requester can read', async () => {
    const ticket = await ticketService.raise(guardianScope, {
      subject: 'Address change', body: 'We have moved.', category: 'data_correction',
    });
    await ticketService.reply(agentScope, {
      ticketId: ticket.id, body: 'Updated, thank you.',
    });

    const after = await ticketService.get(agentScope, ticket.id);
    expect(after.first_responded_at).not.toBeNull();
    expect(after.status).toBe('waiting_on_requester');
  });

  it('does not stop the clock on the requester\'s own follow-up', async () => {
    const ticket = await ticketService.raise(guardianScope, {
      subject: 'Still waiting', body: 'Any update?', category: 'other',
    });
    await ticketService.reply(guardianScope, { ticketId: ticket.id, body: 'Hello?' });

    const after = await ticketService.get(agentScope, ticket.id);
    expect(after.first_responded_at).toBeNull();
  });

  it('counts what is late', async () => {
    const ticket = await ticketService.raise(guardianScope, {
      subject: 'Overdue example', body: 'x', category: 'other',
    });
    await withOwnerDb((c) => c.query(
      `UPDATE support_ticket SET first_response_due_at = now() - interval '1 hour'
        WHERE id = $1`, [ticket.id]));

    const counts = await ticketService.breaches(agentScope);
    expect(counts.response_breached).toBeGreaterThanOrEqual(1);
    expect(counts.awaiting_first_response).toBeGreaterThanOrEqual(1);
  });
});

/* ========================================================================== */
/* Lifecycle                                                                  */
/* ========================================================================== */

describe('ticket lifecycle', () => {
  it('reopens when the requester replies to a resolved ticket', async () => {
    const ticket = await ticketService.raise(guardianScope, {
      subject: 'Late bus', body: 'It was 40 minutes late.', category: 'other',
    });
    await ticketService.reply(agentScope, { ticketId: ticket.id, body: 'Sorted.' });
    await ticketService.setStatus(agentScope, ticket.id, 'resolved');

    await ticketService.reply(guardianScope, {
      ticketId: ticket.id, body: 'It happened again this morning.',
    });

    const after = await ticketService.get(agentScope, ticket.id);
    // Not a new ticket. Splitting it would lose the history that makes the
    // second complaint make sense.
    expect(after.status).toBe('open');
    expect(after.resolved_at).toBeNull();
  });

  it('will not reopen a closed ticket', async () => {
    const ticket = await ticketService.raise(guardianScope, {
      subject: 'Closed example', body: 'x', category: 'other',
    });
    await ticketService.setStatus(agentScope, ticket.id, 'closed');

    expect(TRANSITIONS.closed).toEqual([]);
    await expect(ticketService.reply(guardianScope, {
      ticketId: ticket.id, body: 'one more thing',
    })).rejects.toMatchObject({ response: { error: { code: 'ticket_closed' } } });
    await expect(ticketService.setStatus(agentScope, ticket.id, 'open'))
      .rejects.toMatchObject({ response: { error: { code: 'illegal_ticket_transition' } } });
  });

  it('keeps the conversation append-only', async () => {
    const ticket = await ticketService.raise(guardianScope, {
      subject: 'Append example', body: 'original wording', category: 'other',
    });
    // A support thread is the record of what was promised. A system where the
    // last reply can be edited cannot settle an argument about what was said.
    await expect(withTenant(agentScope, (db) => db.query(
      `UPDATE ticket_message SET body = 'something else' WHERE ticket_id = $1`,
      [ticket.id]))).rejects.toThrow(/permission denied|append-only/);
    await expect(withOwnerDb((c) => c.query(
      `UPDATE ticket_message SET body = 'something else' WHERE ticket_id = $1`,
      [ticket.id]))).rejects.toThrow(/append-only/);
  });

  it('numbers tickets per tenant, so one school cannot count another\'s', async () => {
    const mine = await ticketService.raise(agentScope, {
      subject: 'Numbering A', body: 'x', category: 'other',
      raisedByPersonId: guardianPersonId,
    });
    const theirsOwner = await createPersonRaw(other.orgId, 'Other', { familyName: 'Owner' });
    await linkAccount(theirsOwner, otherOwner.userId);
    const theirs = await ticketService.raise(otherScope, {
      subject: 'Numbering B', body: 'x', category: 'other',
    });

    expect(mine.reference).toMatch(/^TKT-\d{4}-\d{5}$/);
    // The other tenant starts at 1 regardless of how many we have raised. A
    // global sequence would tell every school how busy every other one is.
    expect(theirs.reference).toMatch(/-00001$/);
  });
});

/* ========================================================================== */
/* Knowledge base                                                             */
/* ========================================================================== */

describe('the knowledge base', () => {
  it('hides a draft from parents and shows the published version', async () => {
    const slug = `paying-fees-${randomUUID().slice(0, 6)}`;
    const created = await kbService.create(agentScope, {
      slug, title: 'Paying fees online', body: 'FIRST DRAFT, not for parents',
      audience: 'guardians',
    });

    // Draft: staff only.
    expect((await kbService.search(guardianScope, 'Paying fees'))
      .map((a) => a.slug)).not.toContain(slug);
    expect((await kbService.search(agentScope, 'Paying fees'))
      .map((a) => a.slug)).toContain(slug);

    await kbService.revise(agentScope, created.id, {
      title: 'Paying fees online', body: 'Open the Fees tab and choose Pay now.',
    });
    await kbService.publish(agentScope, created.id, 2);

    // A third version is then drafted and NOT published. This is the case that
    // matters: with only a published latest version, serving "the newest" and
    // serving "the published one" are the same answer, and a test that stops
    // here cannot tell them apart.
    await kbService.revise(agentScope, created.id, {
      title: 'Paying fees online', body: 'HALF-WRITTEN, do not ship',
    });

    const asParent = await kbService.bySlug(guardianScope, slug);
    expect(asParent.version).toBe(2);
    expect(asParent.body).toContain('Fees tab');
    // The half-finished text somebody saved at 9pm stays invisible. For a
    // guardian this is belt AND braces: the policy already hides an unpublished
    // version, so even a query that asked for the newest one would get this.
    expect(asParent.body).not.toContain('HALF-WRITTEN');

    // Staff is where the SELECT itself has to be right, because staff can see
    // every version and RLS filters nothing. Reading the article still gives
    // the published text — an editor checking the help centre sees what a
    // parent sees, which is the only way to check it.
    const asStaff = await kbService.bySlug(agentScope, slug);
    expect(asStaff.version).toBe(2);
    expect(asStaff.body).not.toContain('HALF-WRITTEN');
  });

  it('never shows a staff-only article to a parent', async () => {
    const slug = `voiding-invoices-${randomUUID().slice(0, 6)}`;
    const created = await kbService.create(agentScope, {
      slug, title: 'Voiding an invoice', body: 'Only an accountant may do this.',
      audience: 'staff',
    });
    await kbService.publish(agentScope, created.id, 1);

    expect((await kbService.search(agentScope, 'Voiding')).map((a) => a.slug))
      .toContain(slug);
    // Published, and still invisible: audience is enforced in the policy, so no
    // phrasing of a search can surface it.
    expect((await kbService.search(guardianScope, 'Voiding')).map((a) => a.slug))
      .not.toContain(slug);
    await expect(kbService.bySlug(guardianScope, slug))
      .rejects.toMatchObject({ response: { error: { code: 'article_not_found' } } });
  });

  it('hides a staff article\'s very existence, not just its body', async () => {
    const slug = `staff-only-listing-${randomUUID().slice(0, 6)}`;
    const created = await kbService.create(agentScope, {
      slug, title: 'Handling a complaint about a teacher',
      body: 'Escalate to the head before replying.', audience: 'staff',
    });
    await kbService.publish(agentScope, created.id, 1);

    // Asserted against kb_article directly, not through a service call.
    //
    // Every service read joins kb_article_version, whose policy checks the
    // audience too — so the check on kb_article looked redundant and a mutation
    // removing it passed the whole suite. It is not redundant: a title is
    // itself informative, and the first endpoint that lists articles without
    // their bodies would leak "Handling a complaint about a teacher" to the
    // parent complaining. This test is what keeps that clause alive.
    const titles = await withTenant(guardianScope, async (db) => {
      const { rows } = await db.query<{ title: string }>(
        'SELECT title FROM kb_article');
      return rows.map((r) => r.title);
    });
    expect(titles).not.toContain('Handling a complaint about a teacher');

    const asStaff = await withTenant(agentScope, async (db) => {
      const { rows } = await db.query<{ title: string }>(
        'SELECT title FROM kb_article');
      return rows.map((r) => r.title);
    });
    expect(asStaff).toContain('Handling a complaint about a teacher');
  });

  it('will not let a parent write an article', async () => {
    await expect(kbService.create(guardianScope, {
      slug: `parent-written-${randomUUID().slice(0, 6)}`,
      title: 'Free fees for all', body: 'x',
    })).rejects.toThrow();
  });

  it('keeps old versions readable rather than overwriting them', async () => {
    const slug = `versions-${randomUUID().slice(0, 6)}`;
    const created = await kbService.create(agentScope, {
      slug, title: 'A', body: 'first text',
    });
    await kbService.revise(agentScope, created.id, { title: 'B', body: 'second text' });

    await expect(withOwnerDb((c) => c.query(
      `UPDATE kb_article_version SET body = 'rewritten' WHERE kb_article_id = $1`,
      [created.id]))).rejects.toThrow(/append-only/);
  });

  it('ranks a title match above a body match', async () => {
    const stamp = randomUUID().slice(0, 6);
    const bodyOnly = await kbService.create(agentScope, {
      slug: `body-${stamp}`, title: 'Something else entirely',
      body: `This mentions transport-${stamp} in passing.`,
    });
    const titled = await kbService.create(agentScope, {
      slug: `title-${stamp}`, title: `Transport-${stamp} routes`,
      body: 'Nothing relevant here.',
    });
    await kbService.publish(agentScope, bodyOnly.id, 1);
    await kbService.publish(agentScope, titled.id, 1);

    const hits = await kbService.search(agentScope, `transport-${stamp}`);
    // Somebody searching "fee receipt" wants the article called that, not the
    // twelve that mention it.
    expect(hits[0]!.slug).toBe(`title-${stamp}`);
  });
});

/* ========================================================================== */
/* Guided setup                                                               */
/* ========================================================================== */

describe('guided setup', () => {
  it('reports what actually exists, not what somebody ticked', async () => {
    const { steps } = await onboardingService.steps(agentScope);
    const byKey = new Map(steps.map((s) => [s.key, s]));

    // The fixtures made a campus and a learner and nothing else.
    expect(byKey.get('campus')!.done).toBe(true);
    expect(byKey.get('learners')!.done).toBe(true);
    expect(byKey.get('fees')!.done).toBe(false);
    expect(byKey.get('enrollment')!.done).toBe(false);
  });

  it('turns a step off again when the thing it describes goes away', async () => {
    const before = (await onboardingService.steps(agentScope)).steps
      .find((s) => s.key === 'learners')!;
    expect(before.done).toBe(true);

    await withOwnerDb((c) => c.query(
      `UPDATE student SET deleted_at = now() WHERE tenant_id = $1`, [tenant.orgId]));
    try {
      const after = (await onboardingService.steps(agentScope)).steps
        .find((s) => s.key === 'learners')!;
      // This is the whole argument for deriving rather than storing. A stored
      // tick would still read "done" here, and the page would be lying.
      expect(after.done).toBe(false);
    } finally {
      await withOwnerDb((c) => c.query(
        `UPDATE student SET deleted_at = NULL WHERE tenant_id = $1`, [tenant.orgId]));
    }
  });

  it('lists steps in dependency order, which is what makes "next" correct', async () => {
    const { steps } = await onboardingService.steps(agentScope);
    // nextStep returns the first undone step in list order, so the ordering is
    // the invariant — not a filter inside nextStep, which was dead code because
    // this property already held. Reorder the array and this fails.
    expect(stepsAreInDependencyOrder(steps)).toBe(true);

    for (const step of steps) {
      for (const need of step.needs) {
        expect(steps.findIndex((s) => s.key === need))
          .toBeLessThan(steps.findIndex((s) => s.key === step.key));
      }
    }
  });

  it('suggests a step the school can actually do next', async () => {
    const { steps } = await onboardingService.steps(agentScope);
    const byKey = new Map(steps.map((s) => [s.key, s]));
    const next = await onboardingService.nextStep(agentScope);

    expect(next).not.toBeNull();
    expect(next!.done).toBe(false);
    for (const need of next!.needs) {
      expect(byKey.get(need)!.done).toBe(true);
    }
  });

  it('does not call a school ready while it cannot bill or enrol', async () => {
    const state = await onboardingService.steps(agentScope);
    expect(state.ready).toBe(false);
    // And no rounded-up percentage: done is a count of steps that are actually
    // done, not a motivational number.
    expect(state.done).toBe(state.steps.filter((s) => s.done).length);
  });

  it('sees only its own tenant\'s progress', async () => {
    const mine = await onboardingService.steps(agentScope);
    const theirs = await onboardingService.steps(otherScope);
    expect(mine.steps.find((s) => s.key === 'learners')!.count).toBeGreaterThan(0);
    expect(theirs.steps.find((s) => s.key === 'learners')!.count).toBe(0);
  });
});
