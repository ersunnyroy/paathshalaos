/**
 * Idempotent replay for the public API.
 *
 * The contract, which is the one every payments API has converged on because
 * the alternatives all lose money:
 *
 *   Same key, same request  → the FIRST response, replayed. The work runs once.
 *   Same key, different body → refused. Not replayed, not executed.
 *   Key in flight            → refused with a retry hint, not executed.
 *   No key on a write        → refused, so a client cannot opt out by accident.
 *
 * The second rule is the one people argue about. Replaying the first response
 * for a different body is worse than an error: a client looping over three
 * invoices with a key it forgot to advance would get three "created" responses
 * and one invoice, and would have no way to notice. Refusing tells them
 * immediately, in development, on the second request.
 *
 * The claim is an INSERT against a unique index rather than a SELECT-then-
 * INSERT. Two duplicate requests arriving in the same millisecond both pass a
 * check-then-act; only one can win an insert.
 */
import { createHash } from 'node:crypto';
import { withTenant, type TenantScope } from '../../db/tenant.ts';
import { ApiError } from '../../common/errors.ts';

export interface Replay {
  kind: 'replay';
  statusCode: number;
  body: unknown;
}
export interface Proceed {
  kind: 'proceed';
  recordId: string;
}

export function requestDigest(method: string, path: string, rawBody: string): string {
  // Method and path are in the digest as well as the body. The same body posted
  // to two different endpoints under one key is two different requests, and
  // replaying one for the other would be a silent substitution.
  return createHash('sha256')
    .update(`${method.toUpperCase()} ${path}\n${rawBody}`)
    .digest('hex');
}

export const idempotencyService = {
  /**
   * Claims the key, or tells the caller what to return instead.
   *
   * `expires_at` is checked here rather than by a sweeper alone: a key whose
   * window has passed is reusable, and waiting for a cleanup job to say so
   * would make the behaviour depend on when that job last ran.
   */
  async begin(
    scope: TenantScope,
    input: {
      apiClientId: string; key: string;
      method: string; path: string; rawBody: string;
    },
  ): Promise<Replay | Proceed> {
    const digest = requestDigest(input.method, input.path, input.rawBody);

    return withTenant(scope, async (db) => {
      // Sweep this key if its window has closed, so the insert below is a clean
      // claim rather than a conflict with a corpse.
      await db.query(
        `DELETE FROM idempotency_key
          WHERE api_client_id = $1 AND idem_key = $2 AND expires_at <= now()`,
        [input.apiClientId, input.key]);

      const { rows: claimed } = await db.query<{ id: string }>(
        `INSERT INTO idempotency_key
           (tenant_id, api_client_id, idem_key, request_digest, endpoint)
         VALUES (app_current_tenant_id(), $1, $2, $3, $4)
         ON CONFLICT (tenant_id, api_client_id, idem_key) DO NOTHING
         RETURNING id`,
        [input.apiClientId, input.key, digest, `${input.method.toUpperCase()} ${input.path}`]);

      if (claimed.length > 0) return { kind: 'proceed', recordId: claimed[0]!.id };

      // Somebody else holds it. What they hold decides the answer.
      const { rows } = await db.query<{
        id: string; state: string; request_digest: string;
        status_code: number | null; response_body: unknown;
      }>(
        `SELECT id, state, request_digest, status_code, response_body
           FROM idempotency_key
          WHERE api_client_id = $1 AND idem_key = $2`,
        [input.apiClientId, input.key]);

      const existing = rows[0];
      if (!existing) {
        // Swept between the delete and the insert by a concurrent request. One
        // retry is honest; looping here would be a spin on someone else's race.
        throw ApiError.make('conflict', 'idempotency_key_raced',
          'That idempotency key was being cleaned up. Retry the request.');
      }

      if (existing.request_digest !== digest) {
        throw ApiError.make('validation_error', 'idempotency_key_reused',
          'This Idempotency-Key was already used for a different request. ' +
          'Use a new key for each distinct request.');
      }

      if (existing.state === 'in_flight') {
        throw ApiError.make('conflict', 'idempotency_key_in_flight',
          'A request with this Idempotency-Key is still being processed. ' +
          'Retry in a moment.');
      }

      return {
        kind: 'replay',
        statusCode: existing.status_code!,
        body: existing.response_body,
      };
    });
  },

  /**
   * Stores the response so the next identical request replays it.
   *
   * Only successful outcomes are stored. A 500 recorded as the final answer
   * would make a transient failure permanent for the life of the key — the
   * client would retry correctly, with the same key, and be handed back the
   * same error for twenty-four hours.
   */
  async complete(
    scope: TenantScope,
    recordId: string, statusCode: number, body: unknown,
  ): Promise<void> {
    await withTenant(scope, async (db) => {
      if (statusCode >= 500) {
        await db.query('DELETE FROM idempotency_key WHERE id = $1', [recordId]);
        return;
      }
      await db.query(
        `UPDATE idempotency_key
            SET state = 'completed', status_code = $2, response_body = $3::jsonb,
                completed_at = now()
          WHERE id = $1 AND state = 'in_flight'`,
        [recordId, statusCode, JSON.stringify(body ?? null)]);
    });
  },

  /** Releases a claim whose work threw, so the client's retry can proceed. */
  async abandon(scope: TenantScope, recordId: string): Promise<void> {
    await withTenant(scope, async (db) => {
      await db.query(
        `DELETE FROM idempotency_key WHERE id = $1 AND state = 'in_flight'`, [recordId]);
    });
  },
};
