# paathshalaOS — Milestone Plan

Every milestone is small enough to finish in days, ends in something runnable, and has a
definition of done that is a command you can run or a screen you can open. Nothing is
"done" because code exists; it is done because a test or a person proved it works.

Phases map to the product plan: **P0** foundations, **P1** launch MVP, **P2** expansion,
**P3** strategic bets.

---

## M0 — Foundations (Phase 0)

| ID | Milestone | Definition of done |
| --- | --- | --- |
| M0.1 | Monorepo skeleton | `pnpm install && pnpm build` succeeds from a clean clone |
| M0.2 | Local dev environment | `docker compose up -d` gives Postgres 16 + Redis 7; `pnpm db:migrate` runs clean |
| M0.3 | Config and secrets | App refuses to boot on a missing or malformed env var, with a readable error |
| M0.4 | Logging and request context | Every log line carries `request_id`, and `tenant_id`/`actor_id` once known |
| M0.5 | CI pipeline | Typecheck, lint, unit and integration tests run on every push |
| M0.6 | Error envelope and API conventions | One error shape, cursor pagination helper, idempotency middleware, all unit tested |

## M1 — Tenancy and isolation (Phase 1) ✅ **done**

| ID | Milestone | Definition of done |
| --- | --- | --- |
| M1.1 | Migration runner | Ordered SQL migrations apply once, are recorded, and are idempotent on re-run |
| M1.2 | Tenancy tables | `organization`, `campus`, `academic_unit`, `academic_year` exist with tenant-scoped uniques |
| M1.3 | Row-level security | `FORCE ROW LEVEL SECURITY` with `USING` **and** `WITH CHECK`; app role has no `BYPASSRLS` |
| M1.4 | Tenant context | Every query runs inside a transaction that sets `app.tenant_id`; no code path bypasses it |
| M1.5 | **AC-1 isolation suite** | Cross-tenant read returns zero rows; cross-tenant write is rejected; test is generated from the route table |
| M1.6 | Health and readiness | `/health` reports DB and Redis; readiness fails while migrations are pending |

## M2 — Identity, RBAC and audit (Phase 1) ✅ **done**

| ID | Milestone | Definition of done |
| --- | --- | --- |
| M2.1 | Users, sessions, devices | Staff password login (Argon2id) and guardian phone-OTP login both issue tokens |
| M2.2 | Token lifecycle | Short access token, rotating refresh token with reuse detection that kills the family |
| M2.3 | Role grants and scopes | `role + scope_type + scope_id`; a grant can never exceed the granter's own permissions |
| M2.4 | **AC-11 immediate role change** | Revoking a grant takes effect on the very next request, no re-login |
| M2.5 | Audit log | Append-only, partitioned, sealed-period digests; **sensitive reads logged, not only writes** |
| M2.6 | **AC-12 impersonation** | Two-person approval, 60-minute cap, read-only default, visible live to the institute owner |

## M3 — People and the guardian model (Phase 1) ✅ **done**

| ID | Milestone | Definition of done |
| --- | --- | --- |
| M3.1 | Person, contacts, addresses | One human, one record per tenant, whatever roles they hold |
| M3.2 | Staff records | Employment lifecycle with campus scoping |
| M3.3 | Student records | Admission numbers unique per tenant, lifecycle status |
| M3.4 | Guardian links | Capability flags per relationship; one guardian across learners, campuses and institutes |
| M3.5 | **AC-4 guardian access** | Unlinked learner is 404; a flag set to false is enforced at the query, not the UI |
| M3.6 | Consent records | Versioned notice, consent stored against the version, one-tap withdrawal |
| M3.7 | Field-level database grants | **Done in M12.** A third role and pool; the app role has no column privilege on the RESTRICTED five |

## M4 — Academic structure (Phase 1) ✅ **done**

| ID | Milestone | Definition of done |
| --- | --- | --- |
| M4.1 | Programmes, years, terms | Overlapping active years per unit are rejected by an exclusion constraint |
| M4.2 | Classes, sections, subjects | Tenant-scoped codes, capacity, class teacher |
| M4.3 | Course offerings | Subject × group × term, with an assigned teacher |
| M4.4 | Timetable slots | Room and teacher double-booking impossible at the database level |
| M4.5 | **AC-3 year rollover** | Renaming a class next year cannot alter last year's report cards |

## M5 — Admissions and enrollment (Phase 1) ✅ **done**

| ID | Milestone | Definition of done |
| --- | --- | --- |
| M5.1 | Leads and enquiries | Pipeline with stages, owner, next action |
| M5.2 | Configurable application forms | Versioned JSON Schema; a submission stores the version that validated it |
| M5.3 | Documents and verification | Upload, verify, reject with reason; purge job for unenrolled applicants |
| M5.4 | Decision and offer | Immutable once issued, with expiry |
| M5.5 | Enrollment | One active enrollment per learner per year, enforced by a partial unique index |
| M5.6 | Transfers and withdrawals | Every transition is an append-only event; history never mutates |

## M6 — Attendance, including offline (Phase 1) ✅ **done**

| ID | Milestone | Definition of done |
| --- | --- | --- |
| M6.1 | Sessions and records | Bulk upsert, idempotent on `client_event_id` |
| M6.2 | Corrections and leave | Amendments never overwrite; approval trail |
| M6.3 | Mobile offline queue | Local SQLite queue, visible pending count, 7-day bound |
| M6.4 | **AC-5 sync and conflicts** | All four conflict paths asserted; no silent last-write-wins |
| M6.5 | Absentee notification | Fires from `attendance.marked`, honours consent |

## M7 — Money (Phase 1) — *the buying trigger* — **done**

| ID | Milestone | Definition of done |
| --- | --- | --- |
| M7.1 | Fee plans and components | Published plans are immutable; drafts are not billable |
| M7.2 | Concessions and instalments | Approval trail; arithmetic covered by property-based tests |
| M7.3 | Invoices | Gapless numbering per campus per financial year; immutable after issue |
| M7.4 | Double-entry ledger | Every entry group sums to zero, enforced by a constraint and a nightly job |
| M7.5 | Payment gateway | Server-created orders; **settlement truth from signed webhook only** |
| M7.6 | **AC-6 pay and reconcile** | A forged client success callback leaves the invoice unpaid |
| M7.7 | **AC-7 refunds** | Original rows unchanged; reversing entries; second approver required |
| M7.8 | Reconciliation | Unmatched settlement queue as a first-class screen |
| M7.9 | UPI AutoPay mandates | Full mandate lifecycle as explicit states and events |
| M7.10 | Tally and CSV export | Accountant can close a month without leaving their existing process |

## M8 — Assessment and results (Phase 1) — **done**

| ID | Milestone | Definition of done |
| --- | --- | --- |
| M8.1 | Grading scales and assessments | Weightages, custom scales, lockable marks |
| M8.2 | Marks entry | Bulk, idempotent, offline-capable, blocked once locked |
| M8.3 | Result computation | Deterministic and re-runnable; reviewed before publish |
| M8.4 | Report card templates | One board first, validated against last year's real cards |
| M8.5 | Publish and correct | A correction supersedes, never overwrites; old artefact retained |

## M9 — Communication, reporting and onboarding (Phase 1) ← **next**

| ID | Milestone | Definition of done |
| --- | --- | --- |
| M9.1 | Templates and preferences | **Done.** DLT and WhatsApp templates as first-class versioned objects |
| M9.2 | Dispatch and delivery tracking | **Done.** Per-attempt status; automatic WhatsApp→SMS fallback |
| M9.3 | **AC-8 consent honoured** | **Done.** Withdrawn consent is never messaged; a 3-child guardian gets 3 correct messages |
| M9.4 | Import pipeline | **Done.** Upload → map → validate → preview → apply → reverse |
| M9.5 | **AC-9 large import** | **Done.** 5,000 rows with 12 defects: nothing written during validation, preview matches apply exactly |
| M9.6 | Dashboards | **Done.** **AC-2**: group totals reconcile to campus figures to the paisa |
| M9.7 | Public API and webhooks | **AC-10**: retries idempotent, signatures verified, deliveries visible to the tenant |
| M9.8 | Support and onboarding | Tickets, knowledge base, guided setup |

## Phase 1 exit gate

One design partner collecting real fees and reconciling correctly; isolation and integrity
suites green; published API docs and trust page; Android rating tracking above 4.3.

| Gate item | Status |
| --- | --- |
| Isolation and integrity suites green | **Done.** 468 tests, every milestone mutation-verified |
| Published API docs | **Done (M11).** Generated from the Zod schemas the handlers validate with, served at `/api/v1/openapi.json`, drift-tested against the router |
| Trust page | **Done (M11).** Every claim names its enforcement; a second section lists what is deliberately not claimed |
| A design partner collecting real fees | **Not started.** Needs a named school, not code |
| Android rating above 4.3 | **Not started.** Needs a shipped app |

## M11 — Publishing the contract (Phase 1 exit gate)

| ID | Milestone | Definition of done |
| --- | --- | --- |
| M11.1 | Every declared scope has an endpoint | **Done.** `results:read`, `payments:read`, `attendance:read` and `webhooks:read` could be granted while nothing used them — a published promise the product did not keep |
| M11.2 | OpenAPI generated, not written | **Done.** Built from the handlers' own Zod schemas; emitted to `openapi.json` at build time so a contract change is a diff in review |
| M11.3 | Drift is unshippable | **Done.** Tests compare the spec against the routes Nest actually registers, and the documented scope against the one the guard enforces |
| M11.4 | Developer and trust pages | **Done.** The docs page reads the spec from the running API, so it cannot describe a version that no longer exists |

## M10+ — Phase 2 and 3

Transport · biometric device import · HR and payroll inputs · homework · automatic timetable ·
multi-campus analytics · AI drafting assists · LMS and video boundaries · migration importers
from CampusCare and Fedena · then white-label apps, the higher-education pack, and the
partner marketplace — each gated on a written business case with a named design partner.

---

## M12 — the carried-over boundaries

| ID | Milestone | Definition of done |
| --- | --- | --- |
| M12.1 | Field-level grants (M3.7) | **Done.** `blood_group`, `medical_note`, `accommodations` and the emergency contacts are unreadable by the application role — a `SELECT *` on `student` now raises permission denied. A third narrow role reads them |
| M12.2 | A teacher's roll is their sections | **Done.** Every staff role could list every learner in the school. Teacher reach is now computed from what they are class teacher of, teach an offering for, or are timetabled into |
| M12.3 | DNS rebinding closed | **Done.** One lookup, every returned address checked, and the socket dials the validated address with the hostname carried in Host and SNI |

### M12 findings

Five defects, three of them introduced by the fix itself and caught before the milestone closed:

- **Policy recursion.** `student` → `app_may_see_student()` → `enrollment` → whose policy
  reads `student`. Neither policy is wrong alone; any two tables whose policies read each
  other will do this, and the read need not be obvious — here it was the branch that lets
  a learner see their own enrollment. Broken with SECURITY DEFINER, as M3 did.
- **The health role could not evaluate its own policy.** Its `EXECUTE` on
  `app_api_client_scopes()` was never granted, so every read raised permission denied.
  Worth noticing the direction it failed in: a role that cannot evaluate its policy reads
  nothing.
- **A column grant covers every column the query MENTIONS.** `deleted_at` appeared only in
  a WHERE clause, was therefore not in the grant, and the whole statement was refused.
- **Two policies expressing one rule had already diverged** three migrations after being
  written separately: a guardian reading their own child's medical note got nothing,
  because the health policy asked for staff scope. Now one function, called by both.
- **`CREATE ROLE` in a migration.** Roles are cluster-level, so 0045 failed the moment a
  second database existed in the same cluster — found by the packaging test on its scratch
  database. Bootstrap's own header had said this from M2; the migration ignored it.

And one found by mutation rather than by a test failing: **`resolveSafely` resolved
twice** — it delegated to `checkWebhookUrl`, which resolves, then resolved again itself.
Two lookups is the entire rebinding attack, and it was behaviourally invisible. The
mutation that deleted the second set of checks broke nothing, which is what exposed it.

## M13 — the rest of the surface

Three milestones were complete, tested and entirely invisible: a person running this
locally could not see assessment, messaging or imports at all. The endpoints existed
from M10; nothing rendered them.

| ID | Milestone | Definition of done |
| --- | --- | --- |
| M13.1 | Results | **Done.** Runs with their state, and the lines behind one. A learner with no marks is a row saying why, not a missing row |
| M13.2 | Messages | **Done.** Sent and, more importantly, withheld — with the reason in the institute's words rather than the machine's |
| M13.3 | Imports | **Done.** Preview counts beside applied counts, side by side, because those two agreeing is the whole of AC-9 |
| M13.4 | A browser view of the database | **Done.** Adminer on 8081, plus `pnpm db:schema` for the part a database client cannot show |

### M13 findings

- **Seed data is part of a feature, not a nicety.** All three screens were correct and
  showed nothing, because nothing had ever created a result run or a suppressed message.
  A feature nobody can see is not finished, and an empty state is not evidence it works —
  the screenshot tour now fails if a seeded screen renders one.
- **Four foreign keys pointed at `staff`, not `user_account`.** Caught one at a time by
  the seed. The two ids are both uuids and both "who did this", which is exactly why the
  distinction needs the database to hold it.
- **Demo names were database artefacts.** "Guardian1 Kumar" reads as a bug on a screen
  whose entire point is that a real person was or was not written to.

## M14 — onboarding a school

Until this milestone there was no way to create one. Migration 0003 says
"provisioning a tenant is a platform operation and runs as the owner role", which was
true and meant adding a customer required a DBA at a SQL prompt — `seed.ts` and the test
fixtures were the only things that had ever done it. That is not a deployment detail; it
is the product being unable to take its first customer, which is also the Phase 1 exit
gate's first line.

| ID | Milestone | Definition of done |
| --- | --- | --- |
| M14.1 | A platform role that cannot read a school | **Done.** No grant on person, student, invoice, attendance or messaging — not a filtered policy, no grant, so the failure is `permission denied` rather than an empty result somebody reads as "no students" |
| M14.2 | Provisioning in one transaction | **Done.** Organization, campus, academic unit, owner login and role grant, or none of them. A school with no owner account needs a DBA to rescue, which is what this ends |
| M14.3 | Idempotent on a request key | **Done.** Onboarding is the operation nobody retries carefully; a refresh mid-sale used to be a second school with the same name and no data |
| M14.4 | Capabilities, granted by somebody else | **Done.** Provisioning and support are separate — onboarding schools does not confer the ability to ask for access to one's records — and nobody can grant to themselves |

### M14 findings

Four failures during the build, each one a privilege the design had not thought through:

- **`SELECT ... FOR UPDATE` needs UPDATE.** Row locking is write-shaped even when nothing
  is written, so the replay check was refused on a table the role could read and insert.
- **A grant is not a policy.** The platform role had the column grants to create a login
  and no RLS policy permitting the insert. Both mechanisms have to say yes, which is the
  point of having both — and it failed on the INSERT rather than widening anything.
- **`bump_grants_version()` ran as its caller.** Writing a `role_grant` fires a trigger
  that increments `user_account.grants_version`, and the platform role has no UPDATE on
  logins — deliberately, because a role that can edit a login can take over a school
  owner's account. Provisioning failed at the last step with everything already created,
  inside the transaction, so nothing was left behind. The argument for the transaction,
  arriving sooner than expected.

And two the mutation pass found, both about tests rather than code:

- **A comment made a claim nothing tested.** "There is deliberately no UPDATE policy for
  this role" was true and unguarded; granting the privilege passed the whole suite.
- **The concurrency test was proving the wrong thing, flakily.** It used one owner email
  across all attempts, so `user_account.login_email` being unique was quietly doing the
  work — dropping the uniqueness on `request_key` changed nothing. Varying the email
  isolated it, and then the test caught the bug only when the attempts genuinely
  overlapped. A guard that fails intermittently teaches people to re-run rather than to
  look, so the guarantee now also has a deterministic test that asserts the constraint
  directly.

## M15 — the super admin console (web only)

**Product design.** Everything below is the operator's side of the product: onboarding,
support, and money. It is a web console and is deliberately not in the mobile app — the
app is for teachers and parents, and shipping a store binary that contains a path to
every school's data is a needless risk for a capability three people use at a desk.

### The one design change I would argue for

The ask is "see every school's data, everything". The architecture below delivers that,
with one difference worth stating plainly before it is buried in a table: **the access is
through a session, not a standing grant.**

A super admin can enter any school, as any role, in one click — no second approver, no
ticket number, no waiting. Functionally that is complete access. What it is not is
*invisible*: entering opens a session row, everything done inside carries both
identities, the school sees it in their own audit trail, and it ends on a clock.

The reason is commercial as much as ethical. Under the DPDP Act the school is the Data
Fiduciary and we are the Data Processor; a processor with standing, unlogged access to
every child's record is the finding that ends an enterprise sale and the one a regulator
asks about first. The audited path costs the super admin one click and gives the school
an answer to "who looked at my children's records". A standing cross-tenant SQL grant
saves the click and removes the answer.

So: the console can reach everything. It cannot reach anything quietly.

### Capabilities

`platform_admin` gains capabilities beyond M14's three. They are separate because these
are different jobs, and because an operator who onboards schools has no reason to read
one:

| Capability | What it permits |
| --- | --- |
| `provision` | Create, suspend and resume schools |
| `impersonate` | Enter any school as any role, read-only by default |
| `impersonate_write` | Elevate a session to write — a separate grant, not a toggle anyone holds by default |
| `billing` | Plans, subscriptions, trials, discounts, invoices to schools |
| `platform_support` | Read the cross-school support queue and platform health |
| `superadmin` | Grant and revoke capabilities. Cannot grant to self |

### M15 milestones

| ID | Milestone | Definition of done |
| --- | --- | --- |
| ID | Milestone | Status | What shipped |
| --- | --- | --- | --- |
| M15.0 | A way in at all | Done | `POST /platform/v1/login`. M14 shipped console endpoints reachable only with a token that requires a role grant in a school — which platform staff never have. The console was unreachable by construction and 500 service-level tests could not see it. The console token carries **no** `tenant_id`, and the tenant guard refuses a token without one |
| M15.1 | Instant entry, still recorded | Done | One click, no approver, no ticket. A session row opens with `entry_path = 'platform'`, the 60-minute cap is a database trigger, and the entry is written into the **school's** audit trail |
| M15.2 | Act as them | Done | The token's `sub` is the person being stood in for, so the school's own policies decide what is visible — there is no privileged view. `assumedRole` narrows to one of that person's roles and can never widen. Read-only is enforced by a global guard on every unsafe method, not by the interface |
| M15.3 | Impossible to forget you are in one | Done | A sticky banner above every screen, amber for read-only and red for write, driven by `/v1/me` rather than by anything the console remembers |
| M15.4 | Cross-school search | Done | Schools by name, accounts by email, with their roles and school. **Not** learners, invoices or people by name — those live inside a school and the console holds no grant on those tables. LIKE metacharacters are escaped, so a search for `%` is not an export |
| M15.5 | Platform health | Done | Per school: status, accounts, owners, live sessions, when we were last inside. Deliberately **not** learner counts or collections — a support console with a copy of every school's business is the thing this design refuses |
| M15.6 | The platform audit trail | Done | One list, two audiences: `/platform/v1/sessions` for us, `/v1/platform-access` for the school — served through their own policies, gated on `audit:read`, with a button that ends a session on the impersonator's next request |

**What changed from the design above, and why.** Two things.

*Entry names a person, always.* The plan said "as any role". A role alone is not something
this database can express: every policy decides by actor id, so there is no generic
teacher's view — only Mrs Nair's. A console that resolved a role to somebody silently would
put a name in the school's access log that the person entering never saw. So the flow is
school → filter by role → pick a person, and `assumed_role` records which of their roles
was being exercised. Migration 0054 got this wrong (it allowed either) and 0057 corrected
it, after ten tests on the older support path failed immediately.

*The school cannot read our staff's names by joining.* `impersonation_session` records
`actor_user_id`, and the obvious join to `user_account` returns NULL — correctly, since a
platform administrator holds no role in the school. The name is therefore written onto the
session row at entry (0056). Denormalised on purpose, and better in one more way: it
survives the account being deleted, and an access log that loses names when staff leave is
not an access log.

### M16 — plans, subscriptions and entitlements

**Product design.** Three things are usually conflated and should not be: what a plan
*costs*, what it *permits*, and what happens when a school *exceeds or stops paying*.

**The catalogue** is versioned. A plan's price and limits are a contract with the schools
already on it; editing them in place silently repriced everybody. So a change creates a
new version and existing subscriptions stay on theirs until moved deliberately.

**Limits are numbers, features are flags.** Learners, campuses, staff, SMS credits and
storage are metered numbers with an included allowance and a hard cap. Modules —
transport, HR, LMS, the public API — are flags. They are enforced in different places and
conflating them produces a system where "you have too many learners" and "you do not have
the transport module" are the same error.

**What happens at the edge is the whole design.** A school that exceeds its learner
allowance mid-term has children enrolled; a school whose card fails on a Sunday has
attendance to mark on Monday. So the ladder is:

1. **Over the included allowance** — it works, and it is metered for overage. Nobody is
   stopped mid-task by a number.
2. **Over the hard cap** — new records of that kind are refused with a message naming the
   plan and the number. Existing records keep working.
3. **Payment overdue** — a banner, then after the grace window the school goes
   **read-only**: every existing record readable and exportable, no new writes.
4. **Never** — no deletion, no lockout from their own data, and no holding an export
   hostage. A school locked out of its attendance register on a Monday is a school that
   never renews and tells every other school in the district.

| ID | Milestone | Status | What shipped |
| --- | --- | --- | --- |
| M16.1 | Versioned plan catalogue | Done | `plan` → `plan_version` → `plan_limit` / `plan_feature`. A published version is frozen by a trigger, **and so are its terms** — freezing the version row alone leaves the door open, since moving a learner cap from 600 to 60 needs no price change to put every school on the plan over it by morning |
| M16.2 | Subscriptions and trials | Done | One live subscription per school, pointing at a **version**. Every change writes an append-only `subscription_event` carrying who, when and why — the row that settles "we were never told we'd moved to the new price" |
| M16.3 | Feature gates in one place | Done | `app_tenant_has_feature()`, consulted by a global guard. A school with no subscription gets **true**: every school predating this milestone has no row, and defaulting to "no features" would switch transport off for all of them on deploy. Billing state is not an authorisation boundary — RLS is, and it never consults this |
| M16.4 | Metering | Done | Counted from the rows, never from a stored counter: a counter drifts on any path that does not increment it, and a school refused at a cap it is not at is worse than a slow query. Learners are those **enrolled or on leave** — a child on leave holds a seat, a child who left does not |
| M16.5 | The ladder, exactly as designed | Done | Over the allowance: metered, nobody stopped. At the cap: a **BEFORE INSERT** trigger refuses new records and existing ones keep working, including updates. Overdue: writable through a 14-day grace window, then read-only. The transitions are enumerated, so `active → read_only` without a recorded missed payment is refused |
| M16.6 | Self-serve visibility | Done | The Getting started page shows the plan, usage against each limit with three states rather than a percentage, which modules are included, and what the next tier would change — so a school learns it has outgrown its plan in February rather than from a refused admission in April |

**The rung I would not move.** A read-only school keeps every GET, including every
export. Withholding a school's own register because they owe us money is the one thing in
this ladder that would be indefensible — it is their record, their children; we are the
processor, not the owner. That is a test (`never withholds the school's own data`), not a
paragraph, and a mutation making the guard refuse safe methods fails it.

**Merged from a parallel build.** M16 was built twice — once here and once in a Claude
Code session on the same repo, which is a process failure worth recording rather than
hiding. The two were reconciled by reading both, not by picking the newer one.

The parallel version had never been executed against a real database: its metering
function referenced three columns that do not exist (`message_attempt.recipient_id`,
`message_recipient.request_id`, `message_attempt.attempted_at`), its
`app_tenant_is_read_only()` filtered `status != 'cancelled'` while claiming to return true
for cancelled — so cancelling a subscription restored full write access — its learner
count omitted `deleted_at IS NULL`, and its immutability trigger on `plan_limit` covered
UPDATE and DELETE but not INSERT. Its hard cap was a function for callers to consult
rather than a trigger, so any path that forgot to ask was uncapped.

It was righter about one thing, and that change was taken: **the app role should hold no
grant on the catalogue at all.** Those four tables carry no tenant column, so there is no
row-level security underneath them — the grant was the entire boundary, and it permitted
any school to read draft prices and privately negotiated plans. Migration 0064 revokes it
and puts the school's four legitimate questions behind `SECURITY DEFINER` functions.
`subscription` and `subscription_event` deliberately keep their grant and policies: those
ARE tenant-scoped, so RLS is available as a second line, and a definer function reading
tenant data has none. Strongest mechanism each table can support, rather than one pattern
everywhere.

**Three things the tests found that the design did not.**

*The freeze was half a freeze.* The first version froze `plan_version` and left
`plan_limit` and `plan_feature` editable. The price was safe and the limits were not,
which is the more dangerous half.

*Append-only beat the FK.* Migration 0060 made `subscription_event.actor_user_id`
`ON DELETE SET NULL` so that offboarding an account would not be blocked. The append-only
trigger refused it immediately — SET NULL is an UPDATE. 0061 reverted it: two promises
were in conflict and the stronger one wins, since accounts are soft-deleted in production
and only the test teardown hard-deletes.

*A mutation that changed nothing.* Relaxing the subscription policy's `WITH CHECK (false)`
to the tenant match broke no test — because the app role has no write **grant** on the
table at all, so the statement is refused before any policy is consulted. The test was
proving the grant while appearing to prove the policy. The privilege is now asserted
directly, and the migration says which mechanism is the enforcing one.

## M17 — attendance that survives losing the network

**Why this before the React Native app.** The server half of AC-5 has been finished and
tested since M6: idempotent marks keyed on a client event id, six conflict paths,
corrections for anything past the bound. What was missing was a client that used any of
it — the web attendance screen posted straight to the API **with no client event id at
all**, so a retry on a flaky connection was a second mark rather than a replay. Fixing
that reaches every cheap Android phone in the country through a browser, with no app
store, no install friction and no review queue. The Expo app is still the plan; it is not
the thing standing between a teacher in a basement classroom and a working register.

| ID | Milestone | Status | What shipped |
| --- | --- | --- | --- |
| M17.1 | The queue becomes a shared package | Done | `packages/offline-queue`, with no dependency on React Native, IndexedDB, SQLite or `fetch` — storage and transport are injected, so the conflict behaviour is tested in Node. A contract test checks its vocabulary against the server's, at compile time and at runtime |
| M17.2 | The web client actually queues | Done | Marks are written to IndexedDB **before** anything touches the network, each with a client event id minted once and never regenerated. A teacher's job is finished the moment the roll is in the queue; whether the network was there is our problem |
| M17.3 | Installable, and loads with no network | Done | A manifest and a service worker that caches the **shell only** |

**The line in the service worker I would defend hardest:** it caches no API response at
all. Caching `GET /v1/students` is the obvious win and it is wrong — a register built
from a roll that looks current and is three weeks old silently omits every child who
joined since, and nobody finds out until a parent asks why their daughter was marked
absent all month. The shell is cached, data is network-only, and a request that cannot be
served fails honestly.

**What the mutations found.**

*Twenty-seven spec files had never been typechecked.* `tsconfig.json` excludes `test/` —
correctly, since it emits to `dist` — and nothing else picked them up, so a test could
assert against a type that did not exist and still pass. A mutation breaking a shared type
failed nothing, which is how it surfaced. Three real errors were hiding there, including
a test reading a JWT claim the declared type denied existed (`verifyAccessToken` now
returns the registered claims it actually produces, instead of a cast that concealed
them). `tsconfig.test.json` now covers them and the build runs it.

*Two tests were reading source text instead of running code.* The service-worker tests
asserted that certain lines appeared in a certain order; wrapping the API guard in
`if (false && …)` passed every one of them. The worker is now loaded into a sandbox with a
fake `caches` and `fetch` and its handlers are dispatched, so the assertions are about
what it does. Likewise the teardown test proved the `stopped` flag while appearing to
prove the listener was removed — deleting `removeEventListener` changed nothing. It now
asserts the registration is gone.

## M18 — the mobile app

| ID | Milestone | Status | What shipped |
| --- | --- | --- | --- |
| M18.1 | A session that survives | Done | `packages/api-client`: rotation-aware refresh with a **single-flight latch**, storage injected, tested in Node. The web app is on it; the mobile app will be |
| M18.2 | The Expo app | Built, unrun | `apps/mobile` on **SDK 57**: sign-in and the register, on the shared client and the shared queue. It typechecks and it **bundles** — `expo export` builds the full graph — but nothing has launched it |

**Why this came before the app.** The server has rotated refresh tokens with reuse
detection since M2.2, and the web client never refreshed at all: when the ten-minute
access token expired, the next request 401'd and the user was bounced to sign-in. On the
web that is an irritation. On a phone a teacher opens twice a day it is a sign-in every
time, which is the difference between an app that gets used and one that does not.

**The part that is easy to get wrong.** Rotation plus reuse detection makes concurrent
refresh actively dangerous. A screen firing three requests on mount, all of which 401,
would call refresh three times with the same token — the first rotates it, and the second
and third look exactly like an attacker replaying a stolen one. The server does the right
thing and revokes the whole family, so the teacher is signed out mid-register and the
audit log records a security event that never happened. Refresh is therefore
single-flight, and that is what most of the package's tests are about; removing the latch
fails them immediately.

Two smaller decisions worth keeping: a refresh that fails **on the network** does not sign
anybody out, because a tunnel is not a security event and a queued register should not be
lost to a lift; and only a closed list of error codes is treated as refreshable, so
`refresh_token_reused` cannot start a loop against a family that is already gone.

**What is verified, and what is not.** The app cannot be launched here — no simulator, no
device — so the shape of it is arranged to make that gap small. Two adapters bind the
shared packages to the phone, both take their native module as an argument, and both are
tested against fakes: a locked keychain returns null rather than crashing the app on
launch, half a session counts as no session, a sign-out that fails to delete the access
token still deletes the refresh token, and a corrupt queue file starts empty rather than
making the register unusable forever. The register's own decisions — which rows to send,
what a tap does, what the teacher is told afterwards — live in `src/lib/register.ts` and
are tested too. What remains unverified is rendering and navigation.

**Bundling was worth more than reading.** `expo export` builds the whole graph without a
device, and it found three things a typecheck could not: `@babel/runtime` and
`query-string` are undeclared transitive dependencies that Metro cannot reach under pnpm's
isolated linking, and the two shared packages needed a `main` field because Metro reads it
before `exports`.

**Pinned to the wrong SDK, and what that cost.** The app was first written against Expo
SDK 52 — the version this environment's knowledge predated the replacement of — and that
was wrong in a way only a phone could reveal: current Expo Go runs SDK 57 and nothing
older, so the app could not be opened at all. Bundling proved the code was sound and said
nothing about whether anybody could run it.

The upgrade to SDK 57 (React Native 0.86, React 19.2) removed three earlier workarounds
rather than adding to them. `@babel/runtime` and `query-string` no longer need declaring;
`metro.config.js` is down from a hand-written resolver configuration to one line that
watches the workspace, because the default config now handles pnpm's isolated store; and
the awkwardest of them is gone entirely — SDK 52 required React 18 while the web app is on
19, so a hoisted root handed one of them the wrong copy and the web build died with a null
`useRef` during prerender. Both apps are on React 19 now. Each removal was verified by
taking the workaround out and bundling again.

**Setup steps that go wrong.** The app derives the API's address from
`Constants.expoConfig.hostUri` — the host the phone already reached Metro on — rather than
asking anybody to find their own LAN IP and keep it in sync with whatever the router hands
out. An explicit `apiUrl` still wins, because a real deployment is not somebody's laptop,
and the sign-in screen prints the address it resolved, because "which machine is this
talking to" is the first question when a request fails and the hardest to answer from a
phone.

The lesson is about verification rather than about Expo: `expo export` proves a bundle
builds, and cannot prove the SDK it targets is one that any installed client will load.
That is a check against the outside world, and it belongs at the start of choosing a
version rather than after somebody's phone shows an empty screen.

## M19 — white-labelling, and how a school is reached

**Two problems that look separate and are the same one.** A school subscribing to this
should be able to put its own name and mark on it — and that is not a cosmetic setting,
because the branding appears on the **sign-in screen**, the one screen shown before anybody
has authenticated. So the school has to be identifiable without a token. Meanwhile the web
app carried its tenant in a build-time variable and the mobile app in a config file, which
is one build per school and the opposite of white-labelling.

The host solves both. `stjosephs.paathshala.app` or `portal.stjosephs.edu.in` identifies
the school before login, which is exactly what the sign-in screen needs — and it removes
the baked-in tenant id that made setup fiddly in the first place.

| ID | Milestone | Status | What shipped |
| --- | --- | --- | --- |
| M19.1 | Addressing | Done | `tenant_domain`. Every school gets a managed subdomain at provisioning, live immediately. A custom domain is registered inert and routes only after a DNS TXT record proves ownership |
| M19.2 | Branding | Done | `tenant_branding` plus `app_brand_for_host()`, a `SECURITY DEFINER` lookup the unauthenticated sign-in screen calls |
| M19.3 | The web app reads the host | Done | `NEXT_PUBLIC_TENANT_ID` is gone. The brand loads before the sign-in form, the school's mark and colours replace ours, and the demo accounts show only in development |
| M19.4 | The mobile app picks a school | Done | A teacher types the address they already use in a browser, once. `expo.extra.tenantId` is gone, and the API address comes from the school rather than from a person who cannot know it |

**One host per school, not one per role.** The obvious reading of "a subdomain to access any
portal of any role" is a subdomain per role, and it is the wrong shape: it leaks the
school's structure to anyone who can guess a hostname, and it gives a person who is both a
teacher and a parent two different URLs for one account. The host says which **school**;
the signed-in user's grants decide what they see, exactly as they do now.

**An unverified domain routes nothing.** Without that, anybody could claim any hostname
and capture the branding — and later the traffic — of a domain they do not own. A school's
parents typing their password into a page somebody else controls is the failure being
prevented, so verification reads the TXT record for real. The check tolerates a domain that
also verifies with Google or Microsoft, and rejoins chunked values, because a TXT string
caps at 255 bytes and a real domain carries several records.

**Branding is a closed list, not a stylesheet.** "Let them supply CSS" is the flexible
answer and it is wrong twice: it is an injection surface on a page we serve under a
school's own domain, and it makes every future layout change somebody's broken portal. A
school sets a name, a mark and two colours. The colours are anchored hex — `#fff;
background: url(…)` is exactly what that pattern refuses, and the database refuses it too.

**What the public endpoint returns is the whole security question.** It is the most exposed
route in the system, so it returns a name, a mark, two colours and a support contact the
school chose to publish — and nothing about size, status, payment or people. A test asserts
the key list exhaustively, so adding a field is a decision somebody makes on purpose.

**Where the API lives is not the school's problem.** The brand lookup prefers the `Origin`
header over `Host`, because `api.paathshala.app` answering for
`stjosephs.paathshala.app` is the ordinary deployment and there the Host header is *ours*.
A browser sends `Origin` on a cross-origin request and cannot forge it; when the two are
same-origin no `Origin` is sent and `Host` is already the school's domain. `?host=` is
honoured only from localhost.

**A colour is checked three times.** The API validates it, a column check refuses it, and
the browser validates it again before writing it into a CSS custom property. That is not
belt-and-braces for its own sake: the last check is the one at the point of consequence,
where a bad value would mean script execution on a page served under a school's own
domain. A mutation removing the anchors from the pattern fails there and nowhere else.

**"Powered by paathshalaOS" is not a setting.** A school can put its own name on this; it
cannot claim to have built it. Keeping it out of the branding table is the point — a field
that can be set is a field somebody will ask to have set.

### Deliberately out of scope

- **Payment collection from schools.** Metering and status are here; taking the money is a
  finance decision with its own compliance surface, and inventing one would be guessing.
- **The mobile app.** Web only, as above.
- **A cross-tenant SQL console.** See the design note at the top. Every read of tenant
  data goes through a session that leaves a record.

## M20 — transport

`transport` has been a plan flag since M16 with nothing behind it. This is the module the
flag was selling.

The whole milestone turns on one sentence, written into 0066 before any code: **a manifest —
children, stops, times — is the document you would want if you meant a child harm.** So it is
not visible to "staff". It is visible to the people who need it for the run that is happening,
and the definition of "happening" is *today*, not *this term*.

| ID | Part | Status | What it is |
| --- | --- | --- | --- |
| M20.1 | The schema | Done | `vehicle`, `driver`, `route`, `route_stop`, `route_assignment`, `transport_enrolment`, `boarding_event` (0066). Papers that expire — fitness, insurance, permit, licence — are columns rather than a document folder, because a bus with lapsed fitness is not a data-quality problem |
| M20.2 | Who may see a manifest | Done | `app_drives_route()` answers *today*, not *ever*. `app_may_see_transport()` has three ways in and no fourth: the office through the ordinary student-visibility rule, the driver or attendant of the route today, and nobody else |
| M20.3 | The manifest as a document | Done | `app_route_manifest()` (0067) — a `SECURITY DEFINER` function with a fixed column list, checked once at the door. A driver gets the five fields a run needs and gains **no read** over `student`, `person` or `contact_method` |
| M20.4 | Moving a child | Done | Ended, not overwritten: "which bus was my child on last Tuesday" stays answerable. A change to an arrangement that has not carried anyone yet is amended in place instead, because closing a row the day before it opened records a journey from Tuesday to Monday |
| M20.5 | Boarding | Done | Same contract as classroom attendance — idempotent on a `client_event_id` minted on the device before any network call, so a bus coming back into signal replays rather than double-marks |
| M20.6 | The HTTP surface | Done | `/v1/transport/*`, entirely behind `@RequiresFeature('transport')` |

### Two defects, one of them severe

**0066 opened every transport row in the school to anyone with a person record.** It called

```sql
app_student_visible(p_student_id, app_current_person_id())
```

The second parameter of that function is the *student's* `person_id`; it exists so the "or the
learner themselves" branch can compare it to the caller. Passing the caller's own id made that
branch read `app_current_person_id() = app_current_person_id()` — true for every guardian,
teacher and former driver, for every child in the school. The tests caught it on their first
run, which is the only good part of the story.

0067 fixes it, and does not stop at fixing it: the trap was a two-argument predicate whose
second argument is derivable from the first, and it was always going to be sprung by whoever
called it next. There is now a one-argument `app_student_visible(uuid)` that resolves the
learner itself, and nothing new is ever asked to supply the id.

**A test passed for the wrong reason.** Weakening `boarding_event`'s `WITH CHECK` to tenant id
alone left all 18 tests green. The refusal the test believed it was asserting came from
Postgres applying a `FOR ALL` policy's `USING` clause on the `ON CONFLICT` path — that is,
from a clause present for *idempotency*, not for authority. A plain `INSERT` walked straight
through. The assertion is now made against the table with a bare insert, and the mutation dies.

A mutation that changes nothing is a finding, not a pass. This is the second time that rule
has earned its place — and it earned it twice more in the same milestone.

Building the transport screen found three defects with nothing to do with transport. The
seed had every learner in `lifecycle_status 'enquiry'`, so the demo school metered as zero
billable learners (M16) and the driver's manifest came back empty (M20). The seed also
predated M19, so a fresh clone reached a sign-in screen saying "no school is registered at
this address" and stopped there — the whole demo unreachable because the school existed and
its address did not. And white-labelling only ever repainted the logo: the stylesheet has
six brand tokens and M19 set one, so a school picked a colour and the buttons, the active
navigation item and every pill stayed our teal. The palette is derived now — the school's
colour kept exactly as the mark, the roles that carry text darkened until they clear 4.5:1
against white, because setting all six to one hex is how a palette ends up with buttons
nobody can read.

The fourth was a comment. `nextKind` in the mobile app had a guard against an index of -1
"wrapping to the end of the cycle"; deleting the guard failed no test, and the reason is
that `-1 + 1` is `0`, so the wrap it described had never been possible. The guard is gone.
A line that cannot be shown to do anything is not defence in depth — it is something untrue
that the next reader believes.

## M21 — the parent app

The mobile app stops being one screen. A parent has no section and no date range —
they have Aarav and four questions about him — so this is a read surface shaped like a
family rather than like a school.

| ID | Part | Status | What it is |
| --- | --- | --- | --- |
| M21.1 | What a parent asks | Done | `/v1/family/*`: whose children, was he in school, what do I owe, how did he do, which bus, what has the school told me. Days rather than sessions, one total owed rather than a ledger, and the day reported by its **worst** mark |
| M21.2 | Reads that survive no signal | Done | `CachedReader`: the server's last answer, held per screen, with an age bound and a stamp. Cached is never drawn as live |
| M21.3 | The screens | Done | One screen, a child at the top, a tab underneath. Tabs follow the school's per-link permissions, so a parent who may not see the fees gets no fees tab rather than an empty one — an empty list reads as "you owe nothing", which is the worse lie |
| M21.4 | A parent who can sign in | Done | The demo had guardian records and no guardian account, which made the whole app undemonstrable |

### The recursion, and four mutations that survived

0068 made `result_run` readable to a family with a child in a published run — the marks
were already scoped by `result_line`, but the row saying which **term** they were for was
staff-only, so a parent app could show a column of percentages with no heading.

0068's policy read `result_line`. `result_line`'s policy reads `result_run`. Postgres
answers *infinite recursion detected in policy for relation "result_line"* — and not only
for families: the recursion is in the pair, so it fired for any read reaching both tables,
the office's own results screen included. One migration opened a door and jammed every
other one. 0069 moves the membership test into a `SECURITY DEFINER` function with a pinned
`search_path`, which is what 0045 did for the same reason. There is a test asserting the
office path specifically, rather than trusting the comment.

Eleven mutations on the family surface. Four survived, and each named a different way a
test can be weaker than it looks:

- Weakening `result_run`'s policy changed nothing, because the service inner-joins
  `result_line`, whose policy already demands publication. The guarantee was being proved
  by the query that happened to be written.
- Dropping the tenant clause inside the `SECURITY DEFINER` function changed nothing, because
  every path to it already had a tenant check in front. A guard on a definer function is
  exactly the guard that must be asserted rather than assumed.
- Deleting the person filter from the messages query, and the link filter from the permission
  flags, both passed: the policies cover a guardian. They do not cover **staff**, and both
  endpoints are reachable by anyone with a session.
- An ended guardian link still counting passed, because no fixture had one. A school
  withdraws access by ending a link and writing a narrower one, so both rows exist for the
  same adult.

### And one comment that was borrowing a hazard

`rupees()` said it keeps money as a string because "12500.10 as a JSON double is
12500.099999999999". True of a *number* arriving in JSON, and nothing to do with a function
whose input is already exact integer paise: routing those through `Number(p) / 100` and
`toFixed(2)` gives the same answer for every value below 2^53 paise. Breaking the string
handling failed no test. The comment now says what is actually true — the string path has
no rounding step, the float path is exact until it silently is not — and the boundary,
9007199254740993 paise, is in the tests so the claim that remains is checkable.

Second milestone running in which a comment described a bug that could not happen. Both were
found the same way.

## M23 — observability

Structured logs with a request id that survives, metrics somebody would alert on, and
alerts with runbooks. Done before M22 and M24 because it is the only one of the three
that can be built and verified without a deployment existing.

| ID | Part | Status | What it is |
| --- | --- | --- | --- |
| M23.1 | A request id worth trusting | Done | Accepted from the caller, on terms: bounded, and restricted to characters that are safe in a response header, a log line and a URL. Anything else is replaced rather than refused |
| M23.2 | One line per request | Done | Method, matched **route**, status, duration, tenant, actor, impersonation id. Never the raw path, never the body |
| M23.3 | Metrics | Done | Eleven series, each with a sentence saying what a human would *do* about it. No tenant label anywhere |
| M23.4 | Alerts | Done | `ops/alerts/paathshala.rules.yml` — eleven rules, eleven runbooks, and a test that every metric they name is one the service emits |
| M23.5 | The id reaches Postgres | Done | `application_name` carries it, so a slow query in `pg_stat_activity` ties back to the request that caused it. The scope is set in one round trip instead of three |
| M23.6 | One shape for every failure | Done | `errors.ts` had promised this since M1 and it was false of anything nobody wrote a handler for |

### The interceptor that could not see the thing it was for

The access log started as a global interceptor, with a comment saying it ran first so a
request refused by a guard was still logged. Nest runs middleware, then guards, then
interceptors — so a guard that throws produces no interceptor call, and every 401, every
403 from the entitlement ladder, and every refusal inside an impersonation session would
have gone unlogged. Which is to say: exactly the requests an access log exists for.

It is `res.on('finish')` middleware now, which fires whatever produced the response, and
there is a test that calls an endpoint a guard refuses and asserts a line was written.

### And a gauge that reported a confident zero

The backlog gauges asked the platform role for three counts. That role has no grant on
`webhook_delivery`, `outbox_event` or `schema_migration` — deliberately, and a boot
assertion proves it — so every query threw, the sampler caught the error, and the scrape
reported `paathshala_webhook_backlog 0`.

"Nothing is stuck" and "I cannot see" looked identical on a dashboard, and the second is
the state an alert most needs to fire in. The comment directly above that code warned
about a *different* route to the same lie.

0070 gives the platform role a function returning three integers rather than the tables,
which keeps the assertion true. And the sampler now **removes** the backlog series on
failure rather than zeroing them — a missing series is a question, a zero is an answer —
with `paathshala_gauge_sampling_ok` for an alert to watch.

### Deliberately not traced

M23's definition of done said traces. This is one process, one database, and a request
that fans out to nothing: a trace would show a span for the request and a span for each
query, which is what the access log and `application_name` already give, in exchange for
a collector to run, a sampling rate to get wrong, and a dependency in the hot path.

That changes the day anything becomes asynchronous across a boundary — the webhook relay
and the outbox dispatcher are already separate processes, and when a parent asks why a
message never arrived, the answer crosses them. Written down as the trigger rather than
as a "later".

## M24 — backup and restore

The milestone's own definition of done said "a restore drill that has **actually been
run**, with the time it took written down". So it was, and the numbers are in
`ops/backup/DRILL.md` rather than described here.

| ID | Part | Status | What it is |
| --- | --- | --- | --- |
| M24.1 | A backup that is one | Done | Two files: the roles and the database. The roles are cluster objects and absent from a database dump — a restore without them produces a database whose every `GRANT` names something that does not exist |
| M24.2 | A restore that refuses to be dangerous | Done | The target must be named and must not exist. No `--force`, no drop. `--exit-on-error`, because pg_restore's default is to report failures and exit zero |
| M24.3 | A drill that has been run | Done | Backup 0.41 s, restore 1.61 s, on 46 MB / 70 migrations / 186 policies. Verified by content hash per table, by policy count, and by actually querying as the application role with a tenant scope |
| M24.4 | Point-in-time recovery | **Not done** | Needs WAL archiving, which needs a deployment. Written down as missing rather than implied by the word "backup" |

### The drill was a ritual for about ten minutes

It was written, run, then deliberately broken four ways to check it could fail. Three
were caught: dropping row-level security, losing three rows, and changing one value
without changing any count.

The fourth was not. Emptying `roles.sql` entirely — the classic way a backup turns out not
to have been one — left every check passing, because the roles were already present in the
cluster being restored into. The drill was confirming a property of the machine it ran on
rather than of the backup. It now reads the backup *file* for the four `CREATE ROLE`
statements, which holds whatever cluster it runs against.

A drill that cannot fail is a ritual, and the only way to find out which one you have is
to break it on purpose. Same rule as the code.

## M25 — taking money from schools

Subscription invoicing against M16's plans, with the tax a document issued in India has
to carry. **Not** the payment provider: that needs credentials and an account, and
writing an integration nobody can run would be the same as writing a feature flag that
guards nothing.

| ID | Part | Status | What it is |
| --- | --- | --- | --- |
| M25.1 | The tax arithmetic | Done | Place of supply decides the regime — intra-state splits into CGST and SGST, inter-state is IGST, never both. Each half levied at half the rate, separately rounded |
| M25.2 | Issuing | Done | One invoice per subscription period, with the parties **copied** onto it rather than joined, because an invoice is a statement about what was true when it was issued |
| M25.3 | A series without gaps | Done | A locked counter row, not a sequence. A sequence does not roll back, and a hole in a statutory series is a question from an auditor about a document that does not exist |
| M25.4 | Corrections | Done | Credit notes, with their own series. An issued invoice is frozen by trigger; nothing amends it |
| M25.5 | A payment provider | **Not done** | Needs an account and credentials. Written down as missing rather than stubbed |

**Not verified by an accountant.** The mechanics — the split, the rounding, the numbering,
the immutability — are implemented precisely and tested against themselves. The rate and
the SAC code are inputs rather than constants, deliberately: they are the parts a
professional has to confirm, and a constant would hide that they were assumed. M31 has the
review.

### The schema and the code disagreed, loudly, on the first run

The first version computed the whole tax and split it in two. The test run caught it
immediately: eighteen per cent of 1234.51 is 222.21 paise, which does not halve evenly, so
the two halves differed by a paise — and `CHECK (cgst = sgst)` in 0071 would have refused
the insert.

Halving the total is also not the rule. Each component is levied at half the rate: nine per
cent of 1234.51 is 111.11, twice, summing to 222.22 rather than 222.21. The one-paise gap
from the inter-state figure is a property of the tax, and the version that looked tidier
was the wrong one.

### And the M1 isolation invariant caught 0071

`rls_coverage` names every table with a `tenant_id` and no forced policy, and three of the
new ones were on the list. The tempting answer was to exempt them: they are platform tables
and the application role has no grant on them, so a school cannot read its own invoice
whatever happens.

That is a fact about today's `GRANT` statements. The next migration adding a reporting view
changes it in one line, silently. 0072 gives them RLS with a policy naming only the platform
role, so the application role is refused even if it is granted the table.

### A float that was right almost always

Breaking the exact quantity arithmetic failed no test. Every value in the suite agreed
between the exact path and `Number(q) * Number(p)` — they first diverge at 0.29 of
₹1000.50, which is 290.145 exactly, a half paise that the float lands below. That case is
in the tests now. Third time this project has found a claim that no test could tell from
its opposite.

## M27 — HR, and the teacher who could not mark the register

`hr` has been a plan flag since M16 with nothing behind it — the second of the three
modules M16 sold ahead of building.

The load-bearing part is not contracts or leave balances. It is **relief cover**, which
`attendance.spec.ts` has carried as a written-down limitation since M6: *"Cover assigned
on the morning, for a teacher who is in no timetable slot at all, has no representation in
this schema."* That is a teacher standing in front of a class they cannot mark a register
for, so somebody in the office marks it from what they were told — and the attendance
module's whole argument is that a register is not second-hand.

| ID | Part | Status | What it is |
| --- | --- | --- | --- |
| M27.1 | Employment | Done | `staff_contract`. Deliberately no salary column: pay would need its own access control, its own audit and its own answer to "who may read it", and M27 produces payroll *inputs* |
| M27.2 | Leave | Done | Types defined per school rather than by this schema, balances as a running figure, and `staff_absence` — named for the absence rather than the request, because somebody sick on the morning is an absence before it is a form |
| M27.3 | Relief cover | Done | Dated to a day, named to a section, attributed to whoever granted it. `app_actor_section_ids()` includes cover **today** |
| M27.4 | Payroll inputs | Done | Days employed, days of paid leave, days unpaid. Not payroll |

### Cover is a permission change with a friendly name

It is the only thing in this schema that widens somebody's reach, so it carries the same
three rules transport used for a bus manifest. **Today, not ever** — the date bound is
inside `app_actor_section_ids()` and reads `CURRENT_DATE`, not a date the caller passes,
because a grant that follows the date being viewed can be pointed at any day. **A named
section**, not "this person is covering today". **Written down**, as a `RESTRICTED` audit
entry, in the same class as a platform console entry rather than the same class as a leave
request.

Three refusals fall out of that: cover cannot be backdated (backdating cover is backdating
access; a past register is corrected through the attendance correction path, which is
attributed), cover against a *named* absence that does not cover the day is refused (access
granted for a reason that is not true, with a trail that reads perfectly), and cover cannot
be assigned by the person who benefits.

### Two mutations that survived

Deleting the service's refusal-note check failed nothing — the schema constraint catches it
either way. But the constraint's message is `staff_absence_refusal_has_note`, and a person
told that has learned nothing. The test asserts the *message* now, which is what the
service check is actually for.

And breaking the half-day arithmetic failed nothing, because no test approved a half-day
absence. Half days are the smallest unit any school here tracks.

## M22 — deployment, the half that can be checked

Docker's daemon is unreachable from both environments this was built in, and there is no
AWS account. So M22 splits: the part whose correctness is a property of the code, which is
done and tested, and the part whose correctness is a property of a running system, which
is written and explicitly unverified.

| ID | Part | Status | What it is |
| --- | --- | --- | --- |
| M22.1 | The schema guard | Done | The process refuses to start against a database that is **behind** it, reports one that is **ahead**, and refuses either way on a changed checksum |
| M22.2 | Container images | **Written, never built** | `apps/api/Dockerfile`, multi-stage, non-root, no compiler in the runtime stage. No image of it exists |
| M22.3 | A local stack | **Written, never run** | `bootstrap → migrate → api` in compose, in that order and for a reason |
| M22.4 | Cloud infrastructure | **Not done** | Needs an AWS account. Not written either: unverifiable Terraform is worse than none, because it looks like progress |

### Behind is fatal, ahead is not

The asymmetry is the whole design. A process whose migrations have **not been applied**
will query columns that do not exist — and worse, may write rows into a table missing a
constraint the pending migration was going to add. There is no legitimate deployment in
which code runs ahead of its own migrations, so that is a refusal to start.

A database with migrations the process does **not ship** is the ordinary state of a rolling
deploy: the new version migrated, and old instances keep serving until they are replaced.
Refusing there would make every deploy fail at its first step. So it is reported —
to `paathshala_schema_migrations_ahead`, which M23's `SchemaVersionSplit` alert already
watches, because "an instance was left behind" is a judgement about duration that a boot
check cannot make and an alert can.

### The comment that described a migration which did not exist

The guard's first version queried `schema_migration` directly, under a comment saying it
went through a function "so the application role still needs no grant". The platform role
has no grant on that table — 0070 had already hit the same wall — so the check failed on
its first run. The comment was describing 0075, which had not been written yet.

Writing the comment first and the code second is how a file ends up documenting an
intention rather than a behaviour. Fourth time this project has caught a version of that.

### And the compose chain would have failed where M24 said it would

The four application roles are **cluster-level objects**. Nothing in the migration history
creates them, every `GRANT` in every migration names one, and M24's restore drill found
exactly this by emptying `roles.sql`. So compose runs `bootstrap` before `migrate` — without
it the first `GRANT` fails, which reads as a broken migration rather than a missing
prerequisite.

**Nothing in M22.2 or M22.3 has been built or run.** The first `docker build` will find
something; that is what a first build is for.

## M28 — learning, and the second gradebook that did not get built

The last of the three flags M16 sold with nothing behind it. `transport` was paid off in
M20, `hr` in M27, and this is `lms`.

**One decision shapes every table.** An assignment that carries marks IS an assessment.
There is no score column on `submission` and there is not going to be one.

The obvious schema gives a submission a `marks_obtained` and a `graded_at`, and the bug it
produces is invisible until March: those marks are unknown to M8's weighting, to the result
run and to the report card, so a term of homework the teacher graded every week contributes
nothing to the learner's result and nobody finds out until results are computed. A second
scoring system beside the first is not a feature.

So an assignment that counts points back to an `assessment` row — created for it on the
spot, from nothing more than the teacher saying "out of 20" — and grading a submission
means entering a mark through the machinery M8 already has: the same lock, the same
corrections, the same absent/exempt rule, the same per-row savepoint. An assignment with no
assessment is practice, which is a real thing teachers set and should not have to pollute a
gradebook. There is deliberately no third state.

That is enforced three ways rather than described once: there is no column to write a score
to; a graded assignment's submission cannot be marked returned until a `mark` exists; and
grading an ungraded assignment with a number is refused rather than dropped.

| ID | Sub-milestone | Status | What shipped |
| --- | --- | --- | --- |
| M28.1 | Lessons, assignments, submissions | Done | Five tables, RLS on every one. Drafts are the teacher's until published — the rule 0068 established for a result run, for the same reason |
| M28.2 | Marks flow into M8 | Done | `assignment.assessment_id`, created on the create path. `gradeAndReturn` calls `assessmentService.enterMarks` and returns only the rows whose mark landed |
| M28.3 | The two surfaces | Done | A teacher's Classwork page built around one number — how much is waiting to be marked — and a Homework tab in the parent app, under the same permission as results |

### Three findings, one of them outside this milestone

**A teacher of IX-B was a teacher of IX-A** (fixed in 0077). `app_actor_section_ids()` had,
since 0045, granted a staff member every section of a class group whenever they were primary
teacher of ANY offering in it. `course_offering.section_id` exists precisely to say which
section an offering is taught to, and the branch ignored it — along with `deleted_at`, so
withdrawing a teacher from a class left their access exactly where it was.

The blast radius is larger than this milestone. That function is what `app_may_see_student`
is built on, which is what `app_student_visible` is built on, which is the single rule 0049
put under the policies on `student` — including the health role's, so the RESTRICTED medical
columns — and on marks, attendance and transport. A Class IX with four sections and four
subject teachers gave each of them all four sections' children.

Found by a test that expected a teacher with no connection to a class to see none of its
homework, and watched them see all of it. **No existing test broke when it was narrowed**,
which is the part worth recording: nothing in 779 tests had ever exercised that branch.

**A submission could be born already marked.** The column-ownership guard — the family owns
the work, the teacher owns the verdict — was written `BEFORE UPDATE`, on the assumption that
work is handed in and then marked. Nothing enforced the order. One INSERT carrying
`status = 'returned'`, a timestamp and a compliment passed the policy and skipped every
check. The guard now covers INSERT, and so does the requirement that a mark stands behind a
returned piece of work — including for the teacher recording paper homework, which is the
realistic version of that path and was the last mutation to survive.

**A test that proved the wrong policy.** "A parent cannot submit for another family's
child" passed with `submission`'s entire write rule deleted, because that caller cannot see
the other child's *enrolment* — 0019's policy refused it before this table was consulted.
The same shape M16 found. The assertion now uses the class teacher of the section, who can
see both the assignment and the enrolments and is stopped by nothing else.

**Deliberately not built.** File downloads. 0017 says nothing may be served until a scan has
cleared it, and there is no endpoint here that hands out a URL — bytes are referenced, never
served — so there is nothing to gate. The migration says where the gate goes when one is
added, rather than leaving it implicit.

## M32 — the write surface

Asked whether everything was built, I checked the route table instead of the plan, and
the answer was no in a place the plan could not see.

**The data model, the services and the tests were the mature part. The surface was not.**
115 routes existed, and the school-facing *write* actions were: mark attendance, record a
payment, transport enrolments and boardings, classwork, support tickets, API keys and
branding. Seven modules were built, tested and **unreachable** — no route, no screen,
callable only from a test file:

| Module | What was missing |
| --- | --- |
| HR (M27) | `src/modules/hr` held one file. No controller, nothing in `app.module.ts`. 28 tests, and a school could not file a day's sick leave |
| Admissions (M5) | `admissionsService` had no caller in `src/` |
| Enrollment (M5) | Same — a child could not be enrolled |
| Invoicing (M7) | A payment could be taken against an invoice the product had no way to raise |
| Messaging (M9) | 119 tests, and nothing could send |
| Imports (M9.6) | Onboarding meant typing four hundred learners by hand |
| Assessment (M8) | `GET /v1/results` and nothing else. After M28, the only way to enter a mark was to attach it to homework |

Four of the six plan flags — `hr`, `public_api`, `whatsapp`, `advanced_reports` — still
guarded nothing, which is the problem M20, M27 and M28 were each meant to close, sitting
on the other four.

| ID | Sub-milestone | Status | What shipped |
| --- | --- | --- | --- |
| M32.1 | HR | Done | Nine routes behind `@RequiresFeature('hr')`, the roster/leave/cover reads the service never had, and a Staff page built around the two moments an office actually has |
| M32.2 | Admissions and enrolment | Done | Enquiry → application → decision → offer → enrolled, as one pipeline list, with the form rendered from its own JSON Schema |
| M32.3 | Fees, messaging, imports | Done | Fee plans, instalments, raising an invoice, taking cash; sending to a class; the five-step import with a CSV parser that survives `"Sharma, Priya"` |
| M32.4 | Exams and results | Done | Scale → paper → open → marks → lock → compute → review → publish, and the mark sheet |
| M32.5 | Verification | Done | 51 assertions over real HTTP; 11 mutations, none survived |

**179 routes now, from 115.**

### Tested through `fetch`, not past it

Every assertion in `write-surface-http.spec.ts` goes through the guards against a Nest app
built from the real `AppModule`. That is the milestone's point: a service test proves a
function works and cannot prove anybody can call it, which for seven modules was exactly
the gap. It found eight defects nothing else could have:

- `form_definition.purpose` has no `'admission'` value (0017 allows `application`)
- `enquiry.programme_id` and `academic_year_id` are NOT NULL — a 500 where a 422 belonged
- `lead` requires a phone or an email, which was a constraint violation rather than a refusal
- `lead.source` has no `'campaign'`
- `fee_component` has no `deleted_at`
- `message_template.purpose` is DPDP's vocabulary, not a marketer's
- `ScaleKind` has no `'descriptive'`
- `grade_band` has no `lower_bound`/`upper_bound` — one numrange called `span`

And three attribution holes, all the same shape: **a document's author taken from the
request body.** `decidedByStaffId` on an admission decision, `receivedByStaffId` on a cash
receipt — both now resolved from `app_current_staff_id()`, both with a test that sends a
different id deliberately and asserts it is ignored.

### 0078 — a receipt named nobody

`recordOfflinePayment` has required `receivedByStaffId` since M7 and written it nowhere:
accepted, typed, dropped on the floor. Every cash receipt this system has issued is
attributed to nobody. Cash at a school counter is the one place money can quietly not
arrive, and a named person answerable for each receipt is the control. Nullable, because
the rows that already exist genuinely do not know.

### Intake was not atomic, and said it was

`intake` creates a person, a validated form submission and an application. The first
version was three `withTenant` calls under a comment claiming they were atomic. They are
not — `withTenant` opens a transaction per call. An HTTP test that submitted invalid
answers found the person row still there: an office retrying the form ends up with two
children who are one child.

### The mutation pass, and what it said about the comments

Eleven mutations. Five survived the first run, and three of those were comments
overclaiming rather than code being wrong — the shape M21 found in `rupees()`, three
times in one milestone:

*The money comment.* It said `12500.10` through a double is a receipt with the wrong
figure. Mutating the conversion to the float path failed nothing, because
`Math.round(Number(s) * 100)` recovers exact paise for every amount a school bills. Then
the narrower version — "they first disagree around ₹94 lakh crore" — got a **numeric
overflow** instead of a mismatch, because `fee_component.amount` is `numeric(14,2)` and
cannot hold a tenth of that. Within this schema the two paths are indistinguishable. The
string path stays because it has no rounding step and the column width is a decision
somebody could widen; what is asserted is the boundary that exists.

*The grading comment.* It said a top band of 80–100 fails the coverage check. It does not:
`[80, 100)` satisfies `[0, 100)`. What actually breaks is the learner who scores exactly
100, whose percentage is in no band at all — the one paper certainly right, reported as
ungraded.

*The CSV comment.* It credited the blank-row filter with dropping the trailing newline.
The parser already does that. The filter is for the line of stray commas a spreadsheet
export leaves behind, which parses into real empty columns and would import as a nameless
child.

The other two survivors were tests proving less than they named: the admission-author
assertion passed whether or not the controller read the body, until the body carried one;
and the money-shape check was never given a malformed amount.

### M32.6 — the five that were left

The list above was written honestly and then worked through. Six of the eight are now
reachable.

| Was unreachable | Now |
| --- | --- |
| `grantsService` | `/v1/access` — every account in this system was made by the seed or a test. A school that hired a teacher in October could not give them a login |
| `consentService` | `/v1/consent` — every consent decision the product enforces, and `may_message` consults one on every send, came from a row nothing could create |
| `rolloverService` | `/v1/academic-years/:id/rollover` — AC-3's claim rests on rollover COPYING, and a school with no way to run it would have edited last year's rows instead |
| `exportService` | The day book, as rows and as CSV, and Tally XML — what an Indian school's accountant actually imports |
| `refundService` | Money could come in and never go back out |
| `invoicingService` | `/platform/v1/invoices` — the console could put a school on a plan and had no way to charge it, which for a subscription business is the one thing that has to work |

**201 routes now.** Three services still have no caller, and all three are honest:
`mandateService` and `reconciliationService` are blocked on M26's gateway, and
`retentionService` is a scheduled purge with no scheduler to run it — this system has one
worker, the webhook relay, and no cron. That is a named gap, not a forgotten one.

### The bug the HTTP tests could not see

`/v1/access/delegatable` passed every test and answered 500 in the built server.
`rewriteRelativeImportExtensions` turns a `.ts` specifier into `.js` on the way out for a
static import, and for the top-level dynamic ones in `main.ts` — and it left a dynamic
`import('./authz.service.ts')` inside a class method alone. The suite runs from TypeScript
source and never loads `dist`, so it could not possibly have caught it. The first page
render did.

`packaging.spec.ts` now reads the built output and fails on any relative `.ts` specifier
left in it. Putting the dynamic import back fails that test; the fix passes it.

### Two more findings from the mutation pass

Nineteen mutations across M32. Two survived: the delegatable-roles list passed against a
hard-coded array because the assertion only checked an owner's list, which contains
everything; and the refund refusals were proving the zod shape rather than the service,
because an empty string never reaches it. A teacher's list and a whitespace-only reason
close both.

## M29 — it speaks the language

`organization.locale` was added in migration 0002, with a default of `en-IN`, and until this
milestone **nothing in the product had ever read it**. Every locale decision resolved to a
hard-coded `'en-IN'` in two places: `dispatch.service.ts:357` and `template.service.ts`.

That is not a cosmetic gap. Follow it through: a Hindi-medium school registers its templates
in Hindi, approves them, and sends an absence notice. The dispatcher looks for an `en-IN`
template, finds none, and writes `no_approved_template` against every parent. **A school that
does not operate in English could not send messages at all** — and the failure reports itself
as a per-recipient suppression, which reads like a consent problem and sends whoever
investigates to the wrong screen.

So "India-first" was a claim about the schema. The chain is what makes it a behaviour.

| ID | Sub-milestone | Status | What shipped |
| --- | --- | --- | --- |
| M29.1 | One locale chain, used everywhere | Done | `src/modules/i18n` — the vocabulary as a pure module, the resolution as a service. `approvedVersion` now *requires* a chain, so there is nowhere left to omit it |
| M29.2 | The parent app in the family's language | Done | A string catalogue typed off the English one, per-key fallback, and an auditor that is itself tested against broken fixtures |
| M29.3 | Setting a locale | Done | `/v1/locale` — the school's, the family's own, and the office's on their behalf. Migration 0079 closed the hole the first of those would have opened |

### The chain, and why each link is there

**What the person asked for → what the school teaches in → `en-IN`.**

The person's own preference wins because a parent who set Hindi has told us something a
default cannot override. The school's locale comes next because a Tamil-medium school's
parents overwhelmingly read Tamil, and asking eight hundred families to each set a preference
before the product works for them is not a migration anybody completes. `en-IN` is last
because it is the only tag every seeded row carries — not because it is anybody's language.

It is a *chain* rather than a winning string, and that is the whole fix. The old code
collapsed the answer to one locale before the template lookup ran, so by the time anything
could have consulted the school's language, the alternatives had been thrown away.

Three smaller decisions inside it:

- **An unrecognised but well-formed tag is kept, not dropped.** `message_template_version.locale`
  is free text; a school that registered templates under `bho-IN` (Bhojpuri, not in the Eighth
  Schedule) must still reach its parents. Only a malformed string is discarded, because a
  malformed tag cannot match a row anyway. `TEACHING_LOCALES` is a picker list, not a
  permission list.
- **Every locale a person has stated counts, not just the one keyed to this purpose.**
  `communication_preference.locale` is per purpose, which is a schema shape this has to live
  with: a language belongs to the reader, not to the subject. Somebody who chose Tamil for
  attendance and Bengali for fees has told us twice which languages they read.
- **`message_recipient.locale` is corrected after the send** to the language actually used,
  which is not always the head of the chain. A row claiming Hindi when the parent received
  Tamil cannot answer "what did we actually say to them".

### The endonyms that are missing on purpose

`TEACHING_LOCALES` is English plus the twenty-two languages of the Eighth Schedule — the
constitutional list, not a list of "languages we have translated into", because a school picks
the language it teaches in and whether a template exists in it is a separate question the
template table answers per row.

Five entries carry no endonym: Kashmiri, Sindhi, Manipuri, Santali, Bodo. The spelling in
those scripts is **not publicly verified** by this author, and a language name printed wrong in
a picker is worse than one that is missing — the missing one reads as incomplete, the wrong one
reads as carelessness about the reader. `endonymOf` falls back to the English name, and the
gap is marked in the source for somebody who reads the script.

### The mutation pass, and the one survivor

Eighteen mutations against the eighteen tests. Seventeen died on the first pass. One did not:

**Dropping `updated_at DESC` from the preference ordering broke nothing.** No test had ever set
two locales under purposes *other* than the one being sent, so the tie-break had never
decided anything — the assertion that looked like it covered recency was satisfied by
alphabetical order by accident. Closed with a test that sets Bengali under fees thirty days
ago and Tamil under marketing now, where the two orderings disagree.

One earlier "kill" was also thrown out as dishonest: removing `(purpose = $2)` from the ORDER BY
removed the last use of `$2`, so Postgres refused the bind and the test failed for a mechanical
reason. Re-run as `(purpose <> $2)`, which keeps the parameter and inverts the preference, it
died properly.


### M29.2 — words, and what happens when they are missing

The English catalogue **is** the type: `Strings = Partial<Record<keyof typeof EN, Phrase>>`.
That one decision does three things no test does as well. A string added to the app breaks no
translation, because being late is allowed. A key *removed* from English breaks every locale
that still translates it, so dead strings cannot pile up. And a key **misspelled** in a
translation is a type error immediately rather than a string that falls back to English
forever — which is the failure this shape exists for: a translated app where one screen is
quietly in the wrong language and nobody can see why.

Resolution is **per key, not per catalogue**. The obvious implementation picks one catalogue up
front, and a language with five strings in it then renders five words and fifteen blanks.

**A missing interpolation value leaves its placeholder standing.** The API throws on a missing
template variable, because a half-rendered SMS goes to eight hundred people and cannot be
recalled. A phone is different: throwing inside a render takes the screen down, and a parent
with a blank screen has lost more than a parent with a visibly broken sentence. So `t` renders
`Due {days} days ago`, which is obviously wrong and gets reported, rather than `Due  days ago`,
which reads like a sentence.

**The Hindi catalogue is deliberately incomplete**, and shipping it half-done is the choice. A
parent who reads Hindi and sees five familiar words among twenty English ones is better served
than one who sees twenty English words because the translation was not finished — and the half
state is visible to everybody, which is how the rest gets written.

**The device locale is the last guess, not the first.** A family that told the school they read
Tamil has said something deliberate; a second-hand handset with Hindi set on it has not. The
phone's own setting is still consulted, because a fresh install at the sign-in screen has
nothing else.

**The remembered chain has no expiry**, unlike the read cache beside it. A fee balance from
March is a wrong number with a date next to it; a language does not go wrong with age. Expiring
it would drop a Tamil-reading parent into English after a fortnight with no signal — exactly
when they are least able to go and change it back. The test says so, because that inconsistency
is the thing most likely to be "fixed" later.

### The audit is tested against a broken catalogue, not only a good one

`auditCatalogue` names the three ways a translation goes wrong in a diff nobody reviewing it can
read: a key English does not have, a dropped `{placeholder}`, and a plural pair flattened to one
string. It was extracted out of the test for a reason the first version got wrong — the real
catalogues are clean by construction, so a check written only against them passes whether or not
it works. It now runs twice: over the shipped catalogues, where it must come back empty, and
over deliberately broken fixtures, where it must not.

### M29.3 — and the hole it would have opened

`organization` has carried `GRANT SELECT, UPDATE ... TO paathshala_app` since 0003, and its
`tenant_isolation` policy is `FOR ALL`. So **every principal of a tenant could update the
organization row** — a parent included. Nothing exploited it because no endpoint wrote to that
table, and M29.3 adds the first one.

Migration 0079 splits the policy: reading stays open, because a parent legitimately sees the
school's name and branding; writing needs an organisation-wide `ORG_OWNER` or `CAMPUS_ADMIN`.
Deliberately narrower than `app_actor_has_staff_scope()`, which a teacher satisfies, and
deliberately scoped — an admin of one campus changing what every campus writes in is a scope
escalation wearing a settings screen.

The rule is in the policy rather than the controller, because a rule enforced in one controller
is a rule the second controller will not have.

Two more decisions:

- **Writing is restricted to the listed languages; reading is not.** Resolution has to tolerate
  whatever is already in the column — an imported row, a tag from before the list existed — but
  a picker that accepts free text is how `en_US`, `English` and `hindi` end up in one column,
  none of which match a template row and all of which look like a setting that worked.
- **Setting a person's language leaves one stated language, not a row per purpose.** The table
  is keyed per purpose, so "my language" maps to no single row; writing one per purpose would
  manufacture exactly the disagreeing-rows case the chain then has to arbitrate.

### The office can set a family's language, and that is not a workaround

A parent who cannot read the app cannot reach the screen that changes its language. That is the
whole problem. `/v1/locale/people/:id` and the control on the Access page exist so the
admissions desk can set it while the family is standing there, which is the only version of this
that reaches the families who need it most. A parent pointing it at somebody else gets a 404 —
not a 403, because whether that person exists is not their business.

### Four survivors across M29.2 and M29.3

Fourteen mutations against the mobile catalogue and store: none survived. Seven against the API
service and nine against the 0079 policy function: four did, and each named a test that was
weaker than it read.

- **The account list's preference ordering.** Reading the *wrong* preference row passed, because
  every row in the fixture agreed — `setForPerson` harmonises them, so after any change made
  through the product the ordering cannot be wrong. Closed by writing a disagreeing row straight
  to the table, which is what an import leaves behind and what the ordering exists for.
- **`scope_type = 'organization'` in 0079.** Every `CAMPUS_ADMIN` in the suite was
  organisation-wide, so the clause had never refused anything.
- **`revoked_at IS NULL` in 0079.** The revoked grant in the test was campus-scoped, so the
  *scope* clause was refusing it and the revocation clause was never consulted. Both closed by
  one test that walks the whole lifecycle: campus-scoped refused, school-wide allowed, revoked
  refused, expired refused, restored allowed.
- **`tenant_id = app_current_tenant_id()` in 0079 — not closable.** `role_grant` carries its own
  tenant policy, so for the application role that predicate can never exclude a row, and no test
  could be written that removing it would fail. It stays for symmetry with
  `app_actor_has_staff_scope()` and against a future `SECURITY DEFINER`, and migration **0080**
  records that in the function's comment. A comment, shipped as a migration, because 0079 had
  already been applied and the checksum guard is right to refuse an edit to a file some database
  was built from.

Writing the expiry test also turned up something worth stating: changing a grant row bumps
`grants_version` and kills every token issued before it, so expiring a grant *in place* answers
401 and never reaches the policy at all. The version bump is the first line of defence; the
policy's `expires_at` clause is the second, for a grant that lapses by the passage of time with
no row touched. Only a token taken out after the row exists can test it.

## M30 — scale, where it is real

Three things, and the third is the one that turned out to matter most.

| ID | Sub-milestone | Status | What shipped |
| --- | --- | --- | --- |
| M30.1 | `attendance_record` partitioned by month | Done | Migration 0081. Partitions made on demand by the path that opens a register, because this system has no scheduler |
| M30.2 | The rate limiter off per-process memory | Done | Into the Redis that had been in the compose file since M0 with nothing ever connecting to it |
| M30.3 | Query budgets | Done | A guard that captures the queries the product *actually sends* and fails when one stops naming its month, plus a round-trip ratchet on the sync path |

### M30.1 — the deferral was right, and its reasoning was incomplete

0021 wrote down why it did not partition:

> a partitioned table's unique constraints must include the partition key — so
> `UNIQUE (tenant_id, client_event_id)` would become
> `UNIQUE (tenant_id, session_date, client_event_id)`, and the offline
> idempotency guarantee would hold only within a date rather than absolutely.

Correct, and it missed that **a record's date is not a free variable**. It is
the date of the session the record belongs to, and a replayed batch carries the
same session id — so it resolves to the same date, lands in the same partition,
and still collides. The guarantee survives the narrowing intact.

But only while the date cannot be chosen. So it is enforced by a composite
foreign key to `attendance_session (id, session_date)`: a record may claim only
a date its own session agrees to, and no caller supplies one — every INSERT
reads it back out of the session in the same statement.

**What actually changes**, stated rather than discovered: the same
`client_event_id` submitted for two different learners on two DIFFERENT dates is
now accepted, where it used to be rejected as a client bug. The same id on the
same date is still caught, which is where the damage was, and
`one_per_enrollment` still makes a duplicate mark in one session impossible.

### The trigger that cannot exist

The obvious way to fill in the partition key is a `BEFORE INSERT` trigger. It
does not work, and the reason is not in the error message anybody will search
for: tuple routing happens **before** a partitioned table's row triggers fire on
the chosen partition. A row arriving with a NULL key routes to the default
partition, the trigger then sets a real date, and PostgreSQL refuses with
*"moving row to another partition during a BEFORE FOR EACH ROW trigger is not
supported"*. The key has to be right before the row is routed.

### Partitions without a scheduler

This system has one worker — the webhook relay — and no cron. A partitioned
table that needs a monthly job to stay writable turns that gap into an outage
every 1st of the month, in the one hour of the year when every teacher is
marking a register.

So `ensure_attendance_partition(date)` is called by the path that opens a
session, which is the only way a record comes into existence. Underneath it
there is a DEFAULT partition, because *"no partition of relation found"* is an
outage and a row in the default is a row. The awkward part of having a default —
PostgreSQL refuses to attach a partition whose range overlaps rows already
sitting in it — is handled by the factory itself rather than left for whoever
meets it at the wrong moment.

### Two things that would have gone quietly wrong

**The invariant would have stopped watching.** `rls_coverage` (0004) checks every
table with a `tenant_id` for RLS, forced RLS and an explicit `WITH CHECK`. It
selects `WHERE relkind = 'r'`. A partitioned parent is `'p'`, and its partitions
are `'r'` and each carry a `tenant_id` — so the invariant would have stopped
looking at the table that matters and started demanding policies on thirty-eight
that inherit them. It would have failed loudly for the wrong reason, and the 2am
fix for that is to delete the check. Partitions are now excluded because their
parent answers for them; partitioned parents are included because they are the
table.

**A cascade that was never possible.** The old foreign key from
`attendance_correction` said `ON DELETE CASCADE`, and it could never have run:
`attendance_correction_append_only` fires BEFORE DELETE for every role and raises
unconditionally, so the cascade would always have been refused at the far end.
The schema declared a behaviour the database would never perform. Re-declared as
`ON DELETE RESTRICT`, which is what actually happens.

### And the defence 0021 asked for

0021 told this migration to remember the lesson from 0009 — that a policy on a
partitioned parent is not applied to a query naming a partition directly. The
defence is not a policy on every partition. It is that the application role has
**no grant on any partition**: privileges are checked against the table the
query names, so the app cannot name one at all and can only come through the
parent, where the policies are. Nothing in 0081 grants on a partition, and that
omission is the mechanism, so it is written down next to it.

### M30.2 — a counter that had been waiting since M0

`rate-limit.ts` said, at the top, that counting in process memory meant two API
instances allowed twice the configured rate, and that the counter "belongs in
Redis when there is more than one instance". Redis had been in
`docker-compose.yml` and the environment schema since M0 with nothing ever
connecting to it, so "when" had no date on it.

The window is still **fixed**, deliberately. The boundary flaw the old comment
admitted is still there. Changing where a counter lives and how it counts in one
step produces a bug nobody can locate; the two implementations now have
identical semantics, which is the entire point of having a fallback.

**Failing open, and saying so.** If Redis is unreachable the count falls back to
this process's memory — not to refusing, and not to allowing everything. A rate
limiter that takes the API down when a cache is down has inverted its own job.
The cost is exactly the old behaviour, and it is visible:
`paathshala_rate_limiter_fallbacks_total` counts it, because a degradation
nobody can see is one nobody fixes.

**`enableOfflineQueue: false` looked like the cautious setting.** With
`lazyConnect`, it means the first command is rejected before the connection has
finished opening — so every command failed, every decision fell back to local
memory, and the limiter behaved exactly as it had before the milestone while
reporting success. Caught only because one test reads the Redis key rather than
the verdict.

### M30.3 — the budget that found the milestone was a lie

The partitioning was in place and **every read still scanned every month.** The
parent app, the dashboard, the trend, the office's day view — all of them
filtered on `attendance_session.session_date`, the joined table, not on
`attendance_record`'s own column. The planner cannot carry a predicate across a
join into a partition list. The answers stayed right, the plans read thirty-eight
partitions, and nothing in eight hundred tests could tell.

So the guard is two-sided, and neither side is a copy of the queries:

- **Captured.** `pool.connect` is wrapped for the duration of a call, every
  statement the service issues is recorded with its parameters, and each one
  that touches `attendance_record` is re-run under `EXPLAIN` (with `ANALYZE` for
  reads, because a subquery-supplied date prunes at run time). The budget is two
  partitions, because a parent's thirty-day window straddles a month boundary
  for all but one start date in the year.
- **Static.** Every SQL string in `src/` that names the table must constrain
  **the record's own** `session_date`. Checking for the words alone passes a
  query that filters the joined session instead — which is the whole mistake —
  so the check resolves the table's alias. The check is itself tested against
  known-bad SQL, because the shipped queries all pass it and a version that had
  stopped working would pass too.

The round-trip half is a ratchet: two statements per mark today, ceiling two.
Three was tried first and a mutation adding a query inside the loop survived it —
a loose ceiling is not a safety margin, it is room for a regression.

### The mutation pass, and six survivors

Thirty-four mutations across the three sub-milestones. Six survived, and every
one named a test that was weaker than it read:

- **Seven kills that were not kills.** The first partitioning pass reported eight
  dead mutations, and seven of them were one test failing on its own residue —
  it created a partition for a far-future month and asserted the month had none.
  A test that only passes on a fresh database fails for the next person and gets
  "fixed" by deleting the assertion. The suite now detaches and drops what it
  creates, at both ends.
- **The dashboard's two other queries and the office's day view** had no coverage
  at all: removing their date predicates broke nothing, because the dynamic
  guard only sees the paths it calls and the static one accepted any
  `session_date` anywhere in the string.
- **`resetRateLimits` clearing only one of its two counters**, twice — once for
  the Redis side and once for the local map. The second attempt to close it
  failed too: the assertion ran a minute later, where the local window has rolled
  and the entry is replaced whether or not anything was cleared.
- **Partition pruning switched off in the planner** changed nothing, which was
  not a finding about the test — the per-partition `CHECK` constraints that let
  the factory skip its validation scan also let `constraint_exclusion` do the
  job. With both mechanisms off, the test fails.

One further note, recorded because it cost an hour: the `rls_coverage` view in
0081 was written out from memory and silently reverted **0016's** correction,
which exempts DELETE policies from the explicit-`WITH CHECK` rule. The isolation
suite's own invariant caught it within a minute of the migration applying. The
fix was to rebuild the development database rather than ship a broken migration
plus a correction — legitimate only because no database in the world had been
built from it yet.

## M33 — the jobs nobody was running

Not on the original plan. It was found while looking for something buildable
after M30: four functions in this codebase carry a comment saying a scheduled
job calls them, and **none of them had a caller anywhere in `src/`.**

| What | Its comment said | What was true |
| --- | --- | --- |
| `seal_audit_period` (0007) | "a scheduled job seals each closed period" | `audit_checkpoint` was empty in every database this product had ever built. The audit log was not tamper-evident; it had a function that would have made it so |
| `retentionService.purgeUnsuccessfulApplicantDocuments` (M18) | "the single largest pile of needless personal data an institute holds" | Nothing had ever purged one. ID proofs and birth certificates belonging to children who never enrolled |
| `ledgerService.unbalancedGroups` | "the nightly integrity job's query" | There was no nightly integrity job |
| `ensure_audit_partition` (0007) | "called by a scheduled job; also called defensively on insert failure" | Only the defensive half existed — and it could not work either. See below |

The common cause is recorded elsewhere as a gap: one worker, the webhook relay,
and no scheduler. Every job was written as something somebody else would arrange
later.

| ID | Sub-milestone | Status | What shipped |
| --- | --- | --- | --- |
| M33.1 | A scheduler | Done | 0082: the schedule is a row, the outcome of every run is a row, and "when did this last succeed" is a query |
| M33.2 | The four jobs, wired | Done | 0083, 0084, and a named maintenance connection — see below, because the obvious wiring was silently wrong |
| M33.3 | Somewhere to look | Done | The platform console, and the one number that catches a job which has stopped |

### The outage that had a date on it

`ensure_audit_partition` does CREATE TABLE, GRANT and REVOKE. `paathshala_app`
and `paathshala_auth` can do none of those, and the function was plain
`SECURITY INVOKER`. So it was unrunnable by anything that exists — including the
"defensive" inline call in `audit.service.ts`, whose comment says a missed job
"degrades into a slow write, never a lost record". It does not: that call runs on
the auth pool, hits `permission denied`, and the record is lost with a log line.

0007 pre-created **three months** of partitions. This database was migrated on
20 September 2026 and had partitions through November. On 1 December every audit
write in this product would have failed, the fallback would have failed too, and
the only trace would have been `AUDIT WRITE FAILED` in a log.

0083 makes both audit functions `SECURITY DEFINER` with a pinned `search_path`,
grants EXECUTE narrowly, and tops the partitions up to a year ahead so that a
deployment which somehow never runs the scheduler still has twelve months
instead of three.

### A job is not a person, and that is not a detail

The obvious way to run a job for a school is `withTenant({ tenantId })` — the
shape the webhook relay uses, which works there because the tables it touches
have tenant-only policies. It is silently wrong for everything else, and the
tables a compliance job touches are exactly the wrong ones:

    file                  staff_only:   tenant AND app_actor_has_staff_scope()
    application_document  staff_only:   tenant AND app_actor_has_staff_scope()
    ledger_entry          finance_only: tenant AND app_actor_has_finance_scope()

A job has no actor. Every one of those predicates is false, every query returns
nothing, and the job **reports success having examined zero rows**. The retention
purge would have run every night, deleted nothing, and written
`applicationsConsidered: 0` into its own evidence trail. The fix for "nobody was
running the job" would have been "the job runs and does nothing", which is worse
because it looks finished.

Found because one test asserted that a deliberately broken ledger made the job
FAIL. Without that assertion every other test passed.

`db/maintenance.ts` is the answer: the owner connection with `app.tenant_id`
set, no actor, transaction-local, imported by one file — and a test enforces
that last part rather than a convention.

### ...and the first thing the maintenance connection did

It made three queries wrong. Each had been relying on row-level security for its
tenant filter, which is correct for a request and catastrophic with the policy
off:

- `unbalancedGroups` had **no WHERE clause at all**. Its first run reported one
  school's broken ledger as every school's.
- The `files.pending_erasure` count would have counted the whole fleet.
- The retention purge had no tenant predicate anywhere. One school's nightly
  purge would have deleted **every school's** applicant documents, once per
  school, irreversibly.

A query that leans on a policy for correctness is wrong the moment anything runs
it with the policy off. All three now name their tenant, and three tests run a
job for one school while the school next door holds the poison.

### The number that would have caught all of this

`paathshala_scheduled_task_seconds_since_success`, sampled rather than counted.

A job that fails is loud: a failed run, a log line, a metric. A job that stops
being claimed produces **nothing at all**, so nothing event-driven can alert on
it. That is why every one of these went unnoticed for the life of the product,
and it is why the console's last column and this gauge exist. A task that has
never run has no series rather than a zero — the lesson M23 already paid for.

### The ledger job is a backstop, not a guard

Worth writing down because the comment it was named after reads like the
opposite. `ledger_entry_group_balances` already refuses an unbalanced group on
every ordinary write. The only way one can exist is a write that went round the
trigger — a migration, a data fix, a restore, anything run with
`session_replication_role = replica`. That is the class of write nobody watches
and nobody writes a test for, and it is what this job is for.

### The file sweeper that cannot be written

M18 said the object itself is removed "by a separate sweeper". There is no
sweeper and there could not be: **nothing in this system has ever opened a
connection to object storage.** `file.bucket` and `file.object_key` have been
written since M17 and never read by anything that could act on them.

So `files.pending_erasure` does not pretend to erase. It counts what is waiting
and how long it has waited, and says in its own run record that it cannot do
more. Under DPDP a file a school has promised to delete and has not is a
liability; this turns it into a number. Closing it needs an object-storage
adapter, which belongs with M22.

### Two bugs only HTTP could find, and one only a second suite could

- `extract(epoch ...)::bigint` comes back as a JavaScript BigInt, which
  `JSON.stringify` refuses. The console endpoint answered 500 while every query
  in it was correct.
- 0082 granted the platform role SELECT, which was right for a read-only view
  and wrong the moment "run this now" existed. 0085 grants UPDATE on **two
  columns** — the console may make a task due and clear a stale lease; it may
  not disable a task or rewrite what it last reported, which are the three ways
  a console account could make a compliance job stop while the row still looks
  healthy.
- `task_run` was missing from `TABLE_TEARDOWN_ORDER`, and it failed the platform
  console's suite. The state doc records this exact lesson from M28; it was
  missed again anyway, which is an argument for the guard being a test rather
  than a sentence.

### The mutation pass, and seven survivors

Twenty-eight mutations. Seven survived, and the first pass was worse than that:
several apparent kills were one test failing on a `ghost.job` row a previous
mutation's aborted run had left behind — the same residue problem as M30.1,
found the same way, and fixed the same way.

The survivors worth naming:

- **A test that passed for the wrong reason.** Putting the retention purge back
  through `withTenant` broke nothing, because the test handed the job a scope
  with an ORG_OWNER actor in it. A job never gets one. The suite now has an
  `asJob()` scope — tenant, no actor — and every job assertion uses it.
- **An isolation test that proved nothing.** The neighbouring school had a loose
  file nothing pointed at, so an unfiltered purge would not have touched it
  either. It now has a full rejected-applicant fixture.
- **`SKIP LOCKED`**, which is a liveness property: without it the loser blocks,
  the winner commits, and the loser finds the same nothing. Closed by holding
  the row lock open in another transaction and setting `lock_timeout`, so
  waiting is fatal rather than merely slow.
- **The seal's batch limit and its resume point**, neither exercised until a
  test gave a school sixty days of backlog.
- **Two of the retention purge's three tenant predicates cannot be killed
  individually**, because the first one stops the other two ever firing. They
  stay, and the source says why: the failure they guard is an irreversible
  fleet-wide deletion of children's documents, and a redundant WHERE clause
  costs nothing. Same reasoning as 0080's tenant clause, recorded the same way.

## M34 — what the code says and nothing does

M33 ended with a note: it existed because I went looking for unblocked work
rather than trusting the list of remaining milestones, and that search found a
dated outage. So the next thing to do was the search itself, properly and once —
a sweep for everything this codebase declares and nothing uses.

It found more than M33 did.

| ID | Sub-milestone | Status | What shipped |
| --- | --- | --- | --- |
| M34.1 | The sweep, as a test | Done | `reachability.spec.ts` — every service method nothing calls, listed with a reason, in both directions |
| M34.2 | Attendance can be finished, locked and corrected | Done | The correction workflow had no surface at all |
| M34.3 | The information somebody needs in ten seconds | Done | A child's allergies could not be read from anywhere in the product |
| M34.4 | A feature that could be seen and not changed | Done | `brandingService.set` shipped in M19 with no caller |

**Sixty-four service methods had no caller anywhere in `src/`.** Not obscure
helpers: whole workflows, with tests, that no part of the product could reach.

### The correction workflow, which nothing could complete

`attendance_correction` has carried a `pending` status since 0021 and an index
built for a query nobody had written. Every late offline sync into a locked
session creates one of those rows — the service does that itself, and has since
M6 — and **nothing could list them and nothing could decide them.** They
accumulated for ever and the learner's attendance stayed wrong.

`rejection_reason` had a CHECK constraint requiring it since 0021 and had never
been written by any code at all, because there was no reject path. There is now,
and a refusal has to say why: it is what the next request has to answer.

`lockSession` had no caller either. Locking is what makes a correction necessary
rather than an edit, and AC-5's entire conflict model is written in terms of
locked sessions — which no school could create.

### A child's allergies

`peopleRepository.findStudentSensitive` reads a blood group, a medical note,
accommodations and an emergency contact. It does it properly: on a separate
database role whose column grants are narrower than the application role's,
under the same row-level security, and it writes an audit row **whether or not
it returned anything**, because a refused attempt on a medical note is exactly
as interesting as a successful one.

Nothing could call it. The whole of `peopleRepository` has no caller — the
directory controller writes its own SQL, and that SQL returns a name, an
admission number and a date of birth. A teacher standing over a child who had
collapsed had nothing to read.

It is a separate route rather than extra columns on the learner read, and that
is the design: a sensitive field that rides along with an ordinary read ends up
in a CSV export, a log line and a support screenshot — and makes every read look
like somebody asking for a medical note, which ruins the audit trail for
spotting one who was.

### The guard the sweep left behind

M32 found services with no route. M33 found functions with no scheduled caller.
Both were found by looking, and neither left anything behind that would notice
the next one. `reachability.spec.ts` does:

- it walks every `xService` / `xRepository` and finds the methods nothing calls;
- each one must appear in a list **with a reason**, grouped by the kind of debt
  it is — "waiting on a payment provider" and "shipped without a write surface"
  are different problems and only one of them is anybody's fault;
- a method that becomes unreachable and is not listed fails the suite;
- **a method that is listed and has since been wired also fails it**, so the
  list cannot rot into a page of stale apologies. That direction caught
  `brandingService.set` within a minute of it getting a route.

It does not fail on the number being large. Sixty-odd methods are unreachable
and most are somebody's afternoon. What it refuses is the number growing
quietly, which is how all sixty got there.

### And a hole in M30's guard, found by the same sweep

`requestCorrection` read `SELECT state FROM attendance_record WHERE id = $1` —
no month, so it scanned every partition the school had ever had. M30.3's static
check exists precisely to catch that and did not, because the query is in a
**single-quoted string** and the check only scanned template literals. Its own
comment said template literals were "how every query in this codebase is
written". They were not.

Both are fixed: the query names its month, and the check reads quoted strings
too. A mutation restoring the old query now fails it.

### The mutation pass, and five survivors — three of one shape

Twelve mutations, five survived, and three of them were the same mistake M32
already recorded:

- **A zod rule shadowing the service's own.** The reject route's `min(1)` refused
  an empty reason before `rejectCorrection` could, so deleting the service's
  check broke nothing. Same for the branding colour: a `.max(7)` on the request
  body meant `brandingService.set`'s HEX check — the one with the message and
  the anchors that stop `#fff; background:url(...)` — was unreachable from HTTP.
  The bound is now wide enough that the service answers, and the tests send
  whitespace and `navy`, which reach it.
- **A decision that could be taken twice.** Nothing tried rejecting an
  already-rejected correction, which would have overwritten the reason — the
  evidence of what the school actually said.
- **Two mutations of the guard itself survived**, because the real codebase and
  the list agree, so emptying either filter changes nothing. Closed by pulling
  the comparison into a function and testing it against synthetic disagreements
  in both directions — the third time this exact fix has been needed (M29.2's
  catalogue audit, M30.3's month check, and now this).

## The rest of the plan (M20–M31)

The first nineteen milestones were a plan that ran out rather than a plan that finished.
What follows is the honest remainder: everything named as a gap, everything sold but not
built, and the work between a system that runs on a laptop and one a school can rely on.

**Three of these are not optional in the way the others are.** Nothing is deployed
anywhere; three modules are gated by plan flags that already exist and have nothing behind
them; and money does not move. Those come first, and the ordering below says why.

### The integrity debt, first

M16 shipped feature flags for `transport`, `hr` and `lms`. The gates work. The modules do
not exist. That is the wrong order to have built things in — a flag that guards nothing is
a promise on a pricing page — so it is paid off before anything new is added.

| ID | Milestone | Definition of done |
| --- | --- | --- |
| M20 | Transport — **done, see above** | Routes, stops, vehicles, drivers, and which child is on which bus today. A driver sees the children on **their** route and nothing else; a guardian sees their own child's bus and no other family's. Boarding is attendance, with the same offline queue and the same conflict rules |
| M27 | HR — **done, see above** | Staff lifecycle beyond a `staff` row: contracts, leave balances, and the **relief cover** that attendance has never been able to express. Payroll *inputs*, not payroll — running payroll is a compliance surface of its own and guessing at it would be worse than omitting it |
| M28 | Learning — **done, see above** | Lessons, assignments, submissions, and marks that flow into the assessment module rather than beside it |

### The pilot set

The smallest set that lets one real school use this in anger. Everything after it can
follow real usage instead of guesses.

| ID | Milestone | Definition of done |
| --- | --- | --- |
| M21 | The parent app — **done, see above** | The mobile app stops being one screen. Attendance, fees, results and messages for a guardian's own children, readable offline. This is where parents actually live, and today they have nothing |
| M22 | Deployed, reproducibly — **schema guard done, rest blocked** | Infrastructure as code for the AWS India region, two environments, secrets that are not in a repository, migrations that run as part of a deploy, and a rollback that has been performed rather than described |
| M23 | Observability — **done, see above** | Structured logs with a request id that survives across services, metrics, traces, and alerts that fire on the things that would actually hurt — failed migrations, auth error rates, webhook backlog, queue depth |
| M24 | Backup and restore — **partly done, see above** | Point-in-time recovery, and a **restore drill that has actually been run** with the time it took written down. A backup nobody has restored is a belief, not a backup |
| M25 | Taking money from schools — **invoicing done, see above** | Subscription invoicing against M16's plans, GST, and one payment provider. M16 deliberately stopped short of this; a metered plan nobody is billed for is a spreadsheet |
| M26 | Taking money from parents | A real gateway behind M7's mandates and reconciliation — UPI AutoPay and cards. The ledger, the receipts and the settlement matching already exist and have never seen a live rupee |
| M34 | What the code says and nothing does — **done, see above** | A sweep for everything declared and unused. Sixty-four service methods had no caller; the attendance correction workflow and a child's medical note were among them |
| M33 | The jobs nobody was running — **done, see above** | A scheduler, and callers for four functions whose comments described a job that did not exist. One of them was three months from silently losing every audit record |
| M30 | Scale, where it is real — **done, see above** | `attendance_record` partitioned by month, the rate limiter moved into Redis, and a budget that caught every read still scanning every month |
| M29 | It speaks the language — **done, see above** | The chain, the catalogue and the settings that set both. `organization.locale` had existed since M1 and nothing had ever read it, which meant a school that does not operate in English could not send messages at all |

### Everything else named as a gap

| ID | Milestone | Definition of done |
| --- | --- | --- |
| M31 | Fit to be trusted | A security review by somebody who did not write this, a DPDP assessment by a lawyer, and a pilot with one real school. The pilot will find more than the other two |

### What is deliberately NOT on this list

- **Payroll.** Statutory deductions, PF, ESI and TDS are a compliance product, not a
  feature. M27 produces the inputs and stops.
- **A general report builder.** Every school wants one and every one of them wants a
  different one. The `advanced_reports` flag stays unbuilt until real schools have asked
  for the same report three times.
- **Biometric and RFID attendance.** Hardware integrations are a support burden that scales
  with the number of vendors, not the number of schools.
- **An AI anything.** There is no question a school has asked that this product answers
  better with a model in it, and adding one to a system holding children's records needs a
  reason better than the current fashion.

### Honest sizing

Eleven milestones after M19, of which M22, M23 and M24 are a single piece of work in three
parts and should be done together. The pilot set — M21, M22, M25, M26 — is what stands
between this and a school using it for real. Every milestone so far has found defects that
changed what the next one needed, and a pilot will reorder everything below M26.

## Build order and why

Tenancy before everything, because isolation cannot be retrofitted. Identity and audit next,
because every later table needs an actor. People before academics, because the guardian model
is the schema decision the product is built around. **The import pipeline lands in M9 but its
canonical CSV schema is fixed in M3** — onboarding cost decides unit economics, so it is not
left to the end.


---

## Progress

| Milestone | Status | Tests | Notes |
| --- | --- | --- | --- |
| M1 Tenancy and RLS | Done | 17 | 6 mutations verified |
| M2 Identity, RBAC, audit | Done | 60 | 8 mutations verified; closed a partition-RLS leak |
| M3 People and guardians | Done | 26 | 10 mutations verified; M3.7 closed in M12 |
| M4 Academic structure | Done | 24 | 8 mutations verified; AC-3 proven by row hashes |
| M5 Admissions and enrollment | Done | 52 | 13 mutations verified; tenant schemas treated as untrusted |
| M6 Attendance and offline | Done | 32 | 11 mutations verified; AC-5 complete, six conflict paths |
| M7 Money | Done | 59 | 24 mutations verified; 3 real defects found (see below) |
| M8 Assessment | Done | 45 | 24 mutations verified; 1 real defect, 6 weak tests found |
| M9 Communication | Done | 119 | M9.1–M9.8 (AC-8, AC-9, AC-2, AC-10) |
| M10 Surface | Done | — | HTTP API + web app; the product runs locally |
| M11 Contract | Done | 9 | 8 mutations verified; spec generated from the handlers, not hand-written |
| M12 Carried-over scope | Done | 10 | 8 mutations verified; closed M3.7, narrowed teachers, ended DNS rebinding |
| M13 The rest of the surface | Done | — | Screens for results, messages and imports; three finished milestones made visible |
| M14 Platform and provisioning | Done | 16 | 7 mutations verified; a school can be onboarded without a DBA, by a role that cannot read inside one |
| M15 Super admin console | Done | 33 | 12 mutations verified; 2 real defects found (the console had no login; a read-only session could write) |
| M16 Plans and entitlements | Done | 40 | 20 mutations verified; 4 real defects found, plus a parallel implementation reconciled |
| M20 Transport | Done | 111 | 27 mutations verified; 1 severe visibility defect, 1 test passing for the wrong reason, 3 defects outside transport, 1 comment describing an impossible bug |
| M21 Parent app | Done | 84 | 26 mutations verified; a policy pair that recursed for everyone, 4 tests weaker than they looked, 1 comment borrowing a hazard |
| M23 Observability | Done | 39 | 12 mutations verified; an interceptor blind to guard refusals, and a backlog gauge reporting a confident zero |
| M24 Backup and restore | Partly | drill | 4 damaged restores tried, 3 caught — the 4th found a drill that could not fail. PITR still missing |
| M25 Invoicing schools | Mostly | 41 | 8 mutations verified; unequal tax halves caught by a CHECK constraint, three tables caught by the M1 RLS invariant, one float right almost always. Payment provider not done |
| M27 HR and relief cover | Done | 28 | 8 mutations verified; closed a limitation attendance had carried since M6. 2 survivors: a check whose value is its message, and an untested half day |
| M22 Deploy safety | Partly | 16 | 5 mutations verified. The container stack has now been BUILT AND RUN on a real Docker daemon — .dockerignore was in the wrong directory, and the migration runner blamed a migration for a database whose history did not match it. AWS still absent |
| M32 The write surface | Done | 68 | Over real HTTP. 19 mutations, none survived. 13 modules made reachable (115 routes → 201), 8 SQL/enum defects only a request could find, 3 author-from-the-body holes closed, 3 comments narrowed to what is true, and one bug only the built server could show |
| M28 Learning | Done | 38 | 14 mutations verified, no survivors. Closed the last M16 flag that guarded nothing. 1 finding outside the milestone (0077: section scope ignored `section_id`, reaching student records, marks, attendance and transport), 1 guard that covered only UPDATE, 1 test proving a different policy than it named |
| M29 It speaks the language | Done | 18 API + 26 mobile | 39 mutations verified, 4 survivors closed and 1 shown to be unclosable. `organization.locale` had been unread since M1, which meant a school not operating in English could not send at all. Migration 0079 closed a write policy that let any principal — a parent included — update the organization row; 0080 records the one clause no test can kill |
| M30 Scale | Done | 30 | 34 mutations verified, 6 survivors closed. `attendance_record` partitioned by month (0081) and the first Redis connection this system has ever opened. The budget test found the partitioning had bought nothing: every read filtered the joined session, not the record. Also caught a declared cascade the database could never perform, and an invariant that would have stopped watching the table it guards |
| M33 The jobs nobody was running | Done | 42 | 28 mutations verified, 7 survivors closed. Four functions documented as having a scheduled caller had none. `ensure_audit_partition` could not be executed by any role that exists, so the "defensive" fallback could not work either and every database was three months from losing audit records. The obvious wiring — `withTenant({ tenantId })` — would have made all three compliance jobs succeed having examined zero rows; the fix for that then made one school's purge delete the whole fleet's documents until three tenant predicates were added |
| M34 What the code says and nothing does | Done | 23 | 12 mutations verified, 5 survivors closed. A method-level sweep found 64 service methods with no caller anywhere: the attendance correction workflow had no surface, `lockSession` had no route, `rejection_reason` had never been written by any code, and a child's medical note could not be read from anywhere in the product. The sweep is now a test that fails in both directions. Also found a hole in M30.3's own guard — it scanned only template literals |

Two design decisions were made during M2 that are worth carrying forward:

- **Two database roles, not one.** `paathshala_auth` reaches credentials and nothing else;
  `paathshala_app` reaches tenant data and cannot read a password hash. Both are asserted at
  boot. Every table added from here chooses which role, if either, may touch it.
- **Sealed-period digests over a per-row hash chain.** Chaining every audit insert would
  serialise writes on the busiest table in the system. The digest is computed per period by a
  scheduled job, and still breaks visibly if a sealed row is altered.

- **Guardian scoping is RLS, not a repository convention.** The recursion limit on policy
  expressions forced two structures worth keeping: `tenant_principal` as a trigger-maintained
  projection, and staff scope derived from `role_grant` rather than a caller-supplied flag so
  the failure mode is closed rather than open. Every table added from here that a guardian
  might touch gets the same treatment.
- **An API client is a principal, not a borrowed person.** A key acts as itself, so
  `app_actor_has_staff_scope()` and `app_actor_has_finance_scope()` each grew a machine
  branch that is disjoint from the human one — when no client is in scope both evaluate
  exactly the expression they did before. `app_actor_has_integration_scope()` deliberately
  has NO machine branch: a credential that can mint credentials or redirect the event
  stream can escalate itself. Every table added from here that a key might read inherits
  this for free; every table that manages integrations must stay on integration scope.
- **Secrets live where the application role cannot read them.** API key hashes are in
  their own table with no grant to `paathshala_app`; webhook signing secrets are columns
  the app role has no privilege on, and signing happens via a SECURITY DEFINER function.
  A star-select on either raises permission denied rather than putting a key in a log.
- **An admin console is where a god mode gets built.** The platform role creates schools
  and lists them, and holds no grant on anything inside one — so reaching for a learner
  raises `permission denied` rather than returning an empty set. Support access to a
  tenant's records stays what M2 made it: time-boxed, two-person, audited impersonation.
  Any future platform feature that "just needs a count" from inside a school is a request
  to undo this.
- **Most exposure is internal.** Both M12 gaps sat behind a green isolation suite for ten
  milestones, because neither crossed a tenant boundary. A teacher reading the whole
  school and any staff role reading a medical note are the failures a school would
  actually notice, and no amount of cross-tenant testing would have found either.
- **One rule, one place.** Where two policies need the same predicate they call the same
  function. Written twice, they diverged within three migrations — and the divergence
  presented as a parent being unable to read their own child's record, not as a leak.
- **The API contract is generated from the code that enforces it.** A hand-written spec is
  correct the day it is written and wrong within a sprint, and a wrong spec is worse than
  none — an integrator trusts it, builds against it, and finds the difference in
  production. The spec is built from the same Zod schemas the handlers validate with, and
  tests compare it against the routes Nest actually registers and the scopes the guard
  actually enforces. Any endpoint added from here is documented or the suite names it.
- **Onboarding progress is derived, never stored.** There is no checklist table. Each
  step asks whether the thing exists, every load. A stored tick saying "fees configured"
  while no fee plan exists is worse than no checklist, because an onboarding page that
  lies teaches people to skip onboarding. Any step added later follows the same rule.
- **A support thread is append-only, and internal notes are filtered by POLICY.** Not by a
  `WHERE` clause: a note rendered to a parent cannot be recalled, and the application is
  the wrong place to hold that line.
- **Test fixtures purge their own namespace before running.** An interrupted run used to leave
  duplicate-key debris that made a later run report "26 skipped", which reads like success at a
  glance. Each spec now clears its own email domain in `beforeAll`.
- **Timetable integrity is GiST exclusion constraints, not application checks.** Two admins
  editing in parallel both read "free" and both write; only the database can refuse the second.
  The constraints are scoped by academic year, which is what stopped an open-ended prior-year
  slot from colliding with the rolled-over timetable.
- **Rollover copies and never mutates.** Asserted with row content hashes rather than by reading
  names back, so "was this touched" is answerable exactly. Every milestone that adds a
  year-scoped table inherits this rule.
- **Test teardown is complete, not minimal.** A teardown that misses a table fails in `afterAll`,
  which vitest reports as a failed *suite* while still printing "127 passed" — a test-suite bug
  that reads like a pass. `TABLE_TEARDOWN_ORDER` in `fixtures.ts` must gain every new
  tenant-scoped table.
- **Append-only tables take no foreign keys with referential actions.** `ON DELETE SET NULL` is
  an UPDATE and the append-only trigger refuses it; `NO ACTION` makes the referenced row
  undeletable. Historical tables keep the id verbatim, as `audit_log` always has.
- **Tenant-authored config is untrusted input.** A JSON Schema an institute writes gets a
  whitelist pass before storage — keywords, formats, depth, field count, and a nested-quantifier
  check. Every configurable surface added later inherits that rule.
- **A mutation that changes nothing is a finding, not a pass.** Dropping the `client_event_id`
  index left every test green; chasing why exposed a non-deterministic lookup that could have
  silently attributed one learner's attendance to another. Investigate every green mutation.
- **The offline client is dependency-free.** Storage and transport are injected, so conflict
  behaviour is unit-testable in Node rather than only on a device. Every later offline surface
  (marks entry in M8) reuses this shape.


## M7 findings

Three defects the mutation pass turned up, all of which would have reached production:

1. **Numeric scale.** `sum(amount + amount * tax_rate / 100)` returns 20 decimal places,
   because Postgres expands the scale on numeric division. The money parser refused it,
   which is the right failure — but the fix is to round PER LINE, not on the total: the line
   tax is the figure that goes on a tax return, and rounding the total instead is off by a
   paise whenever a line's tax ends in half a paise.
2. **Allocation ignored its target.** A counter receipt written against one invoice settled
   whichever invoice was oldest. The test only failed when the whole file ran — in isolation
   there was no older invoice. `payment.target_invoice_id` now records intent, allocation
   honours it first, and the column is frozen with the amount.
3. **"Finance" meant "staff".** 0027's own header said teachers cannot see money; its
   policies said `app_actor_has_staff_scope()`, which includes TEACHER. A teacher listing
   invoices got seven rows. 0029 introduces `app_actor_has_finance_scope()`.

Three mutations initially escaped, each exposing a weak test rather than a weak system:

- Removing the service-level ledger balance assertion changed nothing, because the test
  matched `/does not balance/` — which the deferred database trigger also says. The test now
  matches the source type, which only the service names.
- Rounding tax on the total rather than per line changed nothing, because every fixture had
  a zero tax rate. There is now a plan with two lines at 5% that differ by a paise.
- Inverting Tally's debit sign changed nothing, because the groups balance and so the COUNT
  of negative amounts is identical either way. Each entry is now checked against its own
  side.

The standing rule holds: **a mutation that changes nothing is a finding, not a pass.**


## M8 findings

One defect, found before any test ran:

**The scale-coverage check could never return true.** `grading_scale_is_covered()` cast
`range_agg`'s result back to a single `numrange` to test for a hole. Since Postgres 14,
`range_agg` returns a MULTIRANGE, whose text form is braced (`{[0,100)}`), so the cast raised
`malformed range literal` for a contiguous scale exactly as it did for a gapped one — and the
`EXCEPTION` handler turned both into `false`. Every grading scale would have been
unpublishable, with an error that read like a data problem. Migration 0031 uses multirange
containment instead, which says what is meant.

Six mutations escaped on the first pass, every one a weak test rather than a weak system:

- Two `compute()` guards (assessments not locked, scale not published) could both be deleted
  with the suite still green, because both tests asserted only `status: 409` — and several
  *different* refusals in `compute()` are 409. The tests now assert the error code.
- Weights-must-total-100 was never exercised: every fixture happened to sum to 100 or failed
  an earlier check first.
- A learner with **no mark row at all** was never tested. That case is meaningfully different
  from an absence — nobody recorded anything — and the difference is a learner failing a
  subject the office simply forgot.
- Correcting a *draft* report card was unguarded by any test, which would have recorded a card
  as superseded that no family ever received.
- The `mark_is_exactly_one_thing` CHECK could be dropped with nothing failing, because the
  service rejects that shape first. The service is not the only thing that will ever write to
  `mark`, so the rule is now tested at the table.

The standing rule keeps paying: **a mutation that changes nothing is a finding, not a pass.**


## M9.1–M9.3 findings

No defect in the code this time. Two mutations escaped, both weak tests:

- Dropping the `message_recipient_suppressed_has_reason` CHECK changed nothing, because the
  dispatcher always supplies a reason. The dispatcher is not the only thing that will ever
  write there, and "we suppressed it" without "why" is the record that cannot answer a
  regulator — so the rule is now tested at the table, in both directions.
- Widening the recipient read policy to the whole tenant changed nothing, because the fixture
  had exactly one guardian. A test that cannot tell "sees their own" from "sees everything" is
  not testing a policy. There is now a second parent with a message of their own.


## M9.4–M9.5 findings

**One real defect, in code written eight milestones ago.** The import reversal is the first
path in the product that deletes a `person`, and it failed with `permission denied for table
tenant_principal`. The projection trigger from 0012 writes to that table, but the app role
holds only SELECT on it — deliberately, because `app_current_person_id()` reads it and a
writable projection is a writable answer to "who am I". An INSERT happened to work, because a
person created by the app has no `user_account_id` and so takes no branch that writes; a DELETE
always runs its `DELETE FROM tenant_principal` and fails whether or not a row matches. Migration
0038 makes the trigger `SECURITY DEFINER` with a pinned `search_path` rather than granting the
app write access.

**One mutation escaped, and the right fix was to delete code.** The plan digest had an extra
term listing the existing keys the plan was matched against. No mutation could make it matter —
`matchedId` already encodes the same fact on each row's line. Decoration on a
security-relevant hash is worse than nothing, because it reads as coverage it does not provide.
It is gone, with a comment saying why.

**The mutation harness itself had the bug it exists to find.** A run was killed by a timeout
mid-mutation, leaving the mutation in the working tree — and the next backup was taken *from
that tree*, so a later "restore" restored the mutation. Three tests then failed for a reason
that looked like a real defect. The harness now restores on `atexit` and on SIGTERM/SIGINT.
The rule generalises: **a verification tool that can be interrupted must restore on exit, or it
silently becomes the thing it is testing for.**


## M10 — the surface (unplanned, and overdue)

Eight milestones of services had exactly three HTTP controllers between them, so nothing could
be run or looked at. That gap is now closed: a read/write API over the built modules, a demo
seed, and a Next.js web app with sign-in, dashboard, learners, attendance and fees.

Two defects fell out of simply trying to boot it — both invisible to a test suite that calls
services directly:

1. **`pnpm dev` could never have worked.** The API uses Nest decorators;
   `node --experimental-strip-types` only removes types and cannot emit the decorator metadata
   Nest's DI reads at runtime, so the process died at import. An esbuild loader (tsx) got
   further and then failed at the first injected dependency, which is worse — later and less
   legible. Dev now compiles with `tsc --watch` and runs the emitted output, the same code
   production runs.
2. **`section` has no `campus_id`.** Campus is reached through class group → programme →
   academic unit. Two queries written for the dashboard assumed the column existed. A schema
   nobody had queried across modules had never had that assumption tested.

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


The web app is deliberately thin and shows the guarantees rather than describing them: sign in
as the teacher and the fees screen is empty, from the same endpoint and the same SQL as the
principal's. The dashboard checks AC-2 in the browser and says so if the group figures ever stop
matching their campus rows.

Still missing, and worth naming: no refresh-token rotation in the client (a session lasts as
long as the access token), no mobile app, no screens for assessment, messaging or imports, and
`/v1/students` returns the whole school to any staff role rather than a teacher's own sections.


## M10.1 — the interface, properly

The first pass was functional and plain. This pass made it a design system: tokens for every
surface, ink, accent and status step; a selected dark theme rather than an inverted one; a
208px rail that becomes a bottom tab bar under 860px; compact tables that shed columns instead
of scrolling; skeletons instead of the word "Loading"; and a toast instead of an inline banner
that shifts the page.

Three things the redesign found, none of them cosmetic:

1. **Three light-mode text pairs failed WCAG AA** and one failed badly. The green "paid" pill
   measured 3.0:1, because the same hex was doing duty as both the mark colour and the text
   colour. Marks are graphical (3:1); text is text (4.5:1). The tokens now split `--good` from
   `--good-ink`, and every pair in both themes was measured rather than eyeballed.
2. **Stat tiles overflowed on a phone.** Fixed with lakh/crore notation, which is shorter *and*
   what an Indian principal actually reads — with the exact figure kept in the table and on the
   tile's tooltip, so nothing is lost.
3. **The invoice list called everything overdue.** `issued` was painted critical red regardless
   of the due date. It now compares the due date to today, because a bill with three weeks to
   run is not an emergency and colouring it as one teaches people to ignore the colour.

Verified in a real browser at 320, 360, 390, 834 and 1280px, in both themes, as three
different roles: no horizontal page overflow anywhere, no console errors.
