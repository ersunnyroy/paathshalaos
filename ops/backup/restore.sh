#!/usr/bin/env bash
#
# A restore (M24.2).
#
# Deliberately awkward in one specific way: the target database must be named
# explicitly and must not already exist. There is no --force and no drop. A
# restore script that can overwrite a live database is a restore script that
# eventually does, usually while somebody is reading a runbook at speed with
# the wrong terminal focused.
#
# The order matters and is the reason this is a script rather than two
# commands. Roles must exist before the dump is restored, because every GRANT
# in it names one; restoring the dump first produces a long list of "role does
# not exist" errors that pg_restore reports as warnings and exits zero on.
set -euo pipefail

BACKUP_DIR="${1:?usage: restore.sh <backup-dir> <target-database>}"
TARGET_DB="${2:?usage: restore.sh <backup-dir> <target-database>}"

: "${PGHOST:=localhost}"
: "${PGPORT:=5432}"
: "${PGUSER:=paathshala_owner}"
: "${PGSUPERUSER:=$PGUSER}"

for f in roles.sql data.dump manifest.json; do
  [ -f "$BACKUP_DIR/$f" ] || { echo "missing $BACKUP_DIR/$f" >&2; exit 1; }
done

exists=$(psql --host="$PGHOST" --port="$PGPORT" --username="$PGSUPERUSER" \
  --dbname=postgres --tuples-only --no-align \
  --command="SELECT 1 FROM pg_database WHERE datname = '$TARGET_DB'")
if [ -n "$exists" ]; then
  echo "refusing: database '$TARGET_DB' already exists." >&2
  echo "A restore that can overwrite a live database eventually does." >&2
  exit 1
fi

# Roles first — see above. Already-exists errors are expected when restoring
# into a cluster that has them, and are the only errors tolerated here.
psql --host="$PGHOST" --port="$PGPORT" --username="$PGSUPERUSER" \
  --dbname=postgres --quiet --file="$BACKUP_DIR/roles.sql" 2>&1 \
  | grep -v 'already exists' || true

psql --host="$PGHOST" --port="$PGPORT" --username="$PGSUPERUSER" \
  --dbname=postgres --quiet \
  --command="CREATE DATABASE \"$TARGET_DB\" OWNER $PGUSER"

# --exit-on-error, because the default is to report failures and exit zero.
# A restore that half-worked and said nothing is the worst outcome available:
# it is a database that looks restored.
pg_restore --host="$PGHOST" --port="$PGPORT" --username="$PGUSER" \
  --dbname="$TARGET_DB" \
  --exit-on-error \
  --jobs=4 \
  "$BACKUP_DIR/data.dump"

echo "restored $BACKUP_DIR into $TARGET_DB"
