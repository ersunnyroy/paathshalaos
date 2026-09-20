/**
 * One line per request (M23.2).
 *
 * The line answers the question support actually gets asked: *what happened to
 * this person's request*. So it carries who (tenant, actor, whether somebody
 * was standing in for them), what (method and matched ROUTE), how it went
 * (status, duration) and the id that ties it to everything else.
 *
 * Two deliberate omissions.
 *
 * The **path is never logged raw**. `/v1/students/8f3a…` and `/v1/students/1b2c…`
 * are the same endpoint, and logging them separately gives a metrics label a
 * cardinality equal to the number of learners in every school we host — which
 * is how a monitoring bill exceeds a hosting bill. The matched route is logged
 * instead; the ids are in the request id's trail if anybody needs them.
 *
 * And **nothing from the body, ever**. Not on success and not on failure. A
 * validation error on a fee payment is exactly the moment somebody reaches for
 * "just log the payload to see what they sent", and the payload is a parent's
 * bank details. The error code says what was wrong with it.
 */
import type { RequestContext } from '../request-context.ts';

export interface AccessLogLine {
  request_id: string;
  method: string;
  route: string;
  status: number;
  duration_ms: number;
  tenant_id?: string;
  actor_id?: string;
  api_client_id?: string;
  /** Present only inside a platform entry session. */
  impersonation_id?: string;
  error_code?: string;
  /** Set when the request was slow enough that somebody should look. */
  slow?: true;
}

/**
 * Where "slow" starts.
 *
 * A second, not a tenth. The point of the flag is that a human can search for
 * it and find a short list; a threshold that matches a fifth of all traffic is
 * a threshold nobody searches for twice.
 */
export const SLOW_REQUEST_MS = 1000;

/**
 * The route, not the path.
 *
 * Express exposes the matched route pattern once a handler has run. When it is
 * absent — a 404, or a failure before routing — the raw path must NOT be
 * substituted, because that is the unbounded-cardinality case this exists to
 * avoid, and a flood of 404s on random paths is precisely when it would bite.
 */
export function routeOf(
  matched: string | undefined, baseUrl: string | undefined,
): string {
  const route = `${baseUrl ?? ''}${matched ?? ''}`;
  return route.length > 0 ? route : 'unmatched';
}

export function accessLine(input: {
  requestId: string;
  method: string;
  route: string;
  status: number;
  durationMs: number;
  context?: RequestContext | undefined;
  errorCode?: string | undefined;
}): AccessLogLine {
  const line: AccessLogLine = {
    request_id: input.requestId,
    method: input.method,
    route: input.route,
    status: input.status,
    // Rounded: sub-millisecond precision on an HTTP request is noise that
    // makes two identical lines look different.
    duration_ms: Math.round(input.durationMs),
  };
  const ctx = input.context;
  if (ctx?.tenantId) line.tenant_id = ctx.tenantId;
  if (ctx?.actorId) line.actor_id = ctx.actorId;
  if (ctx?.apiClientId) line.api_client_id = ctx.apiClientId;
  // Logged on every request inside an entry session, not only on writes. "Who
  // was in our records" is a question a school asks about reads.
  if (ctx?.impersonationId) line.impersonation_id = ctx.impersonationId;
  if (input.errorCode) line.error_code = input.errorCode;
  if (input.durationMs >= SLOW_REQUEST_MS) line.slow = true;
  return line;
}

/**
 * Which log level a status deserves.
 *
 * 4xx is `info`, not `warn`. A 401 on a refresh, a 404 on a bookmark and a 422
 * on a mistyped form are the system working; logging them as warnings trains
 * everybody to ignore warnings, and then a real one goes past unseen. 429 is
 * the exception — one client being rate limited is noise, but it is the shape
 * of an attack often enough to be worth seeing.
 */
export function levelFor(status: number): 'info' | 'warn' | 'error' {
  if (status >= 500) return 'error';
  if (status === 429) return 'warn';
  return 'info';
}
