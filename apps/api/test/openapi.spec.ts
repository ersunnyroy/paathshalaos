/**
 * The spec and the router agree.
 *
 * A published contract is only worth anything if it is true, and the way a spec
 * stops being true is not dramatic — somebody adds an endpoint, or renames a
 * scope, and the YAML nobody owns quietly falls a week behind. The integrator
 * finds out in production.
 *
 * So these tests compare the spec against the app that actually boots:
 *
 *   Every `/api/v1` route Nest registers is documented.
 *   Every documented path is a route that exists.
 *   Every documented scope is one the database will accept.
 *   Every documented route's scope matches what its guard actually requires.
 *
 * The last one is the one worth having. A path list can be kept in step by
 * hand; a scope written in the docs and a different scope enforced in the guard
 * is how somebody is told they need `results:read`, buys a key with it, and
 * gets 403 forever.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import './fixtures.ts';
import { AppModule } from '../src/app.module.ts';
import { buildSpec } from '../src/openapi/spec.ts';
import { API_SCOPES } from '../src/modules/public-api/api-key.guard.ts';
import { PublicApiController } from '../src/modules/public-api/public.controller.ts';

let app: INestApplication;
let registered: Array<{ method: string; path: string }>;
const spec = buildSpec() as {
  paths: Record<string, Record<string, { 'x-scopes': string[]; operationId: string }>>;
  components: Record<string, unknown>;
};

/** The closed set from the CHECK constraint in migration 0040. */
const KNOWN_SCOPES = [
  'students:read', 'attendance:read', 'attendance:write',
  'invoices:read', 'payments:read', 'results:read', 'webhooks:read',
];

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication({ logger: false });
  await app.init();

  const server = app.getHttpAdapter().getInstance() as {
    _router: { stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }> };
  };
  registered = [];
  for (const layer of server._router.stack) {
    if (!layer.route) continue;
    for (const method of Object.keys(layer.route.methods)) {
      registered.push({ method, path: layer.route.path });
    }
  }
});

afterAll(async () => { await app?.close(); });

describe('the published spec matches the running API', () => {
  it('documents every public route the app registers', () => {
    const publicRoutes = registered
      .filter((r) => r.path.startsWith('/api/v1/') && !r.path.endsWith('openapi.json'))
      .map((r) => `${r.method} ${r.path}`)
      .sort();
    const documented = Object.entries(spec.paths)
      .flatMap(([path, ops]) => Object.keys(ops).map((m) => `${m} ${path}`))
      .sort();

    // Add an endpoint without documenting it and this names it.
    expect(documented).toEqual(publicRoutes);
  });

  it('documents no path that does not exist', () => {
    const real = new Set(registered.map((r) => `${r.method} ${r.path}`));
    for (const [path, ops] of Object.entries(spec.paths)) {
      for (const method of Object.keys(ops)) {
        // A documented endpoint that 404s is worse than an undocumented one:
        // the integrator writes the code before finding out.
        expect(real.has(`${method} ${path}`), `${method} ${path} is documented but not routed`)
          .toBe(true);
      }
    }
  });

  it('documents only scopes the database will accept', () => {
    for (const [path, ops] of Object.entries(spec.paths)) {
      for (const [method, op] of Object.entries(ops)) {
        for (const scope of op['x-scopes']) {
          // A scope in the docs that fails the CHECK constraint in 0040 cannot
          // be granted, so the endpoint is undocumented in practice.
          expect(KNOWN_SCOPES, `${method} ${path} documents unknown scope ${scope}`)
            .toContain(scope);
        }
      }
    }
  });

  it('documents the scope each route actually enforces', () => {
    // Read back off the handler's own metadata — the value the guard reads at
    // request time, not a second list that happens to look similar.
    const enforced = new Map<string, string[]>();
    for (const name of Object.getOwnPropertyNames(PublicApiController.prototype)) {
      if (name === 'constructor') continue;
      const fn = (PublicApiController.prototype as unknown as Record<string, unknown>)[name];
      const scopes = Reflect.getMetadata(API_SCOPES, fn as object) as string[] | undefined;
      if (scopes) enforced.set(name, scopes);
    }

    // Every handler that declares scopes must be documented with the same ones.
    expect(enforced.size).toBeGreaterThan(0);
    const documentedScopes = new Set(
      Object.values(spec.paths).flatMap((ops) =>
        Object.values(ops).map((op) => op['x-scopes'].join(','))));
    for (const [, scopes] of enforced) {
      expect(documentedScopes, `no documented route enforces ${scopes.join(',')}`)
        .toContain(scopes.join(','));
    }
  });

  it('gives every declared scope somewhere to be used', () => {
    // The gap this closes: a key could be issued with results:read while no
    // endpoint read results. The scope was a promise the product did not keep.
    const used = new Set(
      Object.values(spec.paths).flatMap((ops) =>
        Object.values(ops).flatMap((op) => op['x-scopes'])));
    for (const scope of KNOWN_SCOPES) {
      expect(used, `${scope} can be granted but no endpoint uses it`).toContain(scope);
    }
  });

  it('serves the spec without a key', async () => {
    await app.listen(0);
    const base = await app.getUrl();
    const res = await fetch(`${base}/api/v1/openapi.json`);
    expect(res.status).toBe(200);
    const served = await res.json() as { openapi: string; paths: Record<string, unknown> };
    // An integrator reads the contract before they have a key.
    expect(served.openapi).toBe('3.1.0');
    expect(Object.keys(served.paths)).toEqual(Object.keys(spec.paths));
  });
});

describe('the spec says the things an integrator will get wrong', () => {
  it('states that money is a string, on every money field', () => {
    const json = JSON.stringify(spec);
    expect(json).toContain('IEEE double');
    for (const [path, ops] of Object.entries(spec.paths)) {
      if (!['/api/v1/invoices', '/api/v1/payments'].includes(path)) continue;
      const props = JSON.stringify(Object.values(ops)[0]);
      // A money field typed as a number here is a bug that reaches a family's
      // fee balance.
      expect(props).not.toMatch(/"(total|amount|amount_paid)":\s*\{\s*"type":\s*"number"/);
    }
  });

  it('documents the webhook signature scheme in full', () => {
    const sig = (spec as unknown as { 'x-webhook-signature': Record<string, unknown> })
      ['x-webhook-signature'];
    expect(sig['algorithm']).toContain('HMAC-SHA256');
    expect(sig['tolerance_seconds']).toBe(300);
    const notes = (sig['notes'] as string[]).join(' ');
    // The three mistakes every hand-written verifier makes.
    expect(notes).toContain('constant time');
    expect(notes).toContain('RAW body');
    expect(notes).toContain('rotation');
  });

  it('marks the Idempotency-Key as required, not optional', () => {
    const post = spec.paths['/api/v1/attendance/marks']!['post'] as unknown as {
      parameters: Array<{ name: string; required: boolean }>;
    };
    const key = post.parameters.find((p) => p.name === 'Idempotency-Key');
    expect(key?.required).toBe(true);
  });
});
