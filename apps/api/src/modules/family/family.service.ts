/**
 * What a parent asks (M21).
 *
 * Every other read surface in this system is shaped like a school: by section,
 * by date, by run. A parent does not have a section — they have Aarav, and four
 * questions about him. Reusing the office's endpoints and filtering on the
 * phone would mean the client decides which child's rows it shows, which is the
 * one decision a client must never make.
 *
 * Nothing here writes a `WHERE guardian = me` clause. The policies from 0012,
 * 0027, 0033, 0036 and 0049 already answer "may THIS person see this row", and
 * a filter written here is a filter somebody forgets on the next endpoint. What
 * these queries do is choose the SHAPE — a month of days rather than a list of
 * sessions, one total owed rather than a ledger.
 */
import { withTenant, type TenantScope } from '../../db/tenant.ts';

export interface Child {
  id: string;
  admission_no: string;
  given_name: string;
  family_name: string | null;
  section_name: string | null;
  class_name: string | null;
  enrollment_id: string | null;
  /** What this family has been allowed to see. Drives the screens, not the policies. */
  can_view_academics: boolean;
  can_view_finance: boolean;
}

export const familyService = {
  /**
   * The children this person is responsible for.
   *
   * The permission flags come back with them because the app has to draw a
   * screen, and a fees tab that opens onto an empty list is worse than a fees
   * tab that is not there. They are a hint for the interface; the database
   * still refuses the rows either way.
   */
  async children(scope: TenantScope): Promise<Child[]> {
    return withTenant(scope, async (db) => {
      const { rows } = await db.query<Child>(
        `SELECT st.id, st.admission_no, p.given_name, p.family_name,
                sec.name AS section_name, cg.name AS class_name,
                e.id AS enrollment_id,
                COALESCE(bool_or(gl.can_view_academics), false) AS can_view_academics,
                COALESCE(bool_or(gl.can_view_finance), false) AS can_view_finance
           FROM student st
           JOIN person p ON p.id = st.person_id
           LEFT JOIN enrollment e ON e.student_id = st.id AND e.status = 'active'
           LEFT JOIN section sec ON sec.id = e.section_id
           LEFT JOIN class_group cg ON cg.id = sec.class_group_id
           -- The caller's own links, not every link on the child: a parent
           -- must not inherit the other parent's finance permission.
           LEFT JOIN guardian_link gl ON gl.student_id = st.id
                AND gl.guardian_person_id = app_current_person_id()
                AND gl.effective_to IS NULL
          WHERE st.deleted_at IS NULL
          GROUP BY st.id, st.admission_no, p.given_name, p.family_name,
                   sec.name, cg.name, e.id
          ORDER BY p.given_name`);
      return rows;
    });
  },

  /**
   * "Was my child in school?" — a run of days, not a list of sessions.
   *
   * A parent thinks in days. The school records sessions, and a day can hold
   * several; a child marked absent in one and present in another was at school,
   * so the day is reported by its worst mark rather than its first. Reporting
   * the first would tell a parent their child was absent on a day they walked
   * home from.
   */
  async attendance(scope: TenantScope, input: {
    studentId: string; from: string; to: string;
  }): Promise<{
    days: Array<{ on_date: string; state: string }>;
    present: number; absent: number; late: number; recorded: number;
  }> {
    return withTenant(scope, async (db) => {
      const { rows } = await db.query<{ on_date: string; state: string }>(
        `SELECT s.session_date::text AS on_date,
                -- Worst mark of the day wins, in the order a parent cares
                -- about: absent beats late beats present.
                MIN(CASE r.state WHEN 'absent' THEN 1 WHEN 'late' THEN 2
                                 WHEN 'half_day' THEN 2 WHEN 'excused' THEN 3
                                 ELSE 4 END) AS rank,
                CASE MIN(CASE r.state WHEN 'absent' THEN 1 WHEN 'late' THEN 2
                                      WHEN 'half_day' THEN 2 WHEN 'excused' THEN 3
                                      ELSE 4 END)
                  WHEN 1 THEN 'absent' WHEN 2 THEN 'late'
                  WHEN 3 THEN 'excused' ELSE 'present' END AS state
           FROM attendance_record r
           JOIN attendance_session s ON s.id = r.attendance_session_id
           JOIN enrollment e ON e.id = r.enrollment_id
          WHERE e.student_id = $1::uuid
            AND s.session_date BETWEEN $2::date AND $3::date
          GROUP BY s.session_date
          ORDER BY s.session_date DESC`,
        [input.studentId, input.from, input.to]);

      const days = rows.map((r) => ({ on_date: r.on_date, state: r.state }));
      return {
        days,
        present: days.filter((d) => d.state === 'present').length,
        absent: days.filter((d) => d.state === 'absent').length,
        late: days.filter((d) => d.state === 'late').length,
        recorded: days.length,
      };
    });
  },

  /**
   * "What do I owe?"
   *
   * Paise as strings, all the way out. A JSON number is a double, and a fee
   * total that has been through a double is no longer exact — a parent shown
   * ₹12,500.09 for a ₹12,500.10 invoice will not pay it, and they are right
   * not to.
   *
   * A family without `can_view_finance` gets an empty list from the policy
   * rather than an error, which is correct: the other parent handles the fees
   * and this one is not being told off for looking.
   */
  async fees(scope: TenantScope, studentId: string): Promise<{
    outstanding_paise: string;
    next_due_on: string | null;
    invoices: Array<{
      id: string; invoice_no: string; status: string; due_on: string;
      total_paise: string; paid_paise: string; outstanding_paise: string;
    }>;
  }> {
    return withTenant(scope, async (db) => {
      const { rows } = await db.query<{
        id: string; invoice_no: string; status: string; due_on: string;
        total_paise: string; paid_paise: string; outstanding_paise: string;
      }>(
        `SELECT i.id, i.invoice_no, i.status, i.due_on::text AS due_on,
                (i.total * 100)::bigint::text AS total_paise,
                (i.amount_paid * 100)::bigint::text AS paid_paise,
                ((i.total - i.amount_paid) * 100)::bigint::text AS outstanding_paise
           FROM invoice i
           JOIN enrollment e ON e.id = i.enrollment_id
          WHERE e.student_id = $1::uuid AND i.status <> 'void'
          ORDER BY i.due_on DESC
          LIMIT 60`, [studentId]);

      // Summed here rather than in SQL so the total is provably the sum of the
      // rows on screen. A separate aggregate query can disagree with the list
      // it sits above — different policy evaluation, different LIMIT — and a
      // parent who adds up the invoices and gets a different number stops
      // trusting the number.
      const outstanding = rows.reduce((n, r) => n + BigInt(r.outstanding_paise), 0n);
      const unpaid = rows.filter((r) => BigInt(r.outstanding_paise) > 0n)
        .map((r) => r.due_on).sort();
      return {
        outstanding_paise: outstanding.toString(),
        next_due_on: unpaid[0] ?? null,
        invoices: rows,
      };
    });
  },

  /**
   * "How did they do?" — published runs only, and the policy is what enforces
   * that, not this query. See 0068.
   */
  async results(scope: TenantScope, studentId: string): Promise<Array<{
    result_run_id: string; term_label: string | null; published_at: string | null;
    lines: Array<{
      subject: string | null; percentage: string | null;
      grade_label: string | null; is_pass: boolean | null;
      not_graded_reason: string | null;
    }>;
  }>> {
    return withTenant(scope, async (db) => {
      const { rows } = await db.query<{
        result_run_id: string; term_label: string | null; published_at: string | null;
        subject: string | null; percentage: string | null; grade_label: string | null;
        is_pass: boolean | null; not_graded_reason: string | null;
      }>(
        `SELECT l.result_run_id, t.label AS term_label, r.published_at,
                sub.name AS subject, l.percentage::text, l.grade_label,
                l.is_pass, l.not_graded_reason
           FROM result_line l
           JOIN enrollment e ON e.id = l.enrollment_id
           -- Inner joins. A line whose run this family cannot read is a line
           -- that should not appear at all: 0068 makes the run readable exactly
           -- when the line is, so a row dropping out here means the two
           -- disagree, and showing a mark with no term is the worse failure.
           JOIN result_run r ON r.id = l.result_run_id
           LEFT JOIN term t ON t.id = r.term_id
           LEFT JOIN course_offering co ON co.id = l.course_offering_id
           LEFT JOIN subject sub ON sub.id = co.subject_id
          WHERE e.student_id = $1::uuid
          ORDER BY r.published_at DESC NULLS LAST, sub.name NULLS FIRST`,
        [studentId]);

      const runs = new Map<string, {
        result_run_id: string; term_label: string | null; published_at: string | null;
        lines: Array<{
          subject: string | null; percentage: string | null; grade_label: string | null;
          is_pass: boolean | null; not_graded_reason: string | null;
        }>;
      }>();
      for (const row of rows) {
        let run = runs.get(row.result_run_id);
        if (!run) {
          run = {
            result_run_id: row.result_run_id,
            term_label: row.term_label,
            published_at: row.published_at,
            lines: [],
          };
          runs.set(row.result_run_id, run);
        }
        run.lines.push({
          subject: row.subject, percentage: row.percentage,
          grade_label: row.grade_label, is_pass: row.is_pass,
          not_graded_reason: row.not_graded_reason,
        });
      }
      return [...runs.values()];
    });
  },

  /**
   * "What has the school told me?"
   *
   * What reached this person, and nothing about how. A parent has no use for a
   * suppression reason or a delivery receipt — those are the school's
   * operational record of a send, and showing a parent that a message was
   * withheld from them is a conversation the school should be having, not a row.
   */
  async messages(scope: TenantScope): Promise<Array<{
    id: string; channel: string; body: string | null; sent_at: string | null;
  }>> {
    return withTenant(scope, async (db) => {
      const { rows } = await db.query<{
        id: string; channel: string; body: string | null; sent_at: string | null;
      }>(
        `SELECT mr.id, mr.channel, mr.rendered_body AS body,
                mr.created_at AS sent_at
           FROM message_recipient mr
          WHERE mr.person_id = app_current_person_id()
            -- Both, not just 'sent'. A message that reached the phone has
            -- status 'delivered', so filtering on 'sent' alone would hide
            -- exactly the messages that arrived.
            AND mr.status IN ('sent', 'delivered')
          ORDER BY mr.created_at DESC
          LIMIT 100`);
      return rows;
    });
  },
};
