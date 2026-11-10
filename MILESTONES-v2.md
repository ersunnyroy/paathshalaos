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

## Status

| ID | State |
| --- | --- |
| M39 | tokens done; typed client moved to M39.1 |
| M39.1 | not started |
| M40 | part 1 done; 18 pages still on effect-fetching, no shared data table yet |
| M42.5 | every existing platform route now has a screen; what is left needs new API |
| M41 | learner profile and structure screens done; offerings, web file upload, guardian names not started |
| M42 … M52 | not started |
