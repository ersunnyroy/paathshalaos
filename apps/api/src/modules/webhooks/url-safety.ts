/**
 * Where a webhook is allowed to point.
 *
 * A webhook URL is attacker-controlled input with a trusted sender: whatever an
 * institute types here, OUR server connects to, from inside our network, with
 * our credentials on the socket. That is server-side request forgery, and the
 * classic target is the cloud metadata endpoint at 169.254.169.254, which hands
 * out instance credentials to anything that asks from the right place.
 *
 * So the check is on the RESOLVED ADDRESS, not the hostname. A hostname
 * blocklist is defeated by `evil.com` with an A record pointing at 127.0.0.1,
 * and that is not an exotic attack — it is a free DNS record.
 *
 * DNS rebinding — the name resolving publicly when we check and privately when
 * the socket opens — is closed by `resolveSafely()` below, which returns the
 * address it validated so the caller can dial THAT rather than resolving again.
 * A check and a connect that each do their own lookup are two different
 * questions, and the attacker only has to win the second one.
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export interface UrlVerdict { ok: boolean; reason?: string }

/** Ranges that must never be reachable from a tenant-supplied URL. */
function isBlockedV4(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number) as [number, number, number, number];
  if (a === 10) return true;                                  // private
  if (a === 127) return true;                                 // loopback
  if (a === 0) return true;                                   // "this network"
  if (a === 172 && b >= 16 && b <= 31) return true;           // private
  if (a === 192 && b === 168) return true;                    // private
  if (a === 169 && b === 254) return true;                    // link-local + metadata
  if (a === 100 && b >= 64 && b <= 127) return true;          // carrier-grade NAT
  if (a >= 224) return true;                                  // multicast, reserved
  return false;
}

function isBlockedV6(ip: string): boolean {
  const v = ip.toLowerCase();
  if (v === '::1' || v === '::') return true;                 // loopback, unspecified
  if (v.startsWith('fe80')) return true;                      // link-local
  if (v.startsWith('fc') || v.startsWith('fd')) return true;  // unique local
  // IPv4-mapped, e.g. ::ffff:127.0.0.1 — the v4 rules still apply.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
  if (mapped) return isBlockedV4(mapped[1]!);
  return false;
}

/**
 * The checks that need no network: scheme, credentials, and a literal address.
 *
 * Separated so the resolving path can do its DNS lookup exactly ONCE. An
 * earlier version had `resolveSafely` call `checkWebhookUrl`, which resolved,
 * and then resolve again itself — two lookups, which is precisely the gap the
 * whole exercise was closing. It was invisible behaviourally and found by a
 * mutation that deleted the second set of checks and broke nothing.
 */
export function checkUrlShape(raw: string):
  { ok: true; url: URL; host: string } | { ok: false; reason: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'malformed_url' };
  }

  // Also a CHECK constraint on the column. Both, because the constraint cannot
  // be bypassed and this one gives the tenant a sentence instead of a 500.
  if (url.protocol !== 'https:') return { ok: false, reason: 'https_required' };
  if (url.username || url.password) return { ok: false, reason: 'credentials_in_url' };

  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) {
    const blocked = isIP(host) === 4 ? isBlockedV4(host) : isBlockedV6(host);
    if (blocked) return { ok: false, reason: 'private_address' };
  }
  return { ok: true, url, host };
}

/** Every resolved address must be public; the first is the one to dial. */
export function firstSafeAddress(
  addresses: Array<{ address: string; family: number }>,
): { ok: true; address: string; family: number } | { ok: false; reason: string } {
  if (addresses.length === 0) return { ok: false, reason: 'dns_resolution_failed' };
  // EVERY address, not the first. A host answering with one public and one
  // loopback record would otherwise pass whenever the resolver happened to
  // order them conveniently.
  for (const { address, family } of addresses) {
    if (family === 4 ? isBlockedV4(address) : isBlockedV6(address)) {
      return { ok: false, reason: 'private_address' };
    }
  }
  const first = addresses[0]!;
  return { ok: true, address: first.address, family: first.family };
}

export async function checkWebhookUrl(
  raw: string, resolver: Resolver = systemResolver,
): Promise<UrlVerdict> {
  const shape = checkUrlShape(raw);
  if (!shape.ok) return { ok: false, reason: shape.reason };
  const { host } = shape;

  if (isIP(host)) return { ok: true };

  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await resolver(host);
  } catch {
    return { ok: false, reason: 'dns_resolution_failed' };
  }
  const safe = firstSafeAddress(addresses);
  return safe.ok ? { ok: true } : { ok: false, reason: safe.reason };
}

/**
 * Resolves a URL to one address that has been validated, for the caller to dial.
 *
 * This is the half that actually closes rebinding. `checkWebhookUrl` above
 * answers "may this endpoint exist"; this answers "where am I connecting right
 * now, and is it still safe" — and hands back the address so nothing resolves
 * the name a second time. The gap between two lookups is the whole attack: a
 * record with a one-second TTL is public when we validate and 127.0.0.1 when we
 * connect, and both checks pass.
 *
 * The connection then needs the original hostname in the Host header and for
 * TLS, or every certificate fails to verify — see `dialTarget` in the sender.
 */
export interface SafeTarget {
  /** The literal address to connect to. */
  address: string;
  family: 4 | 6;
  /** The original hostname, for Host and SNI. */
  host: string;
  port: number;
  /** The path and query, unchanged. */
  pathAndQuery: string;
}

/**
 * How a name is resolved. Injectable purely so the hostname path can be tested.
 *
 * Without a seam here the only reachable branch in a sandbox is the literal-IP
 * one, which returns before the address checks run — so a mutation deleting
 * those checks passed the whole suite. A security check nothing can exercise is
 * a comment.
 */
export type Resolver = (host: string) => Promise<Array<{ address: string; family: number }>>;

const systemResolver: Resolver = (host) => lookup(host, { all: true });

export async function resolveSafely(
  raw: string,
  resolver: Resolver = systemResolver,
): Promise<{ ok: true; target: SafeTarget } | { ok: false; reason: string }> {
  const shape = checkUrlShape(raw);
  if (!shape.ok) return { ok: false, reason: shape.reason };
  const { url, host } = shape;

  const port = url.port ? Number(url.port) : 443;
  const pathAndQuery = `${url.pathname}${url.search}`;

  if (isIP(host)) {
    return {
      ok: true,
      target: { address: host, family: isIP(host) === 4 ? 4 : 6, host, port, pathAndQuery },
    };
  }

  // ONE lookup, and the address it returns is the address dialled. Calling
  // checkWebhookUrl here instead would resolve a second time, and the gap
  // between two lookups is the entire attack.
  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await resolver(host);
  } catch {
    return { ok: false, reason: 'dns_resolution_failed' };
  }

  const safe = firstSafeAddress(addresses);
  if (!safe.ok) return { ok: false, reason: safe.reason };

  return {
    ok: true,
    target: {
      address: safe.address,
      family: safe.family === 4 ? 4 : 6,
      host, port, pathAndQuery,
    },
  };
}
