/**
 * Transport (M20).
 *
 * The services are thin because the rules that matter are in the policies: who
 * may see a manifest is a row-level decision, not a `WHERE` clause somebody
 * remembers to write. What lives here is the sequencing a transport office
 * actually needs — moving a child to a different stop without losing where
 * they used to be, swapping a bus mid-term, and recording a boarding from a
 * device that had no signal at the time.
 */
import { withTenant, type TenantScope } from '../../db/tenant.ts';
import { ApiError } from '../../common/errors.ts';
import { auditService } from '../audit/audit.service.ts';

export type Direction = 'pickup' | 'drop' | 'both';
export type BoardingKind = 'boarded' | 'alighted' | 'absent' | 'no_show';

export interface ManifestRow {
  student_id: string;
  admission_no: string;
  given_name: string;
  family_name: string | null;
  stop_id: string;
  stop_name: string;
  sequence_no: number;
  pickup_time: string | null;
  drop_time: string | null;
  guardian_phone: string | null;
  boarded_today: BoardingKind | null;
}

export const transportService = {
  /**
   * The routes this caller may see.
   *
   * No `WHERE` on the driver: a driver sees their own routes because the policy
   * on `route` says so, and the transport office sees all of them for the same
   * reason. Writing the filter here as well would mean two places to be wrong
   * and only one of them tested.
   */
  async routes(scope: TenantScope): Promise<Array<{
    id: string; code: string; name: string; direction: string; status: string;
    campus_id: string; stop_count: number; child_count: number;
    vehicle_registration: string | null; driver_name: string | null;
  }>> {
    return withTenant(scope, async (db) => {
      const { rows } = await db.query<{
        id: string; code: string; name: string; direction: string; status: string;
        campus_id: string; stop_count: number; child_count: number;
        vehicle_registration: string | null; driver_name: string | null;
      }>(
        `SELECT r.id, r.code, r.name, r.direction, r.status, r.campus_id,
                (SELECT count(*)::int FROM route_stop rs
                  WHERE rs.route_id = r.id AND rs.deleted_at IS NULL)
                  AS stop_count,
                (SELECT count(*)::int FROM transport_enrolment te
                  WHERE te.route_id = r.id AND te.effective_to IS NULL)
                  AS child_count,
                v.registration AS vehicle_registration,
                p.given_name || COALESCE(' ' || p.family_name, '') AS driver_name
           FROM route r
           LEFT JOIN route_assignment ra ON ra.route_id = r.id
                AND ra.effective_from <= CURRENT_DATE
                AND (ra.effective_to IS NULL OR ra.effective_to >= CURRENT_DATE)
           LEFT JOIN vehicle v ON v.id = ra.vehicle_id
           LEFT JOIN driver d ON d.id = ra.driver_id
           LEFT JOIN person p ON p.id = d.person_id
          WHERE r.deleted_at IS NULL AND r.status <> 'retired'
          ORDER BY r.code`);
      return rows;
    });
  },

  /**
   * The list a driver carries.
   *
   * One call to `app_route_manifest`, which is a document rather than a query:
   * it checks the caller's authority once and returns the fields a run needs.
   * Assembling this from the learner tables here — as the first version did —
   * required the driver to hold a read over `student`, `person` and
   * `contact_method`, which is a far larger grant than "the children on your
   * bus" and one that row-level security cannot narrow, because it grants rows
   * and the problem is columns. See 0067.
   */
  async manifest(scope: TenantScope, input: {
    routeId: string; direction: 'pickup' | 'drop'; on?: string | undefined;
  }): Promise<ManifestRow[]> {
    try {
      return await withTenant(scope, async (db) => {
        const { rows } = await db.query<ManifestRow>(
          'SELECT * FROM app_route_manifest($1, $2, $3::date)',
          [input.routeId, input.direction, input.on ?? null]);
        return rows;
      });
    } catch (e) {
      // 42501 is the function refusing at the door, and it is deliberately a
      // refusal rather than an empty list: a driver who is handed [] cannot
      // tell "you are not on this route today" from "nobody is booked", and
      // the second of those is a reason to drive off.
      if ((e as { code?: string }).code === '42501') {
        throw ApiError.make('permission_error', 'not_this_route',
          'You are not running this route today, so its list is not yours to '
          + 'open. If the roster is wrong, the transport office can fix it.');
      }
      throw e;
    }
  },

  /**
   * Puts a child on a route, ending any previous arrangement in that direction.
   *
   * Ended rather than replaced: "which bus was my child on last Tuesday" has to
   * stay answerable after the office moves them, and an UPDATE would erase the
   * only record of where they used to get off.
   */
  async assignChild(scope: TenantScope, input: {
    studentId: string; routeId: string; stopId: string; direction: Direction;
    from?: string | undefined;
  }): Promise<void> {
    await withTenant(scope, async (db) => {
      const { rows: stop } = await db.query<{ route_id: string }>(
        'SELECT route_id FROM route_stop WHERE id = $1 AND deleted_at IS NULL',
        [input.stopId]);
      if (!stop[0]) {
        throw ApiError.make('not_found', 'stop_not_found', 'No such stop.');
      }
      if (stop[0].route_id !== input.routeId) {
        // The failure this prevents is a child assigned to a stop the bus never
        // reaches, which looks correct on every screen until the afternoon.
        throw ApiError.make('validation_error', 'stop_not_on_route',
          'That stop is not on that route.');
      }

      const directions: Direction[] = input.direction === 'both'
        ? ['pickup', 'drop', 'both'] : [input.direction, 'both'];

      // A correction and a move are different things, and the difference is
      // whether the arrangement being replaced ever carried a journey.
      //
      // Closing a row the day before it starts would produce a negative-length
      // arrangement — which the CHECK constraint refuses, and rightly: a row
      // saying a child rode a bus from Tuesday to Monday is not history, it is
      // a corrupted record. So an open arrangement that has not begun yet is
      // amended in place; one that has been carrying the child is closed and a
      // new row opened after it.
      const on = input.from ?? null;
      const { rowCount: amended } = await db.query(
        `UPDATE transport_enrolment
            SET route_id = $2, stop_id = $3, direction = $4
          WHERE student_id = $1 AND effective_to IS NULL
            AND direction = ANY($5)
            AND effective_from >= COALESCE($6::date, CURRENT_DATE)`,
        [input.studentId, input.routeId, input.stopId, input.direction,
         directions, on]);

      if (amended === 0) {
        await db.query(
          `UPDATE transport_enrolment
              SET effective_to = COALESCE($3::date, CURRENT_DATE) - 1
            WHERE student_id = $1 AND effective_to IS NULL
              AND direction = ANY($2)`,
          [input.studentId, directions, on]);

        await db.query(
          `INSERT INTO transport_enrolment
             (tenant_id, student_id, route_id, stop_id, direction, effective_from)
           VALUES (app_current_tenant_id(), $1, $2, $3, $4,
                   COALESCE($5::date, CURRENT_DATE))`,
          [input.studentId, input.routeId, input.stopId, input.direction, on]);
      }
    });

    await auditService.record({
      tenantId: scope.tenantId, actorUserId: scope.actorId,
      action: 'transport.child_assigned', resourceType: 'transport_enrolment',
      resourceId: input.studentId, classification: 'SENSITIVE',
      after: { route_id: input.routeId, stop_id: input.stopId,
               direction: input.direction },
    });
  },

  /**
   * Records boarding, idempotently.
   *
   * Same contract as classroom attendance: the client event id is minted on the
   * device before any network call and never regenerated, so a bus that comes
   * back into signal and retries replays rather than double-marking a child.
   */
  async recordBoarding(scope: TenantScope, events: Array<{
    clientEventId: string; studentId: string; routeId: string;
    stopId?: string | undefined; vehicleId?: string | undefined;
    direction: 'pickup' | 'drop'; kind: BoardingKind;
    onDate?: string | undefined; deviceRecordedAt?: string | undefined;
  }>): Promise<{ recorded: number; replayed: number }> {
    return withTenant(scope, async (db) => {
      let recorded = 0;
      let replayed = 0;
      for (const event of events) {
        const { rowCount } = await db.query(
          `INSERT INTO boarding_event
             (tenant_id, student_id, route_id, stop_id, vehicle_id, on_date,
              direction, kind, client_event_id, device_recorded_at, recorded_by)
           VALUES (app_current_tenant_id(), $1, $2, $3, $4,
                   COALESCE($5::date, CURRENT_DATE), $6, $7, $8, $9, $10)
           ON CONFLICT (tenant_id, client_event_id) DO NOTHING`,
          [event.studentId, event.routeId, event.stopId ?? null,
           event.vehicleId ?? null, event.onDate ?? null, event.direction,
           event.kind, event.clientEventId, event.deviceRecordedAt ?? null,
           scope.actorId ?? null]);
        if (rowCount === 1) recorded += 1; else replayed += 1;
      }
      return { recorded, replayed };
    });
  },

  /** What a guardian sees: their own child's bus, today. */
  async forChild(scope: TenantScope, studentId: string): Promise<{
    route_code: string; route_name: string; stop_name: string;
    pickup_time: string | null; drop_time: string | null;
    vehicle_registration: string | null; direction: string;
  } | null> {
    return withTenant(scope, async (db) => {
      const { rows } = await db.query<{
        route_code: string; route_name: string; stop_name: string;
        pickup_time: string | null; drop_time: string | null;
        vehicle_registration: string | null; direction: string;
      }>(
        `SELECT r.code AS route_code, r.name AS route_name, rs.name AS stop_name,
                rs.pickup_time::text, rs.drop_time::text,
                v.registration AS vehicle_registration, te.direction
           FROM transport_enrolment te
           JOIN route r ON r.id = te.route_id
           JOIN route_stop rs ON rs.id = te.stop_id
           LEFT JOIN route_assignment ra ON ra.route_id = r.id
                AND ra.effective_to IS NULL
           LEFT JOIN vehicle v ON v.id = ra.vehicle_id
          WHERE te.student_id = $1 AND te.effective_to IS NULL
          ORDER BY te.direction
          LIMIT 1`, [studentId]);
      return rows[0] ?? null;
    });
  },

  /**
   * Papers that expire, and how soon.
   *
   * A bus with lapsed fitness is not a data-quality problem, it is a bus that
   * should not be carrying children — so this is a first-class screen rather
   * than a column somebody notices.
   *
   * Every date crosses as text. A `date` handed to the driver as a JavaScript
   * Date is midnight UTC, which in IST is the evening before — so a fitness
   * certificate expiring on the 16th renders to a school as the 15th. The
   * column is a calendar day and has no business becoming an instant.
   */
  async complianceDue(scope: TenantScope, withinDays = 45): Promise<Array<{
    kind: string; subject: string; expires_on: string; days_left: number;
  }>> {
    return withTenant(scope, async (db) => {
      const { rows } = await db.query<{
        kind: string; subject: string; expires_on: string; days_left: number;
      }>(
        `SELECT * FROM (
           SELECT 'vehicle_fitness' AS kind, v.registration AS subject,
                  v.fitness_expires_on::text AS expires_on,
                  (v.fitness_expires_on - CURRENT_DATE) AS days_left
             FROM vehicle v
            WHERE v.deleted_at IS NULL AND v.status <> 'retired'
              AND v.fitness_expires_on IS NOT NULL
           UNION ALL
           SELECT 'vehicle_insurance', v.registration, v.insurance_expires_on::text,
                  (v.insurance_expires_on - CURRENT_DATE)
             FROM vehicle v
            WHERE v.deleted_at IS NULL AND v.status <> 'retired'
              AND v.insurance_expires_on IS NOT NULL
           UNION ALL
           SELECT 'vehicle_permit', v.registration, v.permit_expires_on::text,
                  (v.permit_expires_on - CURRENT_DATE)
             FROM vehicle v
            WHERE v.deleted_at IS NULL AND v.status <> 'retired'
              AND v.permit_expires_on IS NOT NULL
           UNION ALL
           SELECT 'driver_licence', p.given_name || ' ' || COALESCE(p.family_name, ''),
                  d.licence_expires_on::text, (d.licence_expires_on - CURRENT_DATE)
             FROM driver d JOIN person p ON p.id = d.person_id
            WHERE d.deleted_at IS NULL AND d.status = 'active'
              AND d.licence_expires_on IS NOT NULL
         ) due
         -- Already expired included, and first: those are the urgent ones and
         -- a report that only warns about the future is no use on the day.
         WHERE days_left <= $1
         ORDER BY days_left`, [withinDays]);
      return rows;
    });
  },
};
