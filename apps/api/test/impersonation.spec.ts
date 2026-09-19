/**
 * AC-12 — sensitive support access is time-limited and audited.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import {
  createTenant, destroyTenants, createUser, destroyUsers, OWNER_URL,
  type TenantFixture, type UserFixture,
  purgeTestData,
} from './fixtures.ts';
import { impersonationService } from '../src/modules/platform/impersonation.service.ts';
import { withTenant } from '../src/db/tenant.ts';
import { authPool } from '../src/db/auth-pool.ts';
import { pool } from '../src/db/pool.ts';

let tenant: TenantFixture;
let agent: UserFixture;
let approver: UserFixture;
let owner: UserFixture;

const REASON = 'Investigating ticket SUP-4417: fee receipt not generated after payment.';

beforeAll(async () => {
  await purgeTestData('%@imp-test.example');
  tenant = await createTenant('IMP');
  agent = await createUser('agent@imp-test.example', 'correct-horse-battery');
  approver = await createUser('approver@imp-test.example', 'correct-horse-battery');
  owner = await createUser('owner@imp-test.example', 'correct-horse-battery');
});

afterAll(async () => {
  const client = new pg.Client({ connectionString: OWNER_URL });
  await client.connect();
  await client.query('DELETE FROM impersonation_session WHERE tenant_id = $1', [tenant.orgId]);
  await client.end();
  await destroyUsers([agent.userId, approver.userId, owner.userId]);
  await destroyTenants([tenant.orgId]);
  await Promise.all([authPool.end(), pool.end()]);
});

const agentScope = () => ({ tenantId: tenant.orgId, actorId: agent.userId });

describe('requesting access', () => {
  it('requires a specific reason', async () => {
    await expect(
      impersonationService.request(agentScope(), { reason: 'debug', ticketRef: 'SUP-1' }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('starts in requested state, read-only, with no window open', async () => {
    const s = await impersonationService.request(agentScope(), {
      reason: REASON, ticketRef: 'SUP-4417',
    });
    expect(s.status).toBe('requested');
    expect(s.write_enabled).toBe(false);
    expect(s.started_at).toBeNull();
    expect(s.expires_at).toBeNull();
  });

  it('grants nothing until approved', async () => {
    const s = await impersonationService.request(agentScope(), {
      reason: REASON, ticketRef: 'SUP-4418',
    });
    await expect(impersonationService.assertActive(s.id, tenant.orgId)).rejects.toMatchObject({
      status: 403,
    });
  });
});

describe('two-person approval', () => {
  it('a second platform user can approve', async () => {
    const s = await impersonationService.request(agentScope(), {
      reason: REASON, ticketRef: 'SUP-4419',
    });
    const approved = await impersonationService.approve(agentScope(), s.id, approver.userId);
    expect(approved.status).toBe('active');
    expect(approved.started_at).not.toBeNull();
    await expect(impersonationService.assertActive(s.id, tenant.orgId)).resolves.toBeTruthy();
  });

  it('the requester cannot approve their own request', async () => {
    const s = await impersonationService.request(agentScope(), {
      reason: REASON, ticketRef: 'SUP-4420',
    });
    // Enforced by a CHECK constraint, so a future code path that forgets the
    // check still cannot self-approve.
    await expect(
      impersonationService.approve(agentScope(), s.id, agent.userId),
    ).rejects.toThrow(/impersonation_needs_a_second_person|violates check constraint/i);
  });

  it('cannot become active without an approver, even by direct SQL', async () => {
    const client = new pg.Client({ connectionString: OWNER_URL });
    await client.connect();
    try {
      await expect(
        client.query(
          `INSERT INTO impersonation_session
             (tenant_id, actor_user_id, reason, ticket_ref, status, started_at, expires_at)
           VALUES ($1, $2, $3, 'SUP-X', 'active', now(), now() + interval '30 minutes')`,
          [tenant.orgId, agent.userId, REASON],
        ),
      ).rejects.toThrow(/without an approver/i);
    } finally {
      await client.end();
    }
  });
});

describe('the window is bounded', () => {
  it('caps the window at 60 minutes even when a longer one is asked for', async () => {
    const s = await impersonationService.request(agentScope(), {
      reason: REASON, ticketRef: 'SUP-4421',
    });
    const approved = await impersonationService.approve(agentScope(), s.id, approver.userId, 600);

    const minutes = (approved.expires_at!.getTime() - approved.started_at!.getTime()) / 60000;
    expect(minutes).toBeLessThanOrEqual(60);
  });

  it('the database refuses a window longer than 60 minutes', async () => {
    const client = new pg.Client({ connectionString: OWNER_URL });
    await client.connect();
    try {
      await expect(
        client.query(
          `INSERT INTO impersonation_session
             (tenant_id, actor_user_id, approved_by, approved_at, reason, ticket_ref,
              status, started_at, expires_at)
           VALUES ($1, $2, $3, now(), $4, 'SUP-Y', 'active', now(), now() + interval '8 hours')`,
          [tenant.orgId, agent.userId, approver.userId, REASON],
        ),
      ).rejects.toThrow(/may not exceed 60 minutes/i);
    } finally {
      await client.end();
    }
  });

  it('an expired window stops working without any job having run', async () => {
    const s = await impersonationService.request(agentScope(), {
      reason: REASON, ticketRef: 'SUP-4422',
    });
    await impersonationService.approve(agentScope(), s.id, approver.userId);

    // Move the window into the past. Nothing sweeps it; assertActive evaluates
    // expiry on every request, so it closes exactly on the clock.
    const client = new pg.Client({ connectionString: OWNER_URL });
    await client.connect();
    await client.query(
      `UPDATE impersonation_session
          SET started_at = now() - interval '90 minutes', expires_at = now() - interval '30 minutes'
        WHERE id = $1`,
      [s.id],
    );
    await client.end();

    const err = await impersonationService.assertActive(s.id, tenant.orgId).catch((e) => e);
    expect(err.getResponse().error.code).toBe('impersonation_expired');
  });
});

describe('the institute owner stays in control', () => {
  it('sees the session while it is happening', async () => {
    const s = await impersonationService.request(agentScope(), {
      reason: REASON, ticketRef: 'SUP-4423',
    });
    await impersonationService.approve(agentScope(), s.id, approver.userId);

    const visible = await impersonationService.listForTenant({
      tenantId: tenant.orgId, actorId: owner.userId,
    });
    expect(visible.some((x) => x.id === s.id && x.status === 'active')).toBe(true);
  });

  it('can revoke it, effective on the next request', async () => {
    const s = await impersonationService.request(agentScope(), {
      reason: REASON, ticketRef: 'SUP-4424',
    });
    await impersonationService.approve(agentScope(), s.id, approver.userId);
    await expect(impersonationService.assertActive(s.id, tenant.orgId)).resolves.toBeTruthy();

    await impersonationService.revoke(
      { tenantId: tenant.orgId, actorId: owner.userId }, s.id, owner.userId, 'Not authorised by us.',
    );

    const err = await impersonationService.assertActive(s.id, tenant.orgId).catch((e) => e);
    expect(err.getResponse().error.code).toBe('impersonation_not_active');
  });
});

describe('auditing', () => {
  it('records the request, the approval and both identities', async () => {
    const s = await impersonationService.request(agentScope(), {
      reason: REASON, ticketRef: 'SUP-4425',
    });
    await impersonationService.approve(agentScope(), s.id, approver.userId);

    const rows = await withTenant({ tenantId: tenant.orgId }, async (db) => {
      const r = await db.query<{
        action: string; actor_user_id: string; on_behalf_of_user_id: string | null; reason: string | null;
      }>(
        `SELECT action, actor_user_id, on_behalf_of_user_id, reason
           FROM audit_log WHERE impersonation_id = $1 OR resource_id = $1
          ORDER BY occurred_at`,
        [s.id],
      );
      return r.rows;
    });

    const started = rows.find((r) => r.action === 'impersonation.started');
    expect(rows.some((r) => r.action === 'impersonation.requested')).toBe(true);
    expect(started).toBeTruthy();
    // Both identities, always. Neither replaces the other.
    expect(started!.actor_user_id).toBe(approver.userId);
    expect(started!.on_behalf_of_user_id).toBe(agent.userId);
    expect(started!.reason).toBeTruthy();
  });

  it('an impersonation session from one tenant cannot be replayed against another', async () => {
    const otherTenant = await createTenant('IMP-OTHER');
    try {
      const s = await impersonationService.request(agentScope(), {
        reason: REASON, ticketRef: 'SUP-4426',
      });
      await impersonationService.approve(agentScope(), s.id, approver.userId);

      // Valid session, wrong tenant. RLS makes the row invisible, so the guard
      // refuses rather than honouring a cross-tenant support token.
      await expect(
        impersonationService.assertActive(s.id, otherTenant.orgId),
      ).rejects.toMatchObject({ status: 403 });
    } finally {
      await destroyTenants([otherTenant.orgId]);
    }
  });
});
