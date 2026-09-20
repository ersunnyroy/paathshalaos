#!/usr/bin/env bash
#
# The restore drill (M24.3).
#
# The reason this file exists, rather than a paragraph in a runbook: a backup
# nobody has restored is a belief, not a backup. Every part of this has to
# actually run, and the time it takes has to be written down, because "how long
# would a restore take" is the question asked during the incident and it is too
# late to measure then.
#
# What it proves, in order of how easy it is to get wrong:
#
#   1. The dump restores at all, into a cluster that does not already have the
#      schema. `--exit-on-error`, because pg_restore's default is to report
#      failures and exit zero.
#   2. The ROLES came back. Not obvious: they are cluster objects, absent from
#      a database dump, and a restore without them silently produces a database
#      the application cannot connect to.
#   3. The row-level security came back and is still FORCED. A restore that
#      brings the tables and drops the policies is a restore that hands every
#      school every other school's records — and it looks perfect from the row
#      counts.
#   4. The DATA matches, by content hash rather than by count. Two tables with
#      the same number of rows and different contents is exactly what a partial
#      restore looks like.
#   5. Isolation still works, tested by actually querying as the application
#      role with a tenant scope set — not by reading the catalogue.
#
# What it does NOT prove, and should not be read as proving:
#
#   - Recovery to a point in time. This restores a dump, which means losing
#     everything since it was taken. "Restore us to 14:32, just before the
#     import" needs WAL archiving, which belongs to M22.
#   - A restore into a genuinely fresh cluster. This one runs against the
#     cluster the backup came from, so the roles are already there; that is why
#     step 2 checks the backup FILE for them rather than trusting the cluster.
#   - How long any of this takes on a database the size of a real customer's.
#     The numbers below are honest and small, and a school with five years of
#     attendance is a different measurement.
set -euo pipefail

: "${PGHOST:=localhost}"
: "${PGPORT:=5432}"
: "${PGUSER:=paathshala_owner}"
: "${PGDATABASE:=paathshala}"
SCRATCH_DB="${1:-paathshala_drill}"
WORK_DIR="$(mktemp -d)"
HERE="$(cd "$(dirname "$0")" && pwd)"

cleanup() {
  psql --host="$PGHOST" --port="$PGPORT" --username="$PGUSER" --dbname=postgres \
    --quiet --command="DROP DATABASE IF EXISTS \"$SCRATCH_DB\"" >/dev/null 2>&1 || true
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

say() { printf '%s\n' "$*"; }
fail() { printf 'DRILL FAILED: %s\n' "$*" >&2; exit 1; }

# A scratch database from a previous run would make step 1 pass for the wrong
# reason.
psql --host="$PGHOST" --port="$PGPORT" --username="$PGUSER" --dbname=postgres \
  --quiet --command="DROP DATABASE IF EXISTS \"$SCRATCH_DB\"" >/dev/null

say "== backup =="
backup_start=$(date +%s.%N)
"$HERE/backup.sh" "$WORK_DIR/backup" >/dev/null
backup_end=$(date +%s.%N)
backup_seconds=$(echo "$backup_end - $backup_start" | bc)
dump_bytes=$(stat -c %s "$WORK_DIR/backup/data.dump")
say "backup: ${backup_seconds}s, $(numfmt --to=iec "$dump_bytes")"

say "== restore =="
restore_start=$(date +%s.%N)
"$HERE/restore.sh" "$WORK_DIR/backup" "$SCRATCH_DB" >/dev/null
restore_end=$(date +%s.%N)
restore_seconds=$(echo "$restore_end - $restore_start" | bc)
say "restore: ${restore_seconds}s"

q() { psql --host="$PGHOST" --port="$PGPORT" --username="$PGUSER" \
  --dbname="$1" --tuples-only --no-align --command="$2"; }

say "== 2. roles =="
# Two checks, and the first one is the one that matters.
#
# Checking the cluster alone is not enough and this drill proved it: emptying
# roles.sql entirely left every check passing, because the roles were already
# in the cluster the backup came from. A real recovery restores into a cluster
# that has never seen them, and there the same backup produces a database whose
# every GRANT names something that does not exist — the application cannot
# connect, and the restore reported success.
#
# So the ARTIFACT is checked for the role definitions, which holds whatever
# cluster this runs against, and the cluster is checked afterwards for the
# restore's own sake.
for role in paathshala_app paathshala_auth paathshala_health paathshala_platform; do
  grep -qE "CREATE ROLE $role;|CREATE ROLE \"$role\";" "$WORK_DIR/backup/roles.sql" \
    || fail "the backup does not define role $role — a restore into a fresh cluster would fail"
done
for role in paathshala_app paathshala_auth paathshala_health paathshala_platform; do
  [ "$(q postgres "SELECT 1 FROM pg_roles WHERE rolname = '$role'")" = "1" ] \
    || fail "role $role is missing after restore"
done
say "four application roles defined in the backup and present after restore"

say "== 3. row-level security =="
src_policies=$(q "$PGDATABASE" "SELECT count(*) FROM pg_policy")
dst_policies=$(q "$SCRATCH_DB" "SELECT count(*) FROM pg_policy")
[ "$src_policies" = "$dst_policies" ] \
  || fail "policies: source has $src_policies, restore has $dst_policies"
unforced=$(q "$SCRATCH_DB" "
  SELECT count(*) FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id'
   WHERE c.relkind = 'r' AND n.nspname = 'public'
     AND NOT (c.relrowsecurity AND c.relforcerowsecurity)")
[ "$unforced" = "0" ] || fail "$unforced tenant tables lost FORCE ROW LEVEL SECURITY"
say "$dst_policies policies, every tenant table still forced"

say "== 4. data, by content =="
# Hashed per table rather than counted, and table by table rather than in one
# query: hashing every table at once needs dynamic SQL, and a DO block that
# builds queries from catalogue names is a worse thing to have in a restore
# drill than a loop.
tables=$(q "$PGDATABASE" "
  SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE c.relkind = 'r' AND n.nspname = 'public' ORDER BY c.relname")
mismatched=0
checked=0
nonempty=0
for tbl in $tables; do
  src=$(q "$PGDATABASE" "SELECT md5(COALESCE(string_agg(md5(t.*::text), '' ORDER BY md5(t.*::text)), '')) || ':' || count(*) FROM \"$tbl\" t")
  dst=$(q "$SCRATCH_DB" "SELECT md5(COALESCE(string_agg(md5(t.*::text), '' ORDER BY md5(t.*::text)), '')) || ':' || count(*) FROM \"$tbl\" t")
  checked=$((checked + 1))
  [ "${src##*:}" != "0" ] && nonempty=$((nonempty + 1))
  if [ "$src" != "$dst" ]; then
    mismatched=$((mismatched + 1))
    say "  MISMATCH $tbl: source $src, restore $dst"
  fi
done
[ "$mismatched" = "0" ] || fail "$mismatched tables differ after restore"
say "$checked tables hashed, $nonempty with rows, all identical"

say "== 5. isolation, by querying =="
# The catalogue saying a policy exists is not the same as the policy working,
# so this runs a real query as the application role.
#
# A second tenant is CREATED here, in the scratch database, rather than hoping
# the source has two. A drill that only proves isolation when the backup
# happens to contain more than one school proves nothing on a fresh install —
# and "the restore worked" is a sentence somebody will say after running this
# against exactly that. The scratch database is dropped on exit; the source is
# never touched.
# `| head -1` because psql prints the command tag after the returned row, and
# an id with "INSERT 0 1" stuck on the end is not a uuid.
probe_id=$(q "$SCRATCH_DB" "
  INSERT INTO organization (legal_name, display_name)
  VALUES ('Drill Probe Trust', 'Drill Probe') RETURNING id" | head -1)
q "$SCRATCH_DB" "
  INSERT INTO campus (tenant_id, code, name, is_primary)
  VALUES ('$probe_id', 'DRILL', 'Drill Probe Campus', true)" >/dev/null

scoped=$(PGPASSWORD="${PGAPPPASSWORD:-local_dev_only}" psql \
  --host="$PGHOST" --port="$PGPORT" --username=paathshala_app \
  --dbname="$SCRATCH_DB" --tuples-only --no-align --quiet \
  --command="SELECT set_config('app.tenant_id', '$probe_id', false)" \
  --command="SELECT count(*) FROM campus" | tail -1)
all=$(q "$SCRATCH_DB" "SELECT count(*) FROM campus")

# Exactly the probe's one campus, out of however many the restore contains.
[ "$scoped" = "1" ] || fail "scoped read returned $scoped campuses, expected 1"
[ "$all" -gt 1 ] || fail "only $all campus in the restore; the check would pass trivially"
say "as paathshala_app scoped to one tenant: $scoped of $all campuses — isolation intact"

say ""
say "== result =="
say "backup   ${backup_seconds}s  ($(numfmt --to=iec "$dump_bytes"))"
say "restore  ${restore_seconds}s"
say "total    $(echo "$backup_seconds + $restore_seconds" | bc)s"
say "source manifest: $(cat "$WORK_DIR/backup/manifest.json")"
