# Implementation Plan: Authentication and App Shell

**Branch**: `003-auth-app-shell` | **Date**: 2026-09-05 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/003-auth-app-shell/spec.md`

## Summary

A hand-rolled, stateless session: an HMAC-SHA256-signed cookie over
`AUTH_SECRET`, verified by one Next.js middleware guard in front of the
`(app)` route group. `services/auth.ts` owns `login()`, `scopeForUser()` and
`reassignLead()`; `core/auth.ts` owns signing, verification and
`getSession()`. The authenticated shell — top bar, nav, `/leads`, `/agenda`,
`/catalogo` — is the only new UI. No Auth.js, no session table, no new
runtime service (ADR 12). No login rate limit (ADR 19): only the
failed-login `warn` log line remains.

`research.md` is not produced, following the precedent set by spec 001: every
technology choice here is already fixed by the constitution, ADR 10–12, and
`modelo-de-dados.md`, so there is no unknown to resolve — the rationale for
each choice is inline below, where the decision lives.

### Spec amendment agreed before planning

| ID | Change | Reason |
|---|---|---|
| FR-018, SC-008 | Narrowed from "every log line for an authenticated request" to "every log line this slice's own code emits." | Full per-request correlation needs `AsyncLocalStorage`, which spec 001 explicitly deferred to item 4 ("lands in item 4 with the first real entry points"). Retrofitting it here to satisfy a broader claim would duplicate that work instead of building on it. |

## Technical Context

**Language/Version**: TypeScript 5.x `strict`, Node 24, unchanged from spec 001.

**Primary Dependencies**: `bcryptjs` 3.0.3 (password comparison only — spec 002
owns hashing at seed time) — new. Everything else already in `package.json`:
`zod` for config, Next.js middleware and Server Actions for the guard and
forms, and Web Crypto's `globalThis.crypto.subtle.sign`/`.verify` (both
`Promise`-returning) for HMAC-SHA256 — chosen over `node:crypto`'s
synchronous `createHmac` because Next.js middleware may run on the edge
runtime, which has Web Crypto but not `node:crypto`; one primitive in
`core/auth.ts` serves both the middleware and the Node-side services.

**Storage**: PostgreSQL via spec 002's `users` and `leads` tables (consumed,
not owned). No new table — a session is a cookie, not a row.

**Testing**: `node:test`, unchanged. `core/auth.ts` (sign/verify round-trip,
tamper and expiry rejection) is pure and unit-tested with no database.
`services/auth.ts`'s `login()` and `scopeForUser()` need spec 002's schema and
seed, so those cases run as integration tests inside the container, gated by
`INTEGRATION=1` per the existing convention.

**Target Platform**: unchanged — Linux containers via `docker compose up`.

**Project Type**: Modular monolith, unchanged.

**Performance Goals**: guard adds one cookie verification per request —
sub-millisecond, no I/O. `getSession()` never queries the database.

**Constraints**: no session store, no Redis (constitution). No login rate
limit (ADR 19) — the per-session message budget on the chat side is the
abuse-resistance mechanism this POC relies on; login keeps only the
failed-login `warn` log line.

**Scale/Scope**: ~7 new source files, ~100 lines across `core/auth.ts` and
`services/auth.ts` combined, plus the shell UI (layout, three pages, login
form).

## Constitution Check

*GATE: passed before Phase 0. Re-checked after Phase 1 — result at the end.*

| # | Principle | How this slice satisfies it | Verified by |
|---|---|---|---|
| I | Document Authority | Cites `docs/` and ADR 12 only; `reference/` used only for the login screen's minimalism, already load-bearing in ADR 12. | Inspection |
| II | Language Boundaries | Code and this plan in English; login copy and role badge text in pt-BR. | Inspection |
| III | Modular Monolith | No process-local state — the login rate limit (the one exception this plan used to carry) is dropped per ADR 19. | Inspection |
| IV | One Data Path | `services/auth.ts` is the only module touching `users`/`leads` for this slice; the middleware and layout call `core/auth.ts` and `services/`, never `db/`. | ESLint zone (existing) |
| V | Deterministic Slot Machine | Not applicable — no agent in this slice. | — |
| VI | Provider Independence | Not applicable — no model call in this slice. | — |
| VII | Observability | Not applicable — no LLM call. Failed logins use the existing structured logger, not Langfuse. | Inspection |
| VIII | Privacy and PII | Password never logged (FR-016). `userId` in log lines is an identifier, not PII, per the existing masking rule's scope. | FR-016, FR-018 |
| IX | Resilience | Guard fails closed (edge case). Login is a plain form post with a bounded, synchronous check — no timeout/retry surface to add. | Edge Cases |
| X | User Experience Discipline | Login screen and the shell's top bar each get a who/what/how paragraph below, written before their tasks, per the constitution's amendment (ADR 18). | Screen Intent below |

### Screen Intent (Principle X)

**Login screen.** Who: a broker on a phone, between viewings, coming back to
check a lead. What they came to do: get past the form in one try. The
interaction to optimise: the e-mail field is autofocused so typing starts
immediately with no extra tap; the password field carries a visible-toggle
instead of a second confirm field, since a phone keyboard makes typos easy to
miss; one primary button ("Entrar"); a wrong attempt shows its message inline
next to the form, not in a toast that can scroll away before it is read.

**Shell top bar.** Who: any authenticated user — broker or sales manager —
moving between Leads, Agenda and Catálogo mid-task. What they came to do:
know where they are and get back to work. The interaction to optimise: the
current section is visibly selected in the nav, not just hoverable, so
orientation is immediate on arrival; the user's name and role badge sit
together so identity is legible at a glance; "sair" is a secondary control —
smaller weight, set apart from the nav — because it is rare and its effect
should not compete with the three links used every visit.

### Stack and environment gates

| Gate | Status |
|---|---|
| `npm`, exact versions pinned | Pass — `bcryptjs@3.0.3` only new dependency |
| No Redis, no new runtime service | Pass |
| Environment Contract gate (spec 001) | `AUTH_SECRET` moves from optional to required in `configSchema` and `REQUIRED_KEYS`; `.env.example` already lists it, comment updated; `tests/config.test.ts`'s `valid` fixture and its "optional keys" list, and `tests/env-example.test.ts`, updated in the same commit |

### Post-design re-check

No disclosed exceptions. The one Principle III deviation this plan used to
carry — the in-memory per-IP login attempt counter — no longer exists: the
login rate limit is dropped per ADR 19. No other new violations.

## Project Structure

### Documentation (this feature)

```text
specs/003-auth-app-shell/
├── spec.md
├── plan.md                      # this file
├── data-model.md                # session shape + consumed entities (no new table)
├── quickstart.md                # manual + scripted acceptance run
├── contracts/
│   ├── session-cookie.md        # cookie fields, signing, expiry — what 005/006 can rely on
│   └── scope-for-user.md        # scopeForUser()/reassignLead() signatures and rules
└── tasks.md                     # produced by /speckit-tasks
```

### Source Code (repository root)

```text
src/
├── core/
│   └── auth.ts                  # sign(), verify(), getSession(), cookie constants
├── services/
│   └── auth.ts                  # login(), scopeForUser(), reassignLead()
├── middleware.ts                # guards (app) paths; redirects to /login
├── app/
│   ├── login/
│   │   ├── page.tsx             # form, pt-BR, redirects if already authenticated
│   │   └── actions.ts           # loginAction server action, calls services/auth.ts
│   └── (app)/
│       ├── layout.tsx           # top bar, nav, name + role badge, logoutAction
│       ├── leads/page.tsx       # placeholder
│       ├── agenda/page.tsx      # placeholder
│       └── catalogo/page.tsx    # renders spec 002's catalog screen
tests/
├── auth-core.test.ts            # sign/verify: round-trip, tamper, expiry, malformed
├── auth-service.test.ts         # login, scopeForUser, reassignLead — INTEGRATION=1 for the DB-backed cases
├── config.test.ts               # extended: AUTH_SECRET joins REQUIRED_KEYS
└── env-example.test.ts          # unchanged in shape; passes once .env.example and schema agree
```

**Structure Decision**: matches `docs/arquitetura/visao-geral.md` §3 exactly —
`login/` sits outside both route groups, `(app)` gains its first real pages,
`(public)` is untouched. `middleware.ts` at `src/` root is Next.js's fixed
location for App Router middleware; there is no alternative placement to
choose between.

## Coordination with spec 002 (concurrent)

This slice imports the `users` table and its `broker`/`salesManager` enum
from spec 002's schema module, and renders spec 002's catalog screen inside
`/catalogo`. Both are specified in `modelo-de-dados.md` but neither's exact
export path exists in this branch yet. Tasks that touch either seam are
ordered last and marked blocked-on-002; `services/auth.ts`'s pure logic
(signing, scoping math) is developed and unit-tested against an in-memory
stand-in first, so the slice is not idle while 002 lands.

## Complexity Tracking

No violations. The one entry this table used to carry — an in-memory per-IP
login attempt counter, a Principle III exception — no longer applies: the
login rate limit is dropped per ADR 19.
