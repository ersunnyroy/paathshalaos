import type { NestMiddleware } from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { runWithContext } from './request-context.ts';

@Injectable()
export class ContextMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const requestId = (req.headers['x-request-id'] as string | undefined) ?? randomUUID();
    res.setHeader('x-request-id', requestId);

    // The tenant is never read from a header. AuthGuard sets it from the
    // verified access token. The development shim that used to live here was
    // removed when M2 landed, as planned — a header-settable tenant is the
    // single most dangerous thing this codebase could contain.
    runWithContext({ requestId }, () => next());
  }
}
