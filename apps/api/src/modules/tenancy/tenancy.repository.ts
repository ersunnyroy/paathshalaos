import { withTenant, type TenantScope } from '../../db/tenant.ts';

export interface Campus {
  id: string;
  tenant_id: string;
  code: string;
  name: string;
  is_primary: boolean;
  status: string;
}

export interface AcademicUnit {
  id: string;
  tenant_id: string;
  campus_id: string;
  code: string;
  name: string;
  unit_type: string;
}

/**
 * Note what is absent: no method takes a tenant id as a filter argument, and no
 * query has a `WHERE tenant_id = $1` clause. Isolation is the database's job
 * via RLS, not something each query remembers to do. A missed WHERE clause is a
 * leak; a missed policy is caught by the rls_coverage check.
 */
export const tenancyRepository = {
  async listCampuses(scope: TenantScope): Promise<Campus[]> {
    return withTenant(scope, async (db) => {
      const { rows } = await db.query<Campus>(
        `SELECT id, tenant_id, code, name, is_primary, status
           FROM campus
          WHERE deleted_at IS NULL
          ORDER BY is_primary DESC, name ASC`,
      );
      return rows;
    });
  },

  async findCampusById(scope: TenantScope, id: string): Promise<Campus | undefined> {
    return withTenant(scope, async (db) => {
      const { rows } = await db.query<Campus>(
        `SELECT id, tenant_id, code, name, is_primary, status
           FROM campus
          WHERE id = $1 AND deleted_at IS NULL`,
        [id],
      );
      return rows[0];
    });
  },

  async createCampus(
    scope: TenantScope,
    input: { code: string; name: string; isPrimary?: boolean | undefined },
  ): Promise<Campus> {
    return withTenant(scope, async (db) => {
      const { rows } = await db.query<Campus>(
        `INSERT INTO campus (tenant_id, code, name, is_primary)
         VALUES (app_current_tenant_id(), $1, $2, COALESCE($3, false))
         RETURNING id, tenant_id, code, name, is_primary, status`,
        [input.code, input.name, input.isPrimary ?? null],
      );
      const created = rows[0];
      if (!created) throw new Error('Insert returned no row.');
      return created;
    });
  },

  async listAcademicUnits(scope: TenantScope, campusId?: string): Promise<AcademicUnit[]> {
    return withTenant(scope, async (db) => {
      const { rows } = await db.query<AcademicUnit>(
        `SELECT id, tenant_id, campus_id, code, name, unit_type
           FROM academic_unit
          WHERE deleted_at IS NULL
            AND ($1::uuid IS NULL OR campus_id = $1::uuid)
          ORDER BY name ASC`,
        [campusId ?? null],
      );
      return rows;
    });
  },
};
