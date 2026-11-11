import { z } from 'zod';

/**
 * The app refuses to boot on a missing or malformed variable. A config error at
 * startup is cheap; the same error discovered at 8:45am during the attendance
 * spike is not.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3001),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  /** Owns the schema and runs migrations. Never serves a request. */
  DATABASE_OWNER_URL: z.string().url(),
  /** Serves tenant requests. Must not hold BYPASSRLS — asserted at boot. */
  DATABASE_URL: z.string().url(),
  /**
   * Serves login and token refresh only. Holds no privileges on any tenant
   * table, so a bug in the login path cannot reach a student or a fee ledger.
   */
  DATABASE_AUTH_URL: z.string().url(),
  // The third role, for the RESTRICTED columns on student. Defaulted to the
  // auth url shape so an existing .env keeps working; bootstrap creates the
  // role and prints what to set if it differs.
  DATABASE_HEALTH_URL: z.string().url(),
  // The fourth role. Creates schools and lists customers; holds no grant on
  // anything inside one.
  DATABASE_PLATFORM_URL: z.string().url(),

  /** Signing key for access tokens. 32 bytes minimum. */
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(600),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(60),

  REDIS_URL: z.string().url(),

  /**
   * Object storage. Optional, and its absence is a stated condition rather
   * than a crash.
   *
   * Every one of these is optional together: a deployment with no bucket still
   * boots, still serves every other route, and answers file routes with
   * `storage_not_configured` — which is the truth and is actionable. Making
   * them required would mean a school running this on one box has to stand up
   * S3 before they can take attendance.
   *
   * `OBJECT_STORE_ENDPOINT` is for anything S3-compatible: MinIO, Ceph, a
   * school's own hardware. Left unset, the AWS SDK derives the endpoint from
   * the region, which is what a real deployment in `ap-south-1` wants.
   *
   * `OBJECT_STORE_FORCE_PATH_STYLE` is the one that catches people out.
   * Virtual-host addressing (`bucket.host/key`) needs DNS for every bucket;
   * MinIO and most self-hosted stores serve `host/bucket/key` instead, and the
   * failure without this is a 404 that reads like a missing object.
   */
  OBJECT_STORE_BUCKET: z.string().min(1).optional(),
  OBJECT_STORE_REGION: z.string().min(1).default('ap-south-1'),
  OBJECT_STORE_ENDPOINT: z.string().url().optional(),
  OBJECT_STORE_ACCESS_KEY_ID: z.string().min(1).optional(),
  OBJECT_STORE_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  OBJECT_STORE_FORCE_PATH_STYLE: z.coerce.boolean().default(false),
  /** How long an upload or download link is good for. Minutes, not hours. */
  OBJECT_STORE_URL_TTL_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),
  /** The largest single upload this deployment will sign for. 50MB. */
  OBJECT_STORE_MAX_BYTES: z.coerce.number().int().min(1024).default(52_428_800),

  /**
   * ClamAV, for the scan gate 0017 wrote into the schema.
   *
   * `virus_scan_state` defaults to 'pending' and nothing is served until a scan
   * has cleared it. Unset, that rule stands and every upload stays pending and
   * undownloadable — which is useless and is *supposed* to look useless, so
   * that a deployment without a scanner is visibly missing one rather than
   * quietly serving unscanned files.
   */
  CLAMD_HOST: z.string().min(1).optional(),
  CLAMD_PORT: z.coerce.number().int().positive().default(3310),

  /**
   * Browser origins allowed to call this API, comma-separated.
   *
   * There is no wildcard and no default of '*'. The API serves credentials, and
   * a permissive CORS policy on a credentialed API means any page the user
   * visits can read their school's data.
   */
  WEB_ORIGINS: z.string().default('http://localhost:3000'),
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${detail}`);
  }
  cached = parsed.data;
  return cached;
}
