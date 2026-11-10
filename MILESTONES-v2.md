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

Web tests 25 → 42, ui-tokens 5. Typecheck and `next build` pass. **Not yet looked at in a
browser**: the session that built this could not start Docker, so nobody has clicked it.
API tests were not run (no Postgres in that session); nothing under `apps/api` changed.

Found on the way: `apps/mobile/test/learning.spec.ts` ("counts anything before midnight
tonight as today") fails when the machine clock is UTC. Pre-existing, not fixed here.

Still to do in M40: move the remaining pages onto `useApiQuery`, the shared data table with
saved views and export, the notification bell.

## Status

| ID | State |
| --- | --- |
| M39 | tokens done; typed client moved to M39.1 |
| M39.1 | not started |
| M40 | part 1 done |
| M42.5, M41, M42 … M52 | not started |
