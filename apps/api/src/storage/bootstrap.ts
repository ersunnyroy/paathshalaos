/**
 * Creates the bucket if it is not there, and says which it used.
 *
 * ## Why this is Node and not a container
 *
 * The first version of the compose file ran `minio/mc` as a one-shot container
 * to `mc mb` the bucket. That failed to pull — the tag was written from memory
 * rather than looked up — and took the whole stack down with an error about
 * `docker login`, which is not the problem and sends somebody to the wrong
 * place entirely.
 *
 * The deeper issue is that it was a second image and a second tool to do
 * something this codebase already has a client for. `CreateBucket` is one call
 * on the S3 client the product uses for everything else, so the bucket is
 * created by the same credentials, against the same endpoint, with the same
 * path-style setting — which means if this succeeds, the API's own uploads
 * will too. A separate tool can succeed while the application still cannot
 * reach the store, and that is the failure worth not having.
 *
 * ## Idempotent, and it does not create a bucket by accident
 *
 * Run twice and the second is a no-op. It only ever creates the ONE bucket
 * named in `OBJECT_STORE_BUCKET`, which is why the application itself must
 * never do this on first use: a typo in that variable would silently create a
 * bucket nobody meant, and every file would go into it while the real one sat
 * empty. Setup is a step somebody runs; it is not a side effect of an upload.
 */
import {
  S3Client, CreateBucketCommand, HeadBucketCommand,
} from '@aws-sdk/client-s3';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadDotenv } from '../config/load-dotenv.ts';
import { loadEnv } from '../config/env.ts';

export async function ensureBucket(): Promise<
  { ok: true; bucket: string; created: boolean } | { ok: false; reason: string }
> {
  const env = loadEnv();
  if (!env.OBJECT_STORE_BUCKET) {
    return { ok: false, reason: 'OBJECT_STORE_BUCKET is not set; storage is off' };
  }
  const bucket = env.OBJECT_STORE_BUCKET;

  const client = new S3Client({
    region: env.OBJECT_STORE_REGION,
    ...(env.OBJECT_STORE_ENDPOINT ? { endpoint: env.OBJECT_STORE_ENDPOINT } : {}),
    forcePathStyle: env.OBJECT_STORE_FORCE_PATH_STYLE,
    ...(env.OBJECT_STORE_ACCESS_KEY_ID && env.OBJECT_STORE_SECRET_ACCESS_KEY
      ? { credentials: {
          accessKeyId: env.OBJECT_STORE_ACCESS_KEY_ID,
          secretAccessKey: env.OBJECT_STORE_SECRET_ACCESS_KEY } }
      : {}),
  });

  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
    return { ok: true, bucket, created: false };
  } catch (err: unknown) {
    const status = (err as { $metadata?: { httpStatusCode?: number } })
      .$metadata?.httpStatusCode;
    const name = (err as { name?: string }).name;
    // 404 / NotFound means "make it". 403 means the credentials reach the
    // store and are not allowed to look, which is a permissions problem and
    // not something CreateBucket will fix — reported as itself rather than
    // retried into a second, more confusing error.
    if (status === 403 || name === 'AccessDenied') {
      return { ok: false, reason: `the credentials cannot see bucket "${bucket}" (403)` };
    }
    if (status !== 404 && name !== 'NotFound' && name !== 'NoSuchBucket') {
      return {
        ok: false,
        reason: `could not reach ${env.OBJECT_STORE_ENDPOINT ?? env.OBJECT_STORE_REGION}: `
          + (err instanceof Error ? err.message : String(err)),
      };
    }
  }

  try {
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
    return { ok: true, bucket, created: true };
  } catch (err: unknown) {
    // Two processes racing at start-up both see 404 and both create. Whoever
    // loses gets this, and has exactly what it wanted.
    const name = (err as { name?: string }).name;
    if (name === 'BucketAlreadyOwnedByYou' || name === 'BucketAlreadyExists') {
      return { ok: true, bucket, created: false };
    }
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

const isDirectRun = (() => {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  loadDotenv();
  ensureBucket()
    .then((result) => {
      if (!result.ok) {
        // Exit 0, not 1. Storage is optional — a deployment with no bucket
        // boots and serves every other route — so a setup script must not
        // treat "no storage configured" as a failed build.
        console.log(`object storage: skipped (${result.reason})`);
        return;
      }
      console.log(`object storage: bucket "${result.bucket}" `
        + `${result.created ? 'created' : 'already there'}`);
    })
    .catch((err: unknown) => {
      console.error('object storage: ',
        err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}
