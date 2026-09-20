# Running paathshalaOS on your Mac

Everything below assumes you are in the repo root (`~/paathshalaoS`).

---

## The quick way

```bash
cd ~/paathshalaoS
bash run-local.sh
```

That checks your toolchain, brings up Postgres and Redis with Docker, installs
dependencies, migrates, seeds a demo school, starts both servers and prints the
logins. Run it again any time — every step checks before it acts.

```bash
bash run-local.sh stop     # app servers only
bash run-local.sh down     # containers too
bash run-local.sh reset    # wipe the database and rebuild it
```

The rest of this file is what that script does, in case you want to do it by
hand or something goes wrong.

---

## 0. What you need once

| Thing | Check it | If missing |
|---|---|---|
| Docker Desktop | `docker info` | https://docker.com — and start it |
| Node 20+ | `node -v` | `brew install node` |
| pnpm | `pnpm -v` | `corepack enable` |

---

## 1. Postgres and Redis

Both come from `docker-compose.yml`, on non-default ports so they cannot collide
with anything else you run:

```bash
docker compose up -d
docker exec paathshala-postgres pg_isready -U paathshala_owner -d paathshala
```

| Service | Port | Why not the default |
|---|---|---|
| Postgres | **5433** | A local 5432 is usually already taken |
| Redis | **6380** | Same |

The container creates the `paathshala` database and the `paathshala_owner` role
on first boot. The four unprivileged roles the API runs as are created by
`db:bootstrap` below — one for tenant data, one for credentials, one that reads
nothing but the RESTRICTED columns on a learner record, and one that can create
schools and list them while holding no grant on anything inside one — the app never connects as a superuser, and it refuses
to start if the role it uses can bypass row-level security.

---

## 2. Install and configure

```bash
pnpm install

cat > apps/api/.env <<'ENV'
DATABASE_OWNER_URL=postgres://paathshala_owner:local_dev_only@localhost:5433/paathshala
DATABASE_URL=postgres://paathshala_app:local_dev_only@localhost:5433/paathshala
DATABASE_AUTH_URL=postgres://paathshala_auth:local_dev_only@localhost:5433/paathshala
DATABASE_HEALTH_URL=postgres://paathshala_health:local_dev_only@localhost:5433/paathshala
DATABASE_PLATFORM_URL=postgres://paathshala_platform:local_dev_only@localhost:5433/paathshala
JWT_SECRET=local-development-only-secret-at-least-32-characters
REDIS_URL=redis://localhost:6380
PORT=3001
NODE_ENV=development
WEB_ORIGINS=http://localhost:3000
ENV
```

---

## 3. Bootstrap, migrate, seed

```bash
pnpm db:bootstrap   # creates the two unprivileged roles
pnpm db:migrate     # 44 migrations, applied in order and checksummed
pnpm db:seed        # a demo school: 40 learners, fees, help articles, a ticket
```

The seed prints four logins, a one-time API key, and the address the demo school
lives at. Point the web app at that address:

```bash
cat > apps/web/.env.local <<ENV
NEXT_PUBLIC_API_URL=http://localhost:3001
NEXT_PUBLIC_BRAND_HOST=demo.paathshala.app
ENV
```

In production this variable does not exist. The school is whoever owns the
hostname the browser arrived on, so one deployment serves many schools, each at
its own address and in its own colours. Locally there is only `localhost`, which
belongs to nobody, and this stands in for the `Host` header.

---

## 4. Run it

Two terminals.

**Terminal 1 — the API**

```bash
pnpm dev:api
```

Wait for `api listening`. It refuses to boot if either database role can bypass
row-level security, so an error here is the isolation check doing its job rather
than a misconfiguration to work around.

**Terminal 2 — the web app**

```bash
pnpm dev:web
```

Open **http://localhost:3000**.

**Optional, terminal 3 — the webhook relay.** Only needed if you want outbound
webhooks actually attempted; everything else works without it.

```bash
pnpm webhooks:relay
```

> One command instead of two: `pnpm dev` runs both the API and the web app
> through turbo. Two terminals are easier to read when something fails, which is
> why they are the default above.

---

## 5. Sign in

Three accounts, one password — `demo-password-1234`:

| Email | Role | What it proves |
|---|---|---|
| `principal@demo.school` | Org owner | Sees everything, including integrations |
| `accounts@demo.school` | Accountant | Sees money |
| `teacher@demo.school` | Teacher | Sees **no fees at all** |

The screens do not branch on role. Sign in as the teacher and open Fees: the
page is the same page, and it is empty because the database returned no rows.
That is the isolation model, visible from the browser.

---

## 6. Worth actually trying

**Getting started** — the checklist reads your data on every load. Nothing is
ticked. To see it change, delete something:

```bash
psql -d paathshala -c "UPDATE fee_plan SET deleted_at = now();"
```

Reload the page: "Build your fee structure" turns off and "Ready to run" flips
to *Not yet*. Put it back with `SET deleted_at = NULL`.

**Support** — open the seeded ticket, tick *Internal note*, and reply. The note
is tinted and labelled. Then check that a parent cannot see it — the filtering
is a row-level security policy, not a `WHERE` clause in a query.

**Integrations** — two seeded webhook deliveries are dead, because the endpoint
points at an address that never answers. Press **Replay**: it re-sends the
original bytes under the original delivery id.

**The public API** — use the key the seed printed:

```bash
KEY='pk_test_….…'            # the full prefix.secret string

curl -H "Authorization: Bearer $KEY" \
     'http://localhost:3001/api/v1/students?limit=3'

# The same key has no attendance:write scope, so this is refused by name:
curl -X POST -H "Authorization: Bearer $KEY" \
     -H 'content-type: application/json' \
     -H 'idempotency-key: try-this-once-1' \
     -d '{"sessionId":"00000000-0000-0000-0000-000000000000","marks":[]}' \
     'http://localhost:3001/api/v1/attendance/marks'
```

---

## Looking at the database

Two different questions, two different tools.

### A browser client — http://localhost:8081

`docker compose up -d` now starts **Adminer** alongside Postgres. Log in with:

| Field | Value |
|---|---|
| System | PostgreSQL |
| Server | `postgres` |
| Username | `paathshala_owner` |
| Password | `local_dev_only` |
| Database | `paathshala` |

That gives you tables, columns, indexes, foreign keys and a query console.

The thing worth doing there: **log in as `paathshala_app` instead** (same
password) and run `SELECT * FROM student`. You will get `permission denied` —
because the application role has no column privilege on the medical fields.
Then try `SELECT id, admission_no FROM student` and you will get zero rows,
because row-level security has no tenant set on a bare connection. That is the
isolation model, visible in a query console rather than described in a README.

Adminer is local only and is deliberately absent from anything deployment-shaped.
A database console reachable from a browser is a database console reachable from
anything that can reach that browser.

### The schema reference — `apps/api/SCHEMA.md`

```bash
pnpm --filter @paathshala/api db:schema
```

Adminer will not show you **policies**, and in this schema the policies are the
design: 98 tables and 161 of them. "Which columns does `student` have" is a much
less interesting question here than "who can see a row, and which columns can
they read" — and no general-purpose database UI answers the second.

So this generates a reference from the live database covering what a client
cannot show: every table's RLS state, every policy's `USING` and `WITH CHECK` in
full, every column-level grant that is narrower than its table, and the twelve
`app_*` helper functions the policies are written in terms of.

It is generated rather than written, for the same reason the OpenAPI spec is: a
hand-maintained one is accurate the day it is written.

---

## 7. Tests

```bash
pnpm test
```

454 tests against a real Postgres — no mocked database, because every isolation
guarantee in this product is a policy the database enforces, and a mock would
assert that the mock works.

They create and drop their own tenants, so they are safe to run against the same
database the demo is in.

---

## Troubleshooting

**`Database role "…" can bypass row-level security. Refusing to start.`**
`paathshala_app` ended up a superuser. `pnpm db:bootstrap` takes that back on
every run, so run it again — the check firing is the isolation model doing its
job, not a misconfiguration to work around.

**"No school is registered at this address" on the login page**
`apps/web/.env.local` is missing, or `NEXT_PUBLIC_BRAND_HOST` does not match a
host the seed registered. Re-run the seed to print it again — it says "already
exists" and prints the address without touching your data.

**The login page loads but signing in fails**
The API is not running, or it is on a different port than `NEXT_PUBLIC_API_URL`.
Check `curl -i http://localhost:3001/v1/me` returns 401 rather than nothing.

**`connection refused` on 5433**
The containers are not up: `docker compose up -d`. If Docker itself is not
running, open Docker Desktop and wait for it to say *Running*.

**`Migration NNNN has already been applied but its contents changed`**
Your database was built from an older copy of the migrations, and the runner
refuses to stack new ones on a schema it can no longer describe. That guard is
the point — an edited migration should be caught, not silently skipped. Locally
the database holds only demo data, so rebuild it: `bash run-local.sh reset`.

**`role "paathshala_owner" does not exist`**
The Postgres volume was created before the compose file had that role. Rebuild
it: `bash run-local.sh reset` — this wipes the demo data, which is safe.

**Port 3000 or 3001 already in use**
`lsof -ti:3000 | xargs kill` (and the same for 3001).
