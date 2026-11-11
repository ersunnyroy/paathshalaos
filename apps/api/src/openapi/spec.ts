/**
 * The published API contract.
 *
 * Built from the same Zod schemas the handlers validate with, so a request
 * shape cannot be documented one way and enforced another. The alternative — a
 * hand-maintained YAML — is correct on the day it is written and wrong within a
 * sprint, and a wrong spec is worse than none: an integrator trusts it, builds
 * against it, and discovers the difference in production.
 *
 * What is in here is deliberately only `/api/v1`. The app's own `/v1` routes
 * serve our web client and change whenever a screen does; publishing them would
 * be a promise we have no intention of keeping. A contract is the set of things
 * you have decided not to break.
 */
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

export const API_VERSION = '1.0.0';

/* ------------------------------------------------------------------ pieces */

const uuid = z.string().uuid();
const paise = z.string().describe(
  'An exact decimal as a string. Never a JSON number: a JSON number is an ' +
  'IEEE double, and money that has been through one is no longer the amount owed.');

export const pageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: uuid.optional().describe(
    'The `next_cursor` from the previous page. Keyset, not offset: a row ' +
    'inserted mid-walk shifts every later offset page by one, so an offset ' +
    'client silently skips a record.'),
});

const student = z.object({
  id: uuid, admission_no: z.string(), lifecycle_status: z.string(),
  given_name: z.string(), middle_name: z.string().nullable(),
  family_name: z.string().nullable(), preferred_name: z.string().nullable(),
});

const invoice = z.object({
  id: uuid, invoice_no: z.string(), enrollment_id: uuid, status: z.string(),
  due_on: z.string(), total: paise, amount_paid: paise,
});

const attendanceRecord = z.object({
  id: uuid, attendance_session_id: uuid, enrollment_id: uuid,
  state: z.enum(['present', 'absent', 'late', 'excused', 'half_day']),
  minutes_late: z.number().int().nullable(),
  recorded_at: z.string(), session_date: z.string(),
});

const payment = z.object({
  id: uuid, target_invoice_id: uuid.nullable(), method: z.string(),
  status: z.string(), provider: z.string().nullable(),
  provider_payment_id: z.string().nullable(),
  received_on: z.string(), amount: paise,
});

const resultLine = z.object({
  id: uuid, result_run_id: uuid, enrollment_id: uuid, course_offering_id: uuid,
  obtained: z.string().nullable(), maximum: z.string().nullable(),
  percentage: z.string().nullable(), is_pass: z.boolean().nullable(),
  grade_label: z.string().nullable(), not_graded_reason: z.string().nullable(),
});

const delivery = z.object({
  id: uuid.describe(
    'Stable across every retry of this delivery, including a replay. This is ' +
    'the value to de-duplicate on.'),
  webhook_endpoint_id: uuid, event_type: z.string(), status: z.string(),
  attempt_count: z.number().int(), last_error: z.string().nullable(),
  succeeded_at: z.string().nullable(), created_at: z.string(),
});

export const markAttendanceBody = z.object({
  sessionId: uuid,
  marks: z.array(z.object({
    clientEventId: z.string().min(1).max(120).describe(
      'Your own id for this mark. Required rather than generated, because a ' +
      'generated one would differ on every retry.'),
    studentId: uuid,
    state: z.enum(['present', 'absent', 'late', 'excused', 'half_day']),
    minutesLate: z.number().int().min(0).max(600).optional(),
  })).min(1).max(200),
});

const errorBody = z.object({
  error: z.object({
    type: z.enum(['validation_error', 'authentication_error', 'permission_error',
                  'not_found', 'conflict', 'rate_limited', 'provider_error',
                  'internal_error']),
    code: z.string(), message: z.string(),
    request_id: z.string(), doc_url: z.string(),
    details: z.array(z.object({ path: z.string(), issue: z.string() })).optional(),
  }),
});

/* ----------------------------------------------------------------- routes */

export interface RouteDoc {
  method: 'get' | 'post';
  /** Exactly as Nest registers it, so drift against the router is detectable. */
  path: string;
  operationId: string;
  summary: string;
  description: string;
  scopes: string[];
  query?: z.ZodTypeAny;
  body?: z.ZodTypeAny;
  item: z.ZodTypeAny;
  /** A list endpoint wraps its item in data[] + next_cursor. */
  list: boolean;
  idempotent?: boolean;
}

export const ROUTES: RouteDoc[] = [
  {
    method: 'get', path: '/api/v1/students', operationId: 'listStudents',
    summary: 'List learners',
    description:
      'Active learners, oldest id first. Name parts are returned separately '
      + 'rather than concatenated, because every consumer splits a full name '
      + 'differently. Medical notes and emergency contacts are deliberately '
      + 'not in this response.',
    scopes: ['students:read'], query: pageQuery, item: student, list: true,
  },
  {
    method: 'get', path: '/api/v1/invoices', operationId: 'listInvoices',
    summary: 'List invoices',
    description:
      'Every invoice the key may see. Amounts are exact decimal strings.',
    scopes: ['invoices:read'], query: pageQuery, item: invoice, list: true,
  },
  {
    method: 'get', path: '/api/v1/payments', operationId: 'listPayments',
    summary: 'List payments',
    description:
      'Settled and pending payments, for reconciliation against your own '
      + 'ledger. `target_invoice_id` is the invoice the payer chose, which is '
      + 'not always the oldest one outstanding.',
    scopes: ['payments:read'], query: pageQuery, item: payment, list: true,
  },
  {
    method: 'get', path: '/api/v1/attendance', operationId: 'listAttendance',
    summary: 'List attendance records',
    description:
      '`recorded_at` is the server time the mark was accepted. A mark made '
      + 'offline carries the device time separately and is never trusted for '
      + 'ordering.',
    scopes: ['attendance:read'], query: pageQuery, item: attendanceRecord, list: true,
  },
  {
    method: 'get', path: '/api/v1/results', operationId: 'listResults',
    summary: 'List result lines',
    description:
      'Published result lines only. An unreviewed result is invisible here for '
      + 'the same reason it is invisible in the parent app.',
    scopes: ['results:read'], query: pageQuery, item: resultLine, list: true,
  },
  {
    method: 'get', path: '/api/v1/webhooks/deliveries', operationId: 'listDeliveries',
    summary: 'List webhook deliveries',
    description:
      'What we attempted to send you and what came back, so you can reconcile '
      + 'your inbox against our outbox without asking us.',
    scopes: ['webhooks:read'], query: pageQuery, item: delivery, list: true,
  },
  {
    method: 'post', path: '/api/v1/attendance/marks', operationId: 'markAttendance',
    summary: 'Mark attendance',
    description:
      'Requires an `Idempotency-Key` header. Reusing a key with the same body '
      + 'replays the first response; reusing it with a different body is '
      + 'refused rather than replayed, because that is almost always a loop '
      + 'variable that failed to advance.',
    scopes: ['attendance:write'], body: markAttendanceBody,
    item: z.object({
      sessionId: uuid,
      outcomes: z.array(z.object({
        clientEventId: z.string(),
        status: z.enum(['applied', 'already_applied', 'rejected', 'queued_for_approval']),
        recordId: uuid.optional(),
      })),
      serverTime: z.string(),
    }),
    list: false, idempotent: true,
  },
];

/* ------------------------------------------------------------- the events */

export const WEBHOOK_EVENTS: Array<{ type: string; when: string }> = [
  { type: 'support.ticket.raised', when: 'Somebody raises a support ticket.' },
];

/* ------------------------------------------------------------------ build */

function schema(s: z.ZodTypeAny, name: string): Record<string, unknown> {
  const out = zodToJsonSchema(s, { name, $refStrategy: 'none', target: 'openApi3' });
  const defs = (out as { definitions?: Record<string, unknown> }).definitions;
  return (defs?.[name] ?? out) as Record<string, unknown>;
}

function queryParameters(s: z.ZodTypeAny): unknown[] {
  const json = schema(s, 'q') as {
    properties?: Record<string, Record<string, unknown>>; required?: string[];
  };
  return Object.entries(json.properties ?? {}).map(([name, prop]) => ({
    name, in: 'query',
    required: (json.required ?? []).includes(name),
    description: prop['description'],
    schema: prop,
  }));
}

export function buildSpec(): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};

  for (const route of ROUTES) {
    const ok = route.list
      ? {
          type: 'object',
          required: ['data', 'next_cursor'],
          properties: {
            data: { type: 'array', items: schema(route.item, 'item') },
            next_cursor: {
              type: ['string', 'null'],
              description: 'Pass as `cursor` for the next page. Null on the last page.',
            },
          },
        }
      : { type: 'object', properties: { data: schema(route.item, 'item') } };

    const operation: Record<string, unknown> = {
      operationId: route.operationId,
      summary: route.summary,
      description: route.description,
      security: [{ apiKey: [] }],
      'x-scopes': route.scopes,
      responses: {
        [route.method === 'post' ? '201' : '200']: {
          description: 'Success',
          content: { 'application/json': { schema: ok } },
        },
        401: errorResponse('The API key is missing, malformed, revoked or expired.'),
        403: errorResponse(`The key lacks the ${route.scopes.join(' or ')} scope.`),
        422: errorResponse('The request failed validation.'),
        429: errorResponse(
          'Rate limit exceeded for this key. `Retry-After` says when the window resets.'),
      },
    };

    if (route.query) operation['parameters'] = queryParameters(route.query);

    if (route.idempotent) {
      operation['parameters'] = [
        ...((operation['parameters'] as unknown[]) ?? []),
        {
          name: 'Idempotency-Key', in: 'header', required: true,
          schema: { type: 'string', minLength: 8, maxLength: 255 },
          description:
            'Unique per distinct request. A replayed response carries '
            + '`Idempotent-Replay: true`.',
        },
      ];
      (operation['responses'] as Record<string, unknown>)['409'] =
        errorResponse('A request with this Idempotency-Key is still in flight.');
    }

    if (route.body) {
      operation['requestBody'] = {
        required: true,
        content: { 'application/json': { schema: schema(route.body, 'body') } },
      };
    }

    paths[route.path] ??= {};
    paths[route.path]![route.method] = operation;
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'paathshalaOS API',
      version: API_VERSION,
      description:
        'The integration surface for an institute running on paathshalaOS.\n\n'
        + '**Money is a string.** Every amount is an exact decimal rendered as '
        + 'a string. Parsing one into a float is the single most common way an '
        + 'integration ends up disagreeing with a school about what a family owes.\n\n'
        + '**Paging is keyset.** Follow `next_cursor`; there is no offset '
        + 'parameter, because a row inserted mid-walk would make an offset '
        + 'client skip a child.\n\n'
        + '**Every write needs an `Idempotency-Key`.** Not optional — a client '
        + 'that omits one is refused.\n\n'
        + '**Scopes are enforced by the database.** A key without '
        + '`invoices:read` does not get filtered results from the invoice '
        + 'tables; it gets none, because the row-level security policy that '
        + 'decides is false for it.',
    },
    servers: [{ url: 'http://localhost:3001', description: 'Local development' }],
    components: {
      securitySchemes: {
        apiKey: {
          type: 'http', scheme: 'bearer',
          description:
            'Your key, as `<prefix>.<secret>`. The prefix identifies the key '
            + 'and is safe to log; the secret after the dot is shown once, when '
            + 'the key is issued, and is never retrievable afterwards.',
        },
      },
      schemas: { Error: schema(errorBody, 'Error') },
    },
    security: [{ apiKey: [] }],
    'x-webhook-events': WEBHOOK_EVENTS,
    'x-webhook-signature': {
      header: 'X-Paathshala-Signature',
      format: 't=<unix seconds>,v1=<hex>[,v1=<hex>]',
      algorithm: 'HMAC-SHA256 over `{t}.{raw request body}`',
      tolerance_seconds: 300,
      notes: [
        'Compare in constant time. A verifier written with === leaks, byte by '
        + 'byte, how much of a guess was right.',
        'Sign the RAW body. Re-serialising parsed JSON changes key order and '
        + 'number formatting, and the signature stops matching.',
        'More than one v1 may be present during a secret rotation; accept the '
        + 'request if any of them matches.',
        'Reject a timestamp more than 300 seconds from now, before doing the '
        + 'HMAC, so replayed requests cost you nothing.',
      ],
    },
    paths,
  };
}

function errorResponse(description: string): Record<string, unknown> {
  return {
    description,
    content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
  };
}
