import type { TenantClient } from '../../db/tenant.ts';

export type Role =
  | 'ORG_OWNER' | 'CAMPUS_ADMIN' | 'ADMISSIONS' | 'ACCOUNTANT'
  | 'TEACHER' | 'STUDENT' | 'GUARDIAN' | 'TRANSPORT' | 'SUPPORT_AGENT';

export type Permission =
  | 'campus:read' | 'campus:write'
  | 'student:read' | 'student:write'
  | 'finance:read' | 'finance:write'
  | 'attendance:read' | 'attendance:write'
  | 'result:read' | 'result:write' | 'result:publish'
  | 'transport:read' | 'transport:write'
  | 'grant:manage'
  | 'audit:read';

/**
 * What each role may do. Deliberately a plain table rather than rows in a
 * database: these are product decisions that should be reviewed in a diff, not
 * edited in production. Tenant-defined custom roles (M2.3, delegated
 * administration) compose subsets of these, and can never exceed them.
 */
const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  ORG_OWNER: [
    'campus:read', 'campus:write', 'student:read', 'student:write',
    'finance:read', 'finance:write', 'attendance:read', 'attendance:write',
    'result:read', 'result:write', 'result:publish',
    'transport:read', 'transport:write', 'grant:manage', 'audit:read',
  ],
  CAMPUS_ADMIN: [
    'campus:read', 'campus:write', 'student:read', 'student:write',
    'finance:read', 'attendance:read', 'attendance:write',
    'result:read', 'result:write', 'transport:read', 'grant:manage',
  ],
  ADMISSIONS: ['campus:read', 'student:read', 'student:write', 'finance:read'],
  // No academic writes: an accountant changing a grade is not a workflow, it is
  // an incident.
  ACCOUNTANT: ['campus:read', 'student:read', 'finance:read', 'finance:write'],
  // No finance at all: a teacher must not see who is behind on fees.
  TEACHER: ['campus:read', 'student:read', 'attendance:read', 'attendance:write', 'result:read', 'result:write'],
  STUDENT: ['attendance:read', 'result:read', 'finance:read'],
  GUARDIAN: ['attendance:read', 'result:read', 'finance:read'],
  // Rider names and stops only — no academic or financial data.
  TRANSPORT: ['transport:read', 'transport:write'],
  SUPPORT_AGENT: ['campus:read'],
};

export type ScopeType = 'organization' | 'campus' | 'academic_unit' | 'class_group' | 'section' | 'self';

export interface Grant {
  role: Role;
  scopeType: ScopeType;
  scopeId: string | null;
}

/** Broad to narrow. A grant covers its own level and everything below it. */
const SCOPE_DEPTH: Record<ScopeType, number> = {
  organization: 0, campus: 1, academic_unit: 2, class_group: 3, section: 4, self: 5,
};

export interface ResourceScope {
  type: ScopeType;
  id: string | null;
  /** Broad-to-narrow chain of ancestor ids, e.g. [campusId, unitId, classId]. */
  ancestors?: readonly string[];
}

export const authzService = {
  permissionsFor(roles: readonly Role[]): Set<Permission> {
    const out = new Set<Permission>();
    for (const role of roles) for (const p of ROLE_PERMISSIONS[role] ?? []) out.add(p);
    return out;
  },

  /**
   * A grant covers a resource when the role carries the permission AND the
   * grant's scope sits at or above the resource in the hierarchy.
   *
   * An organization-scoped grant covers everything in the tenant. A campus-scoped
   * grant covers only resources whose ancestor chain contains that campus — which
   * is why the caller must resolve the chain rather than passing a bare id.
   */
  covers(grant: Grant, permission: Permission, resource: ResourceScope): boolean {
    if (!(ROLE_PERMISSIONS[grant.role] ?? []).includes(permission)) return false;
    if (grant.scopeType === 'organization') return true;
    if (grant.scopeId === null) return false;

    if (SCOPE_DEPTH[grant.scopeType] > SCOPE_DEPTH[resource.type]) return false;
    if (grant.scopeType === resource.type) return grant.scopeId === resource.id;
    return (resource.ancestors ?? []).includes(grant.scopeId);
  },

  can(grants: readonly Grant[], permission: Permission, resource: ResourceScope): boolean {
    return grants.some((g) => this.covers(g, permission, resource));
  },

  /**
   * Delegated administration: a grant may never exceed the granter's own
   * permissions, and may never sit above the granter's own scope. Checked here
   * at grant time and again at use time, because a permission set that was valid
   * when granted can be narrowed later.
   */
  canDelegate(granterGrants: readonly Grant[], proposed: Grant): { ok: true } | { ok: false; reason: string } {
    const granterPerms = this.permissionsFor(granterGrants.map((g) => g.role));
    const proposedPerms = ROLE_PERMISSIONS[proposed.role] ?? [];

    const excess = proposedPerms.filter((p) => !granterPerms.has(p));
    if (excess.length > 0) {
      return { ok: false, reason: `grant would confer permissions the granter lacks: ${excess.join(', ')}` };
    }

    const coversScope = granterGrants.some((g) => {
      if (!(ROLE_PERMISSIONS[g.role] ?? []).includes('grant:manage')) return false;
      if (g.scopeType === 'organization') return true;
      return g.scopeType === proposed.scopeType && g.scopeId === proposed.scopeId;
    });
    if (!coversScope) {
      return { ok: false, reason: 'granter cannot manage grants at that scope' };
    }
    return { ok: true };
  },

  async grantsFor(db: TenantClient, userAccountId: string): Promise<Grant[]> {
    const { rows } = await db.query<{ role: Role; scope_type: ScopeType; scope_id: string | null }>(
      `SELECT role, scope_type, scope_id FROM role_grant
        WHERE user_account_id = $1 AND revoked_at IS NULL
          AND (expires_at IS NULL OR expires_at > now())`,
      [userAccountId],
    );
    return rows.map((r) => ({ role: r.role, scopeType: r.scope_type, scopeId: r.scope_id }));
  },
};
