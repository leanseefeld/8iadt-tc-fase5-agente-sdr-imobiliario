---

description: "Task list for authentication and the app shell"
---

# Tasks: Authentication and App Shell

**Input**: Design documents from `/specs/003-auth-app-shell/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [contracts/](contracts/), [data-model.md](data-model.md), [quickstart.md](quickstart.md)

**Tests**: Included. `core/auth.ts` is pure and unit-tested with no database;
`services/auth.ts`'s database-touching cases (`login`, `reassignLead`) run
under `INTEGRATION=1`, the project's standing convention for DB-backed tests.

**Organization**: By user story, per [spec.md](spec.md). Session signing and
the `AUTH_SECRET` config change live in Foundational because every story
needs a verifiable cookie before it can be tested at all.

**Simplification pass (before implementation)**: spec 002 has merged, so every
"blocked on 002 / write against a stand-in fixture" instruction is gone. The
four separate verification tasks (T013, T015, T020, T021) collapse into one
end-to-end verification task, since they run the same container and the same
login cycle. A test task and its one-line implementation task are merged where
splitting them only produced ceremony (`scopeForUser`). `bcryptjs` was already
added by spec 002's seed, so Setup is empty and gone. The guard file is
`src/proxy.ts`, not `src/middleware.ts` — see [plan.md](plan.md#source-code-repository-root).

## Format: `[ID] [P?] [Story] Description`

`[P]` = different file, no dependency on an incomplete task. `[Story]` = US1–US3 per [spec.md](spec.md). Single project; `src/`, `tests/` at the repository root, per [plan.md](plan.md#source-code-repository-root).

---

## Phase 1: Foundational

**Purpose**: a verifiable session cookie and the `AUTH_SECRET` config gate. Every story below depends on this.

**⚠️ Blocks all user stories.**

- [ ] T001 Write `tests/auth-core.test.ts` — table-driven: sign/verify round-trip preserves the payload; a tampered signature is rejected; an `expiresAt` in the past is rejected; a payload missing `userId`, `agencyId` or `role` is rejected
- [ ] T002 Implement `src/core/auth.ts`: async `sign()`/`verify()` over `globalThis.crypto.subtle` HMAC-SHA256, async `getSession()`, `clearSessionCookie()`, and the `session` cookie constants (`httpOnly`, `sameSite=lax`, `secure` outside development, 7-day `maxAge`) — per [contracts/session-cookie.md](contracts/session-cookie.md) (satisfies T001)
- [ ] T003 Move `AUTH_SECRET` from optional to required in `src/core/config.ts` (drop `.optional()`, add to `REQUIRED_KEYS`), update `tests/config.test.ts` (add it to the `valid` fixture, drop it from the "optional keys" list) and the `.env.example` comment — one commit, Environment Contract gate (spec 001)

**Checkpoint**: `core/auth.ts` signs and verifies; `AUTH_SECRET`'s absence stops boot.

---

## Phase 2: User Story 3 — Role scoping and reassignment (P2)

**Goal / Independent Test**: `scopeForUser()` and `reassignLead()` are correct
and reusable by specs 005/006. Ordered before the UI because the login the
shell calls lives in the same file.

- [ ] T004 [US3] Implement `login(email, password, sourceIp)` in `src/services/auth.ts`: look up the `users` row by e-mail, `bcrypt.compare` against `passwordHash`, return the session payload or `null` — indistinguishable outcome between "no such user" and "wrong password" (FR-002); on `null`, log at `warn` with the attempted e-mail and `sourceIp`, never the password (FR-016)
- [ ] T005 [US3] Implement `scopeForUser(session)` and `reassignLead(session, leadId, newBrokerId)` in `src/services/auth.ts` per [contracts/scope-for-user.md](contracts/scope-for-user.md): scoping is a pure `{ agencyId, defaultOwnLeadsOnly }`; reassignment rejects a non-`salesManager` session, validates the target is a same-agency `broker`, writes `leads.assignedBrokerId` and records the `lead.reassigned` event itself
- [ ] T006 [US3] Write `tests/auth-service.test.ts`: `scopeForUser` unit cases run always; `login` and `reassignLead` cases run under `INTEGRATION=1` against the seeded users and leads, per [quickstart.md](quickstart.md) step 3

**Checkpoint**: the scoping rule later specs depend on is implemented and tested.

---

## Phase 3: User Story 1 — A seeded user logs in and uses the shell (P1) 🎯 MVP

**Goal / Independent Test**: submit `ana@demo.com.br` / `demo1234` at `/login`, confirm redirect to `/leads` with the top bar populated; "sair" ends the session.

- [ ] T007 [US1] Define the shared palette in `src/app/globals.css` and point `src/app/(app)/catalogo/catalogo.module.css` at it — the shell and the login screen must not invent a second set of colours
- [ ] T008 [US1] Implement `src/app/login/actions.ts`: `loginAction` reads the source IP, calls `login()`, signs and sets the cookie via `core/auth.ts`, logs the login with the new `userId`, redirects to `/leads`; returns the one generic pt-BR failure message otherwise (FR-002, FR-018)
- [ ] T009 [US1] Implement `src/app/login/page.tsx` + its CSS Module: e-mail (autofocused) and password (visibility toggle) fields, one primary button, inline generic error, pt-BR, no sign-up or reset controls; redirect to `/leads` when `getSession()` is already valid (FR-005, FR-007)
- [ ] T010 [US1] Implement `src/app/(app)/layout.tsx` + its CSS Module: top bar with product name, nav to Leads/Agenda/Catálogo with the current section visibly selected, the user's name and a role badge ("corretor"/"gerente comercial"), and "sair" as a secondary control calling a `logoutAction` that logs the logout with the session's `userId`, clears the cookie, then redirects to `/login` (FR-013, FR-018)
- [ ] T011 [P] [US1] Implement placeholder pages `src/app/(app)/leads/page.tsx` and `src/app/(app)/agenda/page.tsx` — one static pt-BR line each (FR-014)
- [ ] T012 [US1] Confirm `/catalogo` renders unchanged inside the shell — it moves under the guard by virtue of the route group, not by a rewrite (FR-015)

**Checkpoint**: a seeded user can log in, see the shell, and log out. Nothing guards the routes yet.

---

## Phase 4: User Story 2 — Unauthenticated visitors are kept out (P1)

**Goal / Independent Test**: with no cookie, request `/leads`, `/agenda`, `/catalogo` — each redirects to `/login`; the public chat responds normally.

- [ ] T013 [US2] Implement `src/proxy.ts`: matcher on `/leads/:path*`, `/agenda/:path*`, `/catalogo/:path*`; `await`s `core/auth.ts`'s `verify()` on the `session` cookie, redirects to `/login` on `null`, passes through otherwise; logs nothing that would carry a `userId` it does not have (FR-008, FR-009, FR-018)

**Checkpoint**: US1 + US2 together are the deployable MVP — login, shell, and enforcement.

---

## Phase 5: Verification

- [ ] T014 Run the suites and the lint zone inside the container: `npm test`, `INTEGRATION=1 npm test`, `npm run lint` — the last confirms no `app/**` file imports `db/` or `drizzle-orm` directly
- [ ] T015 Run [quickstart.md](quickstart.md) end to end with `curl`: login sets the cookie and reaches `/leads` (SC-001); wrong password and unknown e-mail give byte-identical text (SC-005); `/catalogo` renders inside the shell; "sair" then `/leads` redirects to `/login` (SC-007); a tampered and an absent cookie both redirect (SC-002); the public chat path is untouched by the guard (SC-003); log lines carry `userId` only where FR-018 requires it (SC-008)
- [ ] T016 Confirm `AUTH_SECRET` removal stops the worker within 10 s naming the variable (SC-009), and that `docker build --target build .` still type-checks

---

## Dependencies & Execution Order

Foundational → US3 → US1 → US2 → Verification.

- **US3 before US1** only because `login()` shares `services/auth.ts` with the
  scoping helpers; by spec priority US1 is first and US3 could follow the UI.
- **US2 needs US1's `/login`** to have somewhere to redirect to.

## Notes

- Solo project: `[P]` means "no ordering constraint," not "assign to someone else"
- If a task needs a decision listed in `docs/decisoes-pendentes.md`, stop
