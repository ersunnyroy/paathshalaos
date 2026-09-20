import type { NestMiddleware } from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { runWithContext } from './request-context.ts';
import { normaliseRequestId } from './telemetry/request-id.ts';

@Injectable()
export class ContextMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    // Normalised, not taken as given. The header is a caller's choice, and
    // this value is echoed into a response header, written into every log line
    // and used as the key support searches by — see telemetry/request-id.ts.
    const requestId = normaliseRequestId(req.headers['x-request-id'], randomUUID);
    res.setHeader('x-request-id', requestId);

    // The tenant is never read from a header. AuthGuard sets it from the
    // verified access token. The development shim that used to live here was
    // removed when M2 landed, as planned — a header-settable tenant is the
    // single most dangerous thing this codebase could contain.
    runWithContext({ requestId }, () => next());
  }
}
