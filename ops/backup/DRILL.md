# Restore drill — what was actually run

A backup nobody has restored is a belief, not a backup. This file records a
drill that was run, with the numbers it produced, because "how long would a
restore take" is asked during the incident and measuring it then is too late.

Re-run it with `ops/backup/drill.sh`. It is destructive only to its own scratch
database, which it drops on exit.

## The run

| | |
| --- | --- |
| Date | 2026-09-20 |
| Where | The development container, PostgreSQL 16.13, local socket |
| Source database | 46 MB, 70 migrations, 186 policies, 3 tenants, 115 tables (61 with rows) |
| Backup | **0.41 s**, producing a 1.5 MB compressed dump |
| Restore | **1.61 s** into a fresh database |
| Total | **2.02 s** |

## What it proved

1. **The dump restores**, with `pg_restore --exit-on-error`. The default is to
   report failures and exit zero, which is how a half-restored database gets
   called restored.
2. **The roles are in the backup.** They are cluster objects and absent from a
   database dump; a restore without them produces a database whose every
   `GRANT` names something that does not exist. See the finding below.
3. **Row-level security came back, and is still forced.** 186 policies, and no
   tenant table without `FORCE ROW LEVEL SECURITY`. A restore that brings the
   tables and drops the policies hands every school every other school's
   records, and looks perfect from the row counts.
4. **The data matches by content**, md5 per table rather than by count. Two
   tables with the same number of rows and different contents is exactly what a
   partial restore looks like.
5. **Isolation still works, by querying** — as `paathshala_app`, with a tenant
   scope set, returning 1 of 2 campuses.

## What it does not prove

- **Point-in-time recovery.** This restores a dump. Losing everything since it
  was taken is the shape of the guarantee, and "restore us to 14:32, just
  before the import" needs WAL archiving — which belongs to M22 and does not
  exist. A nightly dump is not a recovery plan; it is the floor under one.
- **A restore into a genuinely fresh cluster.** The drill runs against the
  cluster the backup came from. That is precisely why step 2 reads the backup
  *file* for the role definitions rather than trusting the cluster to have them.
- **Timing at customer scale.** 46 MB restores in under two seconds. A school
  with five years of attendance is a different measurement and this number
  should not be quoted as if it covered one.

## The finding this drill produced

The drill was written, run, and then deliberately broken four ways to check it
could fail. Three were caught: dropping row-level security, losing three rows,
and changing one value without changing any count.

The fourth was not. Emptying `roles.sql` entirely — the classic way a backup
turns out not to be one — left every check passing, because the roles were
already present in the cluster being restored into. The drill was confirming a
property of the machine it ran on rather than of the backup.

Step 2 now checks the backup artifact for the four `CREATE ROLE` statements,
which holds whatever cluster it runs against. That mutation now fails the drill.

A drill that cannot fail is a ritual. This one was one, for about ten minutes.

## Before this is a real backup story

- [ ] WAL archiving and point-in-time recovery (M22).
- [ ] The drill run against a fresh cluster, not the source's.
- [ ] The drill run on a restore of production-sized data, with the time
      recorded here next to this one.
- [ ] A schedule, and an alert when a backup does not appear.
- [ ] The dump encrypted at rest, and the restore path tested with the
      encryption in place.
