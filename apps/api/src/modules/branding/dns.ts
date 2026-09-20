/**
 * One DNS lookup, isolated so it can be replaced in tests.
 *
 * Domain verification is the only thing standing between a school's parents and
 * a sign-in page somebody else controls, so the check has to be real — a test
 * that stubs the whole service proves nothing about it. This is the seam:
 * the tests replace THIS, and everything above it is the code that ships.
 */
import { Resolver } from 'node:dns/promises';

let resolver: { resolveTxt(host: string): Promise<string[][]> } = new Resolver();

/** @internal — used by the tests to supply a DNS server that answers. */
export function setResolver(next: { resolveTxt(host: string): Promise<string[][]> }): void {
  resolver = next;
}

export async function resolveTxtRecords(host: string): Promise<string[]> {
  try {
    const records = await resolver.resolveTxt(host);
    // Each record arrives as an array of strings, because a TXT value longer
    // than 255 bytes is transmitted in chunks and must be rejoined.
    return records.map((chunks) => chunks.join(''));
  } catch {
    // NXDOMAIN and SERVFAIL are both "not verified yet", not errors worth
    // showing somebody who is waiting for DNS to propagate.
    return [];
  }
}
