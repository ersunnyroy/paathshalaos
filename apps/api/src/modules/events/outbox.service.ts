import type { TenantClient } from '../../db/tenant.ts';

export interface DomainEvent {
  eventType: string;
  aggregateType: string;
  aggregateId?: string;
  schemaVersion?: string;
  payload: Record<string, unknown>;
}

/**
 * Writes a domain event inside the caller's transaction.
 *
 * It takes a TenantClient rather than opening its own, and that is the entire
 * point: the event lands in the same commit as the change it describes. An event
 * published from application code after the commit is lost whenever the process
 * dies in between — which is precisely when the notification matters most.
 */
export const outboxService = {
  async emit(db: TenantClient, event: DomainEvent): Promise<string> {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO outbox_event
         (tenant_id, event_type, aggregate_type, aggregate_id, schema_version, payload)
       VALUES (app_current_tenant_id(), $1, $2, $3, COALESCE($4, '1.0'), $5::jsonb)
       RETURNING id`,
      [event.eventType, event.aggregateType, event.aggregateId ?? null,
       event.schemaVersion ?? null, JSON.stringify(event.payload)],
    );
    return rows[0]!.id;
  },

  /** What the relay claims. Unpublished, oldest first, skipping locked rows. */
  async claimUnpublished(
    db: TenantClient,
    limit = 100,
  ): Promise<Array<{ id: string; event_type: string; payload: Record<string, unknown> }>> {
    const { rows } = await db.query<{
      id: string; event_type: string; payload: Record<string, unknown>;
    }>(
      `SELECT id, event_type, payload
         FROM outbox_event
        WHERE published_at IS NULL
        ORDER BY occurred_at
        LIMIT $1
        FOR UPDATE SKIP LOCKED`,
      [limit],
    );
    return rows;
  },

  async markPublished(db: TenantClient, ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;
    const { rowCount } = await db.query(
      'UPDATE outbox_event SET published_at = now() WHERE id = ANY($1::uuid[])',
      [ids],
    );
    return rowCount;
  },
};
