/**
 * M19 — whose product is this, and how do you reach it.
 *
 * Most of what matters here is refusal. Branding is easy; what is hard is that
 * the sign-in screen has to resolve a school BEFORE anybody has authenticated,
 * which makes the host the only thing identifying the tenant. So the tests are
 * about what that lookup must not do: route a hostname nobody proved they own,
 * leak anything beyond a name and a mark, or let a colour carry a payload into
 * a stylesheet we serve on a school's own domain.
 */
import 'reflect-metadata';
import pg from 'pg';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  createTenant, destroyTenants, createUser, destroyUsers, grantRole, purgeTestData,
  OWNER_URL, type TenantFixture, type UserFixture,
} from './fixtures.ts';
import { domainService, slugify, VERIFY_RECORD, MANAGED_SUFFIX }
  from '../src/modules/branding/domain.service.ts';
import { brandingService } from '../src/modules/branding/branding.service.ts';
import { setResolver } from '../src/modules/branding/dns.ts';
import { withTenant } from '../src/db/tenant.ts';
import { pool } from '../src/db/pool.ts';
import { authPool } from '../src/db/auth-pool.ts';
import { platformPool } from '../src/db/platform-pool.ts';

let school: TenantFixture;
let neighbour: TenantFixture;
let staff: UserFixture;
let owner: UserFixture;

/** A DNS server that answers whatever the test says it answers. */
const zone = new Map<string, string[][]>();
setResolver({
  async resolveTxt(host) {
    const found = zone.get(host);
    if (!found) throw new Error('ENOTFOUND');
    return found;
  },
});

async function owned<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: OWNER_URL });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

beforeAll(async () => {
  await purgeTestData('%@brand-test.example');
  school = await createTenant('BRAND');
  neighbour = await createTenant('BRANDB');
  staff = await createUser('platform@brand-test.example', 'correct-horse-battery');
  owner = await createUser('head@brand-test.example', 'correct-horse-battery');
  await grantRole(school.orgId, owner.userId, 'ORG_OWNER');
});

afterAll(async () => {
  await owned(async (c) => {
    await c.query('DELETE FROM tenant_branding WHERE tenant_id = ANY($1)',
      [[school.orgId, neighbour.orgId]]);
    await c.query('DELETE FROM tenant_domain WHERE tenant_id = ANY($1)',
      [[school.orgId, neighbour.orgId]]);
  });
  await destroyTenants([school.orgId, neighbour.orgId]);
  await destroyUsers([staff.userId, owner.userId]);
  await Promise.all([pool.end(), authPool.end(), platformPool.end()]);
});

describe('every school gets an address', () => {
  it('turns a school name into a usable hostname label', () => {
    expect(slugify('St Joseph\'s Higher Secondary')).toBe('st-joseph-s-higher-secondary');
    expect(slugify('  Sunrise   Public School  ')).toBe('sunrise-public-school');
    // Accents folded rather than dropped, so a school is still recognisable.
    expect(slugify('Kendriya Vidyālaya')).toBe('kendriya-vidyalaya');
    // Never a leading or trailing hyphen: both are invalid in a DNS label.
    expect(slugify('--Oddly--Named--')).toBe('oddly-named');
    expect(slugify('!!!')).toBe('');
  });

  it('allocates a managed subdomain, live immediately', async () => {
    const domain = await domainService.allocateManaged(
      staff.userId, school.orgId, 'Brand Test School');
    expect(domain.host).toBe(`brand-test-school.${MANAGED_SUFFIX}`);
    // Ours, so there is nothing to verify — a school unreachable until somebody
    // ticked a box would be a school that cannot sign in on day one.
    expect(domain.verified_at).not.toBeNull();
    expect(domain.is_primary).toBe(true);
  });

  it('does not hand the same address to two schools', async () => {
    const second = await domainService.allocateManaged(
      staff.userId, neighbour.orgId, 'Brand Test School');
    expect(second.host).toBe(`brand-test-school-2.${MANAGED_SUFFIX}`);
  });
});

describe('a custom domain routes only once it is proved', () => {
  it('registers unverified, and resolves to nothing', async () => {
    const added = await domainService.addCustom(
      staff.userId, school.orgId, 'Portal.BrandTest.example');
    expect(added.host).toBe('portal.brandtest.example');
    expect(added.verified_at).toBeNull();
    expect(added.record).toBe(`${VERIFY_RECORD}.portal.brandtest.example`);

    // THE test. Until the school proves it owns this name, the host is inert —
    // otherwise anybody could claim a hostname and capture the branding, and
    // later the traffic, of a domain they do not own.
    expect(await brandingService.forHost('portal.brandtest.example')).toBeNull();
  });

  it('refuses to verify while the record is absent', async () => {
    const domains = await domainService.listAll();
    const custom = domains.find((d) => d.host === 'portal.brandtest.example')!;
    await expect(domainService.verify(staff.userId, custom.id))
      .rejects.toMatchObject({
        response: { error: { code: 'verification_record_missing' } },
      });
  });

  it('refuses a token that belongs to a different domain', async () => {
    const domains = await domainService.listAll();
    const custom = domains.find((d) => d.host === 'portal.brandtest.example')!;
    zone.set(`${VERIFY_RECORD}.portal.brandtest.example`, [['some-other-token']]);
    await expect(domainService.verify(staff.userId, custom.id))
      .rejects.toMatchObject({
        response: { error: { code: 'verification_record_missing' } },
      });
  });

  it('verifies when the record is there, even alongside other TXT records', async () => {
    const domains = await domainService.listAll();
    const custom = domains.find((d) => d.host === 'portal.brandtest.example')!;
    // A real domain carries several TXT records — Google, Microsoft, SPF.
    // Reading only the first would fail for almost every real customer.
    zone.set(`${VERIFY_RECORD}.portal.brandtest.example`, [
      ['google-site-verification=abc'],
      // Long values arrive chunked, because a TXT string caps at 255 bytes.
      [custom.verify_token.slice(0, 8), custom.verify_token.slice(8)],
    ]);
    const verified = await domainService.verify(staff.userId, custom.id);
    expect(verified.verified_at).not.toBeNull();

    const brand = await brandingService.forHost('portal.brandtest.example');
    expect(brand?.tenantId).toBe(school.orgId);
  });

  it('will not let a school claim a subdomain of ours through the custom path', async () => {
    // Otherwise the reserved-name list is decorative: claim `admin.ours` as a
    // "custom" domain and skip it entirely.
    await expect(domainService.addCustom(
      staff.userId, school.orgId, `admin.${MANAGED_SUFFIX}`))
      .rejects.toMatchObject({ response: { error: { code: 'not_yours_to_claim' } } });
  });

  it('does not say who holds a hostname that is taken', async () => {
    // A "that belongs to Sunrise Public School" message would turn this into a
    // way to ask who our customers are.
    const taken = domainService.addCustom(
      staff.userId, neighbour.orgId, 'portal.brandtest.example');
    await expect(taken).rejects.toMatchObject({
      response: { error: { code: 'host_taken' } },
    });
    await expect(taken).rejects.not.toMatchObject({
      response: { error: { message: expect.stringContaining('BRAND') } },
    });
  });
});

describe('what an unauthenticated caller can learn', () => {
  it('returns a name, a mark and colours — and nothing else', async () => {
    await brandingService.set({ tenantId: school.orgId, actorId: owner.userId }, {
      appName: 'Brand Test Portal',
      primaryColour: '#14B8A6',
      supportEmail: 'office@brandtest.example',
    });

    const brand = await brandingService.forHost(`brand-test-school.${MANAGED_SUFFIX}`);
    expect(brand).toMatchObject({
      tenantId: school.orgId,
      name: 'Brand Test Portal',
      primaryColour: '#14B8A6',
      poweredBy: 'paathshalaOS',
    });

    // The exhaustive half: nothing about the school beyond what a sign-in
    // screen needs. A status leaks whether they are behind on payment; a count
    // leaks how big they are; either is somebody else's business.
    expect(Object.keys(brand!).sort()).toEqual([
      'inkColour', 'logoDarkUrl', 'logoUrl', 'name', 'poweredBy',
      'primaryColour', 'supportEmail', 'supportPhone', 'tenantId',
    ]);
  });

  it('says nothing at all for a host nobody registered', async () => {
    expect(await brandingService.forHost('not-a-school.example')).toBeNull();
    expect(await brandingService.forHost('')).toBeNull();
  });

  it('ignores the port, and matches case-insensitively', async () => {
    // A Host header is whatever the browser sent, including a port in
    // development and whatever capitalisation somebody typed.
    const withPort = await brandingService.forHost(
      `BRAND-TEST-SCHOOL.${MANAGED_SUFFIX.toUpperCase()}:3000`);
    expect(withPort?.tenantId).toBe(school.orgId);
  });

  it('stops answering for a school that has been terminated', async () => {
    const other = await createTenant('BRANDC');
    try {
      await domainService.allocateManaged(staff.userId, other.orgId, 'Gone Away School');
      expect(await brandingService.forHost(`gone-away-school.${MANAGED_SUFFIX}`))
        .not.toBeNull();

      await owned((c) => c.query(
        `UPDATE organization SET status = 'terminated' WHERE id = $1`, [other.orgId]));
      expect(await brandingService.forHost(`gone-away-school.${MANAGED_SUFFIX}`))
        .toBeNull();
    } finally {
      await owned((c) => c.query('DELETE FROM tenant_domain WHERE tenant_id = $1',
        [other.orgId]));
      await destroyTenants([other.orgId]);
    }
  });
});

describe('branding cannot carry a payload', () => {
  it('refuses a colour that is not a colour', async () => {
    // These values are interpolated into a CSS custom property on a page we
    // serve under the school's own domain. The anchors on the pattern are the
    // whole defence.
    for (const bad of [
      '#fff; background: url(javascript:alert(1))',
      'red', '#12345', 'rgb(1,2,3)', '#fff }', 'expression(alert(1))',
    ]) {
      await expect(brandingService.set(
        { tenantId: school.orgId, actorId: owner.userId }, { primaryColour: bad },
      )).rejects.toMatchObject({ response: { error: { code: 'not_a_colour' } } });
    }
  });

  it('refuses it at the database too, not only in the service', async () => {
    // Belt and braces: a second code path that forgets the check still cannot
    // store one.
    await expect(owned((c) => c.query(
      `INSERT INTO tenant_branding (tenant_id, primary_colour) VALUES ($1, $2)
       ON CONFLICT (tenant_id) DO UPDATE SET primary_colour = EXCLUDED.primary_colour`,
      [neighbour.orgId, '#fff; background: url(x)'])))
      .rejects.toThrow(/violates check constraint/);
  });

  it('accepts the shapes a designer actually uses', async () => {
    for (const good of ['#14B8A6', '#fff', '#0F172A']) {
      await expect(brandingService.set(
        { tenantId: school.orgId, actorId: owner.userId }, { primaryColour: good },
      )).resolves.toBeTruthy();
    }
  });
});

describe('a school cannot claim its own addresses', () => {
  it('reads its domains but cannot insert one', async () => {
    const mine = await domainService.listForTenant({
      tenantId: school.orgId, actorId: owner.userId,
    });
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((d) => d.tenant_id === school.orgId)).toBe(true);

    // Claiming a hostname has effects outside the school claiming it, so it is
    // a console operation. The grant says so rather than the absence of an
    // endpoint saying so.
    const privs = await withTenant({ tenantId: school.orgId }, async (db) => {
      const { rows } = await db.query<{ ins: boolean }>(
        `SELECT has_table_privilege('tenant_domain', 'INSERT') AS ins`);
      return rows[0]!;
    });
    expect(privs.ins).toBe(false);
  });

  it('does not see another school\'s domains', async () => {
    const mine = await domainService.listForTenant({
      tenantId: school.orgId, actorId: owner.userId,
    });
    expect(mine.some((d) => d.tenant_id === neighbour.orgId)).toBe(false);
  });
});
