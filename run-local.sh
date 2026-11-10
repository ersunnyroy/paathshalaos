#!/usr/bin/env bash
#
# One-shot local setup and start for paathshalaOS.
#
# Postgres and Redis come from docker-compose.yml — Postgres on 5433 and Redis
# on 6380, deliberately off the default ports so this cannot collide with
# anything else you already have running.
#
# Safe to run more than once: every step checks before it acts, and nothing here
# overwrites an env file that already exists.
#
#   bash run-local.sh          set up if needed, then start both servers
#   bash run-local.sh stop     stop the app servers (containers keep running)
#   bash run-local.sh down     stop the servers and the containers too
#   bash run-local.sh reset    wipe the database volume and rebuild from scratch
#
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

LOGS="$ROOT/.local-logs"
mkdir -p "$LOGS"

PG_PORT=5433
REDIS_PORT=6380
PG_PW=local_dev_only

bold()  { printf '\033[1m%s\033[0m\n' "$*"; }
ok()    { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn()  { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()   { printf '\n\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
step()  { printf '\n\033[1m%s\033[0m\n' "$*"; }

# Compose ships as a docker subcommand now and as a separate binary on older
# installs. Resolve it once rather than guessing at each call site.
compose() {
  if docker compose version >/dev/null 2>&1; then docker compose "$@";
  else docker-compose "$@"; fi
}

stop_servers() {
  for port in 3000 3001; do
    pids=$(lsof -ti:"$port" 2>/dev/null || true)
    if [ -n "$pids" ]; then
      echo "$pids" | xargs kill 2>/dev/null || true
      ok "stopped whatever was on port $port"
    fi
  done
}

case "${1:-}" in
  stop)
    step "Stopping the app servers"
    stop_servers
    echo
    echo "  Containers are still up. 'bash run-local.sh down' stops those too."
    exit 0 ;;
  down)
    step "Stopping everything"
    stop_servers
    compose down && ok "containers stopped"
    exit 0 ;;
esac

# ------------------------------------------------------------------ toolchain

step "1. Checking the toolchain"

command -v docker >/dev/null 2>&1 || die \
  "Docker is not installed. Install Docker Desktop from https://docker.com, start it, then run this again."

if ! docker info >/dev/null 2>&1; then
  warn "Docker is installed but not running — trying to start Docker Desktop"
  open -a Docker 2>/dev/null || true
  printf '  waiting for the Docker daemon'
  for _ in $(seq 1 90); do
    docker info >/dev/null 2>&1 && break
    printf '.'; sleep 2
  done
  echo
fi
docker info >/dev/null 2>&1 || die \
  "The Docker daemon is not responding. Open Docker Desktop, wait for it to say Running, then try again."
ok "docker $(docker --version | awk '{print $3}' | tr -d ,)"

# A shadowed coreutil is not hypothetical — see the note by the seed parsing
# below. Checking here turns a confusing mid-run failure into one sentence.
for util in sed awk grep curl lsof; do
  command -v "$util" >/dev/null 2>&1 || die "\`$util\` is not on your PATH."
done

command -v node >/dev/null 2>&1 || die \
  "Node is not installed. Install it with: brew install node"
NODE_MAJOR=$(node -v | sed 's/v\([0-9]*\).*/\1/')
# 20 is the real floor: everything runs compiled, so there is no dependency on
# a version-gated flag. An earlier version of this repo ran the database scripts
# straight off TypeScript and needed 22.6+, which failed on older Node with
# "bad option" — a message that reads like a broken checkout.
[ "$NODE_MAJOR" -ge 20 ] || die "node $(node -v) is too old; this needs 20 or newer"
ok "node $(node -v)"

if ! command -v pnpm >/dev/null 2>&1; then
  warn "pnpm is missing — installing"
  corepack enable >/dev/null 2>&1 || true
  command -v pnpm >/dev/null 2>&1 || npm i -g pnpm || die "could not install pnpm"
fi
ok "pnpm $(pnpm -v)"

# ------------------------------------------------------------------ containers

step "2. Postgres, Redis, object storage and the scanner"

if [ "${1:-}" = "reset" ]; then
  warn "reset: removing the containers AND their data volumes"
  stop_servers
  compose down -v || die "could not bring the containers down"
fi

# Pulled before `up`, so a tag that does not resolve is its own error line.
#
# This is here because a tag WAS wrong: the object-storage services were first
# added pinned to release tags written from memory, and `compose up` failed with
# "pull access denied ... repository does not exist or may require 'docker
# login'". That reads as an authentication problem and is not one — the image
# simply is not there — and it took the whole stack down with it.
# The services the product cannot run without are pulled together and a failure
# stops here. Object storage and the scanner are pulled one at a time and a
# failure is a warning.
#
# That split exists because of 10 Nov 2026: MinIO withdrew its community images
# from Docker Hub and then from quay.io, so `quay.io/minio/minio` answers 401
# for every tag — which reads as a login problem and is not one. One optional
# image that no longer exists took down Postgres, Redis and the whole app with
# it. Without object storage, file upload is off and everything else works.
SERVICES="postgres redis adminer"
printf '  pulling images (first run downloads a few hundred MB)'
if ! compose pull --quiet $SERVICES >/tmp/paathshala-pull.log 2>&1; then
  echo
  sed 's/^/  /' /tmp/paathshala-pull.log
  die "could not pull one of the images — the line above names it"
fi
echo
ok "core images present"

STORE_UP=""
for optional in minio clamav; do
  # An image already on this machine is used as it is: compose only needs the
  # registry for something it does not have.
  image=$(compose config --images "$optional" 2>/dev/null | sed -n '1p')
  if { [ -n "$image" ] && docker image inspect "$image" >/dev/null 2>&1; } \
     || compose pull --quiet "$optional" >/tmp/paathshala-pull.log 2>&1; then
    SERVICES="$SERVICES $optional"
    [ "$optional" = "minio" ] && STORE_UP=1
  elif [ "$optional" = "minio" ]; then
    warn "object storage image could not be pulled — FILE UPLOAD IS OFF for this run."
    warn "  MinIO no longer publishes public images; everything else works without it."
  else
    warn "virus scanner image could not be pulled — uploads will be stored and not served."
  fi
done

# Named services, so one that could not be pulled is simply not started.
compose up -d $SERVICES || die "docker compose up failed"

printf '  waiting for Postgres to be healthy'
PG_READY=""
for _ in $(seq 1 60); do
  if docker exec paathshala-postgres pg_isready -U paathshala_owner -d paathshala >/dev/null 2>&1; then
    PG_READY=1; break
  fi
  printf '.'; sleep 1
done
echo
[ -n "$PG_READY" ] || { compose logs --tail 30 postgres; die "Postgres did not become healthy — log above"; }
ok "postgres ready on localhost:$PG_PORT"
ok "redis ready on localhost:$REDIS_PORT"

MINIO_READY=""
if [ -n "$STORE_UP" ]; then
  printf '  waiting for object storage'
  for _ in $(seq 1 60); do
    if curl -fsS http://localhost:9000/minio/health/live >/dev/null 2>&1; then
      MINIO_READY=1; break
    fi
    printf '.'; sleep 1
  done
  echo
  if [ -n "$MINIO_READY" ]; then
    ok "object storage ready on localhost:9000 (console on 9001)"
  else
    compose logs --tail 30 minio
    warn "object storage did not come up — file upload is off for this run"
  fi
fi

# Deliberately NOT waited on. ClamAV downloads a few hundred megabytes of virus
# signatures on first start and can take ten minutes; the API treats a scanner
# that is not there as "failed", never "clean", so everything else works while
# it warms up. Uploads are stored and not served until it is ready, which is
# 0017's rule doing its job rather than a fault.
if docker exec paathshala-clamav clamdcheck.sh >/dev/null 2>&1; then
  ok "virus scanner ready on localhost:3310"
  CLAMAV_READY=1
else
  warn "virus scanner still downloading signatures — uploads will be stored and"
  warn "  not served until it is ready. Check with: docker logs -f paathshala-clamav"
  CLAMAV_READY=""
fi

# The compose file creates the paathshala database and the owner role for us;
# db:bootstrap below creates the two unprivileged roles the API actually uses.

# --------------------------------------------------------------------- env

step "3. Environment files"

if [ ! -f apps/api/.env ]; then
  cat > apps/api/.env <<ENV
DATABASE_OWNER_URL=postgres://paathshala_owner:$PG_PW@localhost:$PG_PORT/paathshala
DATABASE_URL=postgres://paathshala_app:$PG_PW@localhost:$PG_PORT/paathshala
DATABASE_AUTH_URL=postgres://paathshala_auth:$PG_PW@localhost:$PG_PORT/paathshala
DATABASE_HEALTH_URL=postgres://paathshala_health:$PG_PW@localhost:$PG_PORT/paathshala
DATABASE_PLATFORM_URL=postgres://paathshala_platform:$PG_PW@localhost:$PG_PORT/paathshala
JWT_SECRET=local-development-only-secret-at-least-32-characters
REDIS_URL=redis://localhost:$REDIS_PORT
OBJECT_STORE_BUCKET=paathshala
OBJECT_STORE_ENDPOINT=http://localhost:9000
OBJECT_STORE_ACCESS_KEY_ID=paathshala
OBJECT_STORE_SECRET_ACCESS_KEY=paathshala-local-only
OBJECT_STORE_FORCE_PATH_STYLE=true
CLAMD_HOST=localhost
PORT=3001
NODE_ENV=development
WEB_ORIGINS=http://localhost:3000
ENV
  ok "wrote apps/api/.env"
else
  # An .env written before a role existed makes the API refuse to boot on a
  # validation error. Each role is checked separately rather than assuming a
  # file missing one is missing all of them — an earlier version keyed the whole
  # block on the health url, so a file that had that and not the platform one
  # was "left alone" straight into a failure.
  added=""
  # Object storage, added to an .env written before M37 existed. Same reason as
  # the roles below: a file missing one variable refuses to boot on a
  # validation error, and "left alone" straight into a failure is the worst
  # kind of helpful.
  if ! grep -q "OBJECT_STORE_BUCKET" apps/api/.env; then
    cat >> apps/api/.env <<'STORE'
OBJECT_STORE_BUCKET=paathshala
OBJECT_STORE_ENDPOINT=http://localhost:9000
OBJECT_STORE_ACCESS_KEY_ID=paathshala
OBJECT_STORE_SECRET_ACCESS_KEY=paathshala-local-only
OBJECT_STORE_FORCE_PATH_STYLE=true
STORE
    added="$added OBJECT_STORE_*"
  fi
  if ! grep -q "CLAMD_HOST" apps/api/.env; then
    echo "CLAMD_HOST=localhost" >> apps/api/.env
    added="$added CLAMD_HOST"
  fi
  for role in health platform; do
    var="DATABASE_$(printf '%s' "$role" | tr '[:lower:]' '[:upper:]')_URL"
    if ! grep -q "$var" apps/api/.env; then
      printf '%s=postgres://paathshala_%s:%s@localhost:%s/paathshala\n' \
        "$var" "$role" "$PG_PW" "$PG_PORT" >> apps/api/.env
      added="$added $var"
    fi
  done
  if [ -n "$added" ]; then
    ok "added$added to your existing apps/api/.env"
  else
    ok "apps/api/.env exists — left alone"
  fi
fi

# ------------------------------------------------------------------ install

step "4. Installing dependencies"
pnpm install --silent || die "pnpm install failed"
ok "dependencies installed"

# ------------------------------------------------------- migrate and seed

step "5. Bootstrap, migrate, seed"

# Each of these compiles first — the entry points run from dist/, never from
# TypeScript source.
pnpm db:bootstrap 2>&1 | sed 's/^/  /' || die "db:bootstrap failed"

# Captured rather than streamed, so the one failure worth explaining can be
# recognised instead of just printed.
MIGRATE_OUT=$(pnpm db:migrate 2>&1)
MIGRATE_RC=$?
echo "$MIGRATE_OUT" | sed 's/^/  /'

if [ $MIGRATE_RC -ne 0 ]; then
  if echo "$MIGRATE_OUT" | grep -q 'contents changed'; then
    # The checksum guard did its job. It exists so that an edited migration is
    # caught rather than silently skipped, and the only honest resolution is to
    # rebuild the schema — which is free here, because this database holds
    # nothing but demo data.
    cat >&2 <<'EXPLAIN'

  ────────────────────────────────────────────────────────────────────────
  Your database was built from an older copy of the migrations.

  Every applied migration is recorded with a checksum, and one of them no
  longer matches the file on disk. The runner refuses to continue rather
  than apply the rest on top of a schema it can no longer describe.

  This database holds only the demo school, so rebuilding it costs nothing:

      bash run-local.sh reset

  That wipes the Postgres volume and rebuilds from migration 0001.
  ────────────────────────────────────────────────────────────────────────

EXPLAIN
    exit 1
  fi
  die "db:migrate failed"
fi

# The bucket, through the product's own S3 client rather than a second image.
# If this succeeds the API's uploads will too, which a separate tool cannot
# promise: it can reach the store with different credentials, a different
# endpoint or a different addressing style and still report success.
if [ -n "$MINIO_READY" ]; then
  pnpm --filter @paathshala/api storage:bootstrap 2>&1 | sed 's/^/  /' \
    || die "could not create the object storage bucket"
else
  warn "skipped creating the bucket: object storage is not running"
fi

SEED_OUT=$(pnpm db:seed 2>&1)
echo "$SEED_OUT" | sed 's/^/  /'

# `sed -n 1p` rather than `head -1`.
#
# Perl's libwww installs a program called `head` that takes a URL, and on a
# machine where its bin directory precedes /usr/bin it shadows the coreutil.
# The failure is loud but baffling — "Unknown option: 1" and a usage message for
# an HTTP client — and it lands in the middle of a database script. `sed` and
# `awk` have no such impostors.
TENANT=$(echo "$SEED_OUT" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | sed -n '1p')
[ -n "$TENANT" ] || die "could not read the tenant id from the seed output"
API_KEY=$(echo "$SEED_OUT" | grep -oE 'pk_(test|live)_[0-9a-f]{16}\.[0-9a-f]{64}' | sed -n '1p')

# Which school `localhost` is. Since M19 the web app finds its school from the
# address bar, and localhost names nobody — so without this the sign-in page
# says "No school is registered at this address" on a freshly seeded demo. The
# seed prints the line to add; nothing ever added it. Read from that output so
# a changed PAATHSHALA_DOMAIN follows through.
BRAND_HOST=$(echo "$SEED_OUT" | grep -oE 'NEXT_PUBLIC_BRAND_HOST=[A-Za-z0-9.-]+' | sed -n '1p' | cut -d= -f2)
[ -n "$BRAND_HOST" ] || BRAND_HOST="demo.paathshala.app"

# Rewritten every run, because the tenant id changes whenever the demo is
# reseeded — and a stale one here is the most confusing failure there is: the
# login page loads, the password is right, and nothing works.
cat > apps/web/.env.local <<ENV
NEXT_PUBLIC_API_URL=http://localhost:3001
NEXT_PUBLIC_TENANT_ID=$TENANT
NEXT_PUBLIC_BRAND_HOST=$BRAND_HOST
ENV
ok "wrote apps/web/.env.local with tenant $TENANT, reached as $BRAND_HOST"

# ------------------------------------------------------------------- run

step "6. Starting the servers"

stop_servers

# Build once before the watchers start. `dev:api` runs `tsc --watch` alongside
# `node --watch dist/main.js`, and on a tree that has never been built the second
# of those starts by failing on a file that does not exist yet. It recovers, but
# the first thing you would see is a stack trace, and a stack trace on a fresh
# checkout is indistinguishable from something being wrong.
pnpm --filter @paathshala/api build >/dev/null 2>&1 || die "the API did not compile"
ok "API compiled"

nohup pnpm dev:api > "$LOGS/api.log" 2>&1 &
nohup pnpm dev:web > "$LOGS/web.log" 2>&1 &

printf '  waiting for the API'
API_UP=""
for _ in $(seq 1 120); do
  code=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:3001/v1/me 2>/dev/null)
  # 401 is the right answer: the route exists and is refusing an unauthenticated
  # request, which is precisely what "up" looks like here.
  if [ "$code" = "401" ]; then API_UP=1; break; fi
  printf '.'; sleep 1
done
echo
[ -n "$API_UP" ] || { tail -40 "$LOGS/api.log"; die "the API did not start — log above"; }
ok "API listening on http://localhost:3001"

printf '  waiting for the web app'
WEB_UP=""
for _ in $(seq 1 120); do
  code=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:3000/ 2>/dev/null)
  if [ "$code" = "200" ]; then WEB_UP=1; break; fi
  printf '.'; sleep 1
done
echo
[ -n "$WEB_UP" ] || { tail -40 "$LOGS/web.log"; die "the web app did not start — log above"; }
ok "web app listening on http://localhost:3000"

# ----------------------------------------------------------------- summary

cat <<SUMMARY

$(bold "Open http://localhost:3000")

  Three accounts, one password:

    principal@demo.school     demo-password-1234    sees everything
    accounts@demo.school      demo-password-1234    sees money
    teacher@demo.school       demo-password-1234    sees no fees at all

  The screens do not branch on role. Sign in as the teacher and open Fees:
  it is the same page, and it is empty because the database returned no rows.

SUMMARY

if [ -n "${API_KEY:-}" ]; then
  cat <<KEY
  A test API key was issued (shown once, here):

    $API_KEY

    curl -H "Authorization: Bearer $API_KEY" \\
         'http://localhost:3001/api/v1/students?limit=3'

KEY
fi

cat <<TAIL
  Logs:   tail -f $LOGS/api.log
          tail -f $LOGS/web.log
  Stop:   bash run-local.sh stop      app servers only
          bash run-local.sh down      containers too
  Reset:  bash run-local.sh reset     wipes the database and rebuilds it

TAIL
