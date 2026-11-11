/**
 * AC-1: Tenant A can never access Tenant B data.
 *
 * These tests go through the same withTenant() wrapper the application uses,
 * against a real Postgres with RLS enabled. Mocking the database here would
 * test nothing that matters — the guarantee lives in the policies.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { createTenant, destroyTenants, APP_URL, type TenantFixture } from './fixtures.ts';
import { withTenant } from '../src/db/tenant.ts';
import { pool, assertAppRoleCannotBypassRls } from '../src/db/pool.ts';

let tenantA: TenantFixture;
let tenantB: TenantFixture;

beforeAll(async () => {
  tenantA = await createTenant('ISO-A');
  tenantB = await createTenant('ISO-B');
});

afterAll(async () => {
  await destroyTenants([tenantA.orgId, tenantB.orgId]);
  await pool.end();
});

describe('the application role itself', () => {
  it('cannot bypass row-level security', async () => {
    await expect(assertAppRoleCannotBypassRls()).resolves.toBeUndefined();
  });

  it('is not a superuser and does not hold BYPASSRLS', async () => {
    const { rows } = await pool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
    );
    expect(rows[0]?.rolsuper).toBe(false);
    expect(rows[0]?.rolbypassrls).toBe(false);
  });

  it('has no DDL rights on a tenant table', async () => {
    await expect(pool.query('ALTER TABLE campus ADD COLUMN sneaky text')).rejects.toThrow(
      /must be owner|permission denied/i,
    );
  });
});

describe('reads', () => {
  it('scoped to tenant A returns only tenant A rows', async () => {
    const rows = await withTenant({ tenantId: tenantA.orgId }, async (db) => {
      const r = await db.query<{ id: string; tenant_id: string }>('SELECT id, tenant_id FROM campus');
      return r.rows;
    });

    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.tenant_id === tenantA.orgId)).toBe(true);
    expect(rows.some((r) => r.id === tenantB.campusId)).toBe(false);
  });

  it('cannot fetch tenant B rows by id, even knowing the id', async () => {
    const rows = await withTenant({ tenantId: tenantA.orgId }, async (db) => {
      const r = await db.query('SELECT id FROM campus WHERE id = $1', [tenantB.campusId]);
      return r.rows;
    });

    // Zero rows, not an error. The row is invisible, which is what lets the API
    // return 404 rather than a 403 that would confirm the id exists.
    expect(rows).toHaveLength(0);
  });

  it('cannot see tenant B through a join on a second table', async () => {
    const rows = await withTenant({ tenantId: tenantA.orgId }, async (db) => {
      const r = await db.query(
        `SELECT u.id FROM academic_unit u JOIN campus c ON c.id = u.campus_id WHERE u.id = $1`,
        [tenantB.unitId],
      );
      return r.rows;
    });
    expect(rows).toHaveLength(0);
  });

  it('cannot see tenant B through an aggregate', async () => {
    const total = await withTenant({ tenantId: tenantA.orgId }, async (db) => {
      const r = await db.query<{ count: string }>('SELECT count(*)::text AS count FROM campus');
      return Number(r.rows[0]?.count ?? 0);
    });
    const allTenantCampuses = await countAsOwner();

    expect(total).toBeLessThan(allTenantCampuses);
  });

  it('sees its own organization row and no other', async () => {
    const rows = await withTenant({ tenantId: tenantA.orgId }, async (db) => {
      const r = await db.query<{ id: string }>('SELECT id FROM organization');
      return r.rows;
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(tenantA.orgId);
  });
});

describe('writes', () => {
  it('rejects an insert stamped with another tenant id (WITH CHECK)', async () => {
    await expect(
      withTenant({ tenantId: tenantA.orgId }, async (db) => {
        await db.query(
          `INSERT INTO campus (tenant_id, code, name) VALUES ($1, 'SMUGGLED', 'Smuggled Campus')`,
          [tenantB.orgId],
        );
      }),
    ).rejects.toThrow(/row-level security/i);

    // And the rollback held: nothing was written for either tenant.
    const leaked = await existsAsOwner('SMUGGLED');
    expect(leaked).toBe(false);
  });

  it('cannot update another tenant row', async () => {
    const affected = await withTenant({ tenantId: tenantA.orgId }, async (db) => {
      const r = await db.query(`UPDATE campus SET name = 'Renamed by A' WHERE id = $1`, [
        tenantB.campusId,
      ]);
      return r.rowCount;
    });

    expect(affected).toBe(0);
    expect(await campusNameAsOwner(tenantB.campusId)).toBe('ISO-B Main Campus');
  });

  it('cannot delete another tenant row', async () => {
    const affected = await withTenant({ tenantId: tenantA.orgId }, async (db) => {
      const r = await db.query('DELETE FROM campus WHERE id = $1', [tenantB.campusId]);
      return r.rowCount;
    });

    expect(affected).toBe(0);
    expect(await campusNameAsOwner(tenantB.campusId)).toBe('ISO-B Main Campus');
  });

  it('cannot re-stamp its own row into another tenant', async () => {
    await expect(
      withTenant({ tenantId: tenantA.orgId }, async (db) => {
        await db.query('UPDATE campus SET tenant_id = $1 WHERE id = $2', [
          tenantB.orgId,
          tenantA.campusId,
        ]);
      }),
    ).rejects.toThrow(/row-level security/i);
  });
});

describe('the tenant setting itself', () => {
  it('denies everything when no tenant is set (fails closed)', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const r = await client.query('SELECT id FROM campus');
      expect(r.rows).toHaveLength(0);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('does not leak the tenant setting onto the next user of a pooled connection', async () => {
    await withTenant({ tenantId: tenantA.orgId }, async (db) => {
      await db.query('SELECT 1');
    });

    // set_config(..., true) is transaction-scoped, so by the time the
    // connection returns to the pool the setting is gone. If this ever fails,
    // one request would inherit the previous request's tenant.
    const client = await pool.connect();
    try {
      const r = await client.query<{ tenant: string | null }>(
        "SELECT current_setting('app.tenant_id', true) AS tenant",
      );
      expect(r.rows[0]?.tenant ?? '').toBe('');
    } finally {
      client.release();
    }
  });

  it('refuses to run without a tenant id', async () => {
    await expect(
      withTenant({ tenantId: '' }, async () => undefined),
    ).rejects.toThrow(/without a tenantId/);
  });
});

describe('policy coverage', () => {
  it('every table with a tenant_id column has RLS enabled, forced and a policy', async () => {
    const { rows } = await pool.query<{
      table_name: string;
      rls_enabled: boolean;
      rls_forced: boolean;
      policy_count: string;
      is_covered: boolean;
    }>('SELECT * FROM rls_coverage ORDER BY table_name');

    expect(rows.length).toBeGreaterThan(0);

    const uncovered = rows.filter((r) => !r.is_covered).map((r) => r.table_name);
    // This is the check that keeps the guarantee true as the schema grows: add
    // a tenant table without a policy and this test names it.
    expect(uncovered).toEqual([]);
  });

  it('declares WITH CHECK explicitly on every writable policy', async () => {
    // Postgres reuses USING as the write check when WITH CHECK is omitted, so
    // an implicit policy passes every behavioural test above. It stops passing
    // the day someone narrows USING. This asserts the intent, not the effect.
    const { rows } = await pool.query<{
      table_name: string;
      policies_without_explicit_with_check: string;
    }>('SELECT table_name, policies_without_explicit_with_check FROM rls_coverage');

    const implicit = rows
      .filter((r) => Number(r.policies_without_explicit_with_check) > 0)
      .map((r) => r.table_name);

    expect(implicit).toEqual([]);
  });
});

// --- helpers that read as the owner, to assert on ground truth ---

async function withOwner<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: process.env['DATABASE_OWNER_URL'] });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function countAsOwner(): Promise<number> {
  return withOwner(async (c) => {
    const r = await c.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM campus WHERE tenant_id = ANY($1)',
      [[tenantA.orgId, tenantB.orgId]],
    );
    return Number(r.rows[0]?.count ?? 0);
  });
}

async function existsAsOwner(code: string): Promise<boolean> {
  return withOwner(async (c) => {
    const r = await c.query('SELECT 1 FROM campus WHERE code = $1', [code]);
    return r.rows.length > 0;
  });
}

async function campusNameAsOwner(id: string): Promise<string | undefined> {
  return withOwner(async (c) => {
    const r = await c.query<{ name: string }>('SELECT name FROM campus WHERE id = $1', [id]);
    return r.rows[0]?.name;
  });
}

// APP_URL is imported to make the dependency explicit in this file's header.
void APP_URL;
