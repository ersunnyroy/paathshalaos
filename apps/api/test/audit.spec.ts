/**
 * M2.5 — the audit log is append-only, tenant-isolated, records reads as well as
 * writes, and is tamper-evident.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { createTenant, destroyTenants, OWNER_URL, type TenantFixture } from './fixtures.ts';
import { auditService } from '../src/modules/audit/audit.service.ts';
import { withTenant } from '../src/db/tenant.ts';
import { authPool } from '../src/db/auth-pool.ts';
import { pool } from '../src/db/pool.ts';

let tenantA: TenantFixture;
let tenantB: TenantFixture;

beforeAll(async () => {
  tenantA = await createTenant('AUD-A');
  tenantB = await createTenant('AUD-B');
});

afterAll(async () => {
  const client = new pg.Client({ connectionString: OWNER_URL });
  await client.connect();
  await client.query('DELETE FROM audit_checkpoint WHERE tenant_id = ANY($1)', [
    [tenantA.orgId, tenantB.orgId],
  ]);
  await client.end();
  await destroyTenants([tenantA.orgId, tenantB.orgId]);
  await Promise.all([authPool.end(), pool.end()]);
});

describe('writing', () => {
  it('records an entry with the actor, resource and classification', async () => {
    await auditService.record({
      tenantId: tenantA.orgId,
      actorUserId: null as unknown as undefined,
      action: 'campus.read',
      resourceType: 'campus',
      resourceId: tenantA.campusId,
      classification: 'SENSITIVE',
    });

    const rows = await withTenant({ tenantId: tenantA.orgId }, async (db) => {
      const r = await db.query<{ action: string; classification: string }>(
        `SELECT action, classification FROM audit_log WHERE action = 'campus.read'`,
      );
      return r.rows;
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.classification).toBe('SENSITIVE');
  });

  it('records sensitive READS, not only writes', async () => {
    await auditService.recordRead({
      tenantId: tenantA.orgId,
      action: 'student.medical_note.read',
      resourceType: 'student',
      resourceId: tenantA.unitId,
    });

    const rows = await withTenant({ tenantId: tenantA.orgId }, async (db) => {
      const r = await db.query<{ classification: string }>(
        `SELECT classification FROM audit_log WHERE action = 'student.medical_note.read'`,
      );
      return r.rows;
    });
    // This is the control that answers "what did they see" after an incident.
    expect(rows[0]?.classification).toBe('SENSITIVE');
  });

  it('refuses an action that requires a reason when none is given', async () => {
    await expect(
      auditService.record({
        tenantId: tenantA.orgId, action: 'export.bulk', resourceType: 'student',
      }),
    ).rejects.toThrow(/requires a reason/);
  });
});

describe('append-only', () => {
  it('rejects UPDATE from the application role', async () => {
    await expect(
      withTenant({ tenantId: tenantA.orgId }, (db) =>
        db.query(`UPDATE audit_log SET action = 'tampered' WHERE tenant_id = $1`, [tenantA.orgId]),
      ),
    ).rejects.toThrow(/permission denied|append-only/i);
  });

  it('rejects DELETE from the application role', async () => {
    await expect(
      withTenant({ tenantId: tenantA.orgId }, (db) =>
        db.query('DELETE FROM audit_log WHERE tenant_id = $1', [tenantA.orgId]),
      ),
    ).rejects.toThrow(/permission denied|append-only/i);
  });

  it('rejects UPDATE and DELETE even from the table owner', async () => {
    // Defence in depth: the revokes stop the app roles, the trigger stops
    // everything that inherits ownership.
    const client = new pg.Client({ connectionString: OWNER_URL });
    await client.connect();
    try {
      await expect(client.query(`UPDATE audit_log SET action = 'x'`)).rejects.toThrow(/append-only/i);
      await expect(client.query('DELETE FROM audit_log')).rejects.toThrow(/append-only/i);
    } finally {
      await client.end();
    }
  });
});

describe('tenant isolation', () => {
  it('one tenant cannot read another audit trail', async () => {
    await auditService.record({
      tenantId: tenantB.orgId, action: 'secret.b', resourceType: 'campus',
    });

    const seen = await withTenant({ tenantId: tenantA.orgId }, async (db) => {
      const r = await db.query(`SELECT action FROM audit_log WHERE action = 'secret.b'`);
      return r.rows.length;
    });
    expect(seen).toBe(0);
  });

  it('cannot be read directly from a partition, bypassing the parent policy', async () => {
    // Regression test for a real leak: RLS on a partitioned parent is not
    // applied when a query names a partition directly, and migration 0007 had
    // granted SELECT on the partitions.
    const part = `audit_log_${new Date().toISOString().slice(0, 7).replace('-', '_')}`;
    await expect(
      withTenant({ tenantId: tenantA.orgId }, (db) => db.query(`SELECT action FROM ${part}`)),
    ).rejects.toThrow(/permission denied/i);
  });

  it('the auth role can append but cannot read a tenant trail back', async () => {
    await expect(authPool.query('SELECT action FROM audit_log LIMIT 1')).rejects.toThrow(
      /permission denied|policy/i,
    );
  });
});

describe('tamper evidence', () => {
  it('seals a period and detects a later alteration', async () => {
    const client = new pg.Client({ connectionString: OWNER_URL });
    await client.connect();
    try {
      const start = new Date(Date.now() - 3_600_000);
      const end = new Date(Date.now() + 3_600_000);

      const first = await client.query<{ seal_audit_period: string }>(
        'SELECT seal_audit_period($1, $2, $3)', [tenantA.orgId, start, end],
      );
      const digest = first.rows[0]!.seal_audit_period;
      expect(digest).toMatch(/^[0-9a-f]{64}$/);

      // Recomputing over unchanged rows reproduces the digest exactly.
      await client.query('DELETE FROM audit_checkpoint WHERE tenant_id = $1', [tenantA.orgId]);
      const again = await client.query<{ seal_audit_period: string }>(
        'SELECT seal_audit_period($1, $2, $3)', [tenantA.orgId, start, end],
      );
      expect(again.rows[0]!.seal_audit_period).toBe(digest);

      // Add a row, and the digest for the period changes — which is what makes
      // a silently-inserted or altered record detectable after the fact.
      await auditService.record({
        tenantId: tenantA.orgId, action: 'tamper.probe', resourceType: 'campus',
      });
      await client.query('DELETE FROM audit_checkpoint WHERE tenant_id = $1', [tenantA.orgId]);
      const third = await client.query<{ seal_audit_period: string }>(
        'SELECT seal_audit_period($1, $2, $3)', [tenantA.orgId, start, end],
      );
      expect(third.rows[0]!.seal_audit_period).not.toBe(digest);
    } finally {
      await client.end();
    }
  });

  it('chains each checkpoint to the previous one', async () => {
    const client = new pg.Client({ connectionString: OWNER_URL });
    await client.connect();
    try {
      await client.query('DELETE FROM audit_checkpoint WHERE tenant_id = $1', [tenantB.orgId]);
      const t0 = new Date(Date.now() - 7_200_000);
      const t1 = new Date(Date.now() - 3_600_000);
      const t2 = new Date(Date.now() + 3_600_000);

      await client.query('SELECT seal_audit_period($1, $2, $3)', [tenantB.orgId, t0, t1]);
      await client.query('SELECT seal_audit_period($1, $2, $3)', [tenantB.orgId, t1, t2]);

      const { rows } = await client.query<{ prev_digest: string | null; digest: string }>(
        'SELECT prev_digest, digest FROM audit_checkpoint WHERE tenant_id = $1 ORDER BY period_start',
        [tenantB.orgId],
      );
      expect(rows).toHaveLength(2);
      expect(rows[0]!.prev_digest).toBeNull();
      // Altering anything in the first period changes its digest, which changes
      // the second checkpoint's input, and so on down the chain.
      expect(rows[1]!.prev_digest).toBe(rows[0]!.digest);
    } finally {
      await client.end();
    }
  });
});
