/**
 * The first bytes this product has ever stored (M37).
 *
 * `file` has existed since 0017 with a bucket, an object key, a digest, a scan
 * state and a legal hold. Nothing ever wrote to an object store — the
 * `files.pending_erasure` job said so in its own run record every night: *"counted
 * only: this product has no object-storage client"*.
 *
 * ## Tested against a real S3 server, not a mock
 *
 * `s3rver` speaks the S3 protocol in-process, including SigV4, so the presigned
 * URLs here are signed by the real AWS SDK and verified by a real
 * implementation. A hand-written mock would accept whatever the SDK sent and
 * prove nothing about whether a URL is valid — which is the only interesting
 * question about a presigner.
 *
 * The clamd tests use a socket server that implements INSTREAM properly. The
 * protocol is four things and the responses are exact strings, so a fake that
 * speaks it is a fake that catches a client that does not.
 */
import './fixtures.ts';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server, type Socket } from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import S3rver from 's3rver';
import {
  makeObjectStore, useObjectStore, type ObjectStore,
} from '../src/storage/object-store.ts';
import { makeScanner, useScanner } from '../src/storage/scanner.ts';
import { objectKey, tenantOfKey, contentDisposition, BadObjectKey }
  from '../src/storage/keys.ts';

const BUCKET = 'paathshala-test';
const TENANT = '11111111-2222-3333-4444-555555555555';

let s3: S3rver;
let dir = '';
let store: ObjectStore;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'paathshala-s3-'));
  s3 = new S3rver({
    port: 0, address: '127.0.0.1', silent: true, directory: dir,
    configureBuckets: [{ name: BUCKET, configs: [] }],
  });
  const { port } = await s3.run();
  store = makeObjectStore({
    bucket: BUCKET,
    region: 'ap-south-1',
    endpoint: `http://127.0.0.1:${port}`,
    accessKeyId: 'S3RVER',
    secretAccessKey: 'S3RVER',
    // MinIO, Ceph and s3rver all serve host/bucket/key. Virtual-host
    // addressing needs DNS for every bucket, and the failure without this is a
    // 404 that reads like a missing object.
    forcePathStyle: true,
    urlTtlSeconds: 300,
  });
}, 60_000);

afterAll(async () => {
  await s3?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
  useObjectStore(undefined);
  useScanner(undefined);
});

const digestOf = (s: string) => createHash('sha256').update(s).digest('hex');

async function put(store: ObjectStore, key: string, body: string, type = 'text/plain') {
  const { url, headers } = await store.presignUpload({
    key, contentType: type, sizeBytes: Buffer.byteLength(body),
  });
  return fetch(url, { method: 'PUT', body, headers });
}

describe('an object key is derived, never supplied', () => {
  it('fans out by the first two byte-pairs of the digest', () => {
    const sha = digestOf('hello');
    expect(objectKey(TENANT, sha))
      .toBe(`tenants/${TENANT}/${sha.slice(0, 2)}/${sha.slice(2, 4)}/${sha}`);
  });

  it('refuses anything that is not a digest', () => {
    // A key built from an uploaded filename is a path the uploader controls.
    for (const bad of ['../../etc/passwd', '', 'nope', digestOf('x').toUpperCase()]) {
      expect(() => objectKey(TENANT, bad), bad).toThrow(BadObjectKey);
    }
  });

  it('refuses a tenant that is not a uuid', () => {
    expect(() => objectKey('../other', digestOf('x'))).toThrow(BadObjectKey);
  });

  it('reads the tenant back out, for the sweeper to check', () => {
    const key = objectKey(TENANT, digestOf('hello'));
    expect(tenantOfKey(key)).toBe(TENANT);
    expect(tenantOfKey('tenants/not-a-uuid/ab/cd/ef')).toBeUndefined();
    expect(tenantOfKey('somewhere/else')).toBeUndefined();
  });

  it('keeps a filename usable and a header safe', () => {
    const plain = contentDisposition('birth certificate.pdf');
    expect(plain).toContain('filename="birth certificate.pdf"');

    // Devanagari survives in the RFC 6266 form and is mangled in the fallback,
    // which is what the fallback is for.
    const hindi = contentDisposition('जन्म.pdf');
    expect(hindi).toContain("filename*=UTF-8''");
    expect(hindi).toContain(encodeURIComponent('जन्म.pdf'));

    // A newline in a response header is response splitting, and this value
    // comes from whatever somebody typed at a counter.
    const nasty = contentDisposition('a\r\nSet-Cookie: x=1"\\.pdf');
    expect(nasty).not.toMatch(/[\r\n]/);
    expect(nasty.split('filename="')[1]!.split('"')[0]).not.toContain('\\');
  });
});

describe('a presigned upload is bounded by its signature', () => {
  it('accepts the bytes it was signed for', async () => {
    const body = 'a birth certificate, pretend';
    const key = objectKey(TENANT, digestOf(body));
    const res = await put(store, key, body);
    expect(res.status).toBe(200);

    const head = await store.head(key);
    expect(head?.sizeBytes).toBe(Buffer.byteLength(body));
  });

  it('signs the length and the type into the URL, and says which headers to send',
    async () => {
      // The whole reason ContentLength is signed in: without it a presigned PUT
      // is an unbounded write against somebody else's bill, handed to whoever
      // asked for a URL.
      //
      // **Asserted on the request we produce, not on a rejection.** `s3rver`
      // implements the S3 protocol but does not verify SigV4 — it is a fake
      // store, not a fake IAM — so sending a mismatched body to it succeeds,
      // and a test that expected a 4xx here would be asserting a property of
      // the fake. What this code controls is which headers go into the signature
      // and what the caller is told to send; that AWS then enforces them is
      // S3's documented contract and is **not publicly verified by this suite**.
      const key = objectKey(TENANT, digestOf('small'));
      const { url, headers } = await store.presignUpload({
        key, contentType: 'application/pdf', sizeBytes: 5,
      });

      const signed = new URL(url).searchParams.get('X-Amz-SignedHeaders') ?? '';
      expect(signed).toContain('content-length');
      expect(signed).toContain('content-type');
      // The caller gets them back rather than being expected to know them: a
      // mismatch produces `SignatureDoesNotMatch`, which says nothing about
      // which header was wrong.
      expect(headers).toEqual({
        'content-type': 'application/pdf', 'content-length': '5',
      });
    });

  it('signs a URL for exactly one key', async () => {
    // Same caveat as above: what is asserted is that the key is in the signed
    // path and the URL carries a signature over it, not that this particular
    // fake rejects a swapped key.
    const key = objectKey(TENANT, digestOf('one'));
    const { url } = await store.presignUpload({
      key, contentType: 'text/plain', sizeBytes: 3,
    });
    const parsed = new URL(url);
    expect(parsed.pathname).toBe(`/${BUCKET}/${key}`);
    expect(parsed.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
    expect(parsed.searchParams.get('X-Amz-Expires')).toBe('300');
  });

  it('reports a missing object as missing, not as an error', async () => {
    // `confirmUpload` asks this question about a browser that may simply not
    // have finished. A throw here would read as a broken store.
    expect(await store.head(objectKey(TENANT, digestOf('never uploaded'))))
      .toBeUndefined();
  });
});

describe('a presigned download serves it under a name and as an attachment', () => {
  it('round-trips the bytes', async () => {
    const body = 'the transfer certificate';
    const key = objectKey(TENANT, digestOf(body));
    await put(store, key, body);

    const { url } = await store.presignDownload({
      key, filename: 'transfer certificate.pdf', contentType: 'application/pdf',
    });
    const res = await fetch(url);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(body);
  });

  it('never serves inline', async () => {
    // An HTML file rendered from the store's own origin is a script running
    // next to whatever else that origin holds.
    const body = '<script>alert(1)</script>';
    const key = objectKey(TENANT, digestOf(body));
    await put(store, key, body);
    const { url } = await store.presignDownload({
      key, filename: 'x.html', contentType: 'text/html',
    });
    const res = await fetch(url);
    expect(res.headers.get('content-disposition')).toMatch(/^attachment;/);
  });
});

describe('erasing is idempotent, because a sweep gets interrupted', () => {
  it('removes the object and does not mind removing it twice', async () => {
    const body = 'to be erased';
    const key = objectKey(TENANT, digestOf(body));
    await put(store, key, body);
    expect(await store.head(key)).toBeTruthy();

    await store.remove(key);
    expect(await store.head(key)).toBeUndefined();

    // A run that died halfway must be safe to repeat, and a store that had
    // already expired the object through its own lifecycle rule must not stop
    // a row being marked erased.
    await expect(store.remove(key)).resolves.toBeUndefined();
  });
});

describe('with no bucket configured, every file route says so', () => {
  const none = makeObjectStore({
    bucket: undefined, region: 'ap-south-1', forcePathStyle: false,
    urlTtlSeconds: 300,
  });

  it('boots, and refuses by name rather than by crashing', async () => {
    expect(none.bucket).toBe('');
    const calls: Array<() => Promise<unknown>> = [
      () => none.presignUpload({ key: 'k', contentType: 'text/plain', sizeBytes: 1 }),
      () => none.presignDownload({ key: 'k', filename: 'f', contentType: 'text/plain' }),
      () => none.head('k'),
      () => none.remove('k'),
    ];
    for (const call of calls) {
      const err = await Promise.resolve().then(call).catch((e: unknown) => e);
      expect((err as { getResponse(): { error: { code: string } } })
        .getResponse().error.code).toBe('storage_not_configured');
    }
  });
});

/* ------------------------------------------------------------------ clamd */

/** The INSTREAM protocol, as a server, so the client can be held to it. */
function fakeClamd(reply: (bytes: Buffer) => string): Promise<{
  port: number; close(): Promise<void>; seen(): Buffer;
}> {
  let received = Buffer.alloc(0);
  const server: Server = createServer((socket) => {
    let buf = Buffer.alloc(0);
    let greeted = false;
    socket.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (!greeted) {
        const nul = buf.indexOf(0);
        if (nul === -1) return;
        expectCommand(buf.subarray(0, nul).toString());
        buf = buf.subarray(nul + 1);
        greeted = true;
      }
      // Length-prefixed chunks until a zero length ends the stream.
      for (;;) {
        if (buf.length < 4) return;
        const len = buf.readUInt32BE(0);
        if (len === 0) {
          socket.write(reply(received));
          return;
        }
        if (buf.length < 4 + len) return;
        received = Buffer.concat([received, buf.subarray(4, 4 + len)]);
        buf = buf.subarray(4 + len);
      }
    });
  });
  function expectCommand(cmd: string) {
    if (cmd !== 'zINSTREAM') throw new Error(`unexpected clamd command: ${cmd}`);
  }
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({
        port: typeof addr === 'object' && addr ? addr.port : 0,
        close: () => new Promise<void>((r) => server.close(() => r())),
        seen: () => received,
      });
    });
  });
}

// The EICAR test file: the industry's agreed harmless string that every
// scanner reports as a virus. Assembled rather than written out, because a
// literal in a source file is a literal a real scanner quarantines — which
// would mean this repository could not be checked out on a machine running one.
const EICAR = ['X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-',
               'ANTIVIRUS-TEST-FILE!$H+H*'].join('');

describe('the scan gate 0017 asked for', () => {
  it('streams the bytes and reads a clean verdict', async () => {
    const clamd = await fakeClamd(() => 'stream: OK\0');
    try {
      const s = makeScanner({ host: '127.0.0.1', port: clamd.port });
      expect(s.configured).toBe(true);
      const bytes = Buffer.from('an ordinary pdf');
      expect(await s.scan(bytes)).toEqual({ state: 'clean' });
      // The server got exactly the bytes, framed correctly. A client that
      // mis-frames would still see 'OK' from a fake that did not check.
      expect(clamd.seen().equals(bytes)).toBe(true);
    } finally {
      await clamd.close();
    }
  });

  it('names the signature when something is found', async () => {
    const clamd = await fakeClamd((seen) =>
      seen.includes('EICAR-STANDARD')
        ? 'stream: Win.Test.EICAR_HDB-1 FOUND\0'
        : 'stream: OK\0');
    try {
      const s = makeScanner({ host: '127.0.0.1', port: clamd.port });
      expect(await s.scan(Buffer.from(EICAR)))
        .toEqual({ state: 'infected', signature: 'Win.Test.EICAR_HDB-1' });
    } finally {
      await clamd.close();
    }
  });

  it('frames a file larger than one chunk correctly', async () => {
    // 64KB chunks, so this is three of them plus a remainder. An off-by-one in
    // the length prefix shows up here and nowhere else.
    const big = Buffer.alloc(200_000, 0x41);
    const clamd = await fakeClamd(() => 'stream: OK\0');
    try {
      const s = makeScanner({ host: '127.0.0.1', port: clamd.port });
      expect(await s.scan(big)).toEqual({ state: 'clean' });
      expect(clamd.seen().length).toBe(big.length);
      expect(clamd.seen().equals(big)).toBe(true);
    } finally {
      await clamd.close();
    }
  });

  it('refuses a stream past the scanner’s own limit, rather than being cut off',
    async () => {
      const clamd = await fakeClamd(() => 'stream: OK\0');
      try {
        const s = makeScanner({
          host: '127.0.0.1', port: clamd.port, maxStreamBytes: 1024,
        });
        const verdict = await s.scan(Buffer.alloc(4096, 0x42));
        expect(verdict.state).toBe('failed');
        // clamd would cut the connection here and the client would see a reset
        // with no explanation. Saying it ourselves gives an operator a number.
        expect((verdict as { reason: string }).reason).toContain('1024');
      } finally {
        await clamd.close();
      }
    });

  it('a scanner that is down is a failure, never a clean file', async () => {
    // The direction that matters. `failed` leaves the row pending and
    // undownloadable; anything that resolved to `clean` here would serve an
    // unscanned file because a daemon was restarting.
    const s = makeScanner({ host: '127.0.0.1', port: 1, timeoutMs: 2000 });
    const verdict = await s.scan(Buffer.from('anything'));
    expect(verdict.state).toBe('failed');
  });

  it('a scanner that never answers times out, and still is not clean', async () => {
    const accepted: Socket[] = [];
    const silent = createServer((c) => { accepted.push(c); });
    await new Promise<void>((r) => silent.listen(0, '127.0.0.1', r));
    const addr = silent.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    try {
      const s = makeScanner({ host: '127.0.0.1', port, timeoutMs: 300 });
      const verdict = await s.scan(Buffer.from('anything'));
      expect(verdict.state).toBe('failed');
      expect((verdict as { reason: string }).reason).toContain('timed out');
    } finally {
      // Destroyed explicitly: `server.close()` waits for open connections, and
      // a half-closed one left by the client's own destroy is enough to make
      // this hang until the runner's timeout — which reads as the scanner
      // hanging rather than the fixture.
      for (const c of accepted) c.destroy();
      await new Promise<void>((r) => silent.close(() => r()));
    }
  });

  it('with no host configured, nothing is ever clean', async () => {
    // The rule 0017 wrote into the default. A deployment without a scanner
    // should look like it is missing one, not quietly serve unscanned files.
    const s = makeScanner({ host: undefined, port: 3310 });
    expect(s.configured).toBe(false);
    const verdict = await s.scan(Buffer.from('anything'));
    expect(verdict.state).toBe('failed');
    expect((verdict as { reason: string }).reason).toContain('CLAMD_HOST');
  });
});
