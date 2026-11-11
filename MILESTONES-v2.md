# paathshalaOS — Milestones, v2 (M39 onward)

Continues `MILESTONES.md`, which the session that wrote this could not write to
(permission denied on that one file). Fold this into it when convenient.
Plan: https://claude.ai/artifact/CR3bLqHquohMWpJfYhE8rW · Branch: `modernise/v2`.

## M39 — one token set, and what the typed client turned out to need

Planned as "a typed client generated from OpenAPI, and shared tokens". Half of that was
buildable.

**Shipped.** `packages/ui-tokens` is the one copy of the palette. It generates
`apps/web/src/app/tokens.css` (both dark blocks from one map, so they cannot diverge) and
exports `native` for the mobile app, whose `theme.ts` no longer keeps its own brand sheet.
A test fails if the committed stylesheet is not what the package generates. Mobile's
`good` and `warning` moved to the web's ink values (`#047857`, `#92400E`); they had drifted.

**Where the plan was wrong.** `openapi.json` describes **7 paths** — the public API-key
surface — not the 278 routes the apps call. Internal routes have no response schemas, so
there is nothing to generate a typed client *from*. That is its own milestone (response
schemas per controller, then generation). Carried as **M39.1**.

## M40 — the web shell (part 1)

- **Navigation is filtered by role** (`src/lib/nav.ts`). A convenience, not a control:
  RLS still decides. It fails open — an unknown role, an empty role list, or anyone inside
  a school through the console sees everything.
- **Command palette**, Ctrl/Cmd+K or the top-bar button. Screens come from the navigation
  the person was already shown; learners come from `/v1/students?q=`, so the same RLS.
- **TanStack Query** behind `useApiQuery` (`src/lib/query.ts`). 4xx is not retried. The
  Learners page is the first page moved onto it; the other eighteen still fetch in effects.

Mutation pass: the fail-open rule, the 4xx retry rule and the stale-stylesheet check were
each broken and each caught. **One mutation changed nothing** — removing the de-duplication
in `matchScreens` — so a test was added for a screen whose label and synonym both match.

Web tests 25 → 42, ui-tokens 5. Typecheck and `next build` pass. Checked in Chrome on 10 Nov once the stack was running: palette, learner search and
role-filtered navigation all work.
API tests were not run (no Postgres in that session); nothing under `apps/api` changed.

Found on the way: `apps/mobile/test/learning.spec.ts` ("counts anything before midnight
tonight as today") fails when the machine clock is UTC. Pre-existing, not fixed here.

Still to do in M40: move the remaining pages onto `useApiQuery`, the shared data table with
saved views and export, the notification bell.

## M38.3, M38.4 — the local demo, again

- MinIO withdrew its public images (Docker Hub, then quay.io: 401 for every tag). One
  optional image took the whole stack down. `run-local.sh` now pulls object storage and
  the scanner separately and a failure is a warning: **file upload is off locally until
  MinIO is replaced** with another S3-compatible store. SeaweedFS was the candidate; it
  could not be tested from the building session, so nothing untested was swapped in.
- The sign-in page said "No school is registered at this address" on a fresh demo: since
  M19 the web app finds its school from the host and `run-local.sh` never wrote
  `NEXT_PUBLIC_BRAND_HOST`. It does now, read from the seed's own output.

## M42.5 — the business console (part 1)

The console had routes for plans, subscriptions, invoices and platform admins and a screen
for none of them. It now has tabs: **Schools, Plans, Billing, Team, Operations.**

- Schools: headline counts, suspend and resume.
- Plans: every version with price, limits, features and subscriber count; a form that
  creates the plan, drafts a version and sets its terms; publish and retire.
- Billing: a school's platform invoices with exact totals, credit notes, and "put on a
  plan" (with trial days).
- Team: one row per person, capabilities held now, grant and revoke.
- Anything that cannot be undone uses a two-click button that disarms after four seconds.

Exercised in a real browser against the running API: a plan was drafted, a bad hard cap
was refused, the plan was published, the demo school was subscribed. **The demo school is
now on a plan called Everything (all features, no limits, 14-day trial)**; a second plan,
Starter, exists with no subscribers.

Not built (needs new API, so Postgres tests on the Mac): revenue dashboard, school
lifecycle pipeline, usage and health per school, two-factor for staff, the support desk
across schools, moving a school between plans and changing subscription status from the
screen (routes exist, no form yet), creating a school from the screen.

Found: the zod comment on plan prices says "paise"; the column is `numeric(14,2)` and the
invoice maths treats it as rupees. The screen treats it as rupees. The comment is wrong.

## M41 — learner 360 (part 1)

`/students/<id>`: header, then Overview, Attendance, Fees, Results, Classwork, Guardians.
Reached from the roster and from the command palette. Every read is an existing route —
the `family/children/:id/*` routes answer for staff as well as guardians because RLS, not
the route, decides. Medical and emergency details load only on a click, because that read
is audited.

Gaps this exposed: the guardians route returns a relationship and permissions but **no
name or phone**; attendance is fixed at the last 30 days; there is no activity timeline.
Academic-structure screens and file upload on web (the other half of M41) are not started.

Mutation pass on both: 11 mutations, 10 caught first time. The one that changed nothing —
`<` to `<=` on the overdue date in `feeStanding` — got a test for an invoice due today.

Web tests now 78. Typecheck and `next build` pass. API suite still not run from this
session; nothing under `apps/api` changed.

## M41.2 and M42.5.2 — structure screens, and the rest of the console that needed no new API

**School structure** (`/academics`, in the nav under Academics for unrestricted roles):
years and terms, classes and sections, subjects, programmes, rooms — list and add. The
year form names the year from its dates and splits it into equal back-to-back terms that
can then be adjusted; an overlap or a term outside the year is caught before the request.
Nothing deletes, because the API does not.

**Console:** a New school form (organisation, first campus, owner; the temporary password
is shown once and the request key is fixed when the form opens, so a double click cannot
create two schools), and Change subscription (move to another plan version, or change
status, each with a recorded reason).

Exercised in a browser against the running API. Demo data added by that: year 2027-28
with two terms, Class XI with section A, subject Physics, Room 101; a second school,
Sunrise Public School (owner@sunrise.test); Demo Vidyalaya's subscription set to active.

Mutation pass: 10 mutations across `structure.ts` and `buildSchool`, all caught.
Web tests 102. Typecheck and `next build` pass.

Not on the structure screen yet: course offerings (which subject a class takes in a term,
and who teaches it), assigning a class teacher or room to a section, adding a term to an
existing year. All have routes.

## M42.5.3 — revenue, and four tests that were failing before anything changed

**Revenue.** `GET /platform/v1/revenue` (capability `billing`) and a Revenue tab. MRR counts
schools being billed — active and past due — with past due also shown on its own; trials
are pipeline and never inside MRR; an annual plan is its annual price over twelve, rounded
half up. Invoiced, credited and net by month for six months, and for the financial year.
The arithmetic is a pure module (`revenue.ts`, 21 tests, 8 mutations all caught); the
query is `revenue.service.ts`. **No "collected" figure**: nothing in the schema records a
school paying a platform invoice, so one would be the invoiced number under another name.

`platform-revenue.spec.ts` is the database-backed test, asserting differences rather than
absolutes because the database is shared. **Written but not run by the session that wrote
it** (no Postgres there). The endpoint itself was called over real HTTP against the real
database and returned correct figures for the demo data.

**The baseline API run on 10 Nov 2026 had 4 failures in 3 files**, none caused by this
branch (nothing under `apps/api` had changed yet):

- `scheduler.spec` ×2 — the suite says "this suite configures none, deliberately" about
  object storage and the scanner, but `fixtures.ts` loads `apps/api/.env`, and since M38
  `run-local.sh` writes `OBJECT_STORE_*` and `CLAMD_HOST` there. Passes in CI, fails on
  any developer machine. Fixed with `test/without-storage.ts`, imported second.
- `hr.spec` — a fixed window (November 2026) and a fixture teacher whose joining date is
  the day the suite runs. Correct until 1 Nov 2026, then `employed_days` became 21. The
  test now fixes the joining date too.
- `messaging.spec` — `SELECT … LIMIT 1` with no tenant filter picked another school's
  message attempt on a database with a demo school in it. Now filtered by tenant.
  (Diagnosed by reading, not by reproducing.)

All three fixes are unrun for the same reason as above.

## M42.1 — a class's week, and three smaller things

**Timetable** (`/timetable`, under Academics; teachers see it too). Pick a class and
section: the week as a grid whose rows are the periods that class actually has, and below
it the subjects the class takes this term with their teachers. Add a subject to the class;
add a lesson on one or several days with a time, teacher and room. The page refuses a
lesson that lands on one of this class's own; a room or teacher booked elsewhere is
refused by the database's exclusion constraints and its message is shown ("That room is
already booked for an overlapping period" — seen live). A multi-day add stops at the first
refusal and says which days were saved.

**Not built, and it matters:** a lesson cannot be removed or moved — there is no route.
No drag and drop. No substitution board (B2). Period numbers are not shown.

**Guardian names.** `guardiansOf` now joins `person` (LEFT JOIN, so a link is never dropped
for want of a visible name) and the learner page shows who the guardian is. Four tests
added to `people.spec.ts`, unrun.

**A wrong diagnosis, recorded.** The API was failing to restart about every other file
change ("EADDRINUSE"). This entry first said that was a race for the port and that a
retry in `main.ts` had fixed it. It had not: the failures continued, alternating exactly.
See M42.2.

Mutation pass on `timetable.ts`: 8 mutations, all caught. Web tests 130. Demo data added:
Physics for Class IX with a teacher; Mathematics Mon/Wed/Fri 9:00 in Room 101 and Physics
Mon 9:40 for Class IX.

## M42.2 — remove and move a lesson; and why the API kept "failing to restart"

**Remove and move.** `POST /v1/structure/schedule-slots/:id/remove` marks a slot
`deleted_at` (which the exclusion constraints and the timetable query both filter on, so
the room and teacher are free at once). `…/:id/move` is one UPDATE, so the constraints
judge the lesson where it is going; `roomId` and `staffId` are three-valued — absent
leaves, null clears, a value sets. A caller who can see the slot and may not change it
gets `staff_only`, not "not found". On the page, click a lesson to move it or take it off.
Both exercised in a browser against the running API. Eight tests appended to
`academics.spec.ts`, unrun.

The substitution board in the plan (B2) already exists as M27's absent-and-cover panel on
the Staff page. What it lacks is suggesting who is free in that period.

**The restart failures were two supervisors, not a race.** `run-local.sh`'s
`stop_servers` killed whatever listened on 3000 and 3001. For the API that is the
innermost of three processes, and `node --watch` exists to start it again — so each run
of the script left a `concurrently` / `tsc --watch` / `node --watch` trio behind. After
the second run there were two trios, each restarting its own API on every file change and
racing for port 3001. Which one lost alternated, which is exactly the "fails every other
restart" that was observed; the loser's error is what landed in `api.log`, and the winner
served requests, which is why everything kept working.

What was tried first and was wrong: a retry in `main.ts`, then a wait-for-port plus a
bounded shutdown. Neither changed the pattern — a mutation that changes nothing — and
`main.ts` is back exactly as it was. `stop_servers` now stops the supervisors first,
matched by command line **and** working directory so it cannot touch another project.
**Inferred from the log, not observed**: the session cannot list processes on the Mac, and
the script change is syntax-checked only. `bash run-local.sh` once clears the leftovers.

## M40.2 — one table for every list

`components/data-table.tsx` over `lib/table.ts`: filter, sort by clicking a heading
(ascending, descending, back to the arriving order), a column picker, a view remembered
per table in the browser, and CSV export of what is on screen. The Learners page is the
first list on it; it says so when the API's 200-row ceiling is reached.

Two things the tests found:

- **The file name stripped Hindi.** `\p{L}\p{N}` keeps letters and digits and drops
  combining marks, and Devanagari vowel signs are combining marks: "छात्र सूची" became
  "छतर सच". `\p{M}` is kept now.
- **A tie-break that did nothing.** The sort carried each row's index to keep ties in
  arriving order. Removing it changed no test, because `Array.prototype.sort` has been
  stable since ES2019. It is gone, with a comment saying why.

Export is hardened against spreadsheet formulas: a cell beginning `=`, `+`, `-`, `@`, tab
or carriage return is prefixed with an apostrophe. That includes a negative amount, on
purpose. Nine mutations: eight caught, one equivalent (above).

Also: every table added since M40 used `className="num"` for figures, and the stylesheet's
class is `n`, so nothing was right-aligned. `num` is now styled the same.

Still on effect-fetching and hand-written tables: the other sixteen school pages.

## M40.3 — the fee desk on the shared table, and two bugs it was sitting on

The invoice list on Fees is now the shared table: sort by amount owed, filter, pick
columns, export. A column of buttons is a new kind of column (`action`) — never sorted,
hidden or exported.

**"Two taps at a counter are one payment" was not true.** The comment said it; the code
built the idempotency key from `Date.now()` at the moment of the click, so every click
had its own key and the server's de-duplication had nothing to match. The only thing
stopping a double payment was the button disabling in time. The key is now made when the
amount is typed and reused for every press, and the field clears only after the payment
is recorded so a failed attempt retries under the same key. Checked live: two clicks,
one ₹100 receipt.

**Three pages took "today" from UTC.** `new Date().toISOString().slice(0, 10)` is
yesterday from midnight to 5:30 a.m. in India: Fees called invoices due today "not yet
due", the attendance register opened on the previous day, and the staff cover panel
looked at the wrong date. `lib/dates.ts` has `localIsoDate()` with a test that pins the
timezone and shows the old expression giving the wrong day.

Web tests 159.

## M44.1 — a parent's home, on the web

**What a parent saw before this:** the school's dashboard ("Fee collection", "By campus",
"Needs attention"), the attendance register, and the fee desk with a "Take cash" button.
Every row was correctly limited to their own children — the database did its job — on
screens built for the office.

**Now.** A guardian lands on `/family` and their navigation is that and Consent. One card
per child: today's attendance and the last week, what is owed and what is overdue, the
bus stop and times; then what the school has sent. "Full record" opens the child's page,
which for a parent has no medical panel and goes back to their children, not to a roster.

Each guardian link's permissions are honoured: where a link does not allow fees, no fee
request is made for that child at all (seen live: one child with fees shown, one with
"not shared with you"). A teacher who is also a parent here gets both and lands on the
dashboard. Fees cannot be paid online — that is M26 — and the page says so instead of
showing a button that does nothing.

`nav.ts` gained role-only items (`only`) and `homeFor`. Four mutations, all caught. The
sign-in page lists the demo parent. Web tests 165.

Not done: the same for the mobile app (its family screen predates this), student login,
push notifications, leave requests.

## M45.1 — a teacher's day, on the web

A teacher signing in landed on the school dashboard: collections, campuses, things for
the office. They now land on `/today` ("My day"): today's lessons in order with which is
on now and which is next and how long until it starts; each of their classes with whether
the register is not taken, started and left, or taken; a banner if they are covering for
somebody; and the rest of their week. The dashboard is still in their navigation.

`GET /v1/timetable/mine` is new. A teacher could be shown anybody's timetable by staff id
and had no way to ask for their own, because nothing told a client which staff record it
was signed in as. The route takes no id: `app_current_staff_id()` — what the cover
policies already use — answers inside the database. Three tests in `hr.spec.ts`, unrun.

`lib/today.ts`: 7 mutations, 6 caught; the seventh (`< 60` to `<= 60` in "in 59 min"
versus "in 1 h") changed nothing, so the hour boundary has a test now. Web tests 180.

Found and not fixed: the API's own defaults for "today" (`attendance/sessions`, `hr/cover`,
the family attendance window) use `new Date().toISOString()`, so they are UTC wherever the
server runs. The web now always sends the date, which hides it. The real fix is the
school's timezone, which `organization` does not yet carry into these queries.

## M40.4 — the bell, and the staff roster on the shared table

**The bell.** The five "needs attention" counts lived at the bottom of the dashboard, which
a teacher no longer lands on. They are now a bell in the top bar on every screen for
people who work at the school: a number when something is waiting, nothing at all when
nothing is, and each item links to the screen that deals with it. An item is offered only
if that screen is one the person is shown — a count somebody can do nothing about is a
number that never goes away. It asks once a minute. Seen live: "1 result run to review,
1 message failed to send".

This is not push, and not per-person notifications (M43): it is the queue the school
already computes, put where people will see it.

The dashboard also now sends today's date to `dashboard/today` instead of leaving it to
the server's UTC default.

**Staff roster** on the shared table: sort, filter, export, with Designation and Joined
as optional columns.

`lib/attention.ts`: 5 mutations, all caught. Web tests 190.

## M48.1 — the admissions pipeline as a board

Admissions opens on a board: Enquiry, To decide, Offer out, Waitlist, Accepted, On the
roll, Closed. Every family is in exactly one column; the longest-waiting is at the top of
each working column, and a card is flagged when somebody should act — an enquiry with no
form after a week, an application undecided after a week, an offer within three days of
lapsing or past it. Clicking a card opens that family in the list, where the buttons that
move them along already were. The list is one click away and unchanged.

**A bug the test for the new code found in the old code.** "Offer lapsed" was decided from
a rounded day count: `Math.ceil` of a small negative fraction is `-0`, which is not `< 0`,
so an offer that ran out an hour ago read "Offered — 0d to reply". Lapsed is now asked of
the instant (`offerLapsed`), on the board and in the list.

`lib/admissions.ts`: 7 mutations, all caught. Web tests 207.

Not built from C2: follow-up reminders, where an enquiry came from as a report, a public
enquiry form with a fee.

## Status

| ID | State |
| --- | --- |
| M39 | tokens done; typed client moved to M39.1 |
| M39.1 | not started |
| M40 | shell, palette, query cache, bell, shared data table (Learners, Fees invoices, Staff roster). 14 pages still to move |
| M42.5 | all existing routes have screens; revenue added. Left: lifecycle pipeline, school health and usage, 2FA, cross-school support desk |
| M41 | learner profile, structure screens, guardian names, offerings (on the timetable page) done; web file upload and activity timeline not started |
| M42 | timetable view, add, move and remove done; who is free to cover done (web); period-level cover not started |
| M44 | parent home on the web done; mobile parent app v2, online payment, notifications not started |
| M45 | teacher's day and marks entry sheet on the web done; mobile teacher app v2, homework with attachments not started |
| M48 | admissions board done; follow-up reminders, source report, public enquiry form not started |
| M43, M46, M47, M49 … M52 | not started |

## M44.2 — Marks entry sheet (plan item B4)

Web only; no API or schema change.

- `apps/web/src/lib/marks.ts` (pure, 25 tests, mutation pass clean): what a cell
  means (`readCell`: number with up to two decimals, A/E, refused above the
  maximum), what goes to the server (`changes`: only cells that differ from what
  is saved), spreadsheet paste (`paste`: one column in register order from the
  cell pasted into; two or more columns matched by admission number, then roll
  number, last column is the mark), class summary, Enter/arrow movement, server
  refusal codes in plain words, requests split at the server's 200-row limit.
- `apps/web/src/app/results/marks-sheet.tsx` replaces the inline marks table on
  Results. Bad cells are held back and marked in red while the rest save; the
  browser warns before leaving with unsaved marks.
- Found and fixed on the way: the old table sent `Number('xx')` (NaN → null),
  which made the server refuse the whole class for one typo; and it resent every
  touched cell even when unchanged.
- Not done: a grade beside each mark. The grading scale is chosen when a result
  run is computed, not on the paper, so a grade here would be a guess. Percent
  is shown instead.
- Checked live in Chrome as principal on "Energy conversions worksheet" (out of
  15): paste of six, two refused in red, four saved, two fixed and saved,
  emptying a saved mark refused. Demo data now has 6 marks on that paper.

## M42.3 — Who is free to cover

Web only; no API or schema change.

- `apps/web/src/lib/cover.ts` (pure, 15 tests, mutation pass clean): for a day,
  every lesson an absent teacher leaves behind, and up to three people who could
  take it. Left out: anybody away, anybody who has left, anybody teaching at that
  time, anybody with no timetable at all (the accountant is always "free").
  Order: already teaches these children, then teaches the subject, then the
  lightest day (own lessons plus cover already handed out), then name.
- `apps/web/src/app/staff/cover-gaps.tsx` in the Cover panel on Staff: each gap
  with its suggestions and the reason for each; two clicks assign. A lesson the
  whole class takes together asks which section, because cover is granted on a
  section.
- Bug fixed: the old cover form never sent `absentStaffId`, so an assigned cover
  was saved but the absence still read "Nobody yet" and the "Classes with no
  cover" tile never cleared. The form now asks who the cover is for.
- Known limits: weeks are read with one request per member of staff (six at a
  time) — fine for a school, worth one API route later. Cover is still for the
  whole day, not the period: nothing maps a lesson's clock time to `period_no`.
  A whole-class lesson shows as covered once any one of its sections has cover.
- Checked live in Chrome: Suresh away Wed 11 Nov → "9:00–9:40 · Mathematics ·
  Class IX", Meera suggested ("teaches this class · 1 lesson that day"),
  assigned, row and table both show her. Demo data: Physics Wed 10:00 for Meera,
  Suresh's leave on 11 Nov, Meera covering Class IX A that day.

## M40.5 — Four more lists on the shared table

Web only. Transport routes, transport "Papers that expire", support tickets and
access accounts now use `DataTable` (filter, sort, choose columns, export).

- `DataTable` gained `onRowClick` and `selected`. A row that opens something
  takes keyboard focus and answers Enter; before, routes and tickets could only
  be opened with a mouse.
- Access accounts is one row per role held (name repeated), so filtering for a
  role finds everybody who holds it. Revoke is now a two-click confirm.
- Checked live in Chrome as principal: all four render with data, a route opens
  by keyboard and is marked, a ticket opens and "Back to the queue" returns.
- Still on hand-written tables: academics, admissions list, attendance,
  consent, console, dashboard, developers, imports, integrations, learning,
  messages, results, setup, trust, learner profile, timetable, today.
  (Several of these are registers or forms, not lists, and should stay.)

## M43.1 — A person's own inbox, and marking a message read

**First migration of v2: `0088_a_message_can_be_read.sql`. Not yet applied or
run against Postgres by anybody.** Until it is applied, the inbox routes answer
500 (the query names a column that is not there) and the bell simply shows no
messages; nothing else is affected.

- Migration: `message_recipient.read_at`, an inbox index, and
  `mark_my_messages_read(uuid)` (SECURITY DEFINER, pinned search_path, tenant
  and person guards written out, EXECUTE to `paathshala_app` only). A function
  rather than an own-row UPDATE policy, because a policy cannot say "this column
  only" and the app role holds UPDATE on the whole table. `read_at` is separate
  from `status`, which is the provider's delivery record.
- `modules/messaging/inbox.service.ts`: `mine` (keyset on created_at + id, with
  the cursor kept to the microsecond), `unread`, `markRead`.
- Routes, on `MessagingController` because `app.module.ts` is not writable from
  the building session (same permission error as `MILESTONES.md`):
  `GET v1/messaging/inbox`, `GET …/inbox/unread`, `POST …/inbox/read-all`,
  `POST …/inbox/:id/read`. Worth moving to their own controller.
- `family.service.messages` now includes status `read`: a WhatsApp read receipt
  made the message disappear from the parent's list.
- Web: the bell is now for everybody. Parents get it (messages only); staff get
  messages plus the office's counts. `lib/inbox.ts` (16 tests, mutation pass
  clean): badge, label, preview, "how long ago", optimistic read.
- `apps/api/test/inbox.spec.ts`: 15 tests, type-checked, **never run**. The
  mutation pass on the SQL (drop the person guard, drop the tenant guard, drop
  the status filter, grant to PUBLIC) has not been done and must be, against a
  live database.

## M47.1 — A fee receipt that can be printed

No migration. Paying has issued a receipt number since M7 and nothing could
show one.

- API: `GET v1/fees/invoices/:id/receipts` (`billing/receipt.service.ts`) —
  school, learner, invoice, lines, every receipt against the invoice with the
  method and who took the money. Read-only over existing tables; existing RLS
  decides who may ask (office: any; guardian: own child's invoice, own
  payments' receipts). Exercised over real HTTP; **no API test written yet**.
- Web: `/fees/receipt/<invoice id>`, opened from the invoice number on Fees.
  Prints on one sheet (print CSS hides the app). `lib/receipt.ts` (31 tests,
  mutation pass clean): exact subtraction in paise, amount in words in the
  Indian system (thousand, lakh, crore), date and method labels, totals that
  leave out cancelled receipts and never print a negative balance.
- An invoice with no lines (the seed's are raised as one figure) prints one
  row, "Fees for <year>", rather than an empty table.
- Checked live in Chrome: INV-000023 shows RCP-000025, ₹100 cash taken by
  Anjali Menon, "Rupees one hundred only", balance ₹32,900. The printed page
  itself has not been looked at on paper or in a print preview.
- Not done: a link from the parent's Family page; receipt PDF stored as a file;
  the school's logo and address on the header (address is not in the schema).

## M43.2 — Telling guardians their child was marked absent

No migration. Migration 0088 (M43.1) has since been applied on the Mac and the
inbox works live; its tests and SQL mutation pass are still unrun.

- The register's "Absent" tile said "Guardians will be notified". Nothing
  notified anybody: `attendance.marked` has gone into the outbox since M6 and
  nothing reads the outbox (`claimUnpublished` has no caller). The tile no
  longer says it.
- API (`messaging/absence.service.ts`, routes on MessagingController):
  `GET v1/messaging/absence-notices/:sessionId` (absent, still to tell, no
  guardian, no consent, notices that would go) and a new audience
  `{ kind: 'absentees', attendanceSessionId }` on `POST v1/messaging/send`.
  Each guardian is told once per child per register: a second press sends
  nothing (`nobody_left_to_tell`), and a child marked absent later still gets
  theirs. A guardian who muted or withdrew is settled; `no_consent` is not —
  nobody was asked — so those go the first time after consent is recorded.
- Web: under a saved register, a line saying who is absent and who has been
  told, with "Tell their guardians". It does not offer a button that would send
  nothing: with no consent on record it says so and points at Consent.
  `lib/absence.ts` (11 tests, mutation pass clean).
- **Cache bug found and fixed**: the read cache was keyed by path only and
  survived sign-out, so the next person to sign in on the same computer was
  shown the last person's cached answers (a parent saw the principal's empty
  inbox; it could as easily have been the reverse). `onIdentityChange` in
  `lib/api.ts` now clears the cache on sign-out, sign-in and console entry.
- Checked live in Chrome: Class IX A, two marked absent → "no consent on record
  for 2 children", no button. Consent recorded for Aarav on the Consent screen
  → button appears → "2 guardians told. 1 not sent: no consent on record." →
  the parent's bell shows "Aarav was marked absent on 11 Nov 2026".
- Not done: an API test for the absence service (exercised over HTTP only);
  SMS/WhatsApp (in-app only: no gateway); sending automatically when the
  register is saved, which wants the outbox consumer.
- Demo data: ATT_ABSENT_V1 has an approved in-app wording; today's Class IX A
  register has two absentees; consent for attendance notices recorded for Aarav
  Kumar.
- Seen once and not reproduced: a parent's first sign-in in a fresh tab stayed
  on /dashboard instead of going to /family until a reload (right after the dev
  server compiled /family for the first time).

## M47.2 — A family sees the receipts for its own child's fees

**Migration `0089_a_family_sees_its_receipts.sql`: written, not applied, not run.**

- Before: `payment_read` / `receipt_read` opened only for the recorded payer,
  and counter cash has no payer, so a parent saw "₹500 paid" and no receipt;
  invoice lines were finance-only.
- 0089 adds family read on `invoice_line` and `payment_allocation`, and widens
  `payment_read` and `receipt_read`, each by reading through the row above it
  (receipt → payment → allocation → invoice). `invoice_read` stays the one
  place the rule is written; no definer function, no cycle. Two things it
  widens are written in the migration: a co-guardian with finance access sees
  the other's payment row, and a payment split across two families is visible
  to both (each sees only its own allocation).
- `apps/api/test/family-receipts.spec.ts`: 27 tests (sheet for office and
  family; each of the four tables asked directly for parent / other family /
  unshared parent / former guardian / teacher / accountant / other school; no
  writes opened). Type-checked, **never run**. SQL mutation pass not done.
- Web: Family page links each invoice, and lists "Receipts" for anything paid.
  The receipt page has a Back button that returns to where the person came
  from, and no longer says "nothing received" when money was received but the
  viewer may not see the receipt — it says the amount and that the numbers are
  with the office.
- Checked live (0089 NOT applied): principal took ₹500 cash on INV-000001; the
  parent's Family page shows "Receipts: INV-000001"; the sheet reads "₹500.00
  has been received. The receipt numbers are with the school office. Balance
  ₹32,500.00". After 0089 the same page should list RCP numbers — unverified.
