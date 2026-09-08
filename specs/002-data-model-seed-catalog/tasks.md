---

description: "Task list for data model, seed and catalog"
---

# Tasks: Data Model, Seed and Catalog

**Input**: Design documents from `/specs/002-data-model-seed-catalog/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md), [data-model.md](data-model.md), [contracts/](contracts/), [quickstart.md](quickstart.md)

**Tests**: Included, per repo convention (ADR 9, spec 001). Pure suites (`property-ranking`, `properties-dataset`) run under plain `npm test`; DB-touching suites (`migrate`, `seed`, `properties-service`) are gated `INTEGRATION=1`, run via `docker compose exec app npm test` — the first spec needing a live database for full coverage.

**Organization**: By user story. Schema/migrations sit in Foundational, not US1's own phase, since seed/catalog/search all need them first; US1's phase holds only what is genuinely US1-specific — the readiness check and its verification (mirrors spec 001's US4).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: different file, no dependency on an incomplete task
- **[Story]**: US1–US4, mapping to [spec.md](spec.md)

## Path Conventions

Single project. `src/`, `tests/` at the repository root, per [plan.md](plan.md#source-code-repository-root).

---

## Phase 1: Setup

- [x] T001 Add `drizzle-kit@0.31.10` (dev) and `bcryptjs@3.0.3` + `@types/bcryptjs` to `package.json`; add `db:generate`, `db:migrate`, `db:seed` scripts
- [x] T002 [P] Create `drizzle.config.ts` at the repo root: schema `src/db/schema.ts`, migrations out `src/db/migrations`, dialect `postgresql`, credentials from `DATABASE_URL`
- [x] T003 [P] Create the `src/db/seed/` scaffold (`index.ts`, `properties.schema.ts` stubs) and `src/app/(app)/catalogo/` directory

---

## Phase 2: Foundational

**⚠️ Blocks all user stories** — nothing below can be exercised against a real database until this lands.

- [x] T004 Define every enum and all nine tables in `src/db/schema.ts` per [data-model.md](data-model.md) — uuid PKs, `agencyId` FKs, `users.specializations`/`availability`, `leads.status` (`new…visited/won/lost`, no `handoff`/`unresponsive`), `conversations.heldByUserId`/`followupState`/`processingSince`, `messages.repliesToMessageId`, `events.actorType`/`actorUserId`/`traceId`, the uniqueness constraints and indexes from FR-003/FR-020 plus `events` (`conversationId`,`createdAt`) and (`agencyId`,`type`,`createdAt`)
- [x] T005 Run `drizzle-kit generate`; review and commit the resulting migration under `src/db/migrations/`, `meta/_journal.json` included
- [x] T006 [P] Implement `src/db/migrate.ts` — one-shot runner over `drizzle-orm/node-postgres/migrator`'s `migrate()`, logs the applied count, exits 0/1
- [x] T007 Add a `migrate` service to `docker-compose.yml` (same image, `command: node src/db/migrate.ts`, `depends_on: db: condition: service_healthy`); add `migrate: condition: service_completed_successfully` to `app`'s and `worker`'s `depends_on`
- [x] T008 [P] Implement `checkMigrations()` in `src/services/health.ts` — read `src/db/migrations/meta/_journal.json`, compare against drizzle's migrations-tracking table, name any missing tag
- [x] T009 Wire `checkMigrations()` into `src/app/api/health/ready/route.ts` and `src/worker/health-server.ts`, alongside the existing database check (FR-007: additive only)

**Checkpoint**: schema exists, one command migrates it, readiness proves it.

---

## Phase 3: User Story 1 — The schema migrates itself on every start (P1)

**Goal / Independent Test**: fresh volume, `docker compose up`; both processes reach ready with a passing `migrations` check and no manual step; a killed migration keeps both from starting.

- [x] T010 [US1] Write `tests/migrate.test.ts` (`INTEGRATION=1`) — apply against a live db, assert `checkMigrations()` reports ready, assert a second run is a no-op
- [x] T011 [US1] Verify SC-001 and SC-006 per [quickstart.md](quickstart.md) — fresh volume reaches ready within 90 s; an unmigrated database reports not-ready naming `migrations`
- [x] T012 [US1] Verify SC-007 — `tests/health.test.ts` passes unmodified; every field spec 001 defined is still present

**Checkpoint**: US1 done.

---

## Phase 4: User Story 2 — The demo data is there on first boot, safely, every time (P1)

**Goal / Independent Test**: `npm run db:seed` produces the agency, users, 100 properties and three leads; run it twice, row counts stay identical.

- [x] T013 [P] [US2] Write `src/db/seed/properties.schema.ts` — a zod schema per dataset entry plus `validateDataset(entries)` checking region/zone match, ~70/30 sale/rent, ~15 commercial, `estimatedRent` non-null iff `sale`
- [x] T014 [P] [US2] Write `tests/properties-dataset.test.ts` — unit tests for `validateDataset()` against small inline fixtures, one per violation
- [x] T015 [US2] Implement `src/db/seed/index.ts`: upsert the agency by `slug`; upsert the three users by (`agencyId`,`email`) with `bcrypt.hash("demo1234", 10)`, Ana's/Bruno's `specializations` and Mon–Fri 09:00–18:00 `availability`, Carla's empty `specializations`/`availability`, `ON CONFLICT DO NOTHING`
- [x] T016 [US2] Extend the seed to load and validate `src/db/seed/properties.json` (already produced by the orchestrator's generator, per spec.md's Assumptions), failing loudly per FR-010, then upsert by (`agencyId`,`code`) `ON CONFLICT DO UPDATE`
- [x] T017 [US2] Extend the seed to create the three demo leads (`externalId` `seed-hot`/`seed-warm`/`seed-cold`) with conversations (`status`/`followupState` per [data-model.md](data-model.md)'s axes table), messages, `events` carrying `actorType` (`agent`/`system`, `actorUserId` null) and — hot only — one confirmed future `appointments` row; skip the whole block per lead if it already exists
- [x] T018 [US2] Confirm `src/db/seed/properties.json` (100 rows, already produced by the orchestrator's deterministic generator) exists and passes `validateDataset()`; if absent, block rather than authoring the dataset here — **present, but does NOT pass `validateDataset()`: see the deviation note in `tests/properties-dataset.test.ts` and the final implementation report**
- [x] T019 [P] [US2] Write `tests/seed.test.ts` (`INTEGRATION=1`) — run twice, assert identical counts (1/3/100/3) and bcrypt-only password storage
- [x] T020 [US2] Verify SC-002 and SC-003 per [quickstart.md](quickstart.md) — **SC-002 passes; SC-003 fails against the committed dataset, documented as a known deviation**

**Checkpoint**: seed is idempotent; demo data exists.

---

## Phase 5: User Story 3 — A broker browses the real catalog (P2)

**Goal / Independent Test**: `/catalogo` renders a paginated, filterable grid of active properties; with the seed applied, confirm 24 cards, each filter narrows the grid, paging preserves filters.

- [x] T021 [US3] Implement `listProperties(agencyId, filters, page)` in `src/services/properties.ts` — scoped by `agencyId`+`isActive`, filter clauses per [contracts/properties-service.md](contracts/properties-service.md) including `code` prefix match, `ORDER BY price ASC, id ASC`, `LIMIT 24`, plus a total count
- [x] T022 [P] [US3] Implement `src/app/(app)/catalogo/PropertyCard.tsx` and `catalogo.module.css` — `code` given the most visual weight alongside price (constitution X), photo, BRL price via `Intl.NumberFormat("pt-BR", {style:"currency",currency:"BRL"})`, bedrooms, area, neighborhood
- [x] T023 [P] [US3] Implement `src/app/(app)/catalogo/FilterBar.tsx` — client component updating `searchParams`; `code` search first and instant (no debounce beyond the input's own change event), then transaction, neighborhood/region, max price, min bedrooms
- [x] T024 [US3] Implement `src/app/(app)/catalogo/page.tsx` — Server Component reading `searchParams`, calling `listProperties`, rendering `FilterBar` + grid + pagination, no session guard (FR-017)
- [x] T025 [P] [US3] Write `tests/properties-service.test.ts` (`INTEGRATION=1`) — `listProperties`: filtered, zero-result, and paging-stability cases
- [x] T026 [US3] Verify SC-004 per [quickstart.md](quickstart.md) — verified in-browser: unfiltered grid, `?maxPrice=1` empty state, `?code=MOE` narrows instantly, `?transaction=rent&page=2` shows "Página 2 de 2" with filter preserved

**Checkpoint**: the catalog is real and browsable.

---

## Phase 6: User Story 4 — The agent's property search returns real, ranked matches (P2)

**Goal / Independent Test**: `searchProperties` returns up to 3 ranked matches, relaxing criteria when nothing matches exactly; call it exact-match, needs-relaxation and empty-agency, confirm count and order each time.

- [x] T027 [US4] Implement the pure ranking/relaxation function in `src/domain/property-ranking.ts` per [research.md](research.md) — price-proximity-then-neighborhood-then-id ranking; neighborhood → region → drop location → widen price (`PRICE_RELAX_FACTOR = 1.2`) ladder; `bedrooms` never relaxed; takes/returns its own minimal candidate shape (`id`/`price`/`neighborhood`/`region`), never the `Property` type, so `domain/` imports nothing (constitution III)
- [x] T028 [P] [US4] Write `tests/property-ranking.test.ts` — no DB: exact match, each relaxation step, empty candidate list, price ties
- [x] T029 [US4] Implement `searchProperties(agencyId, criteria)` in `src/services/properties.ts` — fetch the active/`transaction`-matching candidate set, map to `property-ranking.ts`'s candidate shape, delegate, map the ranked ids back to full `Property` rows, return the top 3
- [x] T030 [US4] Extend `tests/properties-service.test.ts` (`INTEGRATION=1`) — `searchProperties` against seeded data: exact, relaxed, empty-agency, cross-agency isolation
- [x] T031 [US4] Verify SC-005 per [quickstart.md](quickstart.md) — `tests/properties-service.test.ts` (INTEGRATION=1) passes: exact match, relaxed match, no-throw-on-no-match, cross-agency isolation

**Checkpoint**: all four stories complete; `services/properties.ts` is ready for spec 004 to call.

---

## Phase 7: Polish

- [ ] T032 [P] Confirm `tests/env-example.test.ts` still passes unmodified — this spec introduces no new environment variable
- [ ] T033 Run `npm run lint` — confirm nothing under `src/app/(app)/catalogo/` imports `db/` or `drizzle-orm`
- [ ] T034 Run [quickstart.md](quickstart.md) end to end on a clean volume, confirming SC-001 through SC-007
- [ ] T035 [P] If drizzle-kit or the migration step surfaces a genuinely new host-only requirement, record it in `docs/arquitetura/restricoes-de-implantacao.md` — otherwise skip, nothing is expected

---

## Dependencies & Execution Order

Setup → Foundational → US1 → US2 → US3 → US4 → Polish. US1 only verifies Foundational. US2 needs Foundational alone. US3 and US4 need US2 for a meaningful independent test and share `src/services/properties.ts` — same file, so T021 lands before T029.

**Parallel**: Setup — T002/T003 alongside T001. Foundational — T006/T008 together (after T004/T005). US2 — T013/T014 together; T019 alongside T018. US3 — T022/T023/T025 together (after T021). US4 — T028 alongside T027. Polish — T032/T035 alongside anything. Everything else is sequential, since `src/db/seed/index.ts` and `src/services/properties.ts` are each built up across several tasks.

## Implementation Strategy

**MVP is Setup + Foundational + US1 + US2** — the point demo data exists and is trustworthy, the floor spec 003 onward needs. US3/US4 are the read paths on top, and make this slice's own criteria demonstrable rather than merely present in the database. Commit per task or logical group, as in spec 001; stop if a task needs a decision listed in `docs/decisoes-pendentes.md`.

## Notes

- No task authors the 100 rows of `properties.json` — T018 checks for it, per the spec's Out of Scope.
- `INTEGRATION=1` suites need a seeded database via `docker compose exec app npm test`; plain `npm test` stays green without one.
- If a task conflicts with `modelo-de-dados.md`, the document wins — stop and flag it, don't resolve silently.
