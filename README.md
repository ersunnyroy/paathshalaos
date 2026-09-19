# paathshalaOS

Multi-tenant institute operating system for Indian private schools and coaching institutes.
See `MILESTONES.md` for the full build plan.

**Status: M9 in progress, and it runs.** Tenancy with row-level security, identity, RBAC,
an append-only audit log, time-bound support access, the guardian-centric people model, a
clash-proof timetable, admissions through to enrollment, offline-first attendance, exact money
with a double-entry ledger, assessment and report cards, consent-gated messaging, a reversible
import pipeline, and a web app you can sign in to. **386 tests, all mutation-tested.**

## Prerequisites

Node 20.11+ (22 recommended), pnpm, and Docker Desktop.

```bash
corepack enable && corepack prepare pnpm@9.12.3 --activate
```

## Running it locally

Four commands to a working school, then two terminals.

```bash
docker compose up -d                 # Postgres 16 on :5433, Redis 7 on :6380
pnpm install
pnpm db:bootstrap                    # creates the two unprivileged roles — run once
pnpm db:migrate
pnpm db:seed                         # a demo school: 40 learners, fees, today's register
```

`pnpm db:seed` prints a **tenant id** and three logins. Put the tenant id in
`apps/web/.env.local`:

```
NEXT_PUBLIC_API_URL=http://localhost:3001
NEXT_PUBLIC_TENANT_ID=<the id the seed printed>
```

The tenant id is configuration rather than something the login form guesses. An email can
exist in more than one school, and picking one for the user is how somebody ends up looking at
the wrong institute's children.

Then, in two terminals:

```bash
pnpm dev:api    # API on http://localhost:3001
pnpm dev:web    # web on http://localhost:3000
```

Open <http://localhost:3000> and sign in. The password for all three is `demo-password-1234`:

| Login | What you see |
| --- | --- |
| `principal@demo.school` | Everything: dashboard, learners, attendance, fees |
| `accounts@demo.school` | The same, including money |
| `teacher@demo.school` | Learners and attendance. **The fees screen is empty** |

That last row is the thing worth checking. Sign in as the teacher and open Fees: no invoices,
no outstanding total. Nothing in the web app hides them — the same endpoint runs the same SQL,
and the rows do not come back, because `app_actor_has_finance_scope()` excludes TEACHER. Turn
that policy off in the database and the teacher sees every family's arrears with no code change
at all. That is what "isolation is in the database" means in practice.

Two more worth trying by hand:

- **Attendance** starts everybody present and asks you to mark the exceptions. Save the
  register twice — the second save reports the marks as already applied rather than
  double-recording them, which is the same idempotency the offline queue relies on.
- **The dashboard** sums its campus rows rather than computing a second total, so the group
  figures cannot drift from the per-campus ones. The page checks it in the browser too and
  says so if they ever disagree.

```bash
curl localhost:3001/health   # liveness — never touches a dependency
curl localhost:3001/ready    # readiness — fails while migrations are behind the code
pnpm --filter @paathshala/api test   # 386 tests against a real Postgres
```

### The interface

Compact, responsive to a 320px phone, and dark mode that is *selected* rather
than flipped — every dark value is chosen against the dark surface, because
inverting a light palette gives you grey-on-grey text and accents that glow. The
theme follows the OS until someone picks one, applied inline before first paint
so there is no white flash.

The brand teal is `#14B8A6`. It measures **2.49:1** against white, which makes it
a fine *mark* colour and an unusable *text* colour, so the tokens split the two:
`--brand` is the mark (the logo, a meter fill, a chart line), `--brand-solid`
carries white text, `--brand-ink` is teal text on a light surface. One hex doing
all three jobs is how a brand palette ends up with unreadable buttons. Every
foreground/background pair in both themes was measured, not eyeballed, and clears
WCAG AA.

A few decisions that are easy to undo by accident:

- **Money is compacted on tiles and exact in tables.** `₹2.64L` on a tile,
  `₹2,64,000.00` in the row, the exact figure on the tile as a tooltip. Lakh and
  crore because that is what the reader thinks in. Every total is summed in
  `BigInt`; nothing on this path becomes a float.
- **Charts are drawn from real rows.** The sparklines and the collection chart
  read a daily series out of `receipt` and `attendance_record`. A sparkline drawn
  from invented data is worse than none: it reads as evidence, and the first
  person who notices it disagrees with the ledger stops trusting every other
  number on the page. The tile smooths to a 7-day rolling total and *says so* —
  a school's daily collection is a sawtooth, and a 44px chart of a sawtooth is
  noise; the full chart below keeps the daily truth.
- **One axis, one hue, hover by default.** Never two y-scales on one chart. Text
  wears text tokens, never the series colour, so the chart survives greyscale.
- **Status colour is never the only signal.** Every pill carries a dot, a label
  and a wash, and the text uses a darker step than the mark: marks are graphical
  (3:1), text is text (4.5:1).
- **"Issued" and "overdue" are different states.** Painting a bill that has three
  weeks to run in red teaches the office to ignore red.
- **Tables lose columns rather than gain a horizontal scrollbar.** A scrollable
  table on a touch screen is a table nobody scrolls.
- **Skeletons, not the word "Loading".**

The logo is `apps/web/public/brand/` — an SVG mark, a horizontal lockup, a
favicon cut without the book (below ~32px the book is four pixels of noise that
makes the P ambiguous), and PNG exports.

### A note on `pnpm dev:api`

It compiles with `tsc --watch` and runs the emitted JavaScript, rather than using a loader.
Node's `--experimental-strip-types` only *removes* types — it cannot emit the decorator metadata
Nest's dependency injection reads at runtime, so `node --watch src/main.ts` fails at boot.
esbuild-based loaders strip types quickly but drop `emitDecoratorMetadata` too, which fails the
same way at the first injected dependency: later, and harder to read. Compiling with `tsc` means
development and production run the same emitted code.

Two consequences followed, and the second took a second bug to find:

1. The API runs compiled — `tsc` emits, `node dist/main.js` runs.
2. So do the database entry points. They used to run straight off `.ts` with
   `--experimental-strip-types`, which exists only on Node 22.6+ and fails on
   anything older with `node: bad option` — a message that reads like a broken
   repo rather than an old runtime. Compiling them removed the version cliff,
   and immediately exposed the next thing: `tsc` emits `.js` and nothing else,
   so a compiled `migrate.js` looked for `migrations/` beside itself, found an
   empty directory, and reported nothing to do. A migration runner that says
   "0 applied" on a fresh database is worse than one that crashes. The build now
   copies the `.sql` files into `dist/` and fails if it copies none.


## How isolation works

Three things enforce it, and all three are tested rather than documented:

1. **Row-level security in Postgres.** Every tenant table has a policy comparing `tenant_id`
   to `app_current_tenant_id()`, which reads a transaction-local setting. `FORCE ROW LEVEL
   SECURITY` means even the table owner is subject to it. If the setting is absent the
   comparison is `NULL` and no row qualifies — **forgetting the tenant fails closed**.

2. **An unprivileged database role.** The API connects as `paathshala_app`, which is
   `NOSUPERUSER NOBYPASSRLS` with no DDL rights. `assertAppRoleCannotBypassRls()` runs at
   boot and refuses to start the process otherwise, so a "temporary" `GRANT SUPERUSER` to
   unblock something cannot quietly reach production.

3. **One way in.** `withTenant()` opens a transaction, sets `app.tenant_id` via
   `set_config(..., true)`, and runs your query inside it. Transaction-scoped means the
   setting is released on commit, so a pooled connection never carries one request's tenant
   into the next. There is no escape hatch, and no repository method takes a tenant filter —
   isolation is the database's job, not something each query remembers.

### The suite is mutation-tested

Tests that pass when the thing they guard is broken are worse than no tests. Each of these
breaks was applied to a live database and the suite was re-run:

| Break introduced | Tests that failed |
| --- | --- |
| Drop the `campus` policy | 3 |
| Omit `WITH CHECK` (implicit fallback) | 2 |
| Narrow `USING` while `WITH CHECK` is implicit | 2 |
| `GRANT BYPASSRLS` to the app role | 12 |
| `NO FORCE ROW LEVEL SECURITY` | 1 |
| `DISABLE ROW LEVEL SECURITY` | 9 |
| Remove the `grants_version` trigger (AC-11) | 4 |
| Grant the app role the `password_hash` column | 1 |
| Grant the auth role a tenant table | 1 |
| Make the audit log mutable | 3 |
| Re-grant the audit partitions | 1 |
| Remove the 60-minute impersonation cap | 2 |
| Remove the self-approval constraint | 1 |
| Drop the user-visibility policy | 1 |
| Drop guardian scoping from `student` (AC-4) | 11 |
| Let a guardian write `guardian_link` | 4 |
| Make staff scope unconditionally true | 16 |
| Remove the `tenant_principal` sync trigger | 9 |
| Widen the `person` policy to the whole tenant | 2 |
| Make a consent record rewritable | 1 |
| Make a published notice editable | 1 |
| Drop the `can_view_academics` check (code) | 3 |
| Replace the sensitive-read staff check with `true` (code) | 3 |
| Drop the room double-booking constraint | 5 |
| Drop the teacher double-booking constraint | 4 |
| Drop the section double-booking constraint | 1 |
| Drop the term overlap constraint | 2 |
| Permit overlapping active academic years | 1 |
| Remove the academic-year derivation trigger | 4 |
| Let a guardian write the academic structure | 2 |
| Make rollover repoint source rows instead of copying (code) | 4 |
| Drop the one-active-enrollment index | 1 |
| Drop roll-number uniqueness | 1 |
| Remove the section/year consistency trigger | 2 |
| Remove the `enrollment_event` append-only triggers | 3 |
| Drop the one-live-decision index | 1 |
| Remove decision immutability | 7 |
| Drop the one-live-application index | 1 |
| Remove the published-form freeze | 5 |
| Drop the offer-needs-section constraint | 1 |
| Let a guardian into the admissions pipeline | 1 |
| Disable the schema whitelist (code) | 5 |
| Replace the date round-trip with `Date.parse` (code) | 1 |
| Remove the application-numbering advisory lock (code) | 1 |
| Drop the `client_event_id` idempotency index | 1 |
| Drop the one-record-per-enrollment index | 2 |
| Remove the correction append-only trigger | 5 |
| Let a guardian write attendance | 3 |
| Let a guardian read every record | 1 |
| Remove the locked-session guard (code) | 4 |
| Always trust the device clock (code) | 2 |
| Replace conflict with last-write-wins (code) | 1 |
| Resolve enrollment as of today, not the session date (code) | 17 |
| Ignore which learner an event id belongs to (code) | 1 |
| Accept any webhook signature (code) | 4 |
| Accept a webhook whose amount differs from the order (code) | 2 |
| Remove webhook event dedupe (code) | 1 |
| Allocate oldest-first, ignoring the invoice paid for (code) | 5 |
| Void an invoice that has received money (code) | 1 |
| Remove the service-level ledger balance assertion (code) | 1 |
| Post an empty ledger group (code) | 1 |
| Drop the rounding remainder when splitting instalments (code) | 3 |
| Truncate instead of rounding half-up on percentages (code) | 2 |
| Round tax on the total instead of per line (code) | 1 |
| Let a requester approve their own refund (code) | 3 |
| Let a requester approve their own concession (code) | 1 |
| Count unapproved concessions against the fee (code) | 1 |
| Make finance scope mean staff scope (SQL) | 1 |
| Let the institute authorise its own mandate (code) | 1 |
| Make revoked and expired mandates recoverable (code) | 2 |
| Stop enforcing the mandate ceiling (code) | 1 |
| Stop enforcing the mandate validity window (code) | 1 |
| Present a mandate for more than the invoice owes (code) | 1 |
| Settle a mandate presentation without a webhook (code) | 1 |
| Remove the CSV formula-injection guard (code) | 1 |
| Invert Tally's debit sign (code) | 1 |
| Ignore the export date range (code) | 1 |
| Accept an impossible export date (code) | 1 |
| Remove XML escaping from the export (code) | 1 |
| Store an absence as a zero (code) | 1 |
| Accept a row that is both a mark and an absence (code) | 1 |
| Drop the exactly-one-of-three CHECK on `mark` (SQL) | 1 |
| Drop the mark-ceiling trigger (SQL) | 4 |
| Replay a marks batch a second time (code) | 1 |
| Accept an event id reused for another learner (code) | 1 |
| Abort the whole batch on the first bad row (code) | 2 |
| Drop the grade-band overlap constraint (SQL) | 1 |
| Remove the scale-coverage gate (code) | 1 |
| Compute results over unlocked assessments (code) | 1 |
| Compute results on an unpublished scale (code) | 1 |
| Compute with weights that do not total 100 (code) | 1 |
| Score a learner with no mark row as zero (code) | 1 |
| Treat an exemption as an absence (code) | 1 |
| Omit `max_marks` from the input digest (code) | 1 |
| Omit the grading bands from the input digest (code) | 1 |
| Let the computer of a run review it (code) | 1 |
| Publish a run that was never reviewed (code) | 1 |
| Drop the one-published-run-per-section index (SQL) | 1 |
| Make a result line editable (SQL) | 1 |
| Make a published report card editable (SQL) | 2 |
| Correct a draft report card in place (code) | 1 |
| Let a guardian read raw marks (SQL) | 1 |
| Let a guardian read an unpublished result (SQL) | 1 |
| Let the correction flag alone unlock an assessment (SQL) | 1 |
| Approve one's own mark correction (code) | 1 |
| Check consent at queue time instead of send time (code) | 6 |
| Deduplicate recipients by person, not by subject (code) | 4 |
| Record a suppression with no reason (code) | 1 |
| Drop the suppression-needs-a-reason CHECK (SQL) | 1 |
| Drop the one-per-(person, subject) index (SQL) | 13 |
| Render a missing template variable as blank (code) | 1 |
| Remove the channel fallback chain (code) | 1 |
| Approve an SMS template with no DLT registration (SQL) | 1 |
| Make an approved template version editable (SQL) | 1 |
| Remove delivery-receipt dedupe (code) | 1 |
| Act on a receipt with an invalid signature (code) | 1 |
| Let a late receipt move a message backwards (code) | 1 |
| Ignore a muted purpose (code) | 6 |
| Remove message-request idempotency (code) | 1 |
| Make `may_message()` always return ok (SQL) | 6 |
| Make `may_message()` ignore withdrawal (SQL) | 3 |
| Let a guardian read everyone's messages (SQL) | 1 |
| Write valid rows during validation (code) | 3 |
| Skip the plan-digest check on apply (code) | 2 |
| Omit the matched id from the plan digest (code) | 2 |
| Stop detecting duplicates within the file (code) | 7 |
| Accept an impossible date (code) | 7 |
| Parse an Excel-mangled phone number anyway (code) | 1 |
| Drop the required-field check (code) | 7 |
| Cascade an import reversal instead of refusing (code) | 1 |
| Allow an unmapped required field (code) | 1 |
| Allow a target that is not a field of the entity (code) | 1 |
| Invert the two-digit-year pivot (code) | 1 |

The `WITH CHECK` rows are worth explaining. Postgres reuses the `USING` expression as the
write check when `WITH CHECK` is omitted, so an implicit policy behaves correctly — until
somebody narrows `USING` for an unrelated reason (adding `AND deleted_at IS NULL`, say) and
silently changes the write rule with it. The `rls_coverage` view therefore fails the build on
any policy that leaves `WITH CHECK` implicit, and on any table carrying `tenant_id` that has
no policy at all. That is what keeps the guarantee true as the schema grows.

## Two database roles

Credentials and tenant data are reached by different Postgres roles, so a SQL injection in a
student search cannot read a password hash, and a bug in the login path cannot read a fee
ledger. It costs one extra connection pool.

| Role | Can reach | Cannot reach |
| --- | --- | --- |
| `paathshala_app` | Tenant tables, `role_grant`, audit appends | Any credential column — `password_hash` is withheld by a **column-level grant**, so even `SELECT *` is refused by the planner |
| `paathshala_auth` | `user_account`, `session`, `device`; appends to `audit_log` | Every tenant table, and reading the audit log back |

Both assertions run at boot and refuse to start the process if either role has been widened.

## Identity, and why it is not tenant-scoped

One guardian, one login, children at two different institutes. So `user_account` has no
`tenant_id`; access to a tenant comes from a grant. The app role sees a user only while a live
`role_grant` ties them to the current tenant.

Authorization is `role + scope_type + scope_id`. A grant covers its own scope and everything
below it, never above — a class-scoped teacher cannot reach the campus. Delegation is bounded
at both ends: a grant can never confer a permission the granter lacks, nor sit above the
granter's own scope, and both are re-checked inside the granting transaction.

### AC-11: a revoked role takes effect on the next request

A token is a claim about authority made when it was minted. Trusting it for its full lifetime
means a revoked teacher keeps their class for another ten minutes. Every access token carries
the `grants_version` it was minted with; a database trigger bumps that version on any grant
change; the guard compares them on every request. A mismatch means "re-read your authority",
not "you are logged out" — the client refreshes and continues.

The cost is one indexed single-row read per request, and that read is the seam where a cache
goes if it ever shows up in a profile.

### Refresh tokens

Opaque random bytes, stored as a SHA-256 hash, rotated on every use. Presenting an
already-rotated token means it was captured or the client is broken, and we cannot tell which
— so the entire family descended from that login is revoked. That logs the real user out too,
which is the correct trade against a live stolen session.

## Guardians, and AC-4

One guardian, one login, children at two institutes and at two campuses within one. Each
relationship carries its own capability flags — academics, finance, payment, pickup,
notifications — because "parent" as a single boolean is what every incumbent gets wrong, and
because custody arrangements are ordinary rather than exceptional.

**The enforcement lives in the database.** `listStudents` is the same SQL for a principal and
for a parent: the principal sees the school, the parent sees their two children. No repository
method takes a guardian filter, because a filter a developer has to remember is a filter
somebody forgets at the twentieth endpoint.

Two details make that possible, and both were forced by a real constraint — a policy
expression may not read the table it protects, or any table whose policy reads back, or
Postgres raises `infinite recursion detected in policy for relation`:

- **`tenant_principal`** is a trigger-maintained projection of `(tenant, login) -> person`, so
  the actor's person id is one non-recursive lookup away.
- **Staff scope is derived from `role_grant`, never from a flag the caller sets.** A
  caller-supplied "I am a guardian" flag would fail *open* the moment a code path forgot to set
  it. Deriving the positive staff capability from stored grants means an unknown actor gets
  nothing, and revoking a staff grant removes visibility on the next statement.

The asymmetry in the write path is deliberate and correct in both directions. A guardian *can*
see their own link row, so `USING` admits it and the `WITH CHECK` rejects the write outright.
For a learner they are not linked to, the row is invisible and an `UPDATE` affects nothing. A
guardian cannot link themselves to a learner at all — that is a child-safety boundary, so it
is refused by the database rather than merely absent from the app.

Sensitive columns — medical notes, blood group, accommodations, emergency contacts — go through
a separate, greppable read path that checks `can_view_academics` on the relationship and audits
every access, **including refused ones**. A denied attempt on a medical note is exactly as
interesting as a successful one.

## Consent

A notice is immutable once published, and each consent stores *which version* it was given
against — "we updated our privacy policy" must not retroactively rewrite what someone agreed
to. Consent for a minor is given by a guardian, and the record keeps both identities: whose
data, and who agreed.

Processing necessary to deliver the education contract is recorded with `basis = 'contract'`
and cannot be withdrawn, so withdrawing consent for optional processing never breaks the core
service. Withdrawal is immediate and never deletes the record; proof of consent has to outlive
the consent, or there is no way to answer "on what basis did you process this in March".

The purpose list, the age threshold, and what counts as verifiable parental consent are the
questions that need an Indian data-protection opinion before launch. The schema records those
decisions; it does not make them.

## The timetable: clashes are impossible, not detected

Three GiST exclusion constraints on `schedule_slot` mean a room, a teacher or a section cannot
be booked twice. Each matches on four dimensions at once — the academic year, the weekday,
overlapping minutes, and overlapping effective date ranges — so a lesson that ends in June and
its replacement in July do not conflict, and a lesson ending exactly when the next begins is not
a clash (the minute range is half-open).

**An application-level check cannot do this.** Two admins edit the timetable in parallel, both
read "free", both write, and the clash exists. The constraint is evaluated by the index under
the same lock as the insert, so the second write fails however the reads interleaved. There is a
test that fires two conflicting inserts concurrently and asserts exactly one survives.

`minutes` is a generated `int4range` of minutes since midnight, because Postgres has no range
type over `time` and exclusion constraints need one. `academic_year_id` is denormalized onto the
slot and set by a trigger — the application never supplies it. That column exists because of a
bug the constraints caught: a slot left open-ended in 2025-26 overlaps 2026-27 forever, so
rolling the timetable over collided with last year's own lessons. Scoping by year is both more
correct and cheaper than retroactively closing every prior-year range.

## AC-3: changing the structure does not break history

Every structure row is scoped to an academic year, and **rollover copies — it never updates a
prior-year row or repoints one at a new parent**. 2026-27 gets new `class_group` rows; last
year's records keep referencing last year's rows by id, and those rows are never touched again.
That is the whole mechanism behind "renaming Class X to Grade 10 next year cannot alter last
year's report cards".

The test proves it with **content hashes**, not by reading names back: every prior-year
`class_group` and `section` row is byte-identical before and after. A mutation that makes
rollover repoint the source rows instead of copying them fails four tests.

Rollover composes with a partly-configured year rather than demanding an empty one. Staff often
set next year's term dates before rolling structures over, and their dates beat a mechanical
+1 year, so existing terms are kept and only the gaps are filled. Where a term sequence cannot
be created at all — staff renumbered, and a label collision blocks it — rollover refuses rather
than writing offerings that would land on a null term. The whole operation is one transaction: a
half-rolled-over year is worse than an unstarted one, because staff cannot tell which classes
are real.

**What is proven now and what is not.** The structural invariant is fully tested. The literal
acceptance wording — "every 2025-26 report card renders with its original names" — completes in
M8, when report cards exist. The property they will depend on is in place and asserted.

## Admissions

Lead → enquiry → application → decision, with three things worth calling out.

**Application numbers are gapless per year**, generated under a transaction-scoped advisory
lock. `max(n) + 1` under concurrency hands two applicants the same number; a sequence leaves
gaps, which an admissions office reads as a lost form and will ask about. There is a test that
creates three applications concurrently; removing the lock fails it.

**A decision is immutable once issued.** A change of mind supersedes it rather than editing it,
so the sequence of what the institute actually told the family stays on the record — a partial
unique index keeps exactly one live decision per application. An offer must name a section and
carries an expiry that is evaluated on each request rather than by a sweeper, so it lapses on
time even if no job has run.

**A document cannot be verified until the virus scan has cleared.** `virus_scan_state` defaults
to `pending`, not `clean`: a file that skipped the scanner must not become downloadable because
somebody forgot to set a flag. Rejecting a document requires a reason the family can act on.

### Configurable forms, and why tenant schemas are untrusted

Institutes define their own admission questions as JSON Schema, versioned, frozen on publish.
A submission stores the id of the *version that validated it*, so an answer set is reproducible
years later after the form has changed five times. That freeze is also what makes the compiled
validator cache safe without invalidation: the schema behind an id can never change.

A tenant-authored schema is untrusted input, and JSON Schema is expressive enough to be a
denial-of-service vector. Before storage the schema is itself validated against a whitelist:
keywords, five formats, a depth limit, a field-count limit, identifier-shaped field names, and
a pattern check that rejects nested quantifiers — `^(a+)+$` in a form field would let any
applicant hang a request thread. Disabling that whitelist fails five tests.

The five formats are implemented directly rather than pulled from `ajv-formats`, because the
whitelist means only those five could ever be used. The date check is a **round trip**, not
`Date.parse`: `Date.parse('2014-02-31')` does not fail, it silently returns 3 March, so a birth
date would be stored as one day and mean another.

## Enrollment

**One active enrollment per learner per academic year**, enforced by a partial unique index. The
failure mode it prevents is a learner appearing on two rolls and one fee ledger, discovered in
March.

The two kinds of move are deliberately different:

- **Between sections within a year** updates `section_id` on the *same* row. One enrollment
  means one fee assignment, one attendance history, one roll — a learner who moves from XI-A to
  XI-B in August has not started a new relationship with the school.
- **Between campuses** ends one enrollment and opens another, linked in both directions, in one
  transaction. Two rows, because the learner genuinely belonged to two places and each has its
  own roll, fees and attendance that must stay attributable to where it happened. The partial
  unique index makes the *order* mandatory — the old row must stop being active before the new
  one is inserted — which is the invariant doing its job rather than being worked around.

A trigger refuses a section from a different academic year, so a cross-year "section change"
cannot slip through. `enrollment_event` is append-only, so a reversed decision keeps both moves
on the record.

## Attendance, and AC-5

The flagship differentiator: no benchmarked competitor claims offline attendance anywhere in
public documentation. The sync endpoint takes a batch a device may have held for days and
decides, per record, what happens. **Every branch is explicit; nothing is resolved by
last-write-wins**, because "the last device to reconnect decides" is not a rule anybody would
agree to if it were stated out loud.

| Situation | What happens |
| --- | --- |
| The same batch arrives again | No-op. The device generates `client_event_id` *before* any network call and never regenerates it, so a retry is idempotent |
| The session was locked before the sync arrived | Becomes a correction request for a human to approve. The stored record is untouched and the teacher is told what happens next |
| The session is more than 7 days old | Same — stale data cannot silently rewrite a month that may already be closed |
| Somebody else already marked that learner | **Conflict.** The server keeps what is stored and hands back both values with who entered each. The teacher chooses |
| The device clock is implausible | Server time is authoritative; the device's claim is kept for forensics and the rejection is audited |
| The learner transferred while the device was offline | The record attaches to the enrollment active **on the session date**, so the absence belongs to the section they were actually in |

Records reference `enrollment_id`, not `student_id`. That is what makes the last row work: a
learner who transferred mid-year has two enrollments, and the day they were absent belongs to
whichever one was live that day.

### The client queue

`offline-queue.ts` has no dependency on React Native, SQLite or fetch — storage and transport
are injected — so the behaviour a teacher experiences in a basement classroom is testable in
Node. A pending badge means they are never unaware of unsynced work; a transport failure never
consumes the queue entry; and a session awaiting a human decision stays visible as
`needs_attention` rather than disappearing. The queue holds only work still to do: records that
reached a settled outcome leave it, so resolving the last conflict empties the session instead
of leaving applied records to be replayed.

### The transactional outbox

`attendance.marked` is written to `outbox_event` in the **same commit** as the records, carrying
the absentee enrollment ids the M9 dispatcher will need. An event published from application
code after the commit is lost whenever the process dies in between — which is exactly when the
notification matters most. A replayed batch applies nothing, so it emits nothing, so nobody gets
a duplicate message.

## Money

**Arithmetic is exact, in bigint paise.** `money.ts` has no floating point in it. Rupees are
never stored as `number`, because 0.1 + 0.2 is not 0.3 and a fee ledger that drifts is a
reconciliation the accountant does by hand every month. The parser refuses anything that is
not a clean decimal — which is how the very first M7 test run caught Postgres returning
`33000.00000000000000000000` from a numeric division.

**Instalments add back to the total exactly.** Dividing 10,000 by 3 and rounding each part
gives three instalments of 3,333.33 and loses a paise, every term, for every learner on a
three-instalment plan. `split()` distributes the remainder one paise at a time, so the parts
are equal to within a paise and the sum is exact by construction.

**Tax rounds per line, not on the total.** The line tax is the figure that goes on a return; a
tax invoice whose lines do not add up to its total is a filing problem, not a display one.

**Settlement truth comes only from a signed webhook (AC-6).** A client-side success callback
is a URL anybody can call, so it moves nothing. The signature is verified before the body is
parsed, the raw body is stored before anything else, the event is deduped on the provider's own
event id, and the amount is re-checked against the order. A payment is `pending` until the
provider says otherwise — including a mandate presentation, which takes the same path.

**A payment remembers which invoice it was raised for.** Allocation settles that invoice first
and only then spills over to other dues. Pure oldest-first allocation hands a family a receipt
for a bill the books still show as unpaid.

**The ledger is double-entry and cannot be unbalanced.** A `DEFERRABLE INITIALLY DEFERRED`
constraint trigger checks each entry group at COMMIT, so a group can be built row by row and
still be refused as a whole if it does not balance to the paise. The app role holds `INSERT`
and `SELECT` on `ledger_entry` and nothing else: there is no `UPDATE` privilege to misuse. A
correction is a reversing group, so the original rows stay where the auditor left them.

**Refunds need two people and preserve the trail (AC-7).** The requester cannot approve; the
constraint is in the database, not the service. Nothing is rewritten — the original payment,
receipt and ledger group are untouched and the refund posts its own reversing entries.

**Teachers cannot see money.** `app_actor_has_finance_scope()` is deliberately narrower than
`app_actor_has_staff_scope()`: a teacher who knows which families are behind on fees treats
those children differently, and the class teacher is exactly the person a parent's arrears
should never reach. A guardian sees their own children's invoices, and only with
`can_view_finance` on the link.

**Mandates are the most dangerous object here** — standing permission to pull money from a
family's account. They are authorised only by a signed provider callback, never by the
institute; `revoked` and `expired` are terminal, so a family that withdraws permission is not
quietly reinstated by a later event; and every presentation is re-checked against the ceiling,
the validity window and what the invoice actually owes.

**The export is a feature, not a report.** Most institutes keep their statutory books in Tally
and the person who does that will not retype a term's receipts, so if the export is wrong the
audited accounts are wrong. CSV and Tally XML read the same rows through the same projection,
so they cannot disagree about a period. Two details that look cosmetic and are not: a narration
beginning `=` is executed as a formula when the CSV is opened in Excel, and Tally carries no
debit column — only one AMOUNT whose sign is the side, so inverting it imports a mirror image
of the books that still balances and complains about nothing.

## Assessment and results

**An absence is not a zero.** A learner who did not sit the paper has no mark. Storing it as 0
fails them for a paper they never took, drags the aggregate down, and afterwards cannot be told
apart from a genuine zero. A `mark` row carries exactly one of a number, an absence or an
exemption, enforced by a CHECK rather than a convention — and the service refuses a row that
claims to be two of them rather than guessing which was meant.

**An exemption leaves the denominator; an absence does not.** "This does not count for you" is
not "you scored nothing". Two learners with identical raw marks and different reasons for a
missing paper get different percentages, and that is correct. A learner with **no mark row at
all** is a third case again: nobody recorded anything, so the subject is reported as not
graded, with the reason, rather than scoring zero — the gap has to be visible to the reviewer,
because the alternative is a learner failing a subject the office forgot.

**Grading scales are data, and a published one is frozen.** Every board and half the private
schools grade differently; a percentage-to-letter mapping in code is a release for every
customer who joins. Bands are half-open `[lower, upper)`, so 80 is an A and not both a B and an
A depending on which row the planner reached first. Overlap is refused by an exclusion
constraint; a *hole* is refused at publish, because a gap produces a blank grade on a report
card the day it goes home.

**Marks freeze when the assessment locks.** After that the only way to change one is a
correction with a reason, approved by someone other than the person who raised it, and the
correction row keeps what the mark used to be — "it always said 34" is a thing a parent says,
and the system can answer it. The correction is applied by a database trigger that requires
BOTH a transaction-local flag and a matching pending correction row, so setting the flag alone
achieves nothing. The mark ceiling still applies: a correction is permission to change a mark,
never permission to store an impossible one.

**Results are deterministic and re-runnable.** Every input the computation reads — assessment
ids, weights, maxima, every mark, and the grading bands — is folded into a digest. Re-running
over unchanged inputs returns the same run rather than producing a second row that says the
same thing, and a changed digest is how a moved input announces itself. A digest that ignored
`max_marks` would call two runs identical while one of them halved everybody's percentage.

**Computing is not publishing.** A run sits in `computed` until someone who is *not* the person
who ran it marks it reviewed, and that constraint is in the database. A wrong subject weighting
published single-handed reaches three hundred families before anybody reads a number. At most
one run per section per term can be published, by partial unique index: two published runs is
two truths and the family has one of them on paper.

**A correction supersedes; it never overwrites.** A published report card is immutable — the
trigger refuses any change to its snapshot, hash, run or version. A correction is a new version
that points back at the one it replaces, and the old card keeps its snapshot, so "what did the
card we sent in March actually say" stays answerable. The snapshot matters for a second reason:
a card rendered live from a template changes whenever the template does.

**Families see published results, never working numbers.** A raw mark is staff-only; showing it
live turns every data-entry slip into a complaint before anybody has noticed it. A learner or
linked guardian reads a result line only from a *published* run, and a guardian only with
`can_view_academics` — the same capability that gates academics elsewhere. A superseded report
card stays readable to the family: they were sent it, and pretending it never existed is worse
than the correction.

## Messaging, and AC-8

**Consent is read at send time, per recipient.** Not from an audience computed an hour ago.
The failure this prevents is specific and common: a parent withdraws at 9am, the 9:05 job
messages them anyway, and the system has a perfectly good log showing consent was held when
the list was built. `may_message()` is a database function rather than a service method so
every path that sends anything answers the same question the same way — and it returns the
*reason* rather than a boolean, because a dispatcher that only knows "no" cannot tell a parent
why they were not contacted.

**A guardian of three children gets three messages about three children.** The recipient key is
(person, *subject*), not person. The optimisation that breaks this looks like a bug fix — "we
were sending three messages to the same number" — and the parent then hears about one child and
never about the other two. The unique index is shaped so that optimisation cannot be applied by
accident.

**A message that is not sent is recorded, with the reason.** "We have no record of messaging
you" is a much weaker answer than "we recorded a suppression because your consent was withdrawn
on the 4th", and the second is the one a regulator asks for. A suppressed row is visible to the
recipient too: it is the evidence that withdrawing worked.

**Muting is not withdrawal.** A preference says *how* to contact someone; consent says *whether*
it is lawful at all. Conflating them means "please stop texting me about the summer camp" reads
as revoking the legal basis for fee receipts.

**Templates carry their registrations and freeze with them.** Commercial SMS in India must be
sent against a template registered on a DLT platform under a registered entity and header — an
unregistered template is rejected by the operator, not merely delivered less often. WhatsApp
templates are approved separately by Meta with their own name and language. Both approvals
attach to a *specific body*, so an approved version is frozen: editing it means the
registration no longer describes what is being sent. A version cannot reach `approved` without
the ids its channel requires, because an approved template that cannot legally be sent is worse
than a draft — it looks ready.

**A missing variable is an error.** Not an empty string. The alternative is a parent receiving
"Dear , your child  was absent" or, more often, the literal `{{learner_name}}` — which is the
thing people screenshot. A missing locale is different: a parent who set Hindi and whose Hindi
template is not approved yet still gets told their child was absent, in English.

**Delivery is tracked per attempt, and receipts never move a message backwards.** WhatsApp
failing falls back to SMS, and both attempts stay on the record, because "I never got it" is
usually right about something and this is where you look. Providers deliver receipts out of
order routinely, so a late `sent` arriving after `read` is ignored rather than erasing the
knowledge that the parent opened it. Receipts are deduped on the provider's own event id and
stored raw before anything is interpreted, exactly as payment webhooks are.

## Imports, and AC-9

Every institute arrives with a spreadsheet. It is the first thing they do, it decides whether
they stay, and it is almost always partly wrong: duplicate admission numbers, dates as
`12/03/14`, a phone number Excel has turned into `9.8765E+09`, a blank name three thousand rows
down.

**Validation writes nothing.** Not one domain row. `validate()` touches the staging table and
there is no code path from it to anything else — not a conditional one, not an "only for the
valid rows" one. The half-applied import (3,000 learners in, one bad row, nobody knows what
state the school is in) is the failure that loses a customer in week one, and it is worth more
than the convenience of writing the good rows early.

**The preview is the apply.** The preview records a plan per row plus a digest of everything it
read; the apply rebuilds the plan *with the same function* and refuses if the digest moved. So
"it said it would create 4,988 and it created 4,991" is not rare, it is impossible: the only
ways to differ are a changed plan, which is refused, or a bug in the one shared code path,
which both would share. Two implementations "kept in sync" is precisely how a preview stops
matching an apply.

**Reversal refuses rather than cascades.** Every row an apply creates is recorded with its table
and id. Reversing walks them backwards — but a learner who has since been enrolled, linked to a
guardian or invoiced stops the reversal, which names the rows and what is using them. An undo
that deletes those records too is a second disaster, not a recovery.

**The defects are named, in the user's language.** `"9.8765E+09" is a number Excel has rounded;
the digits are gone — format the column as text and upload again` is a sentence the office can
act on. "Invalid phone number" sends them to look at the phone number, which is fine in the
source file. Duplicates *within the file* are detected here too, because no database constraint
can catch them: the second row never gets written.

**A raw row is kept exactly as it arrived.** When somebody asks why a learner's name is wrong,
the answer starts from what they uploaded, not from what the parser made of it. And where
guessing is unavoidable — a two-digit year in a birth date — the rule is written down (`≤30` is
2000s) rather than left to `Date.parse`, which reads `2014-02-31` as 3 March.

**A mapping is a closed list of fields and named transforms.** Not an expression language: an
import mapping is user input, and an expression evaluator over user input is a remote code
execution waiting to be written. A required field left unmapped is refused once, at mapping
time, rather than as 5,000 identical row errors — a wall of red hides the one real problem.

## The audit log

Append-only, partitioned by month, tenant-isolated. `UPDATE` and `DELETE` are revoked from
every role **and** blocked by a trigger, so tampering needs a superuser and a deliberate act.

**Sensitive reads are recorded, not only writes.** In the PowerSchool breach the forensics
could not establish what had been taken, because the logs did not reach back far enough. Reads
are the expensive thing to add later and the only thing that answers "what did they see".

Tamper evidence is a sealed-period digest rather than a per-row hash chain: chaining every
insert would make the audit table a global write bottleneck, since each write would have to
read the previous row under a lock. Each sealed period's digest covers that period's rows plus
the previous digest, so altering any sealed row breaks every checkpoint after it.

## Support access (AC-12)

There is no standing platform access to tenant data. A support agent requests, a **second**
platform person approves, the window is capped at 60 minutes, and it is read-only by default.
Every action carries both identities. The session row is tenant-scoped, so the institute owner
watches it happen under ordinary RLS and can revoke it — effective on the next request.

Each guarantee is enforced where it cannot be bypassed: self-approval by a `CHECK` constraint,
the 60-minute cap by a trigger, expiry by a check on every request rather than a sweeper job.

## Layout

```
apps/api/
  src/config/      env validation (boots or fails, never half-configured)
  src/common/      request context, error envelope, logging
  src/db/          two pools, withTenant, migration runner, SQL migrations
  src/modules/
    auth/          login, tokens, the guard where AC-11 lives
    authz/         the permission table and scope resolution
    audit/         append-only recording
    platform/      impersonation (AC-12)
    health/        liveness and readiness
    tenancy/       campuses and academic units
  test/            isolation · auth · rbac · audit · impersonation
```

## Conventions

- `id uuid` primary keys; `tenant_id` on every tenant table, first column of every index.
- Unique constraints are **always** tenant-scoped and partial on `deleted_at IS NULL`.
- Money is `numeric(14,2)` returned as a string — never parsed into a float.
- Migrations are append-only. Editing an applied one is refused by the runner, because a
  silent re-run would make one database diverge from every other.
- Financial and audit tables are never soft-deleted; they are corrected with compensating
  records.

## A leak this caught

Migration 0009 exists because the `rls_coverage` guard flagged the audit partitions, and a
probe against a live database confirmed it: **a policy on a partitioned parent is not applied
when a query names a partition directly**, and migration 0007 had granted `SELECT` on each
partition. `SELECT * FROM audit_log_2026_09` returned every tenant's audit trail. It is now
fixed twice over — no direct privileges on partitions, and RLS with the same policies on each
one anyway — and there is a regression test.

The `x-dev-tenant-id` shim noted at the end of M1 has been removed, as planned. The tenant now
comes only from a verified access token.

## Carried forward, deliberately

**Field-level database grants.** Sensitive student columns are currently protected by an
audited repository path plus the capability check, which is real and tested — but the app role
can still technically read those columns with a hand-written query. True field-level
enforcement needs a third database role and a second pool, on the pattern already used for
`paathshala_auth`. It is tracked as **M3.7** rather than quietly claimed as done.

**A learner reading their own guardian list.** The `guardian_link` policy deliberately does not
join `student`, to stay out of the recursion described above, so a learner cannot list their own
guardians. Not an MVP screen; it needs a second projection when it becomes one.

## A convention worth knowing before you write SQL here

**Cast every query parameter explicitly.** Postgres infers a parameter's type from its first
use, and two bugs in this codebase came from that: `$2` used both as an integer column value and
inside a comparison made the inference ambiguous and failed the whole statement, and a parameter
passed but never referenced produced "could not determine data type of parameter $1". Both
reached a test rather than production, but both were invisible until something executed. Write
`$1::uuid`, `$2::int`, and pass only what the statement actually uses.

## Two rules that came out of M5

**An append-only table cannot carry a referential action.** `ON DELETE SET NULL` issues an
`UPDATE`, which the append-only trigger refuses — so removing a departed employee's account
failed on a table nobody is allowed to modify, while `NO ACTION` would make the account
undeletable forever. `enrollment_event.actor_user_id` is therefore not a foreign key at all, for
the same reason `audit_log` has none: a historical record should not hold a live reference to a
mutable row.

**Attribution columns degrade to NULL.** `form_definition.created_by`,
`form_submission.submitted_by` and `file.uploaded_by` are `ON DELETE SET NULL`. A departed
employee's account must not pin every file they ever uploaded, and the durable record of who did
what is the audit log.

## What a missed mutation found

Dropping the `client_event_id` index changed nothing — 210 tests still passed. Chasing that
turned up a genuine flaw rather than a redundant index.

The post-insert lookup was a single `WHERE (client_event_id = $1) OR (session AND enrollment)
LIMIT 1`, with no ordering. If a buggy client reused one event id across two learners, that
query could return the *first* learner's record and the second would be reported as
`already_applied` — pointing at somebody else's row, silently dropping a learner's attendance,
and looking like success to both the app and the teacher.

The two cases now run as separate, ordered queries with a distinct outcome for the duplicate-id
case, and a test covers it. Both the index drop and the determinism guard are now caught.

**The general lesson, twice over in this project: a mutation that changes nothing is not
reassurance. It means the test suite cannot see that line — and the reason is worth finding.**

## Deferred, deliberately

`attendance_record` is **not partitioned**, though it is the highest-volume table here and the
plan calls for monthly partitioning. A partitioned table's unique constraints must include the
partition key, so `UNIQUE (tenant_id, client_event_id)` would become
`(tenant_id, session_date, client_event_id)` and the offline idempotency guarantee would hold
only within a date rather than absolutely. Correctness first. When partitioning happens, the
lesson from migration 0009 applies: a policy on a partitioned parent is not applied to a query
naming a partition directly.

## Next: M7 — money

Fee plans and components, concessions and instalments, gapless invoice numbering, the
double-entry ledger, a payment gateway where settlement truth comes only from the signed
webhook, and AC-6 and AC-7: a forged client callback leaves the invoice unpaid, and a refund
preserves the financial trail.

## Running it locally

See **RUNNING.md** — database roles, migrations, the seed, the three demo logins,
and what is worth trying once it is up.

## The public API and webhooks (M9.7)

### Calling the API

Credentials are `<prefix>.<secret>`, presented as a bearer token. The prefix is safe to
log and identifies the key; the secret after the dot is not and is shown exactly once,
when the key is issued.

```bash
curl -H "Authorization: Bearer pk_test_abc….<secret>" \
     'http://localhost:3001/api/v1/students?limit=50'
```

Every write requires an `Idempotency-Key` header. Reusing a key with the same body
replays the first response; reusing it with a *different* body is refused rather than
replayed, because that is almost always a loop variable that failed to advance.

Every response carries `x-ratelimit-limit`, `-remaining` and `-reset`. The limit is per
key, not per client, so revoking one misbehaving integration's key does not throttle its
siblings.

### Receiving webhooks

Each delivery carries:

```
x-paathshala-delivery: <uuid>     stable across every retry of this delivery
x-paathshala-event:    invoice.issued
x-paathshala-attempt:  3
x-paathshala-signature: t=1758182400,v1=<hex>[,v1=<hex>]
```

Verify with HMAC-SHA256 over `"{t}.{raw body}"`, comparing in constant time, and reject
anything whose `t` is more than five minutes from now. During a secret rotation two `v1`
values are sent and either may match, so a receiver can be updated without a flag day.
`src/modules/webhooks/signature.ts` is the reference implementation, written to be copied.

De-duplicate on `x-paathshala-delivery`. Retries re-send byte-identical bodies under the
same id — including a replay of a delivery that had given up — so a receiver that stores
the id is correct, and one that does not still sees the same bytes.

### Running the relay

```bash
pnpm --filter @paathshala/api webhooks:relay      # built
pnpm --filter @paathshala/api webhooks:relay:dev  # from source
```

A separate process from the API on purpose: a slow receiver cannot consume the request
path's event loop, and "stop the relay" is something an on-call engineer can do without
taking the school's app offline.

### What is not done

- **Relief cover has no representation.** A teacher reaches a section by being its class
  teacher, teaching an offering for it, or being timetabled into it. Cover arranged on the
  morning, for somebody in none of those, cannot be expressed — and deriving it from
  `marked_by_staff_id` would let whoever marked first keep marking. It needs a session
  assignment the office can make.
- **The rate limiter is per process.** Two API instances allow twice the configured rate.
  The counter belongs in Redis before there is more than one instance.
- **Scopes are coarse on writes.** `attendance:write` grants what staff scope grants on
  the attendance tables, not a narrower slice of it.
