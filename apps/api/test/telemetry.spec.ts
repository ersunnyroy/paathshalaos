/**
 * M23 — the line, the number, and the shape of a failure.
 *
 * Half of this runs against a real HTTP server rather than against the
 * functions, because the two claims that matter are about WHERE things run:
 * that a request refused by a guard is still logged, and that a bare throw
 * still comes back in the contract's shape. Neither is checkable by calling a
 * pure function, and the first version of this got it wrong — it was an
 * interceptor, which Nest runs after guards, so every refusal went unlogged.
 */
import 'reflect-metadata';
// Imported for its side effect and imported FIRST: fixtures.ts calls
// loadDotenv() at module scope, and `logger.ts` calls loadEnv() at module
// scope too. ESM hoists imports, so calling loadDotenv() in this file's body
// would run after the logger had already failed on an unconfigured
// environment — the module graph decides the order, not the statements.
import './fixtures.ts';
// Before anything that reads config.  calls loadEnv() at module
// scope, so importing the middleware first fails with an unconfigured
// environment rather than an unset test.
import { loadDotenv } from '../src/config/load-dotenv.ts';
loadDotenv();
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { Controller, Get } from '@nestjs/common';
import { Public } from '../src/modules/auth/public.decorator.ts';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../src/app.module.ts';
import { logger } from '../src/common/logger.ts';
import { registry, resetMetrics, httpDuration } from '../src/common/telemetry/metrics.ts';
import {
  accessLine, levelFor, routeOf, SLOW_REQUEST_MS,
} from '../src/common/telemetry/access-log.ts';
import { normaliseRequestId } from '../src/common/telemetry/request-id.ts';
import { pool } from '../src/db/pool.ts';
import { authPool } from '../src/db/auth-pool.ts';

/* --------------------------------------------------------------- pure bits */

describe('the request id a caller supplies', () => {
  const generate = () => 'generated';

  it('is accepted when it is a plain id', () => {
    expect(normaliseRequestId('7c9e6679-7425-40de-944b-e07fc1f90ae7', generate))
      .toBe('7c9e6679-7425-40de-944b-e07fc1f90ae7');
    // Prefixed ids are how most gateways emit them.
    expect(normaliseRequestId('edge-01HXYZ:2', generate)).toBe('edge-01HXYZ:2');
  });

  it('is replaced when it could break a response header', () => {
    // This value is echoed into a header. Node refuses control characters
    // there, so taking it as given turns a crafted request into a 500 from
    // inside the framework with no route and no useful message.
    for (const bad of ['a\r\nX-Injected: yes', 'a\nb', 'a\u0000b']) {
      expect(normaliseRequestId(bad, generate)).toBe('generated');
    }
  });

  it('is replaced when it could forge structure in a log line', () => {
    for (const bad of ['{"level":50}', 'a"b', "a'b", 'a b', '<script>']) {
      expect(normaliseRequestId(bad, generate)).toBe('generated');
    }
  });

  it('is replaced when it is a payload rather than an id', () => {
    // Unbounded means the caller decides the log bill.
    expect(normaliseRequestId('x'.repeat(129), generate)).toBe('generated');
    expect(normaliseRequestId('x'.repeat(128), generate)).toBe('x'.repeat(128));
  });

  it('is replaced when it is absent, empty or not a string', () => {
    for (const bad of [undefined, null, '', '   ', 42, ['a'], {}]) {
      expect(normaliseRequestId(bad, generate)).toBe('generated');
    }
  });
});

describe('the route on a log line', () => {
  it('is the matched pattern, not the path', () => {
    // /v1/students/8f3a… and /v1/students/1b2c… are one endpoint. Logging
    // them separately gives a metric label a cardinality equal to the number
    // of learners in every school we host.
    expect(routeOf('/v1/students/:id', '')).toBe('/v1/students/:id');
  });

  it('does not fall back to the raw path when nothing matched', () => {
    // A flood of 404s on random paths is exactly when unbounded cardinality
    // would bite, so the unmatched case is a constant.
    expect(routeOf(undefined, undefined)).toBe('unmatched');
    expect(routeOf(undefined, '')).toBe('unmatched');
  });
});

describe('what a line carries', () => {
  const base = {
    requestId: 'r-1', method: 'GET', route: '/v1/students',
    status: 200, durationMs: 12.4,
  };

  it('rounds the duration', () => {
    expect(accessLine(base).duration_ms).toBe(12);
  });

  it('carries who, when the guards resolved it', () => {
    const line = accessLine({
      ...base,
      context: {
        requestId: 'r-1', tenantId: 't-1', actorId: 'a-1',
        impersonationId: 'imp-1',
      },
    });
    expect(line.tenant_id).toBe('t-1');
    expect(line.actor_id).toBe('a-1');
    // On every request in an entry session, not only on writes: "who was in
    // our records" is a question a school asks about reads.
    expect(line.impersonation_id).toBe('imp-1');
  });

  it('omits what it does not have rather than writing nulls', () => {
    expect(Object.keys(accessLine(base)).sort())
      .toEqual(['duration_ms', 'method', 'request_id', 'route', 'status']);
  });

  it('flags a slow request and not a fast one', () => {
    expect(accessLine({ ...base, durationMs: SLOW_REQUEST_MS }).slow).toBe(true);
    expect(accessLine({ ...base, durationMs: SLOW_REQUEST_MS - 1 }).slow)
      .toBeUndefined();
  });
});

describe('what a status deserves', () => {
  it('does not cry wolf about ordinary refusals', () => {
    // A 401 on a refresh, a 404 on a bookmark and a 422 on a mistyped form
    // are the system working. Logging them as warnings trains everybody to
    // ignore warnings, and then a real one goes past.
    for (const status of [200, 201, 400, 401, 403, 404, 409, 422]) {
      expect(levelFor(status), String(status)).toBe('info');
    }
  });

  it('warns on rate limiting and errors on ours', () => {
    expect(levelFor(429)).toBe('warn');
    expect(levelFor(500)).toBe('error');
    expect(levelFor(503)).toBe('error');
  });
});

/* ------------------------------------------------------------- over HTTP */

@Controller('v1/__telemetry_test')
class ThrowingController {
  // Public, or the global auth guard refuses it first and this file tests the
  // guard instead of the filter.
  @Public()
  @Get('boom')
  boom(): never {
    // A bare throw, not an HttpException. The message must not reach the body.
    throw new Error('relation "secret_table" does not exist');
  }
}

let app: INestApplication;
let base: string;
let lines: Array<Record<string, unknown>> = [];

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule], controllers: [ThrowingController],
  }).compile();
  app = moduleRef.createNestApplication({ logger: false });
  await app.init();
  await app.listen(0);
  base = await app.getUrl();

  // Captured from the real logger rather than a mock, so what is asserted is
  // what would actually be written to a log sink.
  const original = logger[Symbol.for('pino.write') as never] as unknown;
  void original;
  for (const level of ['info', 'warn', 'error'] as const) {
    const previous = logger[level].bind(logger);
    (logger as unknown as Record<string, unknown>)[level] =
      (obj: unknown, msg?: string) => {
        if (msg === 'request' && typeof obj === 'object' && obj !== null) {
          lines.push({ ...(obj as Record<string, unknown>), __level: level });
        }
        return previous(obj as never, msg as never);
      };
  }
});

afterAll(async () => {
  await app?.close();
  await Promise.all([pool.end(), authPool.end()]);
});

beforeEach(() => { lines = []; resetMetrics(); });

/* eslint-disable @typescript-eslint/no-explicit-any */
async function call(path: string, headers: Record<string, string> = {}):
  Promise<{ status: number; body: any; res: Response }> {
  const res = await fetch(`${base}${path}`, { headers });
  return { status: res.status, body: await res.json().catch(() => null), res };
}

async function settle(): Promise<void> {
  // `res.on('finish')` fires after the response is flushed, which can be after
  // fetch resolves. One tick is enough and waiting on a timer would make this
  // flaky in the other direction.
  await new Promise((r) => setImmediate(r));
}

describe('a request a guard refuses', () => {
  it('is still logged', async () => {
    // The claim the first version of this got wrong. An interceptor runs
    // AFTER guards, so every 401 and every 403 went unlogged — which is to
    // say, exactly the requests an access log exists for.
    const { status } = await call('/v1/me');
    await settle();
    expect(status).toBe(401);

    const line = lines.find((l) => l.route === '/v1/me');
    expect(line, 'no access line was written for a refused request').toBeDefined();
    expect(line!.status).toBe(401);
    expect(line!.method).toBe('GET');
    expect(line!.__level).toBe('info');
  });

  it('is still counted', async () => {
    await call('/v1/me');
    await settle();
    const metrics = await registry.metrics();
    expect(metrics).toContain('route="/v1/me"');
    expect(metrics).toContain('status="401"');
  });

  it('carries the request id the caller supplied', async () => {
    const { res } = await call('/v1/me', { 'x-request-id': 'caller-chosen-1' });
    await settle();
    expect(res.headers.get('x-request-id')).toBe('caller-chosen-1');
    expect(lines.find((l) => l.request_id === 'caller-chosen-1')).toBeDefined();
  });

  it('does not carry one the caller forged', async () => {
    const { res } = await call('/v1/me', { 'x-request-id': 'a"b{"level":50}' });
    await settle();
    expect(res.headers.get('x-request-id')).not.toBe('a"b{"level":50}');
    expect(res.headers.get('x-request-id')).toMatch(/^[A-Za-z0-9._:-]+$/);
  });
});

describe('a request that matched nothing', () => {
  it('is logged without putting the path in a label', async () => {
    await call(`/v1/${randomUUID()}/${randomUUID()}`);
    await settle();
    const line = lines.at(-1);
    expect(line!.route).toBe('unmatched');
    expect(await registry.metrics()).not.toContain(randomUUID().slice(0, 8));
  });

  it('comes back in the contract’s shape', async () => {
    const { status, body } = await call('/v1/no-such-endpoint');
    expect(status).toBe(404);
    // Nest's own NotFoundException, given the contract's shape rather than
    // passed through, so a client never has to handle two.
    expect(body.error.type).toBe('not_found');
    expect(body.error.code).toBe('not_found');
    expect(body.error.request_id).toBeTruthy();
    expect(body.error.doc_url).toContain('not_found');
  });
});

describe('a handler that throws something nobody planned for', () => {
  it('comes back in the contract’s shape, not Nest’s', async () => {
    const { status, body } = await call('/v1/__telemetry_test/boom');
    expect(status).toBe(500);
    expect(body.error.type).toBe('internal_error');
    expect(body.error.request_id).toBeTruthy();
    // Nest's default is {"statusCode":500,"message":"Internal server error"},
    // which is a different shape with no request id in it.
    expect(body.statusCode).toBeUndefined();
  });

  it('does not put the cause in the response', async () => {
    const { body } = await call('/v1/__telemetry_test/boom');
    const text = JSON.stringify(body);
    // An exception message can carry a query, a row, or a person's name.
    expect(text).not.toContain('secret_table');
    expect(text).not.toContain('does not exist');
  });

  it('logs it at error level, with the id that ties it to the request', async () => {
    const { body } = await call('/v1/__telemetry_test/boom');
    await settle();
    const line = lines.find((l) => l.route === '/v1/__telemetry_test/boom');
    expect(line!.__level).toBe('error');
    expect(line!.status).toBe(500);
    expect(line!.request_id).toBe(body.error.request_id);
  });

  it('carries the error code onto the line', async () => {
    await call('/v1/__telemetry_test/boom');
    await settle();
    expect(lines.find((l) => l.route === '/v1/__telemetry_test/boom')!.error_code)
      .toBe('internal_error');
  });
});

describe('the scrape endpoint', () => {
  it('answers without a session', async () => {
    const res = await fetch(`${base}/metrics`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
  });

  it('exposes the numbers somebody would alert on', async () => {
    const body = await (await fetch(`${base}/metrics`)).text();
    for (const name of [
      'paathshala_http_request_duration_ms',
      'paathshala_auth_failures_total',
      'paathshala_webhook_backlog',
      'paathshala_outbox_backlog',
      'paathshala_schema_migrations_applied',
      'paathshala_db_pool_waiting',
    ]) {
      expect(body, `${name} is missing`).toContain(name);
    }
  });

  it('samples the backlogs at scrape time', async () => {
    // Not on a timer: a gauge driven by its own interval keeps reporting the
    // last number it saw when the loop that updates it dies, which is exactly
    // the failure a backlog gauge exists to catch, reported as "fine".
    const body = await (await fetch(`${base}/metrics`)).text();
    expect(body).toMatch(/paathshala_schema_migrations_applied.* [1-9]\d*/);
  });

  it('says whether it could read the database at all', async () => {
    const body = await (await fetch(`${base}/metrics`)).text();
    expect(body).toContain('paathshala_gauge_sampling_ok');
    expect(body).toMatch(/paathshala_gauge_sampling_ok\{[^}]*\} 1/);
  });

  it('removes the backlogs rather than zeroing them when it cannot read', async () => {
    // The failure this is here for: the gauges asked a role with no grant on
    // those tables, every query threw, the sampler caught it, and the scrape
    // reported `paathshala_webhook_backlog 0`. "Nothing is stuck" and "I
    // cannot see" looked identical on a dashboard.
    const { sampleGauges } = await import('../src/common/telemetry/gauges.ts');
    const platform = await import('../src/db/platform-pool.ts');
    const real = platform.platformPool.connect.bind(platform.platformPool);
    (platform.platformPool as unknown as { connect: unknown }).connect =
      () => Promise.reject(new Error('permission denied for table webhook_delivery'));
    try {
      await sampleGauges();
      const body = await registry.metrics();
      expect(body).not.toContain('paathshala_webhook_backlog{');
      expect(body).not.toContain('paathshala_outbox_backlog{');
      expect(body).toMatch(/paathshala_gauge_sampling_ok\{[^}]*\} 0/);
      // The in-process gauges survive: they did not need the database.
      expect(body).toContain('paathshala_db_pool_waiting');
    } finally {
      (platform.platformPool as unknown as { connect: unknown }).connect = real;
    }
  });

  it('carries no tenant label on any series', async () => {
    // A per-tenant counter multiplies every series by the number of schools,
    // which is the number this business is trying to make large.
    const body = await (await fetch(`${base}/metrics`)).text();
    expect(body).not.toMatch(/tenant_id=/);
    expect(body).not.toMatch(/tenant=/);
  });
});

describe('the counters nobody would notice were never incremented', () => {
  /*
   * A metric declared and never incremented is the same problem as a feature
   * flag that guards nothing: it looks like coverage on a dashboard and is a
   * flat line nobody questions. These check the wiring exists, not the number.
   */
  it('counts an authentication failure, by its code', async () => {
    resetMetrics();
    await call('/v1/me');
    const body = await (await fetch(`${base}/metrics`)).text();
    expect(body).toMatch(/paathshala_auth_failures_total\{reason="missing_token"[^}]*\} 1/);
  });

  it('counts each reason separately', async () => {
    resetMetrics();
    await call('/v1/me');
    await call('/v1/me', { authorization: 'Bearer not-a-token' });
    const body = await (await fetch(`${base}/metrics`)).text();
    // Two different reasons, not one bucket called "401". The point of the
    // label is that a spike in one is a password spray and a spike in another
    // is a deploy that invalidated everybody's session.
    const reasons = [...body.matchAll(/paathshala_auth_failures_total\{reason="([a-z_]+)"/g)]
      .map((m) => m[1]);
    expect(new Set(reasons).size).toBeGreaterThanOrEqual(2);
  });

  it('does not count an ordinary 404 as an auth failure', async () => {
    resetMetrics();
    await call('/v1/no-such-endpoint');
    const body = await (await fetch(`${base}/metrics`)).text();
    expect(body).not.toMatch(/paathshala_auth_failures_total\{reason="not_found"/);
  });
});

describe('the request id reaching the database', () => {
  it('rides along as application_name, so a slow query is traceable', async () => {
    // The database is a service too. Without this, a slow query in
    // pg_stat_activity or the Postgres log cannot be tied to the request that
    // caused it, and the answer to "why was this school slow at 9:05" is
    // guesswork.
    const { withTenant } = await import('../src/db/tenant.ts');
    const { runWithContext } = await import('../src/common/request-context.ts');

    const seen = await runWithContext({ requestId: 'trace-me-1' }, () =>
      withTenant({ tenantId: '00000000-0000-0000-0000-000000000000' },
        async (db) => {
          const { rows } = await db.query<{ name: string }>(
            `SELECT current_setting('application_name') AS name`);
          return rows[0]!.name;
        }));
    expect(seen).toBe('paathshala/trace-me-1');
  });

  it('sets the whole scope in one round trip', async () => {
    // Three statements before any real work is three round trips on the
    // hottest path in the system, and the version that regresses it passes
    // every behavioural test — nothing observable changes except latency.
    //
    // So this reads the source. Counting calls at runtime would mean wrapping
    // a pooled client's `query`, which is a fair amount of machinery to
    // assert a fact that is visible in one line of the file.
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(
      new URL('../src/db/tenant.ts', import.meta.url), 'utf8');
    const statements = [...source.matchAll(/client\.query\(\s*\n?\s*`SELECT set_config/g)];
    expect(statements).toHaveLength(1);
    expect(source).not.toMatch(/client\.query\('SELECT set_config/);
  });

  it('treats an absent actor the same as an unset one', async () => {
    // '' rather than omitting the statement, which the reader functions
    // already normalise — NULLIF(current_setting(...), ''). If they did not,
    // every policy keyed on the actor would resolve to "nobody" and every
    // endpoint would return an empty list, which reads as "no data yet".
    const { withTenant } = await import('../src/db/tenant.ts');
    const answer = await withTenant(
      { tenantId: '00000000-0000-0000-0000-000000000000' },
      async (db) => {
        const { rows } = await db.query<{ actor: string | null }>(
          'SELECT app_current_actor_id()::text AS actor');
        return rows[0]!.actor;
      });
    expect(answer).toBeNull();
  });
});

describe('the alert rules', () => {
  /*
   * An alert that names a metric nobody emits is an alert that never fires,
   * and it is indistinguishable on a dashboard from an alert that is quiet
   * because everything is fine. A typo in a rule file is therefore a silent
   * removal of the alert, which is the worst kind of change to make by
   * accident. This is the only check that catches it before an incident does.
   */
  const rulesPath = new URL('../../../ops/alerts/paathshala.rules.yml', import.meta.url);

  it('names only metrics this service actually emits', async () => {
    const { readFileSync } = await import('node:fs');
    const rules = readFileSync(rulesPath, 'utf8');
    const emitted = new Set(
      (await registry.getMetricsAsJSON()).map((m) => m.name));

    const named = new Set(
      [...rules.matchAll(/paathshala_[a-z_]+/g)].map((m) => m[0]!)
        // Prometheus suffixes a histogram's series; the metric is the stem.
        .map((n) => n.replace(/_(bucket|sum|count)$/, '')));

    expect(named.size).toBeGreaterThan(5);
    for (const name of named) {
      expect(emitted, `no metric named ${name} is emitted`).toContain(name);
    }
  });

  it('gives every alert a runbook', async () => {
    // A rule with no runbook is a rule the person woken up cannot act on, and
    // one of those teaches everybody that silencing is normal.
    const { readFileSync } = await import('node:fs');
    const rules = readFileSync(rulesPath, 'utf8');
    const alerts = [...rules.matchAll(/- alert: (\w+)/g)].length;
    const runbooks = [...rules.matchAll(/runbook: /g)].length;
    expect(alerts).toBeGreaterThan(5);
    expect(runbooks).toBe(alerts);
  });

  it('says out loud that its thresholds are untested', async () => {
    // Nothing here has run against real traffic. Numbers that look tuned and
    // are not are worse than numbers labelled as guesses.
    const { readFileSync } = await import('node:fs');
    expect(readFileSync(rulesPath, 'utf8')).toContain('NOT VERIFIED');
  });
});

describe('the duration histogram', () => {
  it('has buckets around the decisions a person makes', async () => {
    httpDuration.observe({ method: 'GET', route: '/x', status: '200' }, 300);
    const body = await registry.metrics();
    // prom-client's defaults are in seconds and put six of ten below 100ms,
    // which says nothing about a web app.
    for (const le of ['100', '250', '1000', '5000']) {
      expect(body).toContain(`le="${le}"`);
    }
  });
});
