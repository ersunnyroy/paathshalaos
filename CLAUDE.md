# paathshalaOS

India-first, multi-tenant Institute Management OS for private schools and coaching
institutes. Built milestone by milestone; `MILESTONES.md` is the plan and the
running status table at its end is the source of truth for what is done.

## Standing constraints (from the product owner, not negotiable)

- **TypeScript monorepo.** Next.js web, React Native/Expo mobile (not built yet),
  **NestJS modular monolith** for the API, PostgreSQL, Redis, object storage,
  AWS India region, OpenAPI-first REST.
- **Do not recommend microservices** for perceived scalability. The monolith is a
  decision, not an oversight.
- **Do not ask clarifying questions.** Make the call, state the assumption, proceed.
- **Never invent unavailable information.** Mark it `not publicly verified` instead.

## How work is done here

Every milestone follows the same path, in this order:

1. Migration(s) — the invariant goes in the database wherever the database can hold it.
2. Service(s) — thin over SQL, no ORM.
3. Tests against a **real Postgres** (no mocks, no in-memory substitute).
4. **Mutation testing.** Deliberately break each new invariant, confirm a test catches
   it, restore. A mutation that changes nothing is a finding, not a pass — it means the
   test was asserting something else.
5. Update `MILESTONES.md` (status table + what actually shipped vs what was planned,
   including where the plan was wrong).

SQL-level invariants are mutated by running `ALTER POLICY` / `CREATE OR REPLACE FUNCTION`
against the live database. Editing an already-applied migration file does nothing — the
runner has a checksum guard and will refuse to start instead.

Tests currently: **526 passing, 58 migrations.** If that number drops, something regressed.

## Architecture you must know before touching anything

**Four unprivileged database roles, each asserted at boot; the process refuses to start
if any assertion fails.**

| Role | Reaches | Cannot reach |
| --- | --- | --- |
| `paathshala_app` | tenant data | any credential |
| `paathshala_auth` | credentials, sessions, audit writes | any tenant table |
| `paathshala_health` | RESTRICTED learner columns only | everything else |
| `paathshala_platform` | creates/lists schools | anything *inside* a school |

That last row is the whole platform design: the console cannot read `student`,
`person`, `invoice` or `attendance_record` — not filtered, *not granted*. Seeing inside a
school is done by entering it as one of its people, on the record (M15). If a migration
ever grants the platform role one of those tables, the boot assertion fails. That is
intended. Do not "fix" it by relaxing the assertion.

- **Row-level security is forced on every tenant table**, owner included. Tenancy comes
  from the verified token into a transaction-local `app.tenant_id`, never from a header.
  `withTenant()` in `src/db/tenant.ts` is the only sanctioned way in.
- **Roles are cluster-level.** `CREATE ROLE` belongs in bootstrap, never in a versioned
  migration — it fails on a second database.
- **A column grant covers every column the query mentions**, including ones only in a
  WHERE clause. `REVOKE SELECT ON table` then `GRANT SELECT (cols)` is the only way to
  express "all but these".
- **Two policies expressing one rule will diverge.** When the same question is asked from
  two places, write one `SECURITY DEFINER` function and have both call it
  (`app_student_visible()` is the precedent). Definer functions also break policy
  recursion between tables that read each other.
- **Money is an exact decimal string**, never a JSON number. Paise, formatted by string
  surgery — never divided.
- **Pagination is keyset**, never OFFSET.
- **OpenAPI is generated from the same Zod schemas the handlers validate with**, and a
  test walks the real Express router to catch drift.

## Running it

Postgres 16 on **:5433** and Redis on **:6380** come from `docker-compose.yml` — Docker
runs everything, there is no separate local Postgres.

```bash
bash run-local.sh          # the supported path: containers, migrate, seed, both apps
bash run-local.sh reset    # wipes the volume; the fix for a migration checksum error
```

`RUNNING.md` has the manual sequence. The web app needs `NEXT_PUBLIC_TENANT_ID` in
`apps/web/.env.local`, printed by the seed.

Adminer is on **:8081** for browsing the schema; `SCHEMA.md` is the written version.

## Traps that have already cost time

- **Node 22.6+ required.** Below it, `--experimental-strip-types` fails. The db entry
  points are compiled first (`pnpm run build && node dist/db/migrate.js`) rather than run
  from TypeScript.
- **`tsc` does not copy `.sql`.** `scripts/copy-assets.mjs` does, and fails loudly if it
  copies none.
- **esbuild drops `emitDecoratorMetadata`**, so Nest's implicit injection of `Reflector`
  silently yields `undefined` under vitest. Every guard injects it by token:
  `@Inject(Reflector)`. Do not "simplify" that back.
- **A direct-run guard using `argv[1].endsWith('x.ts')` breaks the compiled build** — it
  exits 0 having done nothing. Compare `realpathSync` of both sides.
- **`head` may be Perl's LWP `head`, not coreutils.** Scripts use `sed -n '1p'`.
- **Service-level tests cannot see a wrong column name in a SQL string.** Endpoints that
  matter are exercised over real HTTP with a real app (`*-http.spec.ts`,
  `platform-entry.spec.ts`) because the first bug of this kind shipped a 500 past 33
  passing tests.

## Layout

```
apps/api      NestJS. src/db/migrations (numbered, checksummed), src/modules/*, test/*
apps/web      Next.js app router. src/app/*, src/lib/api.ts, src/components/ui.tsx
packages/     shared code
```

Brand colours: teal `#14B8A6`, deep navy `#0F172A`, slate `#334155`, light gray
`#E2E8F0`, off-white `#F8FAFC`.

## Known gaps (carried, deliberately)

No mobile app yet. Relief cover has no representation. The rate limiter is per-process
(Redis is running but unused for it). Write scopes on API keys are coarse.
`attendance_record` is not partitioned. The web client does not rotate refresh tokens.
