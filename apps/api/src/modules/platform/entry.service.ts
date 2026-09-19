/**
 * Entering a school from the platform console.
 *
 * One click, and a row. Those two facts are the whole design and they are not
 * in tension: the friction that protects a school is not the waiting, it is the
 * record. An approval queue between two colleagues who sit together becomes a
 * rubber stamp within a week, and a rubber stamp is worse than no control
 * because it looks like one on a compliance questionnaire.
 *
 * So a platform administrator enters immediately. What they cannot do is enter
 * quietly: the session row carries both identities into every audit entry, the
 * clock is enforced by a database trigger rather than by this file, the school
 * sees it in their own trail, and their owner can end it.
 *
 * Write access is a separate capability, not a checkbox on this one. Almost
 * every real support question is answered by looking, and a console where
 * looking and changing are the same act produces changes nobody meant to make.
 */
import { withPlatform } from '../../db/platform-pool.ts';
import { withTenant } from '../../db/tenant.ts';
import { ApiError } from '../../common/errors.ts';
import { auditService } from '../audit/audit.service.ts';
import { platformAdminService } from './platform-admin.service.ts';
import { tokenService } from '../auth/token.service.ts';
import { authService } from '../auth/auth.service.ts';

/** Shorter than the hour the database permits. Most look-ups take two minutes. */
const DEFAULT_MINUTES = 30;

export interface EntryInput {
  tenantId: string;
  /**
   * Who to become. Required, and deliberately so.
   *
   * "Enter as a teacher" sounds like the useful primitive and is not one. Every
   * row-level security policy in this system answers "may THIS person see this
   * row", resolving the actor's grants, sections and family links from the
   * database — so there is no such thing as a generic teacher's view, only
   * Mrs Nair's view, and a console that pretended otherwise would either show
   * an empty screen or quietly pick somebody without saying who.
   *
   * The console's flow is therefore: pick a school, filter by role, pick a
   * person. What lands in the audit trail is a name, which is what the school
   * needs in order to understand what was seen.
   */
  targetUserId: string;
  /**
   * The role being exercised, when that person holds more than one.
   *
   * Narrows, never widens: it must be a role the target actually holds, and the
   * token carries only it. Answering "what does this look like to her as a
   * class teacher" should not also hand over her accountant's ledger.
   */
  assumedRole?: string | undefined;
  /** Requires the impersonate_write capability. Defaults to looking only. */
  write?: boolean | undefined;
  reason: string;
  minutes?: number | undefined;
}

export interface EntrySession {
  id: string;
  tenantId: string;
  assumedRole: string | null;
  targetUserId: string;
  roles: string[];
  writeEnabled: boolean;
  expiresAt: string;
  /**
   * Drives the school's own screens, carrying the impersonation claim.
   *
   * There is no refresh token beside it. An entry token cannot be renewed: when
   * the window closes the console asks for a new session and writes a new row,
   * which is the point — a renewable entry is a standing grant with extra steps.
   */
  accessToken: string;
}

export const entryService = {
  /**
   * Opens a session and mints a token scoped to it.
   *
   * The token carries the impersonation id, which AuthGuard re-checks on every
   * request — so ending a session or letting it expire takes effect on the next
   * call rather than whenever the token happens to lapse.
   */
  async enter(actorUserId: string, input: EntryInput): Promise<EntrySession> {
    if (input.reason.trim().length < 10) {
      // Not bureaucracy: this is the line the school reads in their audit trail
      // when they ask why somebody was in their records.
      throw ApiError.make('validation_error', 'reason_too_short',
        'Say why you are entering, in a sentence the school would find satisfying.');
    }

    if (!(await platformAdminService.has(actorUserId, 'impersonate'))) {
      throw ApiError.make('not_found', 'not_found', 'Not found.');
    }

    const wantsWrite = input.write === true;
    if (wantsWrite && !(await platformAdminService.has(actorUserId, 'impersonate_write'))) {
      throw ApiError.make('permission_error', 'write_not_permitted',
        'Entering to look is one capability; changing a school’s records is '
        + 'another. Ask for impersonate_write if you genuinely need it.');
    }

    const minutes = Math.min(Math.max(input.minutes ?? DEFAULT_MINUTES, 5), 60);

    // Resolved through the AUTH pool, not the platform pool.
    //
    // The platform role holds no grant on anything inside a school — a boot
    // assertion proves it — and `role_grant` is inside a school. The auth role
    // already answers "which roles does this person hold in this tenant" for
    // every login, so the question has a home; asking it from here would mean
    // widening the console's reach to answer it.
    const roles = await authService.rolesFor(input.targetUserId, input.tenantId);
    if (roles.length === 0) {
      throw ApiError.make('not_found', 'target_not_in_school',
        'That person does not hold a live role in this school.');
    }
    if (input.assumedRole && !roles.includes(input.assumedRole)) {
      throw ApiError.make('validation_error', 'role_not_held',
        `That person does not hold the ${input.assumedRole} role here. `
        + 'Pick a role they actually have, or enter without narrowing.');
    }

    // The target's grants version, not the platform administrator's, because
    // the token names the target. That is not a detail: it means revoking the
    // impersonated person's access also kills every session standing in for
    // them, on the next request, without the console being told.
    const gv = await authService.currentGrantsVersion(input.targetUserId);
    if (gv === undefined) {
      throw ApiError.make('not_found', 'target_not_found', 'No such account.');
    }

    const session = await withPlatform(async (db) => {
      // Copied onto the row rather than joined at read time — see 0056. The
      // school cannot read a platform administrator's account, so if the name
      // is not written here it is not knowable by the people it concerns most.
      const { rows: who } = await db.query<{ login_email: string }>(
        'SELECT login_email FROM user_account WHERE id = $1', [actorUserId]);

      const { rows } = await db.query<{ id: string; expires_at: string }>(
        `INSERT INTO impersonation_session
           (tenant_id, actor_user_id, actor_label, target_user_id, assumed_role,
            reason, entry_path, status, write_enabled, started_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'platform', 'active', $7,
                 now(), now() + make_interval(mins => $8))
         RETURNING id, expires_at`,
        [input.tenantId, actorUserId, who[0]?.login_email ?? 'paathshalaOS staff',
         input.targetUserId, input.assumedRole ?? null, input.reason.trim(),
         wantsWrite, minutes]);
      return rows[0]!;
    });

    // Written to the SCHOOL's audit trail, not only the platform's. The whole
    // argument for the session row is that the institute can see it.
    await auditService.record({
      tenantId: input.tenantId,
      action: 'platform.entered_school',
      resourceType: 'impersonation_session',
      resourceId: session.id,
      actorUserId,
      onBehalfOfUserId: input.targetUserId,
      impersonationId: session.id,
      classification: 'RESTRICTED',
      reason: input.reason.trim(),
      after: {
        assumed_role: input.assumedRole ?? null,
        target_user_id: input.targetUserId,
        write_enabled: wantsWrite,
        expires_at: session.expires_at,
      },
    });

    const effectiveRoles = input.assumedRole ? [input.assumedRole] : roles;

    const accessToken = await tokenService.signAccessToken({
      // `sub` is the person being stood in for, not the administrator.
      //
      // Every policy in this database decides by app.actor_id, so this is what
      // makes the school's screens render exactly as that person sees them —
      // the same sections, the same children, the same redactions — rather than
      // rendering some privileged view that nobody in the school ever gets.
      // Who is really at the keyboard travels in `imp`, which the auth guard
      // resolves to the session on every request and every audit row records.
      sub: input.targetUserId,
      tenant_id: input.tenantId,
      // The entry session IS the session. There is no row in `session` because
      // nobody signed in; pointing at the impersonation row instead keeps the
      // claim honest and makes request logs join straight to the window.
      session_id: session.id,
      gv,
      roles: effectiveRoles,
      imp: session.id,
      write: wantsWrite,
    });

    return {
      id: session.id,
      tenantId: input.tenantId,
      assumedRole: input.assumedRole ?? null,
      targetUserId: input.targetUserId,
      roles: effectiveRoles,
      writeEnabled: wantsWrite,
      expiresAt: session.expires_at,
      accessToken,
    };
  },

  /** Ends a session early. The school's owner can do this too, from their side. */
  async leave(actorUserId: string, sessionId: string): Promise<void> {
    const row = await withPlatform(async (db) => {
      const { rows } = await db.query<{ tenant_id: string }>(
        `UPDATE impersonation_session
            SET status = 'revoked', revoked_at = now(), revoked_by = $2,
                revoked_reason = 'left the school'
          WHERE id = $1 AND status = 'active'
          RETURNING tenant_id`,
        [sessionId, actorUserId]);
      return rows[0];
    });
    if (!row) {
      throw ApiError.make('not_found', 'session_not_active',
        'That session is not open.');
    }

    await auditService.record({
      tenantId: row.tenant_id,
      action: 'platform.left_school',
      resourceType: 'impersonation_session', resourceId: sessionId,
      actorUserId, classification: 'RESTRICTED',
    });
  },

  /** What the console shows: who has been where, most recent first. */
  async recent(limit = 50): Promise<Array<{
    id: string; tenant_id: string; display_name: string | null;
    actor_email: string | null; assumed_role: string | null;
    write_enabled: boolean; entry_path: string; status: string;
    reason: string; started_at: string | null; expires_at: string | null;
  }>> {
    return withPlatform(async (db) => {
      const { rows } = await db.query<{
        id: string; tenant_id: string; display_name: string | null;
        actor_email: string | null; assumed_role: string | null;
        write_enabled: boolean; entry_path: string; status: string;
        reason: string; started_at: string | null; expires_at: string | null;
      }>(
        `SELECT s.id, s.tenant_id, o.display_name, ua.login_email AS actor_email,
                s.assumed_role, s.write_enabled, s.entry_path, s.status,
                s.reason, s.started_at, s.expires_at
           FROM impersonation_session s
           LEFT JOIN organization o ON o.id = s.tenant_id
           LEFT JOIN user_account ua ON ua.id = s.actor_user_id
          ORDER BY s.requested_at DESC
          LIMIT $1`, [limit]);
      return rows;
    });
  },

  /**
   * The same list, for one school, readable by that school.
   *
   * Runs on the tenant pool under the school's own scope, so it is their policy
   * that decides — which is the point. "Who has been in our records" must not be
   * a question only we can answer.
   */
  async forSchool(scope: { tenantId: string; actorId: string }): Promise<Array<{
    id: string; assumed_role: string | null; entry_path: string;
    status: string; reason: string; started_at: string | null;
    expires_at: string | null; write_enabled: boolean;
  }>> {
    return withTenant(scope, async (db) => {
      const { rows } = await db.query<{
        id: string; assumed_role: string | null; entry_path: string;
        status: string; reason: string; started_at: string | null;
        expires_at: string | null; write_enabled: boolean;
      }>(
        `SELECT id, assumed_role, entry_path, status, reason,
                started_at, expires_at, write_enabled
           FROM impersonation_session
          ORDER BY requested_at DESC
          LIMIT 100`);
      return rows;
    });
  },
};
