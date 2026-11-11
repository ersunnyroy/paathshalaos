-- 0082: a scheduler, and the four jobs that have been described in comments
-- since M1 without ever running (M33.1).
--
-- Four functions in this codebase have a comment saying a scheduled job calls
-- them. None of them has a caller anywhere in `src/`:
--
--   `seal_audit_period` (0007) — "a scheduled job seals each closed period".
--     The audit log's tamper-evidence is this function. `audit_checkpoint` is
--     empty in every database this product has ever built, so the audit trail
--     is not tamper-evident; it has a function that would make it so.
--   `retentionService.purgeUnsuccessfulApplicantDocuments` (M18) — ID proofs
--     and birth certificates belonging to children who never enrolled, which
--     the comment calls "the single largest pile of needless personal data an
--     institute holds". Nothing has ever purged one.
--   `ledgerService.unbalancedGroups` — "the nightly integrity job's query".
--     There is no nightly integrity job.
--   `ensure_audit_partition` (0007) — "called by a scheduled job; also called
--     defensively on insert failure". Only the defensive half exists, so every
--     first audit write of a month pays for a CREATE TABLE.
--
-- The common cause is recorded elsewhere as a gap: this system has one worker,
-- the webhook relay, and no scheduler. Every job was therefore written as
-- something somebody else would arrange later.
--
-- ## Why a table rather than cron
--
-- A crontab is not in the repository, is not in the tests, and cannot say when
-- it last succeeded. The failure mode that matters here is not a job that
-- crashes — it is a job that silently stops running, which is exactly what has
-- happened for the whole life of this product. So the schedule is a row, the
-- outcome of every run is a row, and "when did this last succeed" is a query.

CREATE TABLE scheduled_task (
  key                   text PRIMARY KEY,
  description           text NOT NULL,

  interval_seconds      integer NOT NULL CHECK (interval_seconds >= 60),
  enabled               boolean NOT NULL DEFAULT true,

  -- The claim is an UPDATE on this column, which is what makes two workers
  -- safe without a lock table: the second one finds nothing due.
  next_run_at           timestamptz NOT NULL DEFAULT now(),

  -- A lease, not a mutex. A worker that dies mid-run would otherwise hold the
  -- task forever; after `lease_seconds` another worker may take it. Long
  -- enough that a slow run is not double-started, short enough that a crashed
  -- one is not a day's outage.
  running_since         timestamptz,
  lease_seconds         integer NOT NULL DEFAULT 900 CHECK (lease_seconds >= 60),

  last_started_at       timestamptz,
  last_finished_at      timestamptz,
  last_status           text CHECK (last_status IN ('ok', 'partial', 'failed')),
  last_error            text,
  consecutive_failures  integer NOT NULL DEFAULT 0,

  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX scheduled_task_due_idx ON scheduled_task (next_run_at) WHERE enabled;

CREATE TRIGGER scheduled_task_set_updated_at
  BEFORE UPDATE ON scheduled_task FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- One row per task per tenant per run.
--
-- Tenant-scoped on purpose, and not only for isolation: "your retention purge
-- ran on the 3rd and removed 412 documents" is evidence a school needs and
-- cannot produce today. A log only the operator can read is not a compliance
-- record.
CREATE TABLE task_run (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES organization (id),
  task_key     text NOT NULL REFERENCES scheduled_task (key),

  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  status       text NOT NULL DEFAULT 'running'
                 CHECK (status IN ('running', 'ok', 'failed')),
  -- What the job did, in its own shape. Read by people, not by code.
  detail       jsonb,
  error        text,

  CONSTRAINT task_run_finished_has_outcome
    CHECK ((status = 'running') = (finished_at IS NULL))
);

CREATE INDEX task_run_recent_idx ON task_run (tenant_id, task_key, started_at DESC);
CREATE INDEX task_run_failures_idx ON task_run (task_key, started_at DESC)
  WHERE status = 'failed';

ALTER TABLE task_run ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_run FORCE  ROW LEVEL SECURITY;

-- Read-only for a school. The worker writes as the owner, so there is
-- deliberately no INSERT or UPDATE policy here: a tenant principal cannot
-- fabricate evidence that a purge ran.
GRANT SELECT ON task_run TO paathshala_app;
CREATE POLICY tenant_isolation ON task_run
  FOR SELECT TO paathshala_app
  USING (tenant_id = app_current_tenant_id());

GRANT SELECT ON scheduled_task, task_run TO paathshala_platform;
CREATE POLICY platform_reads ON task_run
  FOR SELECT TO paathshala_platform USING (true);

ALTER TABLE scheduled_task ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduled_task FORCE  ROW LEVEL SECURITY;
CREATE POLICY platform_reads ON scheduled_task
  FOR SELECT TO paathshala_platform USING (true);

-- ---------------------------------------------------------------------------
-- The schedule itself
-- ---------------------------------------------------------------------------
--
-- Seeded here rather than assembled in code, so that "what is supposed to run"
-- is answerable from a database nobody has the source for. A key that the code
-- does not know is skipped and reported, which is the safe direction: a task
-- removed from the registry stops running and says so, instead of a deploy
-- silently dropping a compliance job.

INSERT INTO scheduled_task (key, description, interval_seconds, lease_seconds) VALUES
  ('audit.seal',
   'Seal each closed day of the audit log, so altering a row breaks every '
   || 'checkpoint after it. Without this the audit trail is not tamper-evident.',
   3600, 1800),

  ('retention.applicant_documents',
   'Delete the ID proofs and certificates of applicants who did not enrol, one '
   || 'year after the decision. Data minimisation, and the largest pile of '
   || 'needless personal data a school holds.',
   86400, 1800),

  ('ledger.integrity',
   'Find any double-entry group that does not sum to zero. Detection only: a '
   || 'job that silently repaired the books would be worse than the imbalance.',
   86400, 900),

  ('files.pending_erasure',
   'Count files marked deleted whose bytes are still in object storage. This '
   || 'product has no object-storage client, so the count is the whole job — '
   || 'a liability that is measured rather than forgotten.',
   86400, 900),

  ('audit.partitions',
   'Create next month''s audit_log partition before anything needs it, so the '
   || 'first write of a month is not a CREATE TABLE on the request path.',
   86400, 300);

COMMENT ON TABLE scheduled_task IS
  'What is supposed to run, how often, and when it last did. The failure this '
  'shape exists for is not a job that crashes but a job that silently stops '
  'running — which is what happened to every job in this product until M33.';
