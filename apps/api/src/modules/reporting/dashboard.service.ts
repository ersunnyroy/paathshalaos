/**
 * M9.6 — dashboards, and AC-2.
 *
 * **AC-2: group totals reconcile to campus figures to the paisa.**
 *
 * That is not a formatting requirement. The way it breaks is that the group
 * figure and the campus figure are computed by two different queries written
 * months apart — one filters voided invoices, the other does not; one counts
 * enrollments, the other counts students — and the numbers drift by an amount
 * nobody can explain. A principal who cannot reconcile the dashboard to the
 * campus report stops trusting both.
 *
 * The fix is structural: there is ONE query per figure, at the finest grain
 * (campus), and every coarser figure is a SUM of those rows. A group total
 * cannot disagree with its campuses because it is not computed separately — it
 * is their sum, and the reconciliation test asserts exactly that.
 *
 * Money is returned in paise as a string. The moment a dashboard renders rupees
 * as a float, "to the paisa" is over.
 */
import { withTenant, type TenantScope, type TenantClient } from '../../db/tenant.ts';

export interface CampusFigures {
  campus_id: string;
  campus_name: string;
  learners: number;
  staff: number;
  /** Paise, as a string. */
  billed: string;
  collected: string;
  outstanding: string;
  present_today: number;
  absent_today: number;
}

export interface GroupFigures {
  learners: number;
  staff: number;
  billed: string;
  collected: string;
  outstanding: string;
  present_today: number;
  absent_today: number;
  campuses: CampusFigures[];
}

/**
 * Per-campus figures. The single source for every number on every dashboard.
 *
 * `on` is the date attendance is counted for — a parameter rather than
 * `CURRENT_DATE` so the figure is reproducible: a test, a scheduled digest and
 * a screen opened at 00:01 must all be able to ask for the same day.
 */
async function figuresByCampus(
  db: TenantClient, on: string,
): Promise<CampusFigures[]> {
  const { rows } = await db.query<CampusFigures>(
    `WITH campuses AS (
       SELECT id, name FROM campus WHERE deleted_at IS NULL
     ),
     -- A section has no campus of its own: it belongs to a class group, which
     -- belongs to a programme, which belongs to an academic unit, which sits on
     -- a campus. Resolving it here, once, is what keeps every figure below
     -- attributed the same way.
     section_campus AS (
       SELECT sec.id AS section_id, au.campus_id
         FROM section sec
         JOIN class_group cg ON cg.id = sec.class_group_id
         JOIN programme pr ON pr.id = cg.programme_id
         JOIN academic_unit au ON au.id = pr.academic_unit_id
     ),
     learner_counts AS (
       SELECT s.campus_id, count(*)::int AS learners
         FROM (
           SELECT DISTINCT e.student_id, sc.campus_id
             FROM enrollment e
             JOIN section_campus sc ON sc.section_id = e.section_id
            WHERE e.status = 'active'
         ) s
        GROUP BY s.campus_id
     ),
     staff_counts AS (
       SELECT campus_id, count(*)::int AS staff
         FROM staff WHERE deleted_at IS NULL GROUP BY campus_id
     ),
     -- Voided invoices are excluded from BOTH billed and outstanding. The
     -- classic drift is excluding them from one and not the other.
     money AS (
       SELECT campus_id,
              COALESCE(sum(total), 0)                  AS billed,
              COALESCE(sum(amount_paid), 0)            AS collected,
              COALESCE(sum(total - amount_paid), 0)    AS outstanding
         FROM invoice
        WHERE status <> 'void'
        GROUP BY campus_id
     ),
     attendance AS (
       SELECT sc.campus_id,
              count(*) FILTER (WHERE r.state IN ('present', 'late', 'half_day'))::int AS present_today,
              count(*) FILTER (WHERE r.state = 'absent')::int AS absent_today
         FROM attendance_record r
         JOIN attendance_session ses ON ses.id = r.attendance_session_id
         JOIN section_campus sc ON sc.section_id = ses.section_id
        -- r.session_date, not only ses.session_date: the record table is
        -- partitioned on its own column and a predicate on the joined session
        -- prunes nothing (M30.1).
        WHERE r.session_date = $1::date
          AND ses.session_date = $1::date
        GROUP BY sc.campus_id
     )
     SELECT c.id AS campus_id,
            c.name AS campus_name,
            COALESCE(l.learners, 0) AS learners,
            COALESCE(st.staff, 0) AS staff,
            -- Rupees are numeric(14,2); paise is that times 100 as an exact
            -- integer. Worth being straight about this cast: at numeric(14,2)
            -- every possible paise value also fits a float64 exactly, so a
            -- mutation replacing ::bigint with ::float8 changes nothing and no
            -- test can catch it. It stays because the column width is the only
            -- thing making that true, and widening the column later should not
            -- quietly turn money into a float.
            (COALESCE(m.billed, 0) * 100)::bigint::text AS billed,
            (COALESCE(m.collected, 0) * 100)::bigint::text AS collected,
            (COALESCE(m.outstanding, 0) * 100)::bigint::text AS outstanding,
            COALESCE(a.present_today, 0) AS present_today,
            COALESCE(a.absent_today, 0) AS absent_today
       FROM campuses c
       LEFT JOIN learner_counts l ON l.campus_id = c.id
       LEFT JOIN staff_counts st ON st.campus_id = c.id
       LEFT JOIN money m ON m.campus_id = c.id
       LEFT JOIN attendance a ON a.campus_id = c.id
      ORDER BY c.name`,
    [on],
  );
  return rows;
}

export const dashboardService = {
  async campusFigures(scope: TenantScope, on?: string): Promise<CampusFigures[]> {
    return withTenant(scope, (db) =>
      figuresByCampus(db, on ?? new Date().toISOString().slice(0, 10)));
  },

  /**
   * The group view.
   *
   * Every total here is the sum of the campus rows above it. There is no second
   * query, so there is nothing for the two to disagree about — which is AC-2,
   * arranged so that it holds by construction rather than by vigilance.
   */
  async groupFigures(scope: TenantScope, on?: string): Promise<GroupFigures> {
    const campuses = await dashboardService.campusFigures(scope, on);
    const sumMoney = (pick: (c: CampusFigures) => string) =>
      campuses.reduce((total, c) => total + BigInt(pick(c)), 0n).toString();
    const sumCount = (pick: (c: CampusFigures) => number) =>
      campuses.reduce((total, c) => total + pick(c), 0);

    return {
      learners: sumCount((c) => c.learners),
      staff: sumCount((c) => c.staff),
      billed: sumMoney((c) => c.billed),
      collected: sumMoney((c) => c.collected),
      outstanding: sumMoney((c) => c.outstanding),
      present_today: sumCount((c) => c.present_today),
      absent_today: sumCount((c) => c.absent_today),
      campuses,
    };
  },

  /** The daily series behind the sparklines. */
  async trend(scope: TenantScope, days = 30, endOn?: string): Promise<TrendPoint[]> {
    const end = endOn ?? new Date().toISOString().slice(0, 10);
    const start = new Date(`${end}T00:00:00Z`);
    start.setUTCDate(start.getUTCDate() - (days - 1));
    return withTenant(scope, (db) =>
      dailyTrend(db, start.toISOString().slice(0, 10), end));
  },

  /** What a teacher or office sees first thing: today, and what needs doing. */
  async todayFor(scope: TenantScope, on?: string): Promise<{
    date: string;
    unmarked_sessions: number;
    pending_corrections: number;
    unreviewed_results: number;
    failed_messages: number;
    imports_awaiting_apply: number;
  }> {
    const date = on ?? new Date().toISOString().slice(0, 10);
    return withTenant(scope, async (db) => {
      const { rows } = await db.query<{
        unmarked_sessions: number; pending_corrections: number;
        unreviewed_results: number; failed_messages: number;
        imports_awaiting_apply: number;
      }>(
        `SELECT
           (SELECT count(*)::int FROM attendance_session
             WHERE session_date = $1::date AND status = 'open')       AS unmarked_sessions,
           (SELECT count(*)::int FROM attendance_correction
             WHERE status = 'pending')                                 AS pending_corrections,
           (SELECT count(*)::int FROM result_run
             WHERE status = 'computed')                                AS unreviewed_results,
           (SELECT count(*)::int FROM message_recipient
             WHERE status = 'failed')                                  AS failed_messages,
           (SELECT count(*)::int FROM import_batch
             WHERE status = 'previewed')                               AS imports_awaiting_apply`,
        [date],
      );
      return { date, ...rows[0]! };
    });
  },
};

export interface TrendPoint {
  day: string;
  /** Paise collected that day, as a string. */
  collected: string;
  present: number;
  absent: number;
  invoices_issued: number;
}

/**
 * A daily series for the sparklines.
 *
 * Real rows, not a decorative curve. A sparkline drawn from invented data is
 * worse than no sparkline: it reads as evidence, and the first person to notice
 * it disagrees with the ledger stops trusting every other number on the page.
 *
 * `generate_series` supplies the days so a day with no activity is a zero rather
 * than a gap — a line that skips quiet days shows a trend that did not happen.
 */
export async function dailyTrend(
  db: TenantClient, from: string, to: string,
): Promise<TrendPoint[]> {
  const { rows } = await db.query<TrendPoint>(
    `WITH days AS (
       SELECT generate_series($1::date, $2::date, interval '1 day')::date AS day
     ),
     paid AS (
       SELECT r.issued_on::date AS day, sum(r.amount) AS collected
         FROM receipt r
        WHERE r.issued_on::date BETWEEN $1::date AND $2::date
        GROUP BY 1
     ),
     issued AS (
       SELECT i.created_at::date AS day, count(*)::int AS n
         FROM invoice i
        WHERE i.created_at::date BETWEEN $1::date AND $2::date
          AND i.status <> 'void'
        GROUP BY 1
     ),
     att AS (
       SELECT s.session_date AS day,
              count(*) FILTER (WHERE r.state IN ('present','late','half_day'))::int AS present,
              count(*) FILTER (WHERE r.state = 'absent')::int AS absent
         FROM attendance_session s
         JOIN attendance_record r ON r.attendance_session_id = s.id
        WHERE r.session_date BETWEEN $1::date AND $2::date
          AND s.session_date BETWEEN $1::date AND $2::date
        GROUP BY 1
     )
     SELECT d.day::text AS day,
            (COALESCE(p.collected, 0) * 100)::bigint::text AS collected,
            COALESCE(a.present, 0) AS present,
            COALESCE(a.absent, 0) AS absent,
            COALESCE(i.n, 0) AS invoices_issued
       FROM days d
       LEFT JOIN paid p ON p.day = d.day
       LEFT JOIN att a ON a.day = d.day
       LEFT JOIN issued i ON i.day = d.day
      ORDER BY d.day`,
    [from, to],
  );
  return rows;
}
