/**
 * The numbers worth having (M23.3).
 *
 * A metric is a commitment: somebody will alert on it, and a bad one produces
 * pages nobody can act on until they stop reading pages. So this file is short
 * on purpose, and each entry has a sentence saying what a human would DO about
 * it. Anything that failed that test is not here.
 *
 * Two rules the label sets follow, and they are the ones that decide whether
 * this scales:
 *
 * **No tenant label, anywhere.** A per-tenant counter multiplies every series
 * by the number of schools, which is the number this business is trying to make
 * large. Per-school figures are a reporting question and belong in the database
 * with the rest of the school's data; these are for "is the service healthy",
 * which is not a per-school question. The one exception would be a metric whose
 * whole meaning is per-tenant, and there is not one.
 *
 * **Routes, never paths.** See access-log.ts.
 */
import {
  Registry, Counter, Histogram, Gauge, collectDefaultMetrics,
} from 'prom-client';

export const registry = new Registry();
registry.setDefaultLabels({ service: 'paathshala-api' });

// Event loop lag, heap, GC, handles. Cheap, and the first thing anybody wants
// when the API is slow and the database is not.
collectDefaultMetrics({ register: registry });

/**
 * Buckets in milliseconds, chosen around the decisions somebody makes.
 *
 * 50 and 100 are "fine". 250 and 500 are "a page still feels instant". 1000 is
 * where the slow flag goes on. 2500 and 5000 are "a person has noticed". 10000
 * is "they have refreshed". The default prom-client buckets are in seconds and
 * put six of their ten below 100ms, which tells you nothing about a web app.
 */
export const httpDuration = new Histogram({
  name: 'paathshala_http_request_duration_ms',
  help: 'HTTP request duration in milliseconds',
  labelNames: ['method', 'route', 'status'] as const,
  buckets: [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000],
  registers: [registry],
});

/**
 * Failed sign-ins, by reason.
 *
 * DO: a spike in `invalid_credentials` across many accounts is a password
 * spray, and the answer is to look at source addresses. A spike in
 * `grants_changed` is a deploy that invalidated everybody's session, and the
 * answer is to roll back.
 */
export const authFailures = new Counter({
  name: 'paathshala_auth_failures_total',
  help: 'Authentication failures by reason',
  labelNames: ['reason'] as const,
  registers: [registry],
});

/**
 * Webhook deliveries waiting.
 *
 * DO: if this climbs and does not fall, an integration is down and a school's
 * data is not reaching the system they actually work in. Nobody finds that out
 * from the school; they find out three weeks later.
 */
export const webhookBacklog = new Gauge({
  name: 'paathshala_webhook_backlog',
  help: 'Webhook deliveries pending or retrying',
  registers: [registry],
});

/**
 * Outbox events waiting to be dispatched.
 *
 * DO: a rising outbox means messages to parents are not going out — absence
 * notices, fee reminders. Silence here looks exactly like a quiet day.
 */
export const outboxBacklog = new Gauge({
  name: 'paathshala_outbox_backlog',
  help: 'Outbox events not yet dispatched',
  registers: [registry],
});

/**
 * Migrations applied, and the schema version the process booted on.
 *
 * DO: two instances reporting different versions after a deploy means a
 * partial rollout against a changed schema, which is the failure mode that
 * corrupts data rather than just breaking pages.
 */
export const schemaVersion = new Gauge({
  name: 'paathshala_schema_migrations_applied',
  help: 'Number of migrations applied to the database this process is using',
  registers: [registry],
});

/**
 * Migrations applied that THIS build does not ship.
 *
 * DO: zero is the steady state. Non-zero during a deploy is the normal
 * transient — the new version migrated and this instance has not been replaced
 * yet. Non-zero for longer than a deploy takes means an instance was left
 * behind, and it is serving traffic against a schema it does not understand.
 * Pairs with `paathshala_schema_migrations_applied` and M23's
 * SchemaVersionSplit alert, which compares instances rather than absolutes.
 */
export const schemaAhead = new Gauge({
  name: 'paathshala_schema_migrations_ahead',
  help: 'Migrations applied to the database that this build does not ship',
  registers: [registry],
});

/**
 * Requests refused because a school is past due.
 *
 * DO: this going from zero to hundreds means the billing ladder has caught a
 * school that should not have been caught — a payment that did not reconcile,
 * say — and every write in that school is failing while somebody investigates.
 */
export const readOnlyRefusals = new Counter({
  name: 'paathshala_read_only_refusals_total',
  help: 'Writes refused because the account is past due',
  registers: [registry],
});

/**
 * Platform staff entering a school.
 *
 * DO: not an outage signal. It is here because it is the number a school's
 * security questionnaire asks about, and because a jump in it without a
 * matching jump in support tickets is worth a question.
 */
export const schoolEntries = new Counter({
  name: 'paathshala_platform_entries_total',
  help: 'Platform console sessions opened inside a school',
  labelNames: ['write_enabled'] as const,
  registers: [registry],
});

/**
 * Requests counted in this process's memory because Redis did not answer.
 *
 * DO: anything above zero means the per-key rate limit is per INSTANCE again,
 * so the effective ceiling is the configured one times the number of API
 * processes. Not an outage — the product keeps serving, which is the point of
 * failing open — but it is a limit quietly doing something other than what it
 * says, and that is exactly the kind of degradation that is never noticed
 * without a number next to it.
 */
export const rateLimiterFallbacks = new Counter({
  name: 'paathshala_rate_limiter_fallbacks_total',
  help: 'Rate-limit decisions made from local memory because Redis was unreachable',
  registers: [registry],
});

/**
 * Offline batches arriving from a device, by outcome.
 *
 * DO: a rise in `conflict` after a release means the sync contract changed
 * under devices that have not updated — and those devices are holding a
 * teacher's register.
 */
export const syncOutcomes = new Counter({
  name: 'paathshala_sync_outcomes_total',
  help: 'Offline sync record outcomes',
  labelNames: ['kind', 'outcome'] as const,
  registers: [registry],
});

/**
 * Database pool saturation, per role.
 *
 * DO: waiting clients above zero for any length of time means requests are
 * queueing for a connection, and every latency number above is really this.
 * Per role because the four pools fail differently: `auth` saturating locks
 * everybody out, `app` saturating slows everybody down.
 */
export const poolWaiting = new Gauge({
  name: 'paathshala_db_pool_waiting',
  help: 'Clients waiting for a database connection',
  labelNames: ['role'] as const,
  registers: [registry],
});

export const poolInUse = new Gauge({
  name: 'paathshala_db_pool_in_use',
  help: 'Database connections checked out',
  labelNames: ['role'] as const,
  registers: [registry],
});

/**
 * Whether the last scrape could actually read the database.
 *
 * 1 or 0, and it exists because of a real failure: the backlog gauges asked a
 * role with no grant on those tables, every query threw, the sampler caught it,
 * and the scrape reported `paathshala_webhook_backlog 0`. "Nothing is stuck"
 * and "I cannot see" looked identical.
 *
 * DO: alert on this being 0 for more than a couple of scrapes, and treat every
 * backlog number as unknown while it is. The backlog gauges are REMOVED rather
 * than zeroed when it drops, so Prometheus sees them go stale instead of
 * reading a confident zero — a missing series is a question, and a zero is an
 * answer.
 */
export const gaugeSamplingOk = new Gauge({
  name: 'paathshala_gauge_sampling_ok',
  help: 'Whether the last scrape could read the database (1) or not (0)',
  registers: [registry],
});

/** Reset between tests. Never called by the running service. */
export function resetMetrics(): void {
  registry.resetMetrics();
}
