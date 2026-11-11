/**
 * Where an object lives, derived and never supplied.
 *
 * Content-addressed, matching `file_tenant_sha256_key` from 0017: the same
 * document uploaded twice is one row and one object. That index is the reason
 * the digest is in the key rather than a random id — two rows pointing at one
 * object would make deletion a reference-counting problem, and a
 * reference-counting problem that nobody noticed is how a file gets erased out
 * from under a record that still needs it.
 *
 * **No part of this comes from the caller.** A key built from an uploaded
 * filename is a path the uploader controls: `../` escapes the tenant prefix on
 * any store that normalises, a leading `/` changes the meaning on some, and a
 * name in a right-to-left script can be made to read as one thing and address
 * another. The digest is 64 hex characters or this function refuses.
 *
 * The two-level fan-out (`ab/cd/abcd…`) is not decoration. S3 partitions by key
 * prefix, and a bucket where every key starts `tenants/<one busy tenant>/` gets
 * the whole tenant's traffic onto one partition; more to the point, any
 * S3-compatible store that a school self-hosts is usually a filesystem
 * underneath, and a directory with four hundred thousand entries in it is slow
 * in a way that is hard to diagnose later.
 */

const SHA256 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class BadObjectKey extends Error {}

export function objectKey(tenantId: string, sha256: string): string {
  if (!UUID.test(tenantId)) {
    throw new BadObjectKey(`tenant id is not a uuid: ${JSON.stringify(tenantId)}`);
  }
  if (!SHA256.test(sha256)) {
    // Lower-case hex only. 'ABCD…' and 'abcd…' are the same digest and would
    // be two keys, which quietly defeats the content addressing.
    throw new BadObjectKey('sha256 must be 64 lower-case hex characters');
  }
  return `tenants/${tenantId.toLowerCase()}/${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}`;
}

/**
 * The tenant a key belongs to, for the sweeper to check before it deletes.
 *
 * The sweeper reads rows on a maintenance connection with no actor, so the
 * policy is not standing between it and another school's file. Re-deriving the
 * tenant from the key and comparing it to the row's is cheap and catches the
 * one mistake that matters: a loop whose parameter drifted.
 */
export function tenantOfKey(key: string): string | undefined {
  const parts = key.split('/');
  if (parts.length !== 5 || parts[0] !== 'tenants') return undefined;
  const tenant = parts[1]!;
  return UUID.test(tenant) ? tenant : undefined;
}

/**
 * The filename a browser should save it as.
 *
 * Sent in `Content-Disposition` on the presigned GET, so the person who clicks
 * "download" on `birth certificate.pdf` does not get a 64-character hex string
 * with no extension. RFC 6266: `filename*=UTF-8''…` carries anything, and the
 * plain `filename=` is a mangled ASCII fallback for clients that ignore it.
 *
 * Quotes, backslashes, control characters and newlines are stripped rather than
 * escaped. A newline in this header is response splitting, and this value comes
 * from whatever somebody typed at a counter.
 */
export function contentDisposition(filename: string): string {
  const cleaned = filename.replace(/[\u0000-\u001f\u007f"\\]/g, '').trim();
  const fallback = cleaned.replace(/[^\x20-\x7e]/g, '_') || 'download';
  return `attachment; filename="${fallback}"; `
    + `filename*=UTF-8''${encodeURIComponent(cleaned || 'download')}`;
}
