import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { loadDotenv } from './config/load-dotenv.ts';

loadDotenv();

const { loadEnv } = await import('./config/env.ts');
const env = loadEnv();

const { AppModule } = await import('./app.module.ts');
const { logger } = await import('./common/logger.ts');
const { assertSchemaMatchesCode } = await import('./db/schema-guard.ts');
const { assertAppRoleCannotBypassRls, closePool } = await import('./db/pool.ts');
const { closeRedis } = await import('./db/redis.ts');
const { assertAuthRoleIsIsolated, closeAuthPool } = await import('./db/auth-pool.ts');
const { assertHealthRoleIsNarrow, closeHealthPool } = await import('./db/health-pool.ts');
const { assertPlatformRoleCannotReadTenants, closePlatformPool } =
  await import('./db/platform-pool.ts');

async function bootstrap(): Promise<void> {
  // Fail fast and loudly rather than serving traffic with broken isolation,
  // or against a schema this build does not understand.
  await assertSchemaMatchesCode();
  await assertAppRoleCannotBypassRls();
  await assertAuthRoleIsIsolated();
  await assertHealthRoleIsNarrow();
  await assertPlatformRoleCannotReadTenants();

  const app = await NestFactory.create(AppModule, { logger: false });

  // Explicit origins, never '*'. The API is credentialed; a wildcard here means
  // any page the user has open can read their school's records.
  app.enableCors({
    origin: env.WEB_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean),
    credentials: true,
    allowedHeaders: ['content-type', 'authorization', 'x-request-id'],
  });
  app.enableShutdownHooks();

  // In development `node --watch` starts the new process while the old one is
  // still closing its pools, and the new one lost the race for the port about
  // one restart in five: "EADDRINUSE", exit, and an API that stayed down until
  // the next file change. Waiting a few seconds for the port is right there
  // and wrong in production, where a port in use is a second copy running.
  const attempts = env.NODE_ENV === 'production' ? 1 : 40;
  for (let attempt = 1; ; attempt += 1) {
    try {
      await app.listen(env.PORT);
      break;
    } catch (err) {
      const inUse = (err as NodeJS.ErrnoException).code === 'EADDRINUSE';
      if (!inUse || attempt >= attempts) throw err;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  logger.info({ port: env.PORT, env: env.NODE_ENV }, 'api listening');

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      logger.info({ signal }, 'shutting down');
      void app.close().then(closePool).then(closeAuthPool).then(closeHealthPool).then(closePlatformPool)
        // Redis last, and its own failure does not stop the exit: a cache
        // that will not say goodbye is not a reason to hang on SIGTERM.
        .then(closeRedis).catch(() => undefined)
        .then(() => process.exit(0));
    });
  }
}

bootstrap().catch((err: unknown) => {
  console.error('failed to start:', err instanceof Error ? err.message : err);
  process.exit(1);
});
