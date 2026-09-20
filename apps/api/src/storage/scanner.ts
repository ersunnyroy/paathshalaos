/**
 * The virus scan 0017 wrote into the schema and nobody built.
 *
 * `file.virus_scan_state` defaults to `'pending'`, not `'clean'`, and the
 * migration says why: *"a file that skipped the scanner must not be
 * downloadable because somebody forgot to set a flag."* That rule has been in
 * the database since M8 and has never had anything to satisfy it, so every
 * file row a test ever created was marked clean by hand.
 *
 * ## Why this speaks clamd rather than calling a service
 *
 * ClamAV's `clamd` takes a stream over a socket and answers in one line. There
 * is no SDK, no account and no egress to a third party — which matters for a
 * product whose customers are Indian schools handling children's birth
 * certificates under the DPDP Act, where sending a scan of a child's documents
 * to somebody else's API is a transfer that has to be justified rather than a
 * convenience.
 *
 * The protocol, in full:
 *
 *   send    `zINSTREAM\0`
 *   send    for each chunk: a 4-byte big-endian length, then the bytes
 *   send    a 4-byte zero to end the stream
 *   receive `stream: OK\0` or `stream: <SignatureName> FOUND\0` or an error
 *
 * That is the whole thing, and it is why this is ninety lines rather than a
 * dependency.
 *
 * ## Unconfigured means nothing is served
 *
 * With no `CLAMD_HOST`, uploads stay `pending` and downloads of them are
 * refused. That is useless on purpose: a deployment without a scanner should
 * look like it is missing one. The alternative — a flag that marks everything
 * clean — is precisely the thing 0017's default was chosen to prevent, and the
 * person who sets it will not be the person who discovers what it did.
 */
import { connect, type Socket } from 'node:net';
import { loadEnv } from '../config/env.ts';

export type ScanVerdict =
  | { state: 'clean' }
  | { state: 'infected'; signature: string }
  | { state: 'failed'; reason: string };

export interface Scanner {
  readonly configured: boolean;
  scan(bytes: AsyncIterable<Uint8Array> | Uint8Array): Promise<ScanVerdict>;
}

const notConfigured: Scanner = {
  configured: false,
  async scan() {
    return {
      state: 'failed',
      // Read back by a job that reports how many files are stuck. The wording
      // is the operator's next action, not an apology.
      reason: 'no scanner configured (set CLAMD_HOST); the file stays pending '
        + 'and will not be served',
    };
  },
};

/** 25MB. clamd's own default StreamMaxLength, and refusing early beats a reset. */
const DEFAULT_MAX_STREAM = 26_214_400;
const CHUNK = 64 * 1024;

export function makeScanner(config: {
  host?: string | undefined; port: number;
  timeoutMs?: number; maxStreamBytes?: number;
}): Scanner {
  if (!config.host) return notConfigured;
  const host = config.host;
  const timeoutMs = config.timeoutMs ?? 30_000;
  const maxStreamBytes = config.maxStreamBytes ?? DEFAULT_MAX_STREAM;

  return {
    configured: true,
    async scan(bytes) {
      let socket: Socket | undefined;
      try {
        return await new Promise<ScanVerdict>((resolve, reject) => {
          socket = connect({ host, port: config.port });
          socket.setTimeout(timeoutMs);

          let reply = '';
          let sent = 0;
          let settled = false;
          const finish = (v: ScanVerdict) => {
            if (settled) return;
            settled = true;
            socket?.end();
            resolve(v);
          };

          socket.on('error', (err) => {
            if (settled) return;
            settled = true;
            // A scanner that is down must not be reported as a clean file.
            // `failed` leaves the row pending and undownloadable, which is the
            // safe direction and the one an operator can see.
            resolve({ state: 'failed', reason: `clamd unreachable: ${err.message}` });
          });
          socket.on('timeout', () => {
            if (settled) return;
            settled = true;
            socket?.destroy();
            resolve({ state: 'failed', reason: `clamd timed out after ${timeoutMs}ms` });
          });

          socket.on('data', (d: Buffer) => {
            reply += d.toString('utf8');
            if (!reply.includes('\0')) return;
            const line = reply.slice(0, reply.indexOf('\0')).trim();
            if (/\bOK$/.test(line)) return finish({ state: 'clean' });
            const found = /^stream:\s*(.+?)\s+FOUND$/.exec(line);
            if (found) return finish({ state: 'infected', signature: found[1]! });
            return finish({ state: 'failed', reason: line || 'clamd said nothing' });
          });

          socket.on('connect', () => {
            void (async () => {
              try {
                socket!.write('zINSTREAM\0');
                for await (const chunk of toChunks(bytes)) {
                  sent += chunk.length;
                  if (sent > maxStreamBytes) {
                    // clamd would cut the connection here and the client would
                    // see a reset with no explanation. Saying it ourselves
                    // gives an operator the number to raise.
                    if (!settled) {
                      settled = true;
                      socket!.destroy();
                      resolve({
                        state: 'failed',
                        reason: `larger than the scanner's ${maxStreamBytes}-byte limit`,
                      });
                    }
                    return;
                  }
                  const header = Buffer.alloc(4);
                  header.writeUInt32BE(chunk.length, 0);
                  socket!.write(header);
                  socket!.write(chunk);
                }
                socket!.write(Buffer.alloc(4)); // zero length ends the stream
              } catch (err: unknown) {
                if (!settled) {
                  settled = true;
                  socket!.destroy();
                  reject(err);
                }
              }
            })();
          });
        });
      } finally {
        socket?.destroy();
      }
    },
  };
}

async function* toChunks(
  bytes: AsyncIterable<Uint8Array> | Uint8Array,
): AsyncIterable<Buffer> {
  if (bytes instanceof Uint8Array) {
    for (let i = 0; i < bytes.length; i += CHUNK) {
      yield Buffer.from(bytes.subarray(i, Math.min(i + CHUNK, bytes.length)));
    }
    return;
  }
  for await (const chunk of bytes) yield Buffer.from(chunk);
}

let cached: Scanner | undefined;

export function scanner(): Scanner {
  if (cached) return cached;
  const env = loadEnv();
  cached = makeScanner({ host: env.CLAMD_HOST, port: env.CLAMD_PORT });
  return cached;
}

/** Test seam. */
export function useScanner(s: Scanner | undefined): void {
  cached = s;
}
