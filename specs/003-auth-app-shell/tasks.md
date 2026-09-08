---

description: "Task list for authentication and the app shell"
---

# Tasks: Authentication and App Shell

**Input**: Design documents from `/specs/003-auth-app-shell/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [contracts/](contracts/), [data-model.md](data-model.md), [quickstart.md](quickstart.md)

**Tests**: Included. `core/auth.ts` is pure and unit-tested with no database; `services/auth.ts`'s database-touching cases (`login`, `scopeForUser`, `reassignLead`) run under `INTEGRATION=1`, the project's standing convention for slow/DB-backed tests (no prior spec has used it yet — this is its first application).

**Organization**: By user story, per [spec.md](spec.md). Session signing and
the `AUTH_SECRET` config change live in Foundational because every story
needs a verifiable cookie before it can be tested at all.

## Format: `[ID] [P?] [Story] Description`

`[P]` = different file, no dependency on an incomplete task. `[Story]` = US1–US3 per [spec.md](spec.md). Single project; `src/`, `tests/` at the repository root, per [plan.md](plan.md#source-code-repository-root).

---

## Phase 1: Setup

- [ ] T001 Add `bcryptjs@3.0.3` to `package.json` dependencies — the one new dependency this slice introduces, for `bcrypt.compare` in `login()`

---

## Phase 2: Foundational

**Purpose**: a verifiable session cookie and the `AUTH_SECRET` config gate. Every story below depends on this.

**⚠️ Blocks all user stories.**

- [ ] T002 Write `tests/auth-core.test.ts` — table-driven: sign/verify round-trip preserves the payload; a tampered signature is rejected; an `expiresAt` in the past is rejected; a payload missing `userId`, `agencyId` or `role` is rejected
- [ ] T003 Implement `src/core/auth.ts`: async `sign()`/`verify()` over `globalThis.crypto.subtle` HMAC-SHA256, async `getSession()`, sync `clearSessionCookie()`, and the `session` cookie constants (`httpOnly`, `sameSite=lax`, `secure` outside development, 7-day `maxAge`) — signatures per [contracts/session-cookie.md](contracts/session-cookie.md) (satisfies T002)
- [ ] T004 Move `AUTH_SECRET` from optional to required in `src/core/config.ts` — drop `.optional()`, add it to `REQUIRED_KEYS`
- [ ] T005 Update `tests/config.test.ts` in the same commit as T004: add `AUTH_SECRET` to the `valid` fixture, remove it from the "optional keys nothing reads yet" list — `REQUIRED_KEYS`'s existing table-driven loop then covers its rejection cases automatically. Environment Contract gate (spec 001): T004 and T005 must land together.
- [ ] T006 [P] Update the `AUTH_SECRET` comment in `.env.example` to state it is now required; confirm `tests/env-example.test.ts` still passes unmodified

**Checkpoint**: `core/auth.ts` signs and verifies; `AUTH_SECRET`'s absence stops boot.

---

## Phase 3: User Story 1 — A seeded user logs in and uses the shell (P1) 🎯 MVP

**Goal / Independent Test**: submit `ana@demo.com.br` / `demo1234` at `/login`, confirm redirect to `/leads` with the top bar populated; "sair" ends the session.

- [ ] T007 [US1] Implement `login(email, password)` in `src/services/auth.ts`: look up the matching seeded `users` row by e-mail, `bcrypt.compare` against `passwordHash`, return the session payload or `null` — no distinguishable outcome between "no such user" and "wrong password" (FR-002). **Blocked on spec 002's schema module**; write against a local fixture user object until it lands, then swap the import.
- [ ] T008 [US1] Implement `src/app/login/actions.ts`: `loginAction` calls `login()`, signs and sets the cookie via `core/auth.ts` on success, logs the login with the new `userId`, redirects to `/leads`; returns the one generic pt-BR failure message otherwise (FR-002, FR-006, FR-018)
- [ ] T009 [US1] Implement `src/app/login/page.tsx`: e-mail/password form, pt-BR copy, no sign-up or reset controls; if `getSession()` is already valid, redirect to `/leads` before rendering (FR-005, FR-007)
- [ ] T010 [US1] Implement `src/app/(app)/layout.tsx`: top bar with product name, nav to Leads/Agenda/Catálogo, `getSession()`'s name and a role badge ("corretor"/"gerente comercial"), and a `logoutAction` that logs the logout with the session's `userId`, calls `clearSessionCookie()`, then redirects to `/login` (FR-018)
- [ ] T011 [P] [US1] Implement placeholder pages `src/app/(app)/leads/page.tsx` and `src/app/(app)/agenda/page.tsx` — one static pt-BR line each ("em construção")
- [ ] T012 [US1] Implement `src/app/(app)/catalogo/page.tsx` rendering spec 002's catalog screen inside the shell. **Blocked on spec 002's catalog component landing.**
- [ ] T013 [US1] Verify SC-001, SC-005 and SC-007 per [quickstart.md](quickstart.md) steps 1 and 4 — correct login reaches `/leads` with the top bar populated; wrong password and unknown e-mail produce byte-identical failure text; after "sair," the next request to an authenticated page redirects to `/login` with no manual cookie clearing

**Checkpoint**: a seeded user can log in, see the shell, and log out. Nothing guards the routes yet.

---

## Phase 4: User Story 2 — Unauthenticated visitors are kept out (P1)

**Goal / Independent Test**: with no cookie, request `/leads`, `/agenda`, `/catalogo` — each redirects to `/login`; the public chat responds normally.

- [ ] T014 [US2] Implement `src/middleware.ts`: matcher on `/leads/:path*`, `/agenda/:path*`, `/catalogo/:path*`; `await`s `core/auth.ts`'s `verify()` on the `session` cookie, redirects to `/login` on `null`, passes through otherwise; logs the redirect decision with no `userId` when none is known (FR-018 for this file)
- [ ] T015 [US2] Verify SC-002 and SC-003 per [quickstart.md](quickstart.md) step 2 — absent, tampered and expired cookies all redirect; the public chat route is unaffected

**Checkpoint**: US1 + US2 together are the deployable MVP — login, shell, and enforcement.

---

## Phase 5: User Story 3 — Every role sees the whole agency; managers reassign leads (P2)

**Goal / Independent Test**: `scopeForUser()` and `reassignLead()` are correct and reusable by specs 005/006 — apply the scoping helper with each role against the seeded leads; call `reassignLead` as each role.

- [ ] T016 [P] [US3] Write unit tests for `scopeForUser()` in `tests/auth-service.test.ts` — broker and salesManager sessions both produce `{ agencyId, defaultOwnLeadsOnly }`, `true` for broker and `false` for salesManager; no database needed, it is a pure function
- [ ] T017 [US3] Implement `scopeForUser(session)` in `src/services/auth.ts` per [contracts/scope-for-user.md](contracts/scope-for-user.md) (satisfies T016)
- [ ] T018 [US3] Implement `reassignLead(session, leadId, newBrokerId)` in `src/services/auth.ts`: rejects a non-`salesManager` session with no effect; validates the target is a same-agency `broker` before writing `leads.assignedBrokerId`; on success records a `lead.reassigned` event (`actorType: "user"`, `actorUserId = session.userId`, `payload { fromBrokerId, toBrokerId }`) per [contracts/scope-for-user.md](contracts/scope-for-user.md). **Blocked on spec 002's `users`/`leads` schema.**
- [ ] T019 [US3] Write `INTEGRATION=1` cases in `tests/auth-service.test.ts` against the seeded leads: broker/manager scoping both return every agency lead with the documented `defaultOwnLeadsOnly`; `reassignLead` succeeds for a manager (and records the event) and is rejected for a broker (no event), per [quickstart.md](quickstart.md) step 3

**Checkpoint**: the scoping rule later specs depend on is implemented and tested, with no dashboard yet to expose it.

---

## Phase 6: Polish

- [ ] T020 [P] Run `npm run lint` — confirm `src/services/auth.ts` is the only module under this slice importing `users`/`leads`, and no `app/**` file imports `db/` or `drizzle-orm` directly
- [ ] T021 Run [quickstart.md](quickstart.md) steps 5–6 end to end inside the container: `AUTH_SECRET` removal stops both processes naming it within 10 s (SC-009); a full login → authenticated request → logout → anonymous request cycle shows `userId` present only where FR-018 (as amended) requires it (SC-008)
- [ ] T022 Confirm `docker build --target build .` still succeeds — the only type-checking gate, per spec 001's implementation notes

---

## Dependencies & Execution Order

### Phases

Setup → Foundational → US1 → US2 → US3 → Polish.

- **US2 needs US1's login** to have something to guard; `middleware.ts` itself is independent and could be written in parallel, tested only once US1 lands.
- **US3 needs Foundational only** — `scopeForUser` and `reassignLead` share a file with `login()` but not its UI tasks. Ordered after US1/US2 by spec priority, not a hard dependency.
- **T012 and T018 are blocked on spec 002.** Everything else does not wait on it.

### Parallel opportunities

- Foundational: T006 alongside T004/T005
- US1: T011 independent of T007–T010, T012
- US3: T016 alongside T017; T019 after both
- Polish: T020 alongside anything

---

## Implementation Strategy

**MVP is Setup + Foundational + US1 + US2** — the guard is real and a seeded
user can use the shell, the two P1 stories that make this slice worth
merging alone. US3 is worth finishing before specs 005/006 start but blocks
neither.

## Notes

- Solo project: `[P]` means "no ordering constraint," not "assign to someone else"
- Blocked-on-002 tasks: attempt last in their phase; do everything else first if 002 has not merged yet
- If a task needs a decision listed in `docs/decisoes-pendentes.md`, stop
