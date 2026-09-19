import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { loadDotenv } from './config/load-dotenv.ts';

loadDotenv();

const { loadEnv } = await import('./config/env.ts');
const env = loadEnv();

const { AppModule } = await import('./app.module.ts');
const { logger } = await import('./common/logger.ts');
const { assertAppRoleCannotBypassRls, closePool } = await import('./db/pool.ts');
const { assertAuthRoleIsIsolated, closeAuthPool } = await import('./db/auth-pool.ts');
const { assertHealthRoleIsNarrow, closeHealthPool } = await import('./db/health-pool.ts');
const { assertPlatformRoleCannotReadTenants, closePlatformPool } =
  await import('./db/platform-pool.ts');

async function bootstrap(): Promise<void> {
  // Fail fast and loudly rather than serving traffic with broken isolation.
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

  await app.listen(env.PORT);
  logger.info({ port: env.PORT, env: env.NODE_ENV }, 'api listening');

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      logger.info({ signal }, 'shutting down');
      void app.close().then(closePool).then(closeAuthPool).then(closeHealthPool).then(closePlatformPool)
        .then(() => process.exit(0));
    });
  }
}

bootstrap().catch((err: unknown) => {
  console.error('failed to start:', err instanceof Error ? err.message : err);
  process.exit(1);
});
