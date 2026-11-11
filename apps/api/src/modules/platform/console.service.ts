/**
 * What the console can answer without entering a school (M15.4, M15.5).
 *
 * The temptation here is a search box that looks inside every tenant at once —
 * "find this student across all schools" — and it is the single change that
 * would undo this system's guarantees, because a query that can reach every
 * school is exactly the thing row-level security exists to make impossible.
 *
 * So the console searches the things that are ABOUT schools rather than the
 * things inside them: school names, accounts and their roles, provisioning
 * records, and the access sessions we ourselves opened. When a support question
 * needs a learner's record, the answer is to enter that school as somebody, on
 * the record — which is one click away and is the whole point of M15.
 *
 * Everything below therefore runs on the platform pool, which holds no grant on
 * `student`, `person`, `invoice` or `attendance_record`; the boot assertion in
 * platform-pool.ts fails the process if a migration ever gives it one.
 */
import { withPlatform } from '../../db/platform-pool.ts';
import { likeLiteral } from '../../common/like.ts';

export interface SchoolHit {
  id: string;
  display_name: string;
  legal_name: string;
  status: string;
  created_at: string;
}

export interface AccountHit {
  user_account_id: string;
  login_email: string;
  status: string;
  tenant_id: string;
  display_name: string;
  roles: string[];
}

export interface SchoolHealth extends SchoolHit {
  accounts: number;
  owners: number;
  live_sessions: number;
  last_entered_at: string | null;
  provisioned_at: string | null;
}


export const consoleService = {
  /**
   * One box, two kinds of answer.
   *
   * A support request arrives as either "Sunrise Public School says…" or
   * "this parent emailed us from er.sunny@…", and making somebody choose which
   * kind of search they are doing before they type is the sort of thing that
   * gets a console abandoned in favour of asking an engineer.
   */
  async search(term: string, limit = 20): Promise<{ schools: SchoolHit[]; accounts: AccountHit[] }> {
    const trimmed = term.trim();
    if (trimmed.length < 2) return { schools: [], accounts: [] };
    const pattern = likeLiteral(trimmed);

    return withPlatform(async (db) => {
      const { rows: schools } = await db.query<SchoolHit>(
        `SELECT id, display_name, legal_name, status, created_at
           FROM organization
          WHERE deleted_at IS NULL
            AND (display_name ILIKE $1 OR legal_name ILIKE $1)
          ORDER BY display_name
          LIMIT $2`, [pattern, limit]);

      // Email only. There is no name search here because names live on `person`,
      // inside the school, and the console cannot read that table — by design
      // rather than by omission.
      const { rows: accounts } = await db.query<AccountHit>(
        `SELECT ua.id AS user_account_id, ua.login_email, ua.status,
                o.id AS tenant_id, o.display_name,
                array_agg(DISTINCT rg.role ORDER BY rg.role) AS roles
           FROM user_account ua
           JOIN role_grant rg ON rg.user_account_id = ua.id AND rg.revoked_at IS NULL
           JOIN organization o ON o.id = rg.tenant_id AND o.deleted_at IS NULL
          WHERE ua.login_email ILIKE $1
          GROUP BY ua.id, ua.login_email, ua.status, o.id, o.display_name
          ORDER BY ua.login_email
          LIMIT $2`, [pattern, limit]);

      return { schools, accounts };
    });
  },

  /**
   * The estate at a glance.
   *
   * Deliberately not "how many learners does each school have". That number is
   * the obvious thing to put on a platform dashboard and it is a count of rows
   * in a table the console cannot read — and should not, because a support
   * console that knows every school's enrolment is a support console that has
   * a copy of every school's business.
   *
   * What it shows instead is our own relationship with each school: is it live,
   * how many accounts it has, whether anybody from here is inside it right now,
   * and when we were last in. That last column is the one that makes a pattern
   * visible — a school we keep entering is a school whose product is failing.
   */
  async health(): Promise<SchoolHealth[]> {
    return withPlatform(async (db) => {
      const { rows } = await db.query<SchoolHealth>(
        `SELECT o.id, o.display_name, o.legal_name, o.status, o.created_at,
                count(DISTINCT rg.user_account_id)::int AS accounts,
                count(DISTINCT rg.user_account_id)
                  FILTER (WHERE rg.role = 'ORG_OWNER')::int AS owners,
                count(DISTINCT s.id)
                  FILTER (WHERE s.status = 'active' AND s.expires_at > now())::int
                  AS live_sessions,
                max(s.started_at) AS last_entered_at,
                max(tp.created_at) AS provisioned_at
           FROM organization o
           LEFT JOIN role_grant rg
             ON rg.tenant_id = o.id AND rg.revoked_at IS NULL
           LEFT JOIN impersonation_session s ON s.tenant_id = o.id
           LEFT JOIN tenant_provisioning tp ON tp.tenant_id = o.id
          WHERE o.deleted_at IS NULL
          GROUP BY o.id
          ORDER BY o.display_name`);
      return rows;
    });
  },

  /**
   * Who you could enter a school as.
   *
   * Emails and roles, because that is all the console is allowed to know: the
   * people's names are on `person`, inside the school. In practice the email is
   * what a support conversation already contains.
   */
  async peopleIn(tenantId: string, role?: string): Promise<Array<{
    user_account_id: string; login_email: string; status: string; roles: string[];
  }>> {
    return withPlatform(async (db) => {
      const { rows } = await db.query<{
        user_account_id: string; login_email: string; status: string; roles: string[];
      }>(
        `SELECT ua.id AS user_account_id, ua.login_email, ua.status,
                array_agg(DISTINCT rg.role ORDER BY rg.role) AS roles
           FROM role_grant rg
           JOIN user_account ua ON ua.id = rg.user_account_id
          WHERE rg.tenant_id = $1 AND rg.revoked_at IS NULL
            AND ($2::text IS NULL OR EXISTS (
                  SELECT 1 FROM role_grant r2
                   WHERE r2.tenant_id = rg.tenant_id
                     AND r2.user_account_id = rg.user_account_id
                     AND r2.revoked_at IS NULL AND r2.role = $2))
          GROUP BY ua.id, ua.login_email, ua.status
          ORDER BY ua.login_email
          LIMIT 200`, [tenantId, role ?? null]);
      return rows;
    });
  },
};
