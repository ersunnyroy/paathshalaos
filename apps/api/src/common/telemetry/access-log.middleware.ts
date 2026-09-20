/**
 * One line per request, from `res.on('finish')` (M23.2).
 *
 * The first version of this was a global interceptor, with a comment saying it
 * ran first so that a request refused by a guard was still logged. That is
 * backwards: Nest runs middleware, then guards, then interceptors, so a guard
 * that throws produces no interceptor call at all — and every 401, every 403
 * from the entitlement ladder, and every refusal inside an impersonation
 * session would have been the requests that went unlogged. Which is to say,
 * exactly the ones an access log exists for.
 *
 * `res.on('finish')` has no such gap. It fires once the response is written,
 * whatever produced it: a handler, a guard, an exception filter, or Nest's own
 * 404. The cost is that the thrown error is no longer in hand, so the status
 * comes off the response and the error code comes from a header the filter
 * sets — which is honest, because the response is what the caller actually got.
 *
 * Middleware also runs inside the request context, so the tenant and actor are
 * read at finish time and are whatever the guards resolved them to.
 */
import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';
import { getContext } from '../request-context.ts';
import { logger } from '../logger.ts';
import { accessLine, levelFor, routeOf } from './access-log.ts';
import { httpDuration } from './metrics.ts';
import { ERROR_CODE_KEY } from '../error.filter.ts';

interface RouteBearing { route?: { path?: string }; baseUrl?: string }

/*
 * The error code reaches this line on the REQUEST object, under a symbol the
 * exception filter sets. Not a response header: that would travel to the
 * client for no reason, and removing it before sending would also remove it
 * from what `res.on('finish')` can read — which is how the first attempt at
 * this managed to log nothing.
 */

@Injectable()
export class AccessLogMiddleware implements NestMiddleware {
  use(req: Request & RouteBearing, res: Response, next: NextFunction): void {
    const started = process.hrtime.bigint();

    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
      // Read at finish: express fills `req.route` once it has matched, which
      // has happened by now even for a request a guard refused.
      const route = routeOf(req.route?.path, req.baseUrl);
      const status = res.statusCode;

      httpDuration.observe(
        { method: req.method, route, status: String(status) }, durationMs);

      const code = (req as unknown as Record<symbol, unknown>)[ERROR_CODE_KEY];
      logger[levelFor(status)](accessLine({
        requestId: getContext()?.requestId ?? 'unknown',
        method: req.method,
        route,
        status,
        durationMs,
        context: getContext(),
        errorCode: typeof code === 'string' ? code : undefined,
      }), 'request');
    });

    next();
  }
}
