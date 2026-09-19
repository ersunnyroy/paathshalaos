/**
 * M9.7 — the public API and webhooks. AC-10.
 *
 * AC-10 is three claims, so this file is three describes:
 *
 *   1. retries are idempotent
 *   2. signatures are verified
 *   3. deliveries are visible to the tenant
 *
 * Everything runs against a real Postgres with real policies. The one thing
 * faked is the socket: an HttpSender that records what it was given, because
 * the question is what we SEND, and standing up a receiver would test the
 * receiver.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import {
  createTenant, destroyTenants, createUser, destroyUsers, grantRole, purgeTestData,
  OWNER_URL, type TenantFixture, type UserFixture,
} from './fixtures.ts';
import { withTenant } from '../src/db/tenant.ts';
import { pool } from '../src/db/pool.ts';
import { authPool } from '../src/db/auth-pool.ts';
import { apiKeyService, parseCredential } from '../src/modules/public-api/api-key.service.ts';
import { idempotencyService } from '../src/modules/public-api/idempotency.service.ts';
import {
  consume, rateLimitKey, resetRateLimits,
} from '../src/modules/public-api/rate-limit.ts';
import {
  webhookService, type HttpSender, MAX_ATTEMPTS,
} from '../src/modules/webhooks/webhook.service.ts';
import { verify, sign, header, TOLERANCE_SECONDS } from '../src/modules/webhooks/signature.ts';
import {
  checkWebhookUrl, resolveSafely, type Resolver,
} from '../src/modules/webhooks/url-safety.ts';
import { requestOptionsFor } from '../src/modules/webhooks/webhook.service.ts';

const PASSWORD = 'correct-horse-battery';

let tenant: TenantFixture;
let other: TenantFixture;
let owner: UserFixture;
let teacher: UserFixture;
let otherOwner: UserFixture;

let ownerScope: { tenantId: string; actorId: string };
let teacherScope: { tenantId: string; actorId: string };
let otherScope: { tenantId: string; actorId: string };

async function withOwnerDb<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: OWNER_URL });
  await client.connect();
  try { return await fn(client); } finally { await client.end(); }
}

/** Puts an event in the outbox the way the rest of the product does. */
async function emitEvent(
  tenantId: string, type: string, payload: Record<string, unknown>,
): Promise<string> {
  return withOwnerDb(async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO outbox_event (tenant_id, event_type, aggregate_type, payload)
       VALUES ($1, $2, 'test', $3::jsonb) RETURNING id`,
      [tenantId, type, JSON.stringify(payload)]);
    return rows[0]!.id;
  });
}

/** Records every request instead of making one. */
function recorder(respond: (n: number) => { status: number; body: string }): HttpSender & {
  calls: Array<{ url: string; body: string; headers: Record<string, string> }>;
} {
  const calls: Array<{ url: string; body: string; headers: Record<string, string> }> = [];
  return {
    calls,
    async post({ url, body, headers }) {
      calls.push({ url, body, headers });
      return respond(calls.length);
    },
  };
}

const ok = () => ({ status: 200, body: 'ok' });
const boom = () => ({ status: 500, body: 'nope' });

beforeAll(async () => {
  await purgeTestData('%@papi-test.example');
  tenant = await createTenant('PAPI');
  other = await createTenant('PAPX');

  owner = await createUser('owner@papi-test.example', PASSWORD);
  teacher = await createUser('teacher@papi-test.example', PASSWORD);
  otherOwner = await createUser('other@papi-test.example', PASSWORD);

  await grantRole(tenant.orgId, owner.userId, 'ORG_OWNER');
  await grantRole(tenant.orgId, teacher.userId, 'TEACHER');
  await grantRole(other.orgId, otherOwner.userId, 'ORG_OWNER');

  ownerScope = { tenantId: tenant.orgId, actorId: owner.userId };
  teacherScope = { tenantId: tenant.orgId, actorId: teacher.userId };
  otherScope = { tenantId: other.orgId, actorId: otherOwner.userId };
});

afterAll(async () => {
  await destroyUsers([owner.userId, teacher.userId, otherOwner.userId]);
  await destroyTenants([tenant.orgId, other.orgId]);
  await pool.end();
  await authPool.end();
});

beforeEach(() => resetRateLimits());

/* ========================================================================== */
/* AC-10.1 — retries are idempotent                                           */
/* ========================================================================== */

describe('AC-10: retries are idempotent', () => {
  it('replays the stored response instead of doing the work twice', async () => {
    const client = await apiKeyService.createClient(ownerScope, {
      name: `idem-${randomUUID().slice(0, 8)}`, scopes: ['attendance:write'],
    });
    const key = `idem-${randomUUID()}`;
    const request = {
      apiClientId: client.id, key,
      method: 'POST', path: '/api/v1/attendance/marks',
      rawBody: '{"sessionId":"s","marks":[]}',
    };

    const first = await idempotencyService.begin(ownerScope, request);
    expect(first.kind).toBe('proceed');
    await idempotencyService.complete(
      ownerScope, (first as { recordId: string }).recordId, 201, { data: { made: 1 } });

    const second = await idempotencyService.begin(ownerScope, request);
    expect(second.kind).toBe('replay');
    expect(second).toMatchObject({ statusCode: 201, body: { data: { made: 1 } } });
  });

  it('refuses the same key with a different body rather than replaying it', async () => {
    const client = await apiKeyService.createClient(ownerScope, {
      name: `idem2-${randomUUID().slice(0, 8)}`, scopes: ['attendance:write'],
    });
    const key = `idem-${randomUUID()}`;
    const base = {
      apiClientId: client.id, key,
      method: 'POST', path: '/api/v1/attendance/marks',
    };

    const first = await idempotencyService.begin(ownerScope, { ...base, rawBody: '{"a":1}' });
    await idempotencyService.complete(
      ownerScope, (first as { recordId: string }).recordId, 201, { ok: true });

    // The loop-variable bug: a client that forgot to advance its key. Replaying
    // here would silently drop the second request.
    await expect(
      idempotencyService.begin(ownerScope, { ...base, rawBody: '{"a":2}' }),
    ).rejects.toMatchObject({ response: { error: { code: 'idempotency_key_reused' } } });
  });

  it('refuses a second request while the first is still in flight', async () => {
    const client = await apiKeyService.createClient(ownerScope, {
      name: `idem3-${randomUUID().slice(0, 8)}`, scopes: ['attendance:write'],
    });
    const request = {
      apiClientId: client.id, key: `idem-${randomUUID()}`,
      method: 'POST', path: '/api/v1/attendance/marks', rawBody: '{"a":1}',
    };
    await idempotencyService.begin(ownerScope, request);
    await expect(idempotencyService.begin(ownerScope, request))
      .rejects.toMatchObject({ response: { error: { code: 'idempotency_key_in_flight' } } });
  });

  it('lets exactly one of two concurrent duplicates proceed', async () => {
    const client = await apiKeyService.createClient(ownerScope, {
      name: `race-${randomUUID().slice(0, 8)}`, scopes: ['attendance:write'],
    });
    const request = {
      apiClientId: client.id, key: `idem-${randomUUID()}`,
      method: 'POST', path: '/api/v1/attendance/marks', rawBody: '{"a":1}',
    };

    // The real shape of the failure: two duplicates in flight at once. A
    // check-then-insert passes this only by luck.
    const results = await Promise.allSettled([
      idempotencyService.begin(ownerScope, request),
      idempotencyService.begin(ownerScope, request),
    ]);
    const proceeded = results.filter(
      (r) => r.status === 'fulfilled' && r.value.kind === 'proceed');
    expect(proceeded).toHaveLength(1);
  });

  it('does not make a server error permanent for the life of the key', async () => {
    const client = await apiKeyService.createClient(ownerScope, {
      name: `err-${randomUUID().slice(0, 8)}`, scopes: ['attendance:write'],
    });
    const request = {
      apiClientId: client.id, key: `idem-${randomUUID()}`,
      method: 'POST', path: '/api/v1/attendance/marks', rawBody: '{"a":1}',
    };

    const first = await idempotencyService.begin(ownerScope, request);
    await idempotencyService.complete(
      ownerScope, (first as { recordId: string }).recordId, 500, { error: 'boom' });

    // The client retries with the same key, as they should. Handing back the
    // stored 500 would make one bad minute last a day.
    const retry = await idempotencyService.begin(ownerScope, request);
    expect(retry.kind).toBe('proceed');
  });

  it('fans out an event once however many times the relay runs', async () => {
    const ep = await webhookService.createEndpoint(ownerScope, {
      url: 'https://203.0.113.10/once', eventTypes: ['test.fanout'],
    });
    await emitEvent(tenant.orgId, 'test.fanout', { n: 1 });

    const first = await webhookService.fanOut(ownerScope);
    expect(first.deliveries).toBe(1);

    // The normal failure: the relay crashed after sending and before marking
    // published, so it runs again over the same event.
    await withOwnerDb((c) => c.query(
      `UPDATE outbox_event SET published_at = NULL
        WHERE tenant_id = $1 AND event_type = 'test.fanout'`, [tenant.orgId]));
    const second = await webhookService.fanOut(ownerScope);
    expect(second.deliveries).toBe(0);

    const deliveries = await webhookService.listDeliveries(ownerScope, { endpointId: ep.id });
    expect(deliveries).toHaveLength(1);
  });

  it('re-sends byte-identical bytes under the same delivery id on every retry', async () => {
    const ep = await webhookService.createEndpoint(ownerScope, {
      url: 'https://203.0.113.10/retry', eventTypes: ['test.retry'],
    });
    await emitEvent(tenant.orgId, 'test.retry', { amount_paise: '150000' });
    await webhookService.fanOut(ownerScope);

    const [queued] = await webhookService.listDeliveries(ownerScope, { endpointId: ep.id });

    const sender = recorder(boom);
    await webhookService.deliverDue(ownerScope, sender);
    await dueNow(ep.id);
    await webhookService.deliverDue(ownerScope, sender);

    // Filtered to THIS delivery. deliverDue works the whole tenant's queue, so
    // a delivery another test left pending would otherwise be counted here —
    // and a test that counts unrelated work is a test that fails for unrelated
    // reasons.
    const mine = sender.calls.filter(
      (c) => c.headers['x-paathshala-delivery'] === queued!.id);
    expect(mine).toHaveLength(2);
    // This is the claim. A receiver that deduplicates on the delivery id is
    // correct only if both of these hold.
    expect(mine[1]!.body).toBe(mine[0]!.body);
    // And the attempt counter still moves, or a receiver cannot tell a retry
    // from a duplicate event.
    expect(mine[0]!.headers['x-paathshala-attempt']).toBe('1');
    expect(mine[1]!.headers['x-paathshala-attempt']).toBe('2');
  });

  it('replays a dead delivery under its original id, not a new one', async () => {
    const ep = await webhookService.createEndpoint(ownerScope, {
      url: 'https://203.0.113.10/replay', eventTypes: ['test.replay'],
    });
    await emitEvent(tenant.orgId, 'test.replay', { n: 1 });
    await webhookService.fanOut(ownerScope);

    const sender = recorder(boom);
    for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
      await dueNow(ep.id);
      await webhookService.deliverDue(ownerScope, sender);
    }
    const [dead] = await webhookService.listDeliveries(ownerScope, { endpointId: ep.id });
    expect(dead!.status).toBe('dead');

    await webhookService.replay(ownerScope, dead!.id);
    const good = recorder(ok);
    await webhookService.deliverDue(ownerScope, good);

    // Same id. If a replay minted a new one, the institute's receiver would let
    // it through its dedupe table and count the event twice.
    expect(good.calls[0]!.headers['x-paathshala-delivery']).toBe(dead!.id);
  });

  it('gives up visibly rather than retrying for ever', async () => {
    const ep = await webhookService.createEndpoint(ownerScope, {
      url: 'https://203.0.113.10/dead', eventTypes: ['test.dead'],
    });
    await emitEvent(tenant.orgId, 'test.dead', { n: 1 });
    await webhookService.fanOut(ownerScope);

    const sender = recorder(boom);
    for (let i = 0; i < MAX_ATTEMPTS + 2; i += 1) {
      await dueNow(ep.id);
      await webhookService.deliverDue(ownerScope, sender);
    }
    expect(sender.calls).toHaveLength(MAX_ATTEMPTS);

    const [row] = await webhookService.listDeliveries(ownerScope, { endpointId: ep.id });
    expect(row!.status).toBe('dead');
    expect(row!.last_error).toBeTruthy();
  });
});

/* ========================================================================== */
/* AC-10.2 — signatures are verified                                          */
/* ========================================================================== */

describe('AC-10: signatures are verified', () => {
  it('signs every delivery with a secret the receiver can check', async () => {
    const ep = await webhookService.createEndpoint(ownerScope, {
      url: 'https://203.0.113.10/sig', eventTypes: ['test.sig'],
    });
    await emitEvent(tenant.orgId, 'test.sig', { n: 1 });
    await webhookService.fanOut(ownerScope);

    const sender = recorder(ok);
    await webhookService.deliverDue(ownerScope, sender);

    const call = sender.calls[0]!;
    expect(verify(call.headers['x-paathshala-signature'], call.body, ep.secret))
      .toEqual({ ok: true });
  });

  it('rejects a body altered in transit', async () => {
    const ep = await webhookService.createEndpoint(ownerScope, {
      url: 'https://203.0.113.10/tamper', eventTypes: ['test.tamper'],
    });
    await emitEvent(tenant.orgId, 'test.tamper', { amount_paise: '100' });
    await webhookService.fanOut(ownerScope);

    const sender = recorder(ok);
    await webhookService.deliverDue(ownerScope, sender);
    const call = sender.calls[0]!;

    const tampered = call.body.replace('"100"', '"1000000"');
    expect(tampered).not.toBe(call.body);
    expect(verify(call.headers['x-paathshala-signature'], tampered, ep.secret))
      .toMatchObject({ ok: false, reason: 'no_matching_signature' });
  });

  it('rejects a signature made with a different secret', async () => {
    const body = '{"hello":"world"}';
    const t = Math.floor(Date.now() / 1000);
    const forged = header(t, [sign('whsec_not_the_secret', t, body)]);
    expect(verify(forged, body, 'whsec_the_real_one'))
      .toMatchObject({ ok: false, reason: 'no_matching_signature' });
  });

  it('rejects a replay of a request that was valid an hour ago', async () => {
    const secret = 'whsec_replay';
    const body = '{"n":1}';
    const old = Math.floor(Date.now() / 1000) - (TOLERANCE_SECONDS + 60);
    const value = header(old, [sign(secret, old, body)]);

    // The signature itself is perfectly good. That is the point: without the
    // timestamp inside the signed material, this would verify for ever.
    expect(verify(value, body, secret))
      .toMatchObject({ ok: false, reason: 'timestamp_out_of_tolerance' });
  });

  it('binds the timestamp into the signature, not merely alongside it', async () => {
    // The attack this closes: capture one valid delivery, re-present it with a
    // fresh timestamp. If the timestamp is not INSIDE the signed material, the
    // signature still matches and the tolerance check passes — a replay that
    // works for ever, from a single captured request.
    const secret = 'whsec_bound';
    const body = '{"n":1}';
    const captured = Math.floor(Date.now() / 1000) - 120;
    const signature = sign(secret, captured, body);

    // Presented under its own timestamp: valid.
    expect(verify(header(captured, [signature]), body, secret)).toEqual({ ok: true });

    // The same signature under a fresh timestamp, well inside tolerance, must
    // not verify — which is only true if the timestamp is part of what is signed.
    const fresh = Math.floor(Date.now() / 1000);
    expect(fresh).not.toBe(captured);
    expect(verify(header(fresh, [signature]), body, secret))
      .toMatchObject({ ok: false, reason: 'no_matching_signature' });
  });

  it('rejects a missing or malformed signature header', async () => {
    expect(verify(undefined, '{}', 's')).toMatchObject({ ok: false, reason: 'missing_signature' });
    expect(verify('garbage', '{}', 's')).toMatchObject({ ok: false, reason: 'malformed_signature' });
    expect(verify('t=123', '{}', 's')).toMatchObject({ ok: false, reason: 'malformed_signature' });
  });

  it('sends both signatures during a rotation, then only the new one', async () => {
    const ep = await webhookService.createEndpoint(ownerScope, {
      url: 'https://203.0.113.10/rotate', eventTypes: ['test.rotate'],
    });
    const rotated = await webhookService.rotateSecret(ownerScope, ep.id);
    expect(rotated.secret).not.toBe(ep.secret);

    await emitEvent(tenant.orgId, 'test.rotate', { n: 1 });
    await webhookService.fanOut(ownerScope);
    const sender = recorder(ok);
    await webhookService.deliverDue(ownerScope, sender);
    const call = sender.calls[0]!;

    // A receiver that has not been updated yet still verifies. That is what
    // makes a rotation something other than a flag day.
    expect(verify(call.headers['x-paathshala-signature'], call.body, ep.secret))
      .toEqual({ ok: true });
    expect(verify(call.headers['x-paathshala-signature'], call.body, rotated.secret))
      .toEqual({ ok: true });

    // Once the window closes, the old secret stops working.
    await withOwnerDb((c) => c.query(
      `UPDATE webhook_endpoint SET secret_rotated_at = now() - interval '25 hours'
        WHERE id = $1`, [ep.id]));
    await emitEvent(tenant.orgId, 'test.rotate', { n: 2 });
    await webhookService.fanOut(ownerScope);
    const after = recorder(ok);
    await webhookService.deliverDue(ownerScope, after);
    const late = after.calls[0]!;

    expect(verify(late.headers['x-paathshala-signature'], late.body, rotated.secret))
      .toEqual({ ok: true });
    expect(verify(late.headers['x-paathshala-signature'], late.body, ep.secret).ok)
      .toBe(false);
  });

  it('never lets the application role read a signing secret', async () => {
    await webhookService.createEndpoint(ownerScope, {
      url: 'https://203.0.113.10/secret', eventTypes: ['test.secret'],
    });

    // A `SELECT *` is the realistic mistake — someone adds a debug log or a
    // generic row serialiser. It must fail, not succeed quietly.
    await expect(withTenant(ownerScope, (db) =>
      db.query('SELECT * FROM webhook_endpoint LIMIT 1'))).rejects.toThrow(/permission denied/);
    await expect(withTenant(ownerScope, (db) =>
      db.query('SELECT signing_secret FROM webhook_endpoint LIMIT 1')))
      .rejects.toThrow(/permission denied/);
  });

  it('never lets the application role read an API key hash', async () => {
    await expect(withTenant(ownerScope, (db) =>
      db.query('SELECT * FROM api_key_secret LIMIT 1'))).rejects.toThrow(/permission denied/);
  });

  it('dials the address it validated, not the name', async () => {
    // The half that closes DNS rebinding. A checker that answers "safe" and a
    // connector that resolves the name again are asking two different
    // questions, and an attacker only has to win the second one — a record with
    // a one-second TTL is public at check time and 127.0.0.1 at connect time.
    const safe = await resolveSafely('https://203.0.113.10/hook?x=1');
    expect(safe.ok).toBe(true);
    if (safe.ok) {
      // The literal address comes back, so the sender never looks it up again.
      expect(safe.target.address).toBe('203.0.113.10');
      // And the hostname survives, because it is what Host and the TLS server
      // name must carry — without it every certificate fails to verify and the
      // usual next step is to stop verifying.
      expect(safe.target.host).toBe('203.0.113.10');
      expect(safe.target.pathAndQuery).toBe('/hook?x=1');
      expect(safe.target.port).toBe(443);
    }

    for (const bad of ['https://127.0.0.1/hook', 'https://169.254.169.254/latest',
                       'http://203.0.113.10/hook']) {
      expect((await resolveSafely(bad)).ok, bad).toBe(false);
    }
  });

  it('refuses a hostname that resolves inside the network', async () => {
    // The rebinding case, with the resolver injected because a sandbox has no
    // DNS — and without this seam the only reachable branch is the literal-IP
    // one, which returns before these checks run. A mutation deleting them
    // passed the entire suite.
    const rebinding: Resolver = async () => [{ address: '127.0.0.1', family: 4 }];
    expect(await resolveSafely('https://evil.example.com/hook', rebinding))
      .toMatchObject({ ok: false, reason: 'private_address' });

    // And one public record alongside a loopback one is still refused: a host
    // that answers with both would otherwise pass whenever the resolver
    // happened to order them the right way.
    const mixed: Resolver = async () => [
      { address: '203.0.113.10', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ];
    expect(await resolveSafely('https://mixed.example.com/hook', mixed))
      .toMatchObject({ ok: false, reason: 'private_address' });

    const good: Resolver = async () => [{ address: '203.0.113.77', family: 4 }];
    const ok = await resolveSafely('https://good.example.com/hook', good);
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      // The resolved address is handed back so nothing looks the name up again.
      expect(ok.target.address).toBe('203.0.113.77');
      expect(ok.target.host).toBe('good.example.com');
    }
  });

  it('resolves exactly once on the path that dials', async () => {
    // Counted, not inferred. An earlier version delegated to checkWebhookUrl
    // and then resolved again — two lookups, which is the whole of rebinding,
    // and behaviourally invisible.
    let lookups = 0;
    const counting: Resolver = async () => {
      lookups += 1;
      return [{ address: '203.0.113.99', family: 4 }];
    };
    const ok = await resolveSafely('https://once.example.com/hook', counting);
    expect(ok.ok).toBe(true);
    expect(lookups).toBe(1);
  });

  it('connects to the address and presents the hostname', () => {
    const options = requestOptionsFor(
      { address: '203.0.113.77', host: 'good.example.com', port: 443,
        pathAndQuery: '/hook' },
      { 'content-type': 'application/json' }, 10_000);

    // The socket goes to the validated address...
    expect(options.host).toBe('203.0.113.77');
    // ...and the name travels in the two places that must carry it. Swap either
    // for the hostname and the second DNS lookup is back.
    expect(options.servername).toBe('good.example.com');
    expect((options.headers as Record<string, string>)['host']).toBe('good.example.com');
  });

  it('refuses a webhook URL pointing inside the network', async () => {
    for (const url of ['https://127.0.0.1/hook', 'https://169.254.169.254/latest/meta-data',
                       'https://10.0.0.5/hook', 'https://[::1]/hook']) {
      expect(await checkWebhookUrl(url)).toMatchObject({ ok: false, reason: 'private_address' });
    }
    expect(await checkWebhookUrl('http://example.com/hook'))
      .toMatchObject({ ok: false, reason: 'https_required' });
  });
});

/* ========================================================================== */
/* AC-10.3 — deliveries are visible to the tenant                             */
/* ========================================================================== */

describe('AC-10: deliveries are visible to the tenant', () => {
  it('shows the office what was sent and what came back', async () => {
    const ep = await webhookService.createEndpoint(ownerScope, {
      url: 'https://203.0.113.10/visible', eventTypes: ['test.visible'],
    });
    await emitEvent(tenant.orgId, 'test.visible', { n: 1 });
    await webhookService.fanOut(ownerScope);

    const sender = recorder((n) => (n === 1 ? { status: 503, body: 'try later' } : ok()));
    await webhookService.deliverDue(ownerScope, sender);
    await dueNow(ep.id);
    await webhookService.deliverDue(ownerScope, sender);

    const [delivery] = await webhookService.listDeliveries(ownerScope, { endpointId: ep.id });
    expect(delivery!.status).toBe('succeeded');
    expect(delivery!.attempt_count).toBe(2);

    const attempts = await webhookService.listAttempts(ownerScope, delivery!.id);
    expect(attempts.map((a) => a.response_status)).toEqual([503, 200]);
    // The response body, not just the code: "we sent it, here is what your
    // server said" is the sentence that ends a support thread.
    expect(attempts[0]!.response_excerpt).toBe('try later');
  });

  it('shows staff the log without letting them manage the integration', async () => {
    const ep = await webhookService.createEndpoint(ownerScope, {
      url: 'https://203.0.113.10/staff', eventTypes: ['test.staff'],
    });
    await emitEvent(tenant.orgId, 'test.staff', { n: 1 });
    await webhookService.fanOut(ownerScope);

    // A teacher can answer "did the receipt go out".
    expect(await webhookService.listDeliveries(teacherScope, { endpointId: ep.id }))
      .toHaveLength(1);
    // But cannot see, add or rotate the endpoint itself.
    expect(await webhookService.listEndpoints(teacherScope)).toHaveLength(0);
    await expect(webhookService.createEndpoint(teacherScope, {
      url: 'https://203.0.113.10/teacher', eventTypes: ['test.staff'],
    })).rejects.toThrow(/organisation owner/);
  });

  it('shows one tenant nothing of another tenant', async () => {
    await webhookService.createEndpoint(ownerScope, {
      url: 'https://203.0.113.10/mine', eventTypes: ['test.isolation'],
    });
    await emitEvent(tenant.orgId, 'test.isolation', { n: 1 });
    await webhookService.fanOut(ownerScope);

    expect(await webhookService.listEndpoints(otherScope)).toHaveLength(0);
    expect(await webhookService.listDeliveries(otherScope)).toHaveLength(0);
  });

  it('keeps the attempt log append-only', async () => {
    const ep = await webhookService.createEndpoint(ownerScope, {
      url: 'https://203.0.113.10/append', eventTypes: ['test.append'],
    });
    await emitEvent(tenant.orgId, 'test.append', { n: 1 });
    await webhookService.fanOut(ownerScope);
    await webhookService.deliverDue(ownerScope, recorder(ok));

    const [delivery] = await webhookService.listDeliveries(ownerScope, { endpointId: ep.id });

    // "We tried three times" has to be a fact, not an editable field, and it is
    // protected twice over. The application role has no UPDATE privilege at all,
    // so the attempt is refused before any trigger runs.
    await expect(withTenant(ownerScope, (db) => db.query(
      `UPDATE webhook_attempt SET response_status = 200 WHERE webhook_delivery_id = $1`,
      [delivery!.id]))).rejects.toThrow(/permission denied/);

    // And the trigger holds for a role that DOES have the privilege — which is
    // the layer that matters the day someone adds a grant to unblock a script.
    await expect(withOwnerDb((c) => c.query(
      `UPDATE webhook_attempt SET response_status = 200 WHERE webhook_delivery_id = $1`,
      [delivery!.id]))).rejects.toThrow(/append-only/);
  });

  it('does not fan out to a paused endpoint, and says so in the log', async () => {
    const ep = await webhookService.createEndpoint(ownerScope, {
      url: 'https://203.0.113.10/paused', eventTypes: ['test.paused'],
    });
    await webhookService.setStatus(ownerScope, ep.id, 'paused');
    await emitEvent(tenant.orgId, 'test.paused', { n: 1 });

    const result = await webhookService.fanOut(ownerScope);
    expect(result.deliveries).toBe(0);
    expect(await webhookService.listDeliveries(ownerScope, { endpointId: ep.id }))
      .toHaveLength(0);
  });
});

/* ========================================================================== */
/* Keys, scopes and the machine principal                                     */
/* ========================================================================== */

describe('API keys', () => {
  it('authenticates a freshly issued key and refuses a revoked one', async () => {
    const client = await apiKeyService.createClient(ownerScope, {
      name: `auth-${randomUUID().slice(0, 8)}`, scopes: ['students:read'],
    });
    const key = await apiKeyService.issueKey(ownerScope, { clientId: client.id });

    const identity = await apiKeyService.authenticate(key.credential);
    expect(identity.tenantId).toBe(tenant.orgId);
    expect(identity.scopes).toEqual(['students:read']);

    await apiKeyService.revokeKey(ownerScope, key.id);
    await expect(apiKeyService.authenticate(key.credential)).rejects.toMatchObject({ response: { error: { code: 'invalid_api_key' } } });
  });

  it('refuses a key whose secret is wrong, without saying which part was', async () => {
    const client = await apiKeyService.createClient(ownerScope, {
      name: `wrong-${randomUUID().slice(0, 8)}`, scopes: ['students:read'],
    });
    const key = await apiKeyService.issueKey(ownerScope, { clientId: client.id });
    const parsed = parseCredential(key.credential)!;
    const wrong = `${parsed.prefix}.${'0'.repeat(64)}`;

    await expect(apiKeyService.authenticate(wrong)).rejects.toMatchObject({ response: { error: { code: 'invalid_api_key' } } });
    // The same message for an unknown key, so the API is not an oracle for
    // which prefixes exist.
    await expect(apiKeyService.authenticate(`pk_live_${'a'.repeat(16)}.${'0'.repeat(64)}`))
      .rejects.toMatchObject({ response: { error: { code: 'invalid_api_key' } } });
  });

  it('refuses an expired key', async () => {
    const client = await apiKeyService.createClient(ownerScope, {
      name: `exp-${randomUUID().slice(0, 8)}`, scopes: ['students:read'],
    });
    const key = await apiKeyService.issueKey(ownerScope, { clientId: client.id });
    await withOwnerDb((c) => c.query(
      `UPDATE api_key SET created_at = now() - interval '2 hours',
                          expires_at = now() - interval '1 hour'
        WHERE id = $1`, [key.id]));

    await expect(apiKeyService.authenticate(key.credential)).rejects.toMatchObject({ response: { error: { code: 'invalid_api_key' } } });
  });

  it('will not let a teacher mint a key', async () => {
    await expect(apiKeyService.createClient(teacherScope, {
      name: 'sneaky', scopes: ['students:read'],
    })).rejects.toThrow();
  });

  it('gives a machine principal only what its scopes allow', async () => {
    const readOnly = await apiKeyService.createClient(ownerScope, {
      name: `scoped-${randomUUID().slice(0, 8)}`, scopes: ['students:read'],
    });
    const scope = { tenantId: tenant.orgId, apiClientId: readOnly.id };

    // Staff scope, because it holds a read scope...
    const staff = await withTenant(scope, async (db) => {
      const { rows } = await db.query<{ v: boolean }>(
        'SELECT app_actor_has_staff_scope() AS v');
      return rows[0]!.v;
    });
    expect(staff).toBe(true);

    // ...but not finance, because it holds neither money scope.
    const finance = await withTenant(scope, async (db) => {
      const { rows } = await db.query<{ v: boolean }>(
        'SELECT app_actor_has_finance_scope() AS v');
      return rows[0]!.v;
    });
    expect(finance).toBe(false);

    // And never integration scope, whatever it holds: a key that can mint keys
    // or redirect the event stream can escalate itself.
    const integration = await withTenant(scope, async (db) => {
      const { rows } = await db.query<{ v: boolean }>(
        'SELECT app_actor_has_integration_scope() AS v');
      return rows[0]!.v;
    });
    expect(integration).toBe(false);
  });

  it('leaves the human path byte-identical to what it was', async () => {
    // The disjointness claim in 0040. A human session must not be able to reach
    // the machine branch, whatever is set.
    const asOwner = await withTenant(ownerScope, async (db) => {
      const { rows } = await db.query<{ s: boolean; f: boolean; i: boolean }>(
        `SELECT app_actor_has_staff_scope() AS s,
                app_actor_has_finance_scope() AS f,
                app_actor_has_integration_scope() AS i`);
      return rows[0]!;
    });
    expect(asOwner).toEqual({ s: true, f: true, i: true });

    const asTeacher = await withTenant(teacherScope, async (db) => {
      const { rows } = await db.query<{ s: boolean; f: boolean; i: boolean }>(
        `SELECT app_actor_has_staff_scope() AS s,
                app_actor_has_finance_scope() AS f,
                app_actor_has_integration_scope() AS i`);
      return rows[0]!;
    });
    expect(asTeacher).toEqual({ s: true, f: false, i: false });
  });

  it('suspends a client without touching its keys', async () => {
    const client = await apiKeyService.createClient(ownerScope, {
      name: `susp-${randomUUID().slice(0, 8)}`, scopes: ['students:read'],
    });
    const key = await apiKeyService.issueKey(ownerScope, { clientId: client.id });
    expect((await apiKeyService.authenticate(key.credential)).apiClientId).toBe(client.id);

    await withOwnerDb((c) => c.query(
      `UPDATE api_client SET status = 'suspended' WHERE id = $1`, [client.id]));
    await expect(apiKeyService.authenticate(key.credential)).rejects.toMatchObject({ response: { error: { code: 'invalid_api_key' } } });
  });

  it('counts requests per key, not per client', () => {
    // A client with three keys, one of which belongs to a runaway script.
    for (let i = 0; i < 5; i += 1) consume('key-a', 5);
    expect(consume('key-a', 5).allowed).toBe(false);
    expect(consume('key-b', 5).allowed).toBe(true);
  });

  it('throttles the offending key and leaves its siblings alone', () => {
    // Asserted on the KEY-CHOOSING function rather than on consume(), because
    // the bug this guards against is not a broken counter — it is a correct
    // counter pointed at the wrong identifier, which no test of consume() can
    // see. Two keys of one client must not share a budget.
    const one = { apiKeyId: 'key-1', apiClientId: 'client-x' };
    const two = { apiKeyId: 'key-2', apiClientId: 'client-x' };
    expect(rateLimitKey(one)).not.toBe(rateLimitKey(two));

    for (let i = 0; i < 3; i += 1) consume(rateLimitKey(one), 3);
    expect(consume(rateLimitKey(one), 3).allowed).toBe(false);
    expect(consume(rateLimitKey(two), 3).allowed).toBe(true);
  });
});

/** Makes a pending delivery due now, so a test does not wait out the backoff. */
async function dueNow(endpointId: string): Promise<void> {
  await withOwnerDb((c) => c.query(
    `UPDATE webhook_delivery SET next_attempt_at = now()
      WHERE webhook_endpoint_id = $1 AND status = 'pending'`, [endpointId]));
}
