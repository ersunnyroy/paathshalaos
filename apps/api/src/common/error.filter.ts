/**
 * One shape for every failure, including the ones nobody wrote a handler for.
 *
 * `errors.ts` has said since M1 that every error has the same body — a type, a
 * stable code, a message, a request id, a documentation link. That was true of
 * every error the code raised deliberately and false of every other one: an
 * unhandled throw reached Nest's default handler and came back as
 * `{"statusCode":500,"message":"Internal server error"}`, which is a different
 * shape with no request id in it. A client parsing the contract got a parse
 * error on the one response where it most needs to log something useful, and
 * support got a 500 they could not tie to anything.
 *
 * So the filter is here, and it does three things:
 *
 *   - Puts the contract's shape on everything, including a bare throw.
 *   - Logs the cause of a 500 once, with the request id, at error level. The
 *     CAUSE — message and stack — stays in the log and never reaches the body,
 *     because an exception message can contain a query, a row, or a name.
 *   - Leaves the code where the access log can find it.
 *
 * That last one is on the REQUEST object, not a response header. A header
 * would travel to the client for no reason, and removing it before sending
 * would also remove it from what `res.on('finish')` can read — which is where
 * the first attempt at this went wrong.
 */
import {
  Catch, HttpException, type ArgumentsHost, type ExceptionFilter,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { getContext } from './request-context.ts';
import { logger } from './logger.ts';
import type { ErrorBody } from './errors.ts';
import { authFailures, readOnlyRefusals } from './telemetry/metrics.ts';

/** Where the access log looks for the code. Never serialised. */
export const ERROR_CODE_KEY = Symbol.for('paathshala.errorCode');

@Catch()
export class ErrorFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const res = http.getResponse<Response>();
    const req = http.getRequest<Request>();
    const requestId = getContext()?.requestId ?? 'unknown';

    let status = 500;
    let body: ErrorBody;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const payload = exception.getResponse();
      body = isErrorBody(payload) ? payload : {
        // A Nest built-in — NotFoundException from an unmatched route, say.
        // Given the contract's shape rather than passed through, so a client
        // never has to handle two.
        error: {
          type: typeFor(status),
          code: codeFor(status),
          message: messageOf(payload, status),
          request_id: requestId,
          doc_url: `https://docs.paathshala.os/errors/${codeFor(status)}`,
        },
      };
    } else {
      body = {
        error: {
          type: 'internal_error',
          code: 'internal_error',
          // Deliberately incurious. The cause is in the log, tied to the same
          // request id; putting it here would put a query, a row or a person's
          // name into a response.
          message: 'Something went wrong on our side.',
          request_id: requestId,
          doc_url: 'https://docs.paathshala.os/errors/internal_error',
        },
      };
    }

    if (status >= 500) {
      logger.error({
        request_id: requestId,
        err: exception instanceof Error
          ? { message: exception.message, stack: exception.stack }
          : { message: String(exception) },
      }, 'unhandled error');
    }

    count(body.error);

    (req as unknown as Record<symbol, unknown>)[ERROR_CODE_KEY] = body.error.code;
    res.status(status).json(body);
  }
}

/**
 * The counters, incremented here rather than at each throw site.
 *
 * There are eight places that raise an authentication error today and there
 * will be a ninth. Incrementing at each one means the ninth is missed and the
 * graph quietly under-reports, which is worse than not having the graph —
 * a metric that is sometimes right teaches people to distrust the ones that
 * always are. Every failure passes through here exactly once, carrying the
 * code the caller actually received, so this is the one place that cannot
 * drift from what happened.
 *
 * Keyed on the code, which is a closed set the codebase controls. Keying on a
 * message would give the label unbounded cardinality.
 */
function count(error: ErrorBody['error']): void {
  if (error.type === 'authentication_error') {
    authFailures.inc({ reason: error.code });
  }
  if (error.code === 'account_read_only') {
    readOnlyRefusals.inc();
  }
}

function isErrorBody(value: unknown): value is ErrorBody {
  return typeof value === 'object' && value !== null && 'error' in value
    && typeof (value as ErrorBody).error?.code === 'string';
}

function typeFor(status: number): ErrorBody['error']['type'] {
  if (status === 401) return 'authentication_error';
  if (status === 403) return 'permission_error';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'internal_error';
  return 'validation_error';
}

function codeFor(status: number): string {
  return ({
    400: 'invalid_request', 401: 'unauthenticated', 403: 'forbidden',
    404: 'not_found', 405: 'method_not_allowed', 409: 'conflict',
    413: 'payload_too_large', 415: 'unsupported_media_type',
    429: 'rate_limited',
  } as Record<number, string>)[status] ?? (status >= 500 ? 'internal_error' : 'invalid_request');
}

/**
 * Nest's own message, when it has a safe one.
 *
 * Only for statuses below 500. A framework 500 message can carry a driver
 * error, and the whole point of the branch above is that those do not travel.
 */
function messageOf(payload: unknown, status: number): string {
  if (status >= 500) return 'Something went wrong on our side.';
  if (typeof payload === 'string') return payload;
  const message = (payload as { message?: unknown } | null)?.message;
  if (typeof message === 'string') return message;
  return 'The request could not be completed.';
}
