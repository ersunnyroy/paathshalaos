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
| M42 | timetable view, add, move and remove done; free-teacher suggestions for cover not started |
| M44 | parent home on the web done; mobile parent app v2, online payment, notifications not started |
| M45 | teacher's day on the web done; mobile teacher app v2, marks grid, homework with attachments not started |
| M48 | admissions board done; follow-up reminders, source report, public enquiry form not started |
| M43, M46, M47, M49 … M52 | not started |
