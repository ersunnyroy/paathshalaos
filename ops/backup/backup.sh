#!/usr/bin/env bash
#
# A backup of one database (M24.1).
#
# Two files, deliberately.
#
# `roles.sql` exists because the thing that makes this schema safe is not in a
# database dump. `paathshala_app`, `_auth`, `_health` and `_platform` are
# CLUSTER-level objects: a dump carries the grants that name them and not the
# roles themselves, so restoring into a fresh cluster produces a database whose
# every GRANT points at something that does not exist. The restore appears to
# work and the application cannot connect. That is the classic way a backup
# turns out not to have been one, and it is caught here rather than at 3am.
#
# `data.dump` is the custom format, not plain SQL: it can be restored
# selectively, in parallel, and it compresses. Plain SQL is a text file you
# cannot do anything with except run all of it.
#
# What this is NOT: a substitute for point-in-time recovery. A nightly dump
# means losing up to a day, and the answer to "restore us to 14:32, just before
# the import" is WAL archiving, which belongs to the deployment (M22) and does
# not exist yet. Stated here because a script called backup.sh invites the
# assumption that backups are handled.
set -euo pipefail

: "${PGHOST:=localhost}"
: "${PGPORT:=5432}"
: "${PGDATABASE:=paathshala}"
: "${PGUSER:=paathshala_owner}"
OUT_DIR="${1:-./backups/$(date -u +%Y%m%dT%H%M%SZ)}"

mkdir -p "$OUT_DIR"

# Roles first. `--no-role-passwords` because a backup file that carries
# credential hashes is a backup file that has to be guarded like a credential
# store; the passwords come from the secret manager on restore.
pg_dumpall --host="$PGHOST" --port="$PGPORT" --username="$PGUSER" \
  --roles-only --no-role-passwords > "$OUT_DIR/roles.sql"

# The database itself.
pg_dump --host="$PGHOST" --port="$PGPORT" --username="$PGUSER" \
  --dbname="$PGDATABASE" \
  --format=custom \
  --compress=9 \
  --file="$OUT_DIR/data.dump"

# A manifest, so a restore can check it is restoring what it thinks it is.
# The migration count is the schema version: a dump restored against code
# expecting a later one is the failure that corrupts rather than breaks.
psql --host="$PGHOST" --port="$PGPORT" --username="$PGUSER" \
  --dbname="$PGDATABASE" --tuples-only --no-align \
  --command="SELECT json_build_object(
      'taken_at', now(),
      'server_version', current_setting('server_version'),
      'migrations', (SELECT count(*) FROM schema_migration),
      'latest_migration', (SELECT max(name) FROM schema_migration),
      'policies', (SELECT count(*) FROM pg_policy),
      'tenants', (SELECT count(*) FROM organization))" \
  > "$OUT_DIR/manifest.json"

echo "backup written to $OUT_DIR"
cat "$OUT_DIR/manifest.json"
