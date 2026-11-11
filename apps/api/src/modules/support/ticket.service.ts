/**
 * M9.8 — support tickets.
 *
 * The lifecycle is small and the interesting parts are all about honesty:
 *
 *   **The SLA clock is stamped at creation, not computed on read.** If it were
 *   computed, changing the SLA table next term would silently rewrite whether
 *   last term's tickets were met — and a support promise you can retroactively
 *   redefine is not a promise.
 *
 *   **First response is the first STAFF reply that the requester can see.** Not
 *   the first message on the thread, which is the requester's own; not an
 *   internal note, which they never see. A system that stops the clock on a note
 *   nobody read is measuring the wrong thing on purpose.
 *
 *   **Reopening is a transition, not a new ticket.** A parent who replies to a
 *   resolved ticket has not raised a second issue, and splitting it would lose
 *   the history that makes the second reply make sense.
 */
import { withTenant, type TenantScope } from '../../db/tenant.ts';
import { ApiError } from '../../common/errors.ts';
import { auditService } from '../audit/audit.service.ts';
import { outboxService } from '../events/outbox.service.ts';

export type Priority = 'low' | 'normal' | 'high' | 'urgent';
export type Status = 'open' | 'waiting_on_requester' | 'resolved' | 'closed';

/**
 * Hours to first response and to resolution, by priority.
 *
 * Working hours are not modelled, deliberately: a school office closes at 4pm
 * and an "urgent" ticket raised at 3.55pm is not answered in five minutes.
 * Pretending otherwise would put every evening ticket in breach by morning and
 * teach everyone to ignore the breach list — which is the failure mode that
 * makes an SLA worthless. Wall-clock hours, generously set, and a breach means
 * something.
 */
const SLA_HOURS: Record<Priority, { response: number; resolution: number }> = {
  urgent: { response: 4, resolution: 24 },
  high: { response: 8, resolution: 48 },
  normal: { response: 24, resolution: 120 },
  low: { response: 72, resolution: 336 },
};

/**
 * Which transitions are legal.
 *
 * `closed` has no outgoing edges: a closed ticket stays closed, and a parent
 * with a new problem raises a new ticket. An empty array is a real state, not
 * an oversight — the mandate lifecycle in billing learnt the same lesson.
 */
const TRANSITIONS: Record<Status, Status[]> = {
  open: ['waiting_on_requester', 'resolved', 'closed'],
  waiting_on_requester: ['open', 'resolved', 'closed'],
  resolved: ['open', 'closed'],
  closed: [],
};

export interface Ticket {
  id: string; reference: string; subject: string; category: string;
  priority: Priority; status: Status;
  raised_by_person_id: string; assigned_to_staff_id: string | null;
  first_response_due_at: string; resolution_due_at: string;
  first_responded_at: string | null; resolved_at: string | null;
  closed_at: string | null; created_at: string;
}

export interface ThreadItem {
  id: string; kind: 'message' | 'event';
  body: string; is_internal: boolean;
  author_person_id: string | null;
  /** Resolved here so the client is not left rendering a uuid as initials. */
  author_name: string | null;
  at: string;
}

const SELECT_TICKET = `
  id, reference, subject, category, priority, status,
  raised_by_person_id, assigned_to_staff_id,
  first_response_due_at, resolution_due_at, first_responded_at,
  resolved_at, closed_at, created_at`;

export const ticketService = {
  /**
   * Raises a ticket, with its first message in the same transaction.
   *
   * One commit, because a ticket with no body is a row somebody has to chase,
   * and the window where it exists is exactly as long as the next statement
   * takes to fail.
   */
  async raise(
    scope: TenantScope,
    input: {
      subject: string; body: string; category: string;
      priority?: Priority | undefined; raisedByPersonId?: string | undefined;
    },
  ): Promise<Ticket> {
    const priority = input.priority ?? 'normal';
    const sla = SLA_HOURS[priority];

    return withTenant(scope, async (db) => {
      // The requester is the signed-in person unless staff raise it on someone
      // else's behalf — which happens constantly at a front desk, where a parent
      // phones and an administrator types.
      const { rows: who } = await db.query<{ person_id: string | null }>(
        'SELECT app_current_person_id() AS person_id');
      const requester = input.raisedByPersonId ?? who[0]?.person_id;
      if (!requester) {
        throw ApiError.make('validation_error', 'ticket_needs_a_requester',
          'This account is not linked to a person, so it cannot raise a ticket. ' +
          'Raise it on behalf of someone instead.');
      }

      const { rows: ref } = await db.query<{ next_ticket_reference: string }>(
        'SELECT next_ticket_reference()');

      const { rows } = await db.query<Ticket>(
        `INSERT INTO support_ticket
           (tenant_id, reference, raised_by_person_id, subject, category, priority,
            first_response_due_at, resolution_due_at)
         VALUES (app_current_tenant_id(), $1, $2, $3, $4, $5,
                 now() + make_interval(hours => $6),
                 now() + make_interval(hours => $7))
         RETURNING ${SELECT_TICKET}`,
        [ref[0]!.next_ticket_reference, requester, input.subject.trim(),
         input.category, priority, sla.response, sla.resolution]);
      const ticket = rows[0]!;

      await db.query(
        `INSERT INTO ticket_message (tenant_id, ticket_id, author_person_id, body)
         VALUES (app_current_tenant_id(), $1, $2, $3)`,
        [ticket.id, requester, input.body.trim()]);

      await db.query(
        `INSERT INTO ticket_event (tenant_id, ticket_id, actor_person_id, kind, detail)
         VALUES (app_current_tenant_id(), $1, $2, 'created', $3::jsonb)`,
        [ticket.id, requester, JSON.stringify({ priority, category: input.category })]);

      // In the same commit as the ticket, so a webhook can never describe a
      // ticket that was rolled back.
      await outboxService.emit(db, {
        eventType: 'support.ticket.raised',
        aggregateType: 'support_ticket',
        aggregateId: ticket.id,
        payload: { reference: ticket.reference, category: input.category, priority },
      });

      await auditService.record({
        tenantId: scope.tenantId, action: 'support_ticket.raised',
        resourceType: 'support_ticket', resourceId: ticket.id,
        after: { reference: ticket.reference, category: input.category },
      });

      return ticket;
    });
  },

  async list(
    scope: TenantScope,
    filter: { status?: Status | undefined; mine?: boolean | undefined;
              limit?: number | undefined } = {},
  ): Promise<Ticket[]> {
    return withTenant(scope, async (db) => {
      // No tenant or requester clause here. A guardian gets their own tickets
      // because the POLICY says so, which means this same query is correct for
      // every role — and a role added later cannot be forgotten in a WHERE.
      const { rows } = await db.query<Ticket>(
        `SELECT ${SELECT_TICKET}
           FROM support_ticket
          WHERE ($1::text IS NULL OR status = $1)
            AND ($2::boolean IS NOT TRUE
                 OR raised_by_person_id = app_current_person_id())
          ORDER BY
            -- Breached first, then oldest. A queue sorted only by date buries
            -- the urgent ticket raised this morning under last week's backlog.
            (first_responded_at IS NULL AND first_response_due_at < now()) DESC,
            created_at
          LIMIT $3`,
        [filter.status ?? null, filter.mine ?? null, filter.limit ?? 100]);
      return rows;
    });
  },

  async get(scope: TenantScope, ticketId: string): Promise<Ticket> {
    return withTenant(scope, async (db) => {
      const { rows } = await db.query<Ticket>(
        `SELECT ${SELECT_TICKET} FROM support_ticket WHERE id = $1`, [ticketId]);
      if (!rows[0]) {
        // Not found rather than forbidden. The policy already filtered it, and
        // distinguishing the two would confirm to a guardian that a ticket
        // exists which they are not allowed to read.
        throw ApiError.make('not_found', 'ticket_not_found', 'No such ticket.');
      }
      return rows[0];
    });
  },

  /** The conversation and the system events, merged in time order. */
  async thread(scope: TenantScope, ticketId: string): Promise<ThreadItem[]> {
    return withTenant(scope, async (db) => {
      // The person's name is joined here rather than fetched per row by the
      // client. `person` has its own policy, so a name the caller may not see
      // comes back null and the screen shows the fallback — which is the right
      // failure, and one a second round trip could not get right.
      const { rows } = await db.query<ThreadItem>(
        `SELECT m.id, 'message' AS kind, m.body, m.is_internal,
                m.author_person_id,
                btrim(coalesce(p.given_name, '') || ' ' || coalesce(p.family_name, ''))
                  AS author_name,
                m.created_at AS at
           FROM ticket_message m
           LEFT JOIN person p ON p.id = m.author_person_id
          WHERE m.ticket_id = $1
         UNION ALL
         SELECT e.id, 'event' AS kind, e.kind::text AS body, false AS is_internal,
                e.actor_person_id AS author_person_id,
                btrim(coalesce(p.given_name, '') || ' ' || coalesce(p.family_name, ''))
                  AS author_name,
                e.occurred_at AS at
           FROM ticket_event e
           LEFT JOIN person p ON p.id = e.actor_person_id
          WHERE e.ticket_id = $1
          ORDER BY at`,
        [ticketId]);
      return rows;
    });
  },

  /**
   * Adds a reply.
   *
   * Stops the first-response clock only when a staff member writes something the
   * requester can actually see, and reopens a resolved ticket when the requester
   * writes — both of which are the behaviour a person would expect and neither
   * of which happens unless it is written down.
   */
  async reply(
    scope: TenantScope,
    input: { ticketId: string; body: string; internal?: boolean | undefined },
  ): Promise<void> {
    await withTenant(scope, async (db) => {
      const { rows: ctx } = await db.query<{
        person_id: string | null; is_staff: boolean;
      }>('SELECT app_current_person_id() AS person_id, app_actor_has_staff_scope() AS is_staff');
      const me = ctx[0]!;
      if (!me.person_id) {
        throw ApiError.make('validation_error', 'no_person_for_actor',
          'This account is not linked to a person and cannot post to a ticket.');
      }

      const { rows: found } = await db.query<{
        status: Status; first_responded_at: string | null; raised_by_person_id: string;
      }>(`SELECT status, first_responded_at, raised_by_person_id
            FROM support_ticket WHERE id = $1`, [input.ticketId]);
      const ticket = found[0];
      if (!ticket) throw ApiError.make('not_found', 'ticket_not_found', 'No such ticket.');
      if (ticket.status === 'closed') {
        throw ApiError.make('conflict', 'ticket_closed',
          'This ticket is closed. Raise a new one and reference this number.');
      }

      const internal = input.internal === true;
      if (internal && !me.is_staff) {
        throw ApiError.make('permission_error', 'internal_note_requires_staff',
          'Only staff can add an internal note.');
      }

      await db.query(
        `INSERT INTO ticket_message
           (tenant_id, ticket_id, author_person_id, body, is_internal)
         VALUES (app_current_tenant_id(), $1, $2, $3, $4)`,
        [input.ticketId, me.person_id, input.body.trim(), internal]);

      // A visible staff reply stops the clock. An internal note does not — it is
      // not a response to anyone.
      const stopsTheClock = me.is_staff && !internal && ticket.first_responded_at === null;
      if (stopsTheClock) {
        await db.query(
          `UPDATE support_ticket SET first_responded_at = now() WHERE id = $1`,
          [input.ticketId]);
        await db.query(
          `INSERT INTO ticket_event (tenant_id, ticket_id, actor_person_id, kind)
           VALUES (app_current_tenant_id(), $1, $2, 'first_response')`,
          [input.ticketId, me.person_id]);
      }

      // The requester replying to a resolved ticket reopens it. Leaving it
      // resolved means the reply lands in a queue nobody looks at.
      const requesterReplied = !internal && me.person_id === ticket.raised_by_person_id;
      if (requesterReplied && ticket.status === 'resolved') {
        await db.query(
          `UPDATE support_ticket
              SET status = 'open', resolved_at = NULL WHERE id = $1`,
          [input.ticketId]);
        await db.query(
          `INSERT INTO ticket_event (tenant_id, ticket_id, actor_person_id, kind)
           VALUES (app_current_tenant_id(), $1, $2, 'reopened')`,
          [input.ticketId, me.person_id]);
      } else if (me.is_staff && !internal && ticket.status === 'open') {
        await db.query(
          `UPDATE support_ticket SET status = 'waiting_on_requester' WHERE id = $1`,
          [input.ticketId]);
      }
    });
  },

  async setStatus(scope: TenantScope, ticketId: string, next: Status): Promise<void> {
    await withTenant(scope, async (db) => {
      const { rows } = await db.query<{ status: Status }>(
        'SELECT status FROM support_ticket WHERE id = $1', [ticketId]);
      const current = rows[0]?.status;
      if (!current) throw ApiError.make('not_found', 'ticket_not_found', 'No such ticket.');

      if (!TRANSITIONS[current].includes(next)) {
        throw ApiError.make('conflict', 'illegal_ticket_transition',
          `A ${current.replace(/_/g, ' ')} ticket cannot become ${next.replace(/_/g, ' ')}.`);
      }

      await db.query(
        `UPDATE support_ticket
            SET status = $2,
                resolved_at = CASE WHEN $2 IN ('resolved', 'closed')
                                   THEN COALESCE(resolved_at, now()) END,
                closed_at   = CASE WHEN $2 = 'closed' THEN now() END
          WHERE id = $1`,
        [ticketId, next]);

      await db.query(
        `INSERT INTO ticket_event (tenant_id, ticket_id, actor_person_id, kind, detail)
         VALUES (app_current_tenant_id(), $1, app_current_person_id(),
                 'status_changed', $2::jsonb)`,
        [ticketId, JSON.stringify({ from: current, to: next })]);
    });
  },

  async assign(scope: TenantScope, ticketId: string, staffId: string): Promise<void> {
    await withTenant(scope, async (db) => {
      const { rowCount } = await db.query(
        'UPDATE support_ticket SET assigned_to_staff_id = $2 WHERE id = $1',
        [ticketId, staffId]);
      if (rowCount === 0) {
        throw ApiError.make('not_found', 'ticket_not_found', 'No such ticket.');
      }
      await db.query(
        `INSERT INTO ticket_event (tenant_id, ticket_id, actor_person_id, kind, detail)
         VALUES (app_current_tenant_id(), $1, app_current_person_id(),
                 'assigned', $2::jsonb)`,
        [ticketId, JSON.stringify({ staff_id: staffId })]);
    });
  },

  /** What the office needs on a Monday: what is late, and what is about to be. */
  async breaches(scope: TenantScope): Promise<{
    awaiting_first_response: number; response_breached: number;
    resolution_breached: number; open: number;
  }> {
    return withTenant(scope, async (db) => {
      const { rows } = await db.query<{
        awaiting_first_response: number; response_breached: number;
        resolution_breached: number; open: number;
      }>(
        `SELECT
           count(*) FILTER (
             WHERE first_responded_at IS NULL AND status <> 'closed')::int
             AS awaiting_first_response,
           count(*) FILTER (
             WHERE first_responded_at IS NULL AND status <> 'closed'
               AND first_response_due_at < now())::int AS response_breached,
           count(*) FILTER (
             WHERE resolved_at IS NULL AND status <> 'closed'
               AND resolution_due_at < now())::int AS resolution_breached,
           count(*) FILTER (WHERE status NOT IN ('resolved', 'closed'))::int AS open
         FROM support_ticket`);
      return rows[0]!;
    });
  },
};

export { SLA_HOURS, TRANSITIONS };
