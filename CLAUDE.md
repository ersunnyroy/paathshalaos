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

Tests currently: **606 passing across five packages** (api 557, offline-queue 12, api-client 10, web 13, mobile 14), 64 migrations. If that number drops, something regressed.

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
- **Check the SDK against what Expo Go actually runs, before writing the app.** Expo Go
  loads the current SDK and nothing older. The app was first pinned to SDK 52, bundled
  perfectly, and could not be opened on a phone at all. `expo export` proves a bundle
  builds; it cannot prove anyone can load it. Both apps are on React 19 now (SDK 57 /
  React Native 0.86), so a single React major covers the workspace — do not reintroduce a
  second one, and do not set `node-linker=hoisted` to paper over it.
- **Refresh is single-flight, and must stay that way.** The server rotates refresh tokens
  and revokes the whole family when a spent one is presented — that is what a stolen token
  looks like. So two concurrent refreshes sign the user out and write an audit row saying
  reuse was detected. `packages/api-client` holds one in-flight promise that every caller
  awaits; removing it fails the tests immediately. A refresh that fails on the *network*
  never signs anybody out: a tunnel is not a security event.
- **Entitlement is not authorisation.** `app_tenant_has_feature()` returns true for a
  school with no subscription, and row-level security never consults it. Billing decides
  what a school has bought; RLS decides what it may see. Do not merge them.
- **Usage is counted from the rows**, never from a stored counter, and a plan's hard cap
  is a BEFORE INSERT trigger — so new records are refused and existing ones keep working
  on every code path, not just the one that remembered to check.
- **Pick the strongest mechanism each table can support.** Tenant-scoped tables get a
  grant plus an RLS policy. Tables with no tenant column (the plan catalogue) get no app
  grant at all and are read through `SECURITY DEFINER` functions, because there is no RLS
  underneath them to catch a query that forgets its filter — and a definer function's
  WHERE clause is then the whole boundary, so it must be tested against a database where
  the wrong answer exists.
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
- **`tsconfig.json` does not typecheck `test/`** — it emits to `dist` and the tests must
  not ship. `tsconfig.test.json` does, and the build runs it. Adding a test config that
  skips the tests puts the project back where it was: 27 spec files asserting against
  types that did not exist.
- **Assert on behaviour, not on source text.** Two service-worker tests read the file as a
  string and checked line order; wrapping the guard in `if (false && …)` passed them all.
  Load the thing and run it.
- **Service-level tests cannot see a wrong column name in a SQL string.** Endpoints that
  matter are exercised over real HTTP with a real app (`*-http.spec.ts`,
  `platform-entry.spec.ts`) because the first bug of this kind shipped a 500 past 33
  passing tests.

## Working alongside another agent

This repo has already had one milestone built twice in parallel, which cost a day and
overwrote uncommitted work. If more than one session is open on it: **commit to a branch
before starting, and check `git log --oneline -3` and `git status` first.** A tree with
two implementations of the same migration number does not migrate at all.

## Layout

```
apps/api                  NestJS. src/db/migrations (numbered, checksummed), src/modules/*, test/*
apps/web                  Next.js app router. src/app/*, src/lib/api.ts, src/components/ui.tsx
packages/offline-queue    The attendance queue. No browser, no React Native, no fetch —
                          storage and transport are injected, so conflict behaviour is
                          tested in Node. Its vocabulary is contract-tested against the
                          server's, at compile time and at runtime.
packages/api-client       Fetch plus rotation-aware refresh. Token storage injected.
apps/mobile               Expo (expo-router). Screens are thin on purpose: the logic is
                          in the shared packages, and the two device adapters take their
                          native module as an argument so they test in Node.
```

Each package has its own `vitest`; run all five before calling something done. For the
mobile app also run `npx expo export --platform android` — it builds the whole Metro
graph without a device and catches resolution errors a typecheck cannot.

Brand colours: teal `#14B8A6`, deep navy `#0F172A`, slate `#334155`, light gray
`#E2E8F0`, off-white `#F8FAFC`.

## Known gaps (carried, deliberately)

No mobile app yet. Relief cover has no representation. The rate limiter is per-process
(Redis is running but unused for it). Write scopes on API keys are coarse.
`attendance_record` is not partitioned. The web client does not rotate refresh tokens.
