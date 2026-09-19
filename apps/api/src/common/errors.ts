import { HttpException, HttpStatus } from '@nestjs/common';
import type { ZodError } from 'zod';
import { getContext } from './request-context.ts';

/**
 * One error shape for every failure, per the API contract. `type` is one of a
 * small closed set clients can switch on; `code` is a stable string; `message`
 * is for a human and must never contain another tenant's data or an internal
 * identifier.
 */
export type ErrorType =
  | 'validation_error'
  | 'authentication_error'
  | 'permission_error'
  | 'not_found'
  | 'conflict'
  | 'rate_limited'
  | 'provider_error'
  | 'internal_error';

export interface ErrorBody {
  error: {
    type: ErrorType;
    code: string;
    message: string;
    request_id: string;
    doc_url: string;
    details?: Array<{ path: string; issue: string }>;
  };
}

const STATUS: Record<ErrorType, HttpStatus> = {
  validation_error: HttpStatus.UNPROCESSABLE_ENTITY,
  authentication_error: HttpStatus.UNAUTHORIZED,
  permission_error: HttpStatus.FORBIDDEN,
  not_found: HttpStatus.NOT_FOUND,
  conflict: HttpStatus.CONFLICT,
  rate_limited: HttpStatus.TOO_MANY_REQUESTS,
  provider_error: HttpStatus.BAD_GATEWAY,
  internal_error: HttpStatus.INTERNAL_SERVER_ERROR,
};

function body(
  type: ErrorType,
  code: string,
  message: string,
  details?: ErrorBody['error']['details'],
): ErrorBody {
  return {
    error: {
      type,
      code,
      message,
      request_id: getContext()?.requestId ?? 'unknown',
      doc_url: `https://docs.paathshala.os/errors/${code}`,
      ...(details ? { details } : {}),
    },
  };
}

export const ApiError = {
  notFound: (code: string, message: string) => body('not_found', code, message),

  make(type: ErrorType, code: string, message: string, details?: ErrorBody['error']['details']) {
    return new HttpException(body(type, code, message, details), STATUS[type]);
  },

  fromZod(error: ZodError): HttpException {
    return this.make(
      'validation_error',
      'invalid_request',
      'The request body failed validation.',
      error.issues.map((i) => ({ path: i.path.join('.') || '(root)', issue: i.message })),
    );
  },
};
