/**
 * The object store, and the first connection this product has ever opened to
 * one (M37).
 *
 * Since M8 the `file` table has carried a bucket, an object key, a size and a
 * digest, and nothing has ever written a byte anywhere. `files.pending_erasure`
 * has been running nightly since M33 counting rows marked deleted whose bytes
 * are still there, with a note in its own run record saying so: *"counted only:
 * this product has no object-storage client"*. That is the liability this file
 * closes.
 *
 * ## Presigned, not proxied
 *
 * Uploads and downloads go **directly** between the browser and the store. The
 * API signs a URL and hands it over; the bytes never pass through it.
 *
 * Proxying would be less code and is the wrong trade. A school scanning four
 * hundred admission files on the first Monday of April would put four hundred
 * multi-megabyte bodies through the request path that is also serving
 * attendance at 8:45am, on a Node process that is single-threaded, with every
 * upload holding a connection for as long as the slowest phone on the school's
 * wifi takes. The store is built for exactly this and the API is not.
 *
 * What the API keeps is the decision: *may this caller have a URL for this
 * object*. That is a policy question and it stays here, on the tenant
 * connection, under row-level security. The signed URL that comes out is a
 * bearer capability with a short life, which is why the TTL is minutes.
 *
 * ## Absence is a condition, not a crash
 *
 * With no bucket configured the app boots, serves every other route, and
 * answers file routes with `storage_not_configured`. A deployment on one box
 * for one school should not have to stand up S3 before it can take attendance,
 * and a 500 is a worse answer than a sentence naming the missing variable.
 */
import {
  S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { loadEnv } from '../config/env.ts';
import { ApiError } from '../common/errors.ts';
import { contentDisposition } from './keys.ts';

export interface StoredObject {
  sizeBytes: number;
  etag: string | undefined;
}

export interface ObjectStore {
  /** The bucket every key in this deployment lives in. */
  readonly bucket: string;
  presignUpload(input: {
    key: string; contentType: string; sizeBytes: number;
  }): Promise<{ url: string; headers: Record<string, string>; expiresIn: number }>;
  presignDownload(input: {
    key: string; filename: string; contentType: string;
  }): Promise<{ url: string; expiresIn: number }>;
  head(key: string): Promise<StoredObject | undefined>;
  remove(key: string): Promise<void>;
}

/** Raised by every method when no bucket is configured. */
export function storageNotConfigured(): never {
  throw ApiError.make('validation_error', 'storage_not_configured',
    'This deployment has no object storage configured, so files cannot be '
    + 'uploaded or served. Set OBJECT_STORE_BUCKET and its credentials.');
}

const unconfigured: ObjectStore = {
  bucket: '',
  presignUpload: () => storageNotConfigured(),
  presignDownload: () => storageNotConfigured(),
  head: () => storageNotConfigured(),
  remove: () => storageNotConfigured(),
};

/**
 * Builds a store from configuration, or the refusing one.
 *
 * Exported and taking its config explicitly so the suite can point it at a
 * local S3 server. A module that read `loadEnv()` at import time could only
 * ever be tested against whatever the test environment happened to hold, which
 * for a storage client means not at all.
 */
export function makeObjectStore(config: {
  bucket?: string | undefined;
  region: string;
  endpoint?: string | undefined;
  accessKeyId?: string | undefined;
  secretAccessKey?: string | undefined;
  forcePathStyle: boolean;
  urlTtlSeconds: number;
}): ObjectStore {
  if (!config.bucket) return unconfigured;

  const client = new S3Client({
    region: config.region,
    ...(config.endpoint ? { endpoint: config.endpoint } : {}),
    forcePathStyle: config.forcePathStyle,
    // Omitted rather than defaulted, so a deployment on an instance role or a
    // service account works: the SDK's own credential chain finds those, and
    // passing empty strings would override it with credentials that cannot
    // sign anything.
    ...(config.accessKeyId && config.secretAccessKey
      ? { credentials: {
          accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey } }
      : {}),
  });
  const expiresIn = config.urlTtlSeconds;
  const bucket = config.bucket;

  return {
    bucket,

    /**
     * A URL the browser can PUT to, and the headers it must send.
     *
     * `ContentLength` and `ContentType` are signed into the URL, so they are
     * not suggestions: a client that declares 2MB and sends 60MB has a
     * signature that does not match and the store refuses it. Without that, a
     * presigned PUT is an unbounded write against somebody else's bill, handed
     * to whoever asked for it.
     *
     * **`signableHeaders` is load-bearing and is easy to leave out.** The SDK
     * signs `content-length` into a presigned PUT by default and does **not**
     * sign `content-type`: the default `X-Amz-SignedHeaders` is
     * `content-length;host`. Without this set, the mime allowlist in the
     * controller is decoration — a client asks for a URL saying
     * `application/pdf`, PUTs `text/html`, and the store holds an HTML file
     * under a type nobody chose.
     *
     * Found by asserting on the signed URL rather than by reading the SDK's
     * behaviour, which is the only way this shows up: every ordinary upload
     * works identically either way.
     *
     * The caller gets the headers back rather than being expected to know
     * them, because a mismatch produces `SignatureDoesNotMatch`, which says
     * nothing about which header was wrong.
     */
    async presignUpload({ key, contentType, sizeBytes }) {
      const url = await getSignedUrl(client, new PutObjectCommand({
        Bucket: bucket, Key: key,
        ContentType: contentType,
        ContentLength: sizeBytes,
      }), {
        expiresIn,
        signableHeaders: new Set(['content-type', 'content-length']),
      });
      return {
        url,
        headers: { 'content-type': contentType, 'content-length': String(sizeBytes) },
        expiresIn,
      };
    },

    /**
     * A URL the browser can GET.
     *
     * The response headers are overridden on the signed request so the store
     * serves the file under the name a person typed rather than under its
     * digest, and as an attachment rather than inline. Inline matters: an HTML
     * file rendered in the browser from the store's own origin is a script
     * running next to whatever else that origin holds.
     */
    async presignDownload({ key, filename, contentType }) {
      const url = await getSignedUrl(client, new GetObjectCommand({
        Bucket: bucket, Key: key,
        ResponseContentDisposition: contentDisposition(filename),
        ResponseContentType: contentType,
      }), { expiresIn });
      return { url, expiresIn };
    },

    async head(key) {
      try {
        const out = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return { sizeBytes: Number(out.ContentLength ?? 0), etag: out.ETag };
      } catch (err: unknown) {
        // A missing object is an answer, not a failure: it is what
        // `confirmUpload` asks about, and the caller's browser may simply not
        // have finished. Everything else — credentials, network, a bucket that
        // does not exist — is a real error and must not read as "no file".
        const name = (err as { name?: string }).name;
        const status = (err as { $metadata?: { httpStatusCode?: number } })
          .$metadata?.httpStatusCode;
        if (name === 'NotFound' || name === 'NoSuchKey' || status === 404) return undefined;
        throw err;
      }
    },

    /**
     * Deletes the object. Missing is success.
     *
     * S3's DELETE is idempotent and returns 204 for a key that was never
     * there, which is the behaviour the erasure sweep needs: a run that was
     * interrupted halfway must be safe to repeat, and a store that had already
     * expired the object through its own lifecycle rule must not stop a row
     * being marked erased.
     */
    async remove(key) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
  };
}

let cached: ObjectStore | undefined;

/** The deployment's store. Built once, from the environment. */
export function objectStore(): ObjectStore {
  if (cached) return cached;
  const env = loadEnv();
  cached = makeObjectStore({
    bucket: env.OBJECT_STORE_BUCKET,
    region: env.OBJECT_STORE_REGION,
    endpoint: env.OBJECT_STORE_ENDPOINT,
    accessKeyId: env.OBJECT_STORE_ACCESS_KEY_ID,
    secretAccessKey: env.OBJECT_STORE_SECRET_ACCESS_KEY,
    forcePathStyle: env.OBJECT_STORE_FORCE_PATH_STYLE,
    urlTtlSeconds: env.OBJECT_STORE_URL_TTL_SECONDS,
  });
  return cached;
}

/** True when this deployment can store a byte. Used to explain, not to branch. */
export function storageIsConfigured(): boolean {
  return objectStore().bucket !== '';
}

/** Test seam: replace the deployment's store, and put it back. */
export function useObjectStore(store: ObjectStore | undefined): void {
  cached = store;
}
