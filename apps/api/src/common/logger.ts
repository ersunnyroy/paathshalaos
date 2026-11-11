import { pino, type Logger } from 'pino';
import { loadEnv } from '../config/env.ts';

const env = loadEnv();

export const logger: Logger = pino({
  level: env.LOG_LEVEL,
  base: { service: 'paathshala-api' },
  redact: {
    // These must never reach a log sink, in any environment.
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'password',
      '*.password',
      'password_hash',
      '*.password_hash',
      'refresh_token',
      '*.refresh_token',
    ],
    censor: '[redacted]',
  },
  ...(env.NODE_ENV === 'development' ? { transport: { target: 'pino/file', options: { destination: 1 } } } : {}),
});

export type { Logger };
