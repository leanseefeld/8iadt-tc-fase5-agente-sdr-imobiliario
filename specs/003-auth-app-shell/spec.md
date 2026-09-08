# Feature Specification: Authentication and App Shell

**Feature Branch**: `003-auth-app-shell`

**Created**: 2026-09-05

**Status**: Draft

**Input**: User description: "backlog item 3 — authentication and app shell"

Login at `/login`, hand-rolled signed session cookie, a guard on the `(app)`
route group, role scoping for later specs, and the authenticated shell that
`/leads`, `/agenda` and `/catalogo` render inside. Resolves
`docs/decisoes-pendentes.md` decision 2 per ADR 12 (hand-rolled cookie, no
Auth.js). Depends on the `users` table from concurrent spec 002, per
[`modelo-de-dados.md`](../../docs/arquitetura/modelo-de-dados.md). Covers
*Diferencial: segurança · UX*.

## Clarifications

- Q: Return to the originally requested page after login, or a fixed destination? → A: Fixed, always `/leads` — three destinations sit behind the guard; a return-to param is complexity with no demo payoff.
- Q: Does "sair" invalidate the session server-side? → A: No — there is no session store to invalidate; logout overwrites the cookie with an expired one.
- Q: What if a valid-signature cookie names a now-ineligible user? → A: Out of scope — spec 002's seed is static, no deactivation flow exists; the guard checks signature and expiry only.
- Q: Are failed logins logged? → A: Yes, `warn`, attempted e-mail and source IP, never the password, through the existing logging module.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A seeded user logs in and uses the shell (Priority: P1)

A broker or sales manager submits their seeded e-mail and password at `/login`, lands on `/leads` inside the authenticated shell — top bar with product name, nav to Leads/Agenda/Catálogo, their name and role badge — and can "sair" to end the session.

**Why this priority**: the slice's reason to exist; every later spec renders inside this shell.

**Independent Test**: with spec 002's seed applied, submit `ana@demo.com.br` / `demo1234`, confirm redirect to `/leads` with the top bar's five elements rendered and a session cookie set; then "sair" and confirm the next authenticated request redirects to `/login`.

**Acceptance Scenarios**:

1. **Given** correct seeded credentials, **When** submitted, **Then** redirect to `/leads`, top bar shows name, role badge, and the three nav links.
2. **Given** a correct e-mail with the wrong password, **When** submitted, **Then** one generic failure message, no field-level detail.
3. **Given** an already-valid session, **When** `/login` is requested, **Then** redirect straight to `/leads`.
4. **Given** a logged-in user, **When** `/catalogo` is visited, **Then** spec 002's catalog screen renders inside the shell; `/leads`/`/agenda` show a placeholder, not an error.
5. **Given** a logged-in user, **When** "sair" is activated, **Then** the session cookie clears and the next authenticated request redirects to `/login`.

---

### User Story 2 - Unauthenticated visitors are kept out (Priority: P1)

Anyone without a valid session requesting `/leads`, `/agenda` or `/catalogo` is sent to `/login`. The public chat stays reachable throughout.

**Why this priority**: the guard itself — the reason login exists.

**Independent Test**: with no cookie, request each authenticated page and confirm redirect; request the public chat and confirm it responds normally.

**Acceptance Scenarios**:

1. **Given** no session cookie, **When** any authenticated page is requested, **Then** redirect to `/login`.
2. **Given** a cookie with a bad signature, a missing field, or older than 7 days, **When** requested, **Then** treated as unauthenticated, redirected.
3. **Given** no cookie, **When** the public chat is requested, **Then** it responds normally, no redirect.

---

### User Story 3 - Every role sees the whole agency; managers reassign leads (Priority: P2)

Both a broker's and a sales manager's session scope to every lead of the agency — there is no cross-role query restriction. The scoping helper also tells the caller each role's default list filter: a broker's "Meus leads" list is pre-filtered to their own leads by default, a manager's is not; spec 005's UI applies that default, it is not a permission boundary. A sales manager may reassign a lead's broker; a broker may not, and a successful reassignment is recorded as an event.

**Why this priority**: the rule specs 005/006 build their queries on. No dedicated screen exists yet — `/leads` is a placeholder — so it is proven at the service layer.

**Independent Test**: apply the scoping helper with each role's session against the seeded leads and confirm both return every agency lead with the documented `defaultOwnLeadsOnly` value; call the reassignment service as each role and confirm broker is rejected, manager succeeds and records a `lead.reassigned` event.

**Acceptance Scenarios**:

1. **Given** a broker's session, **When** the helper scopes a leads query, **Then** every lead of the broker's `agencyId` is included, and `defaultOwnLeadsOnly` is `true` — a UI default for spec 005, not a filter this spec applies.
2. **Given** a sales manager's session, **When** scoped, **Then** every lead of the manager's `agencyId` is included, and `defaultOwnLeadsOnly` is `false`.
3. **Given** a sales manager's session, **When** reassignment is called with a same-agency broker, **Then** `assignedBrokerId` updates and a `lead.reassigned` event is recorded with `actorType: user`, `actorUserId` = the manager's `userId`, and `payload { fromBrokerId, toBrokerId }`; **given** a broker's session calls it, **then** it is rejected, no change, no event.

---

### Edge Cases

- Malformed submission (empty fields, invalid e-mail shape) gets the same generic failure as wrong credentials — no enumeration hint.
- Two browsers logged in as the same user simultaneously are both valid — the cookie is stateless; this spec adds no single-session enforcement.
- The guard fails closed: any error while signing or verifying is treated as unauthenticated, never authenticated by default.

## Requirements *(mandatory)*

### Functional Requirements

**Login and session**

- **FR-001**: Provide `/login` with e-mail and password fields, pt-BR copy, no
  sign-up, no password reset.
- **FR-002**: Authenticate by comparing the submitted password against the
  `passwordHash` of the matching seeded `users` row (spec 002's schema); on
  failure — unknown e-mail, wrong password, malformed input — show one generic
  message that does not reveal which factor failed.
- **FR-003**: On success, issue a session cookie carrying `userId`, `agencyId`,
  `role`, signed HMAC-SHA256 over `AUTH_SECRET`, `httpOnly`, `sameSite=lax`,
  `secure` outside development, 7-day expiry.
- **FR-004**: Reject a session cookie as unauthenticated when absent,
  malformed, incomplete, expired, or its signature does not verify.
- **FR-005**: Expose server-side `getSession()` returning the decoded session
  or `null`, usable from Server Components and Server Actions, trusting the
  verified cookie for its lifetime with no database round trip.
- **FR-006**: A logout action clears the session cookie and redirects to
  `/login`; the next request without a valid cookie is unauthenticated.
- **FR-007**: A request to `/login` carrying an already-valid session
  redirects to `/leads` instead of rendering the form.

**Route guarding**

- **FR-008**: Every route under the authenticated route group requires a valid
  session, enforced by one guard, not per-page checks.
- **FR-009**: The public chat route group stays reachable with no session and
  unaffected by the guard.
- **FR-010**: A successful login redirects to `/leads`.

**Role scoping**

- **FR-011**: Provide a scoping helper that, given a session, yields
  `{ agencyId: session.agencyId, defaultOwnLeadsOnly: boolean }` for both
  roles — `true` for `broker`, `false` for `salesManager` — and constrain
  every lead-scoped query built from it by `agencyId` only; every role sees
  every lead of the agency, `defaultOwnLeadsOnly` is a UI default spec 005's
  "Meus leads" list applies, not a permission boundary.
- **FR-012**: Provide a service operation reassigning a lead's
  `assignedBrokerId` to another user of the same agency, callable only by a
  `salesManager` session; a `broker` session calling it is rejected, no
  effect. On success the service itself — not the caller — records a
  `lead.reassigned` event with `actorType: user`, `actorUserId` = the
  session's `userId`, and `payload { fromBrokerId, toBrokerId }`.

**App shell**

- **FR-013**: Authenticated pages share one layout: top bar with product name,
  nav to Leads/Agenda/Catálogo, current user's name, role badge, "sair".
- **FR-014**: `/leads` and `/agenda` render placeholder content inside the
  shell in this spec.
- **FR-015**: `/catalogo` renders spec 002's catalog screen inside the shell,
  not a reimplementation.

**Logging**

- **FR-016**: Log each failed login attempt at `warn` with the attempted
  e-mail and source IP, never the password.
- **FR-017**: `AUTH_SECRET` becomes a required configuration value; its
  absence stops both processes at boot, naming the variable — the same
  Environment Contract gate `tests/env-example.test.ts` already enforces.
- **FR-018**: Every log line this slice's own code emits for an authenticated
  request — login, logout, guard decisions — carries `userId` when the
  session is known, and carries none when it is not. Request-wide log
  correlation across every module is item 4's `AsyncLocalStorage` work,
  per spec 001; this slice does not retrofit it.

### Key Entities

- **Session**: not persisted — a signed, opaque cookie decoding to `userId`, `agencyId`, `role`, expiry; verified per request. Does not carry the user's `specializations` or `availability` (spec 002) — the shell's role badge does not need them.
- **User** (spec 002, consumed not owned): `id`, `agencyId`, `name`, `email`, `passwordHash`, `role` (`broker` | `salesManager`).
- **Lead** (spec 002/005, consumed not owned): only `agencyId` matters for scoping; `assignedBrokerId` is the field reassignment reads and writes.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A seeded user with correct credentials reaches `/leads` on the first attempt, 100% of the time.
- **SC-002**: Every request to an authenticated page without a valid session redirects to `/login`, 100% of attempts, across absent, tampered, incomplete and expired cookies.
- **SC-003**: The public chat responds with no login prompt in 100% of requests carrying no session cookie.
- **SC-004**: Scoping the seeded leads produces zero cross-agency leakage: every role's result includes only leads of its own `agencyId`, and includes every lead of that agency regardless of `assignedBrokerId`; `defaultOwnLeadsOnly` is `true` for a broker's session and `false` for a sales manager's.
- **SC-005**: A wrong password and an unknown e-mail produce byte-identical failure text.
- **SC-007**: After "sair", the next request to an authenticated page redirects to `/login` with no manual cookie clearing.
- **SC-008**: 100% of the log lines this slice's login, logout and guard code emit carry `userId` when the session is known, and none when it is not.
- **SC-009**: Removing `AUTH_SECRET` stops both processes within 10 seconds, naming the variable.

## Assumptions

- Spec 002 lands `users`, its role enum and seeded rows (`ana@demo.com.br` / `bruno@demo.com.br` / `carla@demo.com.br`, password `demo1234`) per `modelo-de-dados.md`; this spec neither creates nor seeds users.
- Spec 002 also lands `users.specializations` and `users.availability`; this spec does not read or carry them — they are out of scope for the session cookie and the shell's role badge.
- A single seeded agency means the login form needs no agency selector.
- No CSRF token beyond `sameSite=lax`: login and logout are the only state-changing endpoints added, both simple form posts with no cross-site value to a forged request.
- `/leads` and `/agenda` placeholders are a single static pt-BR line ("em construção") inside the shell.

## Out of Scope

- Sign-up, password reset, e-mail verification, "remember me", multi-factor.
- Real content on `/leads` or `/agenda` — specs 005 and 006.
- A UI control for reassignment — spec 005 builds it on FR-012's service.
- Server-side session revocation, "log out everywhere", refresh/sliding expiry — the cookie is stateless and fixed-length by design (ADR 12).
- OAuth, SSO, or any identity provider beyond the seeded table.
- Auditing beyond the failed-login log line.
- Login rate limiting / brute-force throttling — dropped per ADR 19; only the
  failed-login `warn` log line (FR-016) remains.
