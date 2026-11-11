/**
 * M9.7 — outbound webhooks. AC-10 lives here and in 0039.
 *
 * The shape is deliberately boring: the outbox already guarantees that an event
 * exists if and only if the change it describes committed, so this layer's only
 * jobs are fan-out (which endpoints want this event) and delivery (send it,
 * retry it, give up visibly).
 *
 * The three things that are NOT boring, and why:
 *
 *   **The payload is frozen at fan-out.** A retry re-sends stored bytes. The
 *   tempting alternative — re-read the aggregate and send current state — makes
 *   retries non-idempotent in the way that matters: a receiver that replays its
 *   inbox reconstructs a different history depending on which attempt won.
 *
 *   **Backoff is computed from attempt_count, and the row is claimed before the
 *   request goes out.** Two workers that both pick up the same due delivery
 *   would otherwise both send it. `FOR UPDATE SKIP LOCKED` plus an immediate
 *   bump of next_attempt_at means the second worker sees nothing due.
 *
 *   **Giving up is a state, not a silence.** A dead delivery stays in the log
 *   with its last error, because the institute's question is "did it go", and
 *   a row that quietly stopped being retried cannot answer it.
 */
import { withTenant, type TenantScope, type TenantClient } from '../../db/tenant.ts';
import { ApiError } from '../../common/errors.ts';
import { auditService } from '../audit/audit.service.ts';
import { request, type RequestOptions } from 'node:https';
import { checkWebhookUrl, resolveSafely } from './url-safety.ts';
import { header, signedPayload } from './signature.ts';

/**
 * Backoff, in seconds, by attempt number. Eight attempts over roughly a day:
 * long enough to ride out a receiver's deployment or a short outage, short
 * enough that nobody is surprised by a delivery arriving on Tuesday.
 */
const BACKOFF_SECONDS = [0, 10, 60, 300, 900, 3600, 10_800, 43_200];
export const MAX_ATTEMPTS = BACKOFF_SECONDS.length;

/** A receiver has this long to answer before we count the attempt as failed. */
const TIMEOUT_MS = 10_000;

export interface Endpoint {
  id: string; url: string; description: string | null;
  event_types: string[]; status: string;
  secret_rotated_at: string | null; disabled_reason: string | null;
  created_at: string;
}

/** Everything a delivery row exposes. Note what is absent: the signing secret. */
export interface Delivery {
  id: string; webhook_endpoint_id: string; outbox_event_id: string;
  event_type: string; status: string; attempt_count: number; attempt_baseline: number;
  next_attempt_at: string; last_error: string | null;
  succeeded_at: string | null; created_at: string;
}

/** Injected so tests can assert what was sent without opening a socket. */
export interface HttpSender {
  post(input: {
    url: string; body: string; headers: Record<string, string>; timeoutMs: number;
  }): Promise<{ status: number; body: string }>;
}

/**
 * What the socket is actually told to do.
 *
 * Extracted from the sender so it can be asserted without a network: the three
 * fields below point at two different places on purpose, and a refactor that
 * quietly makes `host` the hostname again reopens DNS rebinding while every
 * behavioural test still passes. This is that decision, in one testable place.
 */
export function requestOptionsFor(
  target: { address: string; host: string; port: number; pathAndQuery: string },
  headers: Record<string, string>,
  timeoutMs: number,
): RequestOptions {
  return {
    // The socket goes to the address we validated...
    host: target.address,
    // ...while TLS verification and the Host header carry the original name.
    // Without servername every certificate fails, and the usual next step is to
    // stop verifying — a worse hole than the one being closed.
    servername: target.host,
    port: target.port,
    path: target.pathAndQuery,
    method: 'POST',
    headers: { ...headers, host: target.host },
    timeout: timeoutMs,
    // Redirects are never followed: a 302 to 169.254.169.254 would undo all of it.
  };
}

export const fetchSender: HttpSender = {
  async post({ url, body, headers, timeoutMs }) {
    // Resolve once, validate what came back, then dial THAT address.
    //
    // Fetching by hostname would resolve a second time, and the gap between the
    // two lookups is the whole of DNS rebinding: a record with a one-second TTL
    // is public when we validate and 127.0.0.1 when the socket opens, and both
    // checks pass honestly.
    const resolved = await resolveSafely(url);
    if (!resolved.ok) throw new Error(`Refusing to connect: ${resolved.reason}`);

    // node:https rather than fetch, because this needs three things pointed at
    // two different places and fetch cannot express it: the SOCKET goes to the
    // validated address, while `servername` and the Host header carry the
    // original hostname. Without servername every certificate fails to verify,
    // and the usual next step is to turn verification off — which would be a
    // worse hole than the one being closed.
    return new Promise((resolve, reject) => {
      const req = request(
        requestOptionsFor(resolved.target, headers, timeoutMs),
        (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => {
            // Bounded while reading, not after. A receiver that answers with a
            // gigabyte should cost us 2KB of memory, not a gigabyte.
            if (text.length < 2048) text += chunk;
          });
          res.on('end', () => {
            resolve({ status: res.statusCode ?? 0, body: text.slice(0, 2048) });
          });
        },
      );

      req.on('timeout', () => { req.destroy(new Error('Receiver timed out')); });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  },
};

const SELECT_ENDPOINT = `
  id, url, description, event_types, status,
  secret_rotated_at, disabled_reason, created_at`;

export const webhookService = {
  /* ------------------------------------------------------------- endpoints */

  /**
   * Adds an endpoint and returns its signing secret — once, here, and never
   * again. The URL is checked against resolved addresses first; see
   * url-safety.ts for why a hostname check would not be a check at all.
   */
  async createEndpoint(
    scope: TenantScope,
    input: { url: string; eventTypes: string[]; description?: string | undefined },
  ): Promise<{ id: string; secret: string }> {
    const verdict = await checkWebhookUrl(input.url);
    if (!verdict.ok) {
      throw ApiError.make('validation_error', `webhook_url_${verdict.reason}`,
        verdict.reason === 'private_address'
          ? 'That address is inside a private network and cannot receive webhooks.'
          : 'That webhook URL cannot be used.');
    }
    if (input.eventTypes.length === 0) {
      throw ApiError.make('validation_error', 'webhook_no_events',
        'Choose at least one event type for this endpoint.');
    }

    return withTenant(scope, async (db) => {
      const { rows } = await db.query<{ endpoint_id: string; secret: string }>(
        'SELECT * FROM webhook_endpoint_create($1, $2::text[], $3)',
        [input.url, input.eventTypes, input.description ?? null],
      );
      const row = rows[0]!;
      await auditService.record({
        tenantId: scope.tenantId, action: 'webhook_endpoint.created',
        resourceType: 'webhook_endpoint', resourceId: row.endpoint_id,
        // The URL, not the secret. An audit log is read by more people than an
        // API response is.
        after: { url: input.url, event_types: input.eventTypes },
      });
      return { id: row.endpoint_id, secret: row.secret };
    });
  },

  async rotateSecret(scope: TenantScope, endpointId: string): Promise<{ secret: string }> {
    return withTenant(scope, async (db) => {
      const { rows } = await db.query<{ webhook_endpoint_rotate_secret: string }>(
        'SELECT webhook_endpoint_rotate_secret($1)', [endpointId]);
      await auditService.record({
        tenantId: scope.tenantId, action: 'webhook_endpoint.secret_rotated',
        resourceType: 'webhook_endpoint', resourceId: endpointId,
        classification: 'RESTRICTED',
      });
      return { secret: rows[0]!.webhook_endpoint_rotate_secret };
    });
  },

  async listEndpoints(scope: TenantScope): Promise<Endpoint[]> {
    return withTenant(scope, async (db) => {
      const { rows } = await db.query<Endpoint>(
        `SELECT ${SELECT_ENDPOINT} FROM webhook_endpoint ORDER BY created_at DESC`);
      return rows;
    });
  },

  async setStatus(
    scope: TenantScope, endpointId: string, status: 'active' | 'paused' | 'disabled',
    reason?: string,
  ): Promise<void> {
    await withTenant(scope, async (db) => {
      const { rowCount } = await db.query(
        `UPDATE webhook_endpoint
            SET status = $2,
                disabled_reason = CASE WHEN $2 = 'disabled' THEN COALESCE($3, 'Disabled by the organisation') END
          WHERE id = $1`,
        [endpointId, status, reason ?? null]);
      if (rowCount === 0) {
        throw ApiError.make('not_found', 'webhook_endpoint_not_found',
          'No such webhook endpoint.');
      }
    });
  },

  /* --------------------------------------------------------------- fan-out */

  /**
   * Turns unpublished outbox events into per-endpoint deliveries.
   *
   * Idempotent by construction: the unique index on (endpoint, event) means a
   * second run inserts nothing. That matters more than it sounds — a relay that
   * crashes after sending and before marking published is the NORMAL failure,
   * not the exotic one, so "run it again" has to be safe rather than merely
   * usually safe.
   */
  async fanOut(scope: TenantScope, limit = 200): Promise<{ events: number; deliveries: number }> {
    return withTenant(scope, async (db) => {
      const { rows: events } = await db.query<{
        id: string; event_type: string; payload: Record<string, unknown>;
        occurred_at: string; aggregate_type: string; aggregate_id: string | null;
      }>(
        `SELECT id, event_type, payload, occurred_at, aggregate_type, aggregate_id
           FROM outbox_event
          WHERE published_at IS NULL
          ORDER BY occurred_at
          LIMIT $1
          FOR UPDATE SKIP LOCKED`,
        [limit]);

      if (events.length === 0) return { events: 0, deliveries: 0 };

      let deliveries = 0;
      for (const event of events) {
        const { rows: endpoints } = await db.query<{ id: string }>(
          `SELECT id FROM webhook_endpoint
            WHERE status = 'active' AND $1 = ANY (event_types)`,
          [event.event_type]);

        for (const endpoint of endpoints) {
          // The envelope, built once and stored. `id` is the delivery id and is
          // what a receiver dedupes on.
          const { rows } = await db.query<{ id: string }>(
            `INSERT INTO webhook_delivery
               (tenant_id, webhook_endpoint_id, outbox_event_id, event_type, payload)
             VALUES (app_current_tenant_id(), $1, $2, $3, $4::jsonb)
             ON CONFLICT (webhook_endpoint_id, outbox_event_id) DO NOTHING
             RETURNING id`,
            [endpoint.id, event.id, event.event_type, JSON.stringify({
              type: event.event_type,
              occurred_at: event.occurred_at,
              aggregate: { type: event.aggregate_type, id: event.aggregate_id },
              data: event.payload,
            })]);
          if (rows.length > 0) deliveries += 1;
        }
      }

      // Marked published only after every delivery row is written, in the same
      // transaction. Marking first and fanning out after is how an event is
      // dropped when the process dies in between.
      await db.query(
        'UPDATE outbox_event SET published_at = now() WHERE id = ANY($1::uuid[])',
        [events.map((e) => e.id)]);

      return { events: events.length, deliveries };
    });
  },

  /* -------------------------------------------------------------- delivery */

  /**
   * Sends every delivery that is due, once each.
   *
   * Each delivery is claimed and pushed forward BEFORE the HTTP call, so a
   * second worker — or this worker after a crash and restart — does not send it
   * again while the first request is still in flight. The cost is that a crash
   * mid-request delays the retry by one backoff step. That is the right side to
   * err on: a late webhook is an inconvenience, a duplicated one that a naive
   * receiver processes twice is a duplicated fee receipt.
   */
  async deliverDue(
    scope: TenantScope, sender: HttpSender = fetchSender, limit = 50,
  ): Promise<{ attempted: number; succeeded: number; failed: number; dead: number }> {
    const due = await withTenant(scope, async (db) => {
      const { rows } = await db.query<{
        id: string; url: string; payload: unknown; attempt_count: number;
        attempt_baseline: number; endpoint_id: string; event_type: string;
      }>(
        `SELECT d.id, e.url, d.payload, d.attempt_count, d.attempt_baseline,
                d.webhook_endpoint_id AS endpoint_id, d.event_type
           FROM webhook_delivery d
           JOIN webhook_endpoint e ON e.id = d.webhook_endpoint_id
          WHERE d.status = 'pending'
            AND d.next_attempt_at <= now()
            AND e.status = 'active'
          ORDER BY d.next_attempt_at
          LIMIT $1
          FOR UPDATE OF d SKIP LOCKED`,
        [limit]);

      // Claim inside the same transaction that selected them. The backoff step
      // is read from position in the CURRENT cycle, not from the lifetime count,
      // so a replayed delivery retries promptly rather than inheriting the
      // twelve-hour wait its previous cycle had reached.
      for (const row of rows) {
        const inCycle = row.attempt_count - row.attempt_baseline + 1;
        await db.query(
          `UPDATE webhook_delivery
              SET attempt_count = attempt_count + 1,
                  next_attempt_at = now() + make_interval(secs => $2)
            WHERE id = $1`,
          [row.id, BACKOFF_SECONDS[Math.min(inCycle, MAX_ATTEMPTS - 1)]!]);
      }
      return rows;
    });

    const tally = { attempted: 0, succeeded: 0, failed: 0, dead: 0 };

    for (const row of due) {
      tally.attempted += 1;
      // The attempt's number in the append-only log: lifetime, never reset.
      const attemptNo = row.attempt_count + 1;
      // Its position in the current retry cycle, which is what the budget counts.
      const inCycle = attemptNo - row.attempt_baseline;
      const body = JSON.stringify(row.payload);
      const timestamp = Math.floor(Date.now() / 1000);

      const signatures = await withTenant(scope, async (db) => {
        const { rows } = await db.query<{ webhook_sign: string[] }>(
          'SELECT webhook_sign($1, $2)', [row.endpoint_id, signedPayload(timestamp, body)]);
        return rows[0]!.webhook_sign;
      });

      let status: number | null = null;
      let excerpt: string | null = null;
      let error: string | null = null;
      const started = Date.now();
      try {
        const res = await sender.post({
          url: row.url, body, timeoutMs: TIMEOUT_MS,
          headers: {
            'content-type': 'application/json',
            // The delivery id, stable across every retry of this delivery. This
            // is the value a receiver stores to make its own side idempotent,
            // and it is why the payload must not change between attempts.
            'x-paathshala-delivery': row.id,
            'x-paathshala-event': row.event_type,
            'x-paathshala-attempt': String(attemptNo),
            'x-paathshala-signature': header(timestamp, signatures),
            'user-agent': 'paathshalaOS-webhooks/1',
          },
        });
        status = res.status;
        excerpt = res.body.slice(0, 2048);
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }

      // 2xx is success. Everything else retries, including 4xx: a receiver that
      // returns 401 because its own config is half-deployed recovers on retry,
      // and treating client errors as permanent means the institute loses the
      // event over a mistake on their side that they fixed ten minutes later.
      const succeeded = status !== null && status >= 200 && status < 300;
      const exhausted = !succeeded && inCycle >= MAX_ATTEMPTS;

      await withTenant(scope, async (db) => {
        await db.query(
          `INSERT INTO webhook_attempt
             (tenant_id, webhook_delivery_id, attempt_no, duration_ms,
              response_status, response_excerpt, error)
           VALUES (app_current_tenant_id(), $1, $2, $3, $4, $5, $6)`,
          [row.id, attemptNo, Date.now() - started, status, excerpt,
           error ?? (succeeded ? null : `HTTP ${status}`)]);

        if (succeeded) {
          await db.query(
            `UPDATE webhook_delivery
                SET status = 'succeeded', succeeded_at = now(), last_error = NULL
              WHERE id = $1`, [row.id]);
        } else {
          await db.query(
            `UPDATE webhook_delivery
                SET status = $2, last_error = $3
              WHERE id = $1`,
            [row.id, exhausted ? 'dead' : 'pending',
             error ?? `HTTP ${status ?? 'no response'}`]);
        }
      });

      if (succeeded) tally.succeeded += 1;
      else if (exhausted) tally.dead += 1;
      else tally.failed += 1;
    }

    return tally;
  },

  /* ------------------------------------------------------------- the log */

  async listDeliveries(
    scope: TenantScope,
    filter: { endpointId?: string | undefined; status?: string | undefined;
              limit?: number | undefined } = {},
  ): Promise<Delivery[]> {
    return withTenant(scope, async (db) => {
      const { rows } = await db.query<Delivery>(
        `SELECT id, webhook_endpoint_id, outbox_event_id, event_type, status,
                attempt_count, attempt_baseline, next_attempt_at, last_error,
                succeeded_at, created_at
           FROM webhook_delivery
          WHERE ($1::uuid IS NULL OR webhook_endpoint_id = $1)
            AND ($2::text IS NULL OR status = $2)
          ORDER BY created_at DESC
          LIMIT $3`,
        [filter.endpointId ?? null, filter.status ?? null, filter.limit ?? 100]);
      return rows;
    });
  },

  async listAttempts(scope: TenantScope, deliveryId: string): Promise<Array<{
    attempt_no: number; attempted_at: string; duration_ms: number | null;
    response_status: number | null; response_excerpt: string | null; error: string | null;
  }>> {
    return withTenant(scope, async (db) => {
      const { rows } = await db.query<{
        attempt_no: number; attempted_at: string; duration_ms: number | null;
        response_status: number | null; response_excerpt: string | null; error: string | null;
      }>(
        `SELECT attempt_no, attempted_at, duration_ms, response_status,
                response_excerpt, error
           FROM webhook_attempt
          WHERE webhook_delivery_id = $1
          ORDER BY attempt_no`,
        [deliveryId]);
      return rows;
    });
  },

  /**
   * Puts a dead delivery back in the queue, unchanged.
   *
   * The same frozen payload under the same delivery id — a replay, not a new
   * event. An institute whose receiver was down for a day fixes it and replays;
   * if this minted a new id, their dedupe table would let the replay through as
   * a fresh event and they would double-count it.
   */
  async replay(scope: TenantScope, deliveryId: string): Promise<void> {
    await withTenant(scope, async (db) => {
      const { rowCount } = await db.query(
        `UPDATE webhook_delivery
            SET status = 'pending', attempt_baseline = attempt_count,
                next_attempt_at = now(), last_error = NULL
          WHERE id = $1 AND status IN ('dead', 'failed')`,
        [deliveryId]);
      if (rowCount === 0) {
        throw ApiError.make('conflict', 'delivery_not_replayable',
          'Only a delivery that has given up can be replayed.');
      }
    });
  },
};

export type { TenantClient };
