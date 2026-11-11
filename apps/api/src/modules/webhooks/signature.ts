/**
 * The webhook signature scheme, and the verifier we hand to integrators.
 *
 * The header looks like this:
 *
 *   X-Paathshala-Signature: t=1758182400,v1=<hex>,v1=<hex>
 *
 * Four decisions, each preventing a specific attack:
 *
 *   **The timestamp is INSIDE the signed material**, not merely alongside it.
 *   Signing the body alone lets anyone who once saw a valid request replay it
 *   forever; signing `t.body` means a replay has to reuse `t`, which the
 *   tolerance below then rejects.
 *
 *   **The comparison is constant time.** A verifier written with `===` leaks,
 *   byte by byte, how much of a guess was right — which is enough to forge a
 *   signature over enough requests. It is the single most common mistake in
 *   hand-written webhook verifiers, so ours does not make it and the one we
 *   publish does not either.
 *
 *   **More than one v1 is allowed.** During a secret rotation both the old and
 *   the new signature are sent, and the receiver accepts either. Without this,
 *   rotating a secret means a flag day where both sides deploy in the same
 *   minute or deliveries fail.
 *
 *   **Only the RAW body is signed.** Not a parsed-and-re-serialised object: key
 *   order and number formatting both survive a round trip through JSON only by
 *   luck, and a verifier that re-serialises will reject perfectly good requests
 *   on whichever payload first contains a float.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/** How far a timestamp may be from now. Clock skew is real; an hour is not. */
export const TOLERANCE_SECONDS = 300;

export function signedPayload(timestamp: number, rawBody: string): string {
  return `${timestamp}.${rawBody}`;
}

export function sign(secret: string, timestamp: number, rawBody: string): string {
  return createHmac('sha256', secret)
    .update(signedPayload(timestamp, rawBody))
    .digest('hex');
}

export function header(timestamp: number, signatures: readonly string[]): string {
  return [`t=${timestamp}`, ...signatures.map((s) => `v1=${s}`)].join(',');
}

export interface VerifyResult { ok: boolean; reason?: string }

/**
 * The reference verifier. This is the code an institute's engineer copies into
 * their own service, so it is written to be read rather than to be clever.
 */
export function verify(
  headerValue: string | undefined,
  rawBody: string,
  secret: string,
  now: number = Math.floor(Date.now() / 1000),
  tolerance: number = TOLERANCE_SECONDS,
): VerifyResult {
  if (!headerValue) return { ok: false, reason: 'missing_signature' };

  let timestamp: number | undefined;
  const candidates: string[] = [];
  for (const part of headerValue.split(',')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === 't') timestamp = Number(value);
    else if (key === 'v1') candidates.push(value);
  }

  if (timestamp === undefined || !Number.isFinite(timestamp)) {
    return { ok: false, reason: 'malformed_signature' };
  }
  if (candidates.length === 0) return { ok: false, reason: 'malformed_signature' };

  // Checked BEFORE the HMAC, so a flood of replayed requests is rejected without
  // doing the cryptography each time.
  if (Math.abs(now - timestamp) > tolerance) {
    return { ok: false, reason: 'timestamp_out_of_tolerance' };
  }

  const expected = Buffer.from(sign(secret, timestamp, rawBody), 'utf8');
  for (const candidate of candidates) {
    const given = Buffer.from(candidate, 'utf8');
    // timingSafeEqual throws on a length mismatch, which would itself be a
    // length oracle — so the length check is explicit and the compare only runs
    // on equal lengths.
    if (given.length === expected.length && timingSafeEqual(given, expected)) {
      return { ok: true };
    }
  }
  return { ok: false, reason: 'no_matching_signature' };
}
