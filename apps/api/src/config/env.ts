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
