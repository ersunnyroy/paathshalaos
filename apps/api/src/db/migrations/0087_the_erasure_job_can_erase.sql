-- 0087: the job that counted a liability can now remove it.
--
-- `files.pending_erasure` has run nightly since 0082 with this description:
--
--   "Count files marked deleted whose bytes are still in object storage. This
--    product has no object-storage client, so the count is the whole job — a
--    liability that is measured rather than forgotten."
--
-- That was honest and it was also the shape of the gap. Every night it reported
-- a number that could not go down. M37 gave the product an object-storage
-- client, so the job deletes the objects and reports what is left.
--
-- The description is UPDATEd rather than the row being deleted and reinserted:
-- `scheduled_task` carries `next_run_at`, `last_started_at` and a lease, and
-- replacing the row would reset a schedule that is running and lose the history
-- a reader uses to tell "never ran" from "ran and did nothing".

UPDATE scheduled_task
   SET description =
     'Delete the objects behind files a school has marked deleted, and report '
     || 'what is left. Skips anything under legal hold — litigation outranks a '
     || 'retention schedule. Until M37 this job could only count, because '
     || 'nothing in this product had ever opened a connection to object storage.'
 WHERE key = 'files.pending_erasure';

-- The other half of the same story.
--
-- 0017 says nothing may be served until a scan has cleared it, and until M37
-- there was nothing that could clear one. A deployment with no CLAMD_HOST
-- accumulates stored-and-unserved files, which is deliberate — it should look
-- like it is missing a scanner rather than quietly serving unscanned files —
-- and this is the number that makes it look that way.
INSERT INTO scheduled_task (key, description, interval_seconds, lease_seconds) VALUES
  ('files.scan_backlog',
   'Count uploads that are stored and not yet cleared by the virus scanner, '
   || 'and how long the oldest has waited. With no scanner configured this '
   || 'climbs forever and is supposed to: nothing is served until something '
   || 'has looked at it. With one configured, a climbing number means clamd is '
   || 'down and the age says for how long.',
   3600, 300)
ON CONFLICT (key) DO NOTHING;
