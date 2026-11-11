-- 0086: the three columns a file needs once the bytes are real.
--
-- `file` has existed since 0017 with a bucket, an object key, a digest and a
-- scan state, and until M37 nothing in this product ever wrote a byte to an
-- object store. Every column here is one the lifecycle needs and the table
-- could not have wanted before there was one.

-- What the person called it.
--
-- Not part of the key — the key is content-addressed and derived, because a
-- key built from an uploaded filename is a path the uploader controls. But a
-- download that arrives as `9f86d081884c7d65…` with no extension is a download
-- nobody can use, so the name rides in `Content-Disposition` on the signed URL
-- and lives here.
--
-- Nullable: a file created by an internal process has no filename anybody
-- typed, and inventing one would be a lie in a column somebody later reports on.
ALTER TABLE file ADD COLUMN original_filename text;

-- When the scanner answered, whatever it said.
--
-- Distinct from `virus_scan_state` because 'pending' has two meanings that
-- matter to an operator: nobody has looked yet, and somebody looked and the
-- scanner was down. The state is the same — the file is not served either way
-- — and the timestamp is what tells them apart.
ALTER TABLE file ADD COLUMN scanned_at timestamptz;

-- When the bytes actually went.
--
-- `deleted_at` says a school asked for this file to be gone. `erased_at` says
-- the object store no longer has it. They are days apart by design: marking is
-- transactional and happens in the request, erasing is a job that can be
-- interrupted and repeated.
--
-- The row is NOT deleted when the bytes are. A retention policy has to be able
-- to show that something was there and is not, and a sweep that deleted rows
-- could not tell "erased" from "never existed" — it would run against the same
-- object forever, or stop being able to prove it ever ran.
ALTER TABLE file ADD COLUMN erased_at timestamptz;

-- Bytes cannot be gone for a file that is still live.
--
-- The ordering is the whole guarantee: something is marked deleted, and only
-- then erased. Without this an UPDATE that set `erased_at` alone would leave a
-- row every screen still treats as a file, pointing at nothing.
ALTER TABLE file
  ADD CONSTRAINT file_erased_implies_deleted
    CHECK (erased_at IS NULL OR deleted_at IS NOT NULL);

-- A file under legal hold is never erased, and the sweep must not have to read
-- the whole table to find that out. Partial, on exactly the sweep's predicate.
CREATE INDEX file_pending_erasure_idx
  ON file (tenant_id, deleted_at)
  WHERE deleted_at IS NOT NULL AND erased_at IS NULL AND legal_hold = false;

-- The scan backlog, for the job that reports it. A deployment with no scanner
-- configured accumulates these, which is the point: it should look like it is
-- missing one.
CREATE INDEX file_pending_scan_idx
  ON file (tenant_id, created_at)
  WHERE virus_scan_state = 'pending' AND deleted_at IS NULL;
