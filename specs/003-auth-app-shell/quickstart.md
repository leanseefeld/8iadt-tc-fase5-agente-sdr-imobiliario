# Quickstart: Authentication and App Shell

Prerequisites: `docker compose up` running, spec 002's migrations and seed
applied (agency, three users, sample leads).

## 1. Login (SC-001, US1)

1. Open `/login`. Submit `ana@demo.com.br` / `demo1234`.
2. Confirm redirect to `/leads` and the top bar shows "Ana", role badge
   "corretora"/"corretor", and links to Leads, Agenda, Catálogo.
3. Submit the same e-mail with a wrong password. Confirm one generic failure
   message (SC-005) — repeat with an unknown e-mail and diff the two
   responses; they must be byte-identical.

## 2. Guard (SC-002, SC-003, US2)

1. Clear cookies. Request `/leads`, `/agenda`, `/catalogo` directly — each
   redirects to `/login`.
2. Edit the `session` cookie's value by one character and repeat — same
   redirect (bad signature).
3. Request the public chat route with no cookie — responds normally, no
   redirect.

## 3. Role scoping (SC-004, US3)

Run `tests/auth-service.test.ts` with `INTEGRATION=1` against the seeded
leads: asserts a broker's scoped query returns only their assigned leads and
a sales manager's returns every agency lead, then exercises
`reassignLead` as both roles per [contracts/scope-for-user.md](contracts/scope-for-user.md).

## 4. Shell and logout (SC-007, US1/US4)

1. Logged in, visit `/catalogo` — spec 002's catalog screen renders inside
   the shell. Visit `/leads`/`/agenda` — placeholder text renders.
2. Click "sair". Confirm the next request to `/leads` redirects to `/login`.

## 5. Rate limit (SC-006, US4)

Submit wrong credentials from one client past the configured threshold
(default in `.env.example`); confirm the next attempt is rejected
immediately (no delay for the credential check), then wait past the
cool-down and confirm a correct login succeeds.

## 6. Configuration gate (SC-009)

`docker compose run --rm -e AUTH_SECRET= app npm run start:worker` — exits
within 10 seconds naming `AUTH_SECRET`. Then `npm test` inside the container
to confirm `tests/env-example.test.ts` and `tests/config.test.ts` pass with
`AUTH_SECRET` required.

## 7. Logging (SC-008)

Capture output across one login, one authenticated request, and one
anonymous request. Confirm the authenticated lines carry `userId` and the
anonymous ones do not.
