/**
 * HR (M27).
 *
 * Three things a school actually does with staff records: agree a contract,
 * take leave, and find somebody to stand in front of the class when they do.
 * The third is the one this milestone exists for.
 *
 * Deliberately NOT here: pay. M27 produces payroll *inputs* — days worked,
 * days of paid leave, days unpaid — and stops. Running payroll means statutory
 * deductions, PF, ESI and TDS, which is a compliance product rather than a
 * feature, and guessing at it would be worse than omitting it.
 */
import { withTenant, type TenantScope } from '../../db/tenant.ts';
import { ApiError } from '../../common/errors.ts';
import { auditService } from '../audit/audit.service.ts';

export interface Absence {
  id: string; staff_id: string; leave_type_id: string | null;
  starts_on: string; ends_on: string; half_day: boolean;
  status: string; reason: string | null;
}

export const hrService = {

  /**
   * The staff roster, with the two numbers a school actually asks about.
   *
   * Added with M32's controller rather than in M27, and that is the finding
   * rather than a detail: M27 shipped a schema, a service and twenty-eight
   * passing tests for a module with no way to list a single member of staff,
   * because nothing that needed a list existed. A service written entirely
   * against its own tests answers the questions the tests ask.
   */
  async roster(scope: TenantScope, opts: { on?: string | undefined } = {}): Promise<Array<{
    staff_id: string; employee_code: string; given_name: string;
    family_name: string | null; designation: string | null;
    joined_on: string; left_on: string | null; status: string;
    contract_kind: string | null; weekly_hours: string | null;
    entitlement_days: string | null; taken_days: string | null;
    away_today: boolean; pending_requests: number;
  }>> {
    const on = opts.on ?? new Date().toISOString().slice(0, 10);
    return withTenant(scope, async (db) => {
      const { rows } = await db.query<{
        staff_id: string; employee_code: string; given_name: string;
        family_name: string | null; designation: string | null;
        joined_on: string; left_on: string | null; status: string;
        contract_kind: string | null; weekly_hours: string | null;
        entitlement_days: string | null; taken_days: string | null;
        away_today: boolean; pending_requests: number;
      }>(
        `SELECT st.id AS staff_id, st.employee_code, p.given_name, p.family_name,
                st.designation, st.joined_on::text, st.left_on::text, st.status,
                ct.kind AS contract_kind, ct.weekly_hours::text,
                bal.opening::text  AS entitlement_days,
                bal.taken::text    AS taken_days,
                EXISTS (SELECT 1 FROM staff_absence a
                         WHERE a.staff_id = st.id AND a.status = 'approved'
                           AND $1::date BETWEEN a.starts_on AND a.ends_on) AS away_today,
                (SELECT count(*)::int FROM staff_absence a
                  WHERE a.staff_id = st.id AND a.status = 'requested')
                  AS pending_requests
           FROM staff st
           JOIN person p ON p.id = st.person_id
           -- The contract in force on the day asked about, not the newest row:
           -- a staff member whose next contract starts in April must not read
           -- as part-time in February because that row already exists.
           LEFT JOIN LATERAL (
             SELECT c.kind, c.weekly_hours FROM staff_contract c
              WHERE c.staff_id = st.id
                AND c.starts_on <= $1::date
                AND (c.ends_on IS NULL OR c.ends_on >= $1::date)
              ORDER BY c.starts_on DESC LIMIT 1) ct ON true
           LEFT JOIN LATERAL (
             SELECT b.opening, b.taken FROM leave_balance b
              WHERE b.staff_id = st.id
              ORDER BY b.year_label DESC LIMIT 1) bal ON true
          WHERE st.deleted_at IS NULL
          ORDER BY p.given_name, p.family_name`, [on]);
      return rows;
    });
  },

  /** Leave types, for the picker on the absence form. */
  async leaveTypes(scope: TenantScope): Promise<Array<{
    id: string; code: string; name: string; is_paid: boolean;
    annual_entitlement: string | null;
  }>> {
    return withTenant(scope, async (db) => {
      const { rows } = await db.query<{
        id: string; code: string; name: string; is_paid: boolean;
        annual_entitlement: string | null;
      }>(
        `SELECT id, code, name, is_paid, annual_entitlement::text
           FROM leave_type WHERE deleted_at IS NULL ORDER BY name`);
      return rows;
    });
  },

  /**
   * Absences in a window, whatever their status.
   *
   * `absentOn` answers "who is away today" and filters to approved, which is
   * right for assigning cover and wrong for the screen where somebody decides
   * the requests — that screen needs to see the ones nobody has decided yet.
   */
  async absences(scope: TenantScope, input: {
    from: string; to: string; status?: string | undefined;
  }): Promise<Array<{
    id: string; staff_id: string; given_name: string; family_name: string | null;
    leave_type: string | null; is_paid: boolean | null;
    starts_on: string; ends_on: string; half_day: boolean;
    status: string; reason: string | null; decision_note: string | null;
  }>> {
    return withTenant(scope, async (db) => {
      const { rows } = await db.query<{
        id: string; staff_id: string; given_name: string; family_name: string | null;
        leave_type: string | null; is_paid: boolean | null;
        starts_on: string; ends_on: string; half_day: boolean;
        status: string; reason: string | null; decision_note: string | null;
      }>(
        `SELECT a.id, a.staff_id, p.given_name, p.family_name,
                lt.name AS leave_type, lt.is_paid,
                a.starts_on::text, a.ends_on::text, a.half_day, a.status,
                a.reason, a.decision_note
           FROM staff_absence a
           JOIN staff st ON st.id = a.staff_id
           JOIN person p ON p.id = st.person_id
           LEFT JOIN leave_type lt ON lt.id = a.leave_type_id
          -- Overlap, not containment: a fortnight's leave that began last
          -- month is still leave this week, and a screen that misses it sends
          -- somebody looking for a teacher who is not in the building.
          WHERE a.starts_on <= $2::date AND a.ends_on >= $1::date
            AND ($3::text IS NULL OR a.status = $3)
          ORDER BY a.starts_on DESC, p.given_name`,
        [input.from, input.to, input.status ?? null]);
      return rows;
    });
  },

  /** Cover already assigned for a day, so a screen can show the gaps. */
  async coverOn(scope: TenantScope, on: string): Promise<Array<{
    id: string; section_id: string; section_name: string; class_name: string | null;
    covering_staff_id: string; covering_name: string;
    absent_staff_id: string | null; period_no: number | null;
  }>> {
    return withTenant(scope, async (db) => {
      const { rows } = await db.query<{
        id: string; section_id: string; section_name: string; class_name: string | null;
        covering_staff_id: string; covering_name: string;
        absent_staff_id: string | null; period_no: number | null;
      }>(
        `SELECT ca.id, ca.section_id, s.name AS section_name, cg.name AS class_name,
                ca.covering_staff_id,
                p.given_name || COALESCE(' ' || p.family_name, '') AS covering_name,
                ca.absent_staff_id, ca.period_no
           FROM cover_assignment ca
           JOIN section s ON s.id = ca.section_id
           LEFT JOIN class_group cg ON cg.id = s.class_group_id
           JOIN staff st ON st.id = ca.covering_staff_id
           JOIN person p ON p.id = st.person_id
          WHERE ca.on_date = $1::date
          ORDER BY cg.name, s.name`, [on]);
      return rows;
    });
  },
  /**
   * Files an absence.
   *
   * A request, or a record of one nobody requested — somebody sick on the
   * morning is an absence before it is a form. The status decides which, and
   * only the office may file one that is already approved.
   */
  async fileAbsence(scope: TenantScope, input: {
    staffId: string; leaveTypeId?: string | undefined;
    startsOn: string; endsOn: string; halfDay?: boolean | undefined;
    reason?: string | undefined;
  }): Promise<Absence> {
    if (input.endsOn < input.startsOn) {
      throw ApiError.make('validation_error', 'dates_reversed',
        'The absence ends before it starts.');
    }
    const absence = await withTenant(scope, async (db) => {
      const { rows } = await db.query<Absence>(
        `INSERT INTO staff_absence
           (tenant_id, staff_id, leave_type_id, starts_on, ends_on, half_day,
            reason)
         VALUES (app_current_tenant_id(), $1, $2, $3::date, $4::date, $5, $6)
         RETURNING id, staff_id, leave_type_id, starts_on::text, ends_on::text,
                   half_day, status, reason`,
        [input.staffId, input.leaveTypeId ?? null, input.startsOn, input.endsOn,
         input.halfDay ?? false, input.reason ?? null]);
      return rows[0]!;
    });

    await auditService.record({
      tenantId: scope.tenantId, actorUserId: scope.actorId,
      action: 'hr.absence_filed', resourceType: 'staff_absence',
      resourceId: absence.id, classification: 'SENSITIVE',
      after: { staff_id: input.staffId, starts_on: input.startsOn,
               ends_on: input.endsOn },
    });
    return absence;
  },

  /**
   * Decides a request, and moves the balance.
   *
   * The balance is updated in the same transaction as the decision. Two
   * statements that can succeed separately are two numbers that eventually
   * disagree, and the one somebody trusts is whichever screen they opened.
   */
  async decideAbsence(scope: TenantScope, input: {
    absenceId: string; approve: boolean; note?: string | undefined;
  }): Promise<void> {
    if (!input.approve && (input.note ?? '').trim().length < 5) {
      throw ApiError.make('validation_error', 'refusal_needs_note',
        'Say why it was refused. A refusal with no reason is a conversation '
        + 'somebody has to have in person.');
    }

    const decided = await withTenant(scope, async (db) => {
      const { rows } = await db.query<{
        staff_id: string; leave_type_id: string | null;
        starts_on: string; ends_on: string; half_day: boolean;
      }>(
        `UPDATE staff_absence
            SET status = $2, decided_at = now(), decided_by = $3,
                decision_note = $4
          WHERE id = $1 AND status = 'requested'
          RETURNING staff_id, leave_type_id, starts_on::text, ends_on::text,
                    half_day`,
        [input.absenceId, input.approve ? 'approved' : 'refused',
         scope.actorId ?? null, input.note ?? null]);
      const row = rows[0];
      if (!row) {
        throw ApiError.make('conflict', 'not_awaiting_decision',
          'That request is not waiting for a decision.');
      }

      if (input.approve && row.leave_type_id) {
        const days = countDays(row.starts_on, row.ends_on, row.half_day);
        // ON CONFLICT so a staff member with no balance row for this year gets
        // one. A missing row is the ordinary case for a mid-year joiner, and
        // refusing their leave over a bookkeeping gap is the wrong answer.
        await db.query(
          `INSERT INTO leave_balance
             (tenant_id, staff_id, leave_type_id, year_label, opening, taken)
           VALUES (app_current_tenant_id(), $1, $2, $3, 0, $4)
           ON CONFLICT (tenant_id, staff_id, leave_type_id, year_label)
             DO UPDATE SET taken = leave_balance.taken + $4,
                           updated_at = now()`,
          [row.staff_id, row.leave_type_id, academicYearLabel(row.starts_on),
           days]);
      }
      return row;
    });

    await auditService.record({
      tenantId: scope.tenantId, actorUserId: scope.actorId,
      action: input.approve ? 'hr.absence_approved' : 'hr.absence_refused',
      resourceType: 'staff_absence', resourceId: input.absenceId,
      classification: 'SENSITIVE',
      ...(input.note ? { reason: input.note } : {}),
      after: { staff_id: decided.staff_id },
    });
  },

  /** Who is away on a given day. The question cover is assigned from. */
  async absentOn(scope: TenantScope, on: string): Promise<Array<{
    staff_id: string; given_name: string; family_name: string | null;
    leave_type: string | null; half_day: boolean;
  }>> {
    return withTenant(scope, async (db) => {
      const { rows } = await db.query<{
        staff_id: string; given_name: string; family_name: string | null;
        leave_type: string | null; half_day: boolean;
      }>(
        `SELECT a.staff_id, p.given_name, p.family_name,
                lt.name AS leave_type, a.half_day
           FROM staff_absence a
           JOIN staff st ON st.id = a.staff_id
           JOIN person p ON p.id = st.person_id
           LEFT JOIN leave_type lt ON lt.id = a.leave_type_id
          WHERE a.status = 'approved'
            AND $1::date BETWEEN a.starts_on AND a.ends_on
          ORDER BY p.given_name`, [on]);
      return rows;
    });
  },

  /**
   * Assigns cover for one section, on one day.
   *
   * This is the write that widens somebody's reach, so it refuses the two
   * shapes that would make it a quiet permission change: cover for a day that
   * has already passed, and cover for somebody who is not actually away.
   *
   * The second is a warning rather than a refusal when no absence is named —
   * a vacancy between appointments is real cover with nobody away — but a
   * NAMED absence that does not cover the date is a mistake, and assigning
   * access off the back of it is exactly the audit trail that looks fine.
   */
  async assignCover(scope: TenantScope, input: {
    sectionId: string; coveringStaffId: string; onDate: string;
    absentStaffId?: string | undefined; staffAbsenceId?: string | undefined;
    periodNo?: number | undefined; note?: string | undefined;
  }): Promise<{ id: string }> {
    const today = new Date().toISOString().slice(0, 10);
    if (input.onDate < today) {
      // Backdating cover is backdating access. Whatever the honest reason,
      // the register for a past day is corrected through the attendance
      // correction path, which is attributed and reviewable.
      throw ApiError.make('validation_error', 'cover_in_the_past',
        'Cover cannot be assigned for a day that has gone. A register for a '
        + 'past day is corrected, not re-marked.');
    }

    const created = await withTenant(scope, async (db) => {
      if (input.staffAbsenceId) {
        const { rows } = await db.query<{ ok: boolean }>(
          `SELECT ($2::date BETWEEN starts_on AND ends_on)
                  AND status = 'approved' AS ok
             FROM staff_absence WHERE id = $1`,
          [input.staffAbsenceId, input.onDate]);
        if (!rows[0]) {
          throw ApiError.make('not_found', 'absence_not_found',
            'No such absence.');
        }
        if (!rows[0].ok) {
          throw ApiError.make('validation_error', 'absence_does_not_cover_day',
            'That absence is not approved for that day, so cover against it '
            + 'would be access granted for a reason that is not true.');
        }
      }

      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO cover_assignment
           (tenant_id, section_id, covering_staff_id, absent_staff_id,
            staff_absence_id, on_date, period_no, assigned_by, note)
         VALUES (app_current_tenant_id(), $1, $2, $3, $4, $5::date, $6, $7, $8)
         RETURNING id`,
        [input.sectionId, input.coveringStaffId, input.absentStaffId ?? null,
         input.staffAbsenceId ?? null, input.onDate, input.periodNo ?? null,
         scope.actorId ?? null, input.note ?? null]);
      return rows[0]!;
    });

    // RESTRICTED, not SENSITIVE. This is a record of somebody's reach being
    // widened, and it belongs in the same class as a platform entry.
    await auditService.record({
      tenantId: scope.tenantId, actorUserId: scope.actorId,
      action: 'hr.cover_assigned', resourceType: 'cover_assignment',
      resourceId: created.id, classification: 'RESTRICTED',
      after: { section_id: input.sectionId,
               covering_staff_id: input.coveringStaffId,
               on_date: input.onDate, period_no: input.periodNo ?? null },
    });
    return created;
  },

  /** What a covering teacher is standing in front of today. */
  async myCoverToday(scope: TenantScope): Promise<Array<{
    section_id: string; section_name: string; class_name: string | null;
    period_no: number | null;
  }>> {
    return withTenant(scope, async (db) => {
      const { rows } = await db.query<{
        section_id: string; section_name: string; class_name: string | null;
        period_no: number | null;
      }>(
        `SELECT ca.section_id, s.name AS section_name, cg.name AS class_name,
                ca.period_no
           FROM cover_assignment ca
           JOIN section s ON s.id = ca.section_id
           LEFT JOIN class_group cg ON cg.id = s.class_group_id
          WHERE ca.covering_staff_id = app_current_staff_id()
            AND ca.on_date = CURRENT_DATE
          ORDER BY ca.period_no NULLS FIRST`);
      return rows;
    });
  },

  /**
   * Payroll INPUTS for a month. Not payroll.
   *
   * Three numbers per member of staff: days in the period they were employed,
   * days of paid leave, days unpaid. What a payroll system does with those is
   * a compliance surface of its own, and producing a net figure here would
   * make this system responsible for statutory deductions it does not model.
   *
   * Unpaid days are counted explicitly rather than derived by subtraction,
   * because "employed minus paid leave" silently absorbs any absence whose
   * leave type was deleted.
   */
  async payrollInputs(scope: TenantScope, input: {
    from: string; to: string;
  }): Promise<Array<{
    staff_id: string; employee_code: string; given_name: string;
    family_name: string | null; employed_days: number;
    paid_leave_days: number; unpaid_leave_days: number;
  }>> {
    return withTenant(scope, async (db) => {
      const { rows } = await db.query<{
        staff_id: string; employee_code: string; given_name: string;
        family_name: string | null; employed_days: number;
        paid_leave_days: number; unpaid_leave_days: number;
      }>(
        `WITH win AS (SELECT $1::date AS from_on, $2::date AS to_on),
        employed AS (
          SELECT st.id AS staff_id, st.employee_code, p.given_name, p.family_name,
                 GREATEST(0,
                   (LEAST(w.to_on, COALESCE(st.left_on, w.to_on))
                    - GREATEST(w.from_on, st.joined_on)) + 1) AS employed_days
            FROM staff st
            JOIN person p ON p.id = st.person_id
            CROSS JOIN win w
           WHERE st.deleted_at IS NULL
             AND st.joined_on <= w.to_on
             AND (st.left_on IS NULL OR st.left_on >= w.from_on)),
        leave AS (
          SELECT a.staff_id,
                 -- Overlap with the window, not the absence's own length: a
                 -- fortnight straddling a month end belongs to two payrolls.
                 SUM(CASE WHEN COALESCE(lt.is_paid, false)
                          THEN days_in_window(a.starts_on, a.ends_on,
                                              w.from_on, w.to_on, a.half_day)
                          ELSE 0 END) AS paid_days,
                 SUM(CASE WHEN COALESCE(lt.is_paid, false) THEN 0
                          ELSE days_in_window(a.starts_on, a.ends_on,
                                              w.from_on, w.to_on, a.half_day)
                     END) AS unpaid_days
            FROM staff_absence a
            LEFT JOIN leave_type lt ON lt.id = a.leave_type_id
            CROSS JOIN win w
           WHERE a.status = 'approved'
             AND a.starts_on <= w.to_on AND a.ends_on >= w.from_on
           GROUP BY a.staff_id)
        SELECT e.staff_id, e.employee_code, e.given_name, e.family_name,
               e.employed_days::int,
               COALESCE(l.paid_days, 0)::float AS paid_leave_days,
               COALESCE(l.unpaid_days, 0)::float AS unpaid_leave_days
          FROM employed e LEFT JOIN leave l ON l.staff_id = e.staff_id
         ORDER BY e.employee_code`,
        [input.from, input.to]);
      return rows;
    });
  },
};

/** Inclusive day count, with a half day counting as a half. */
function countDays(startsOn: string, endsOn: string, halfDay: boolean): number {
  if (halfDay) return 0.5;
  const start = Date.parse(`${startsOn}T00:00:00Z`);
  const end = Date.parse(`${endsOn}T00:00:00Z`);
  return Math.round((end - start) / 86_400_000) + 1;
}

/**
 * The Indian academic year a date falls in, as "2026-27".
 *
 * April to March, like the financial year — schools here run on the same
 * calendar, and a leave balance that reset in January would reset in the
 * middle of a term.
 */
function academicYearLabel(date: string): string {
  const [year, month] = date.split('-').map(Number) as [number, number];
  const startYear = month >= 4 ? year : year - 1;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}
