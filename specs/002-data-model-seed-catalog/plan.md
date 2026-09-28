# Implementation Plan: Data Model, Seed and Catalog

**Branch**: `002-data-model-seed-catalog` | **Date**: 2026-09-05 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/002-data-model-seed-catalog/spec.md`

## Summary

Materialize `docs/arquitetura/modelo-de-dados.md` §1 as a Drizzle schema, committed drizzle-kit migrations applied by a one-shot `migrate` Compose service both `app` and `worker` depend on, an idempotent `npm run db:seed` (agency, three users, 100 properties from a committed JSON dataset, three demo leads with conversations/messages/events), the read-only `/catalogo` grid, and `services/properties.ts` with `listProperties` and `searchProperties`. Readiness on both processes gains a `migrations` check; spec 001's health contract is untouched.

Three decisions carry the weight of this slice: migrations run once, in their own container, so neither long-running process races the other to apply them; the seed is upsert-by-natural-key so a rerun is a no-op rather than a duplicate-guard; and `searchProperties`'s relaxation ladder is a pure function over an in-memory candidate list, testable with `node:test` and no database, so spec 004 inherits a seam it can trust without re-deriving the ranking itself.

## Technical Context

**Language/Version**: TypeScript 5.x `strict`, Node 24 — unchanged from 001.

**Primary Dependencies**: `drizzle-orm` 0.45.2 (present) plus `drizzle-kit` 0.31.10 (new, dev-only — schema push/generate/migrate CLI); `bcryptjs` 3.0.3 (new — seed password hashing, pure JS, no native build step inside the container). No new UI dependency: `/catalogo` is CSS Modules per the constraints register, no component library.

**Storage**: PostgreSQL 17, schema fixed by this spec. `src/db/migrations/` gains its first real migration; `src/db/seed/properties.json` is the only other committed data file.

**Testing**: `node:test`. Pure-function suites (ranking/relaxation, dataset coherence over the committed JSON) run under plain `npm test`. Suites that touch a live Postgres (migration apply, seed idempotency, `listProperties`/`searchProperties` against seeded rows) are gated behind `INTEGRATION=1` inside each file, run with `docker compose exec app npm test` — the first spec in this repo to need a real database for full coverage.

**Target Platform**: Linux containers via Compose, unchanged from 001. One new service (`migrate`), no new runtime process.

**Project Type**: Modular monolith, unchanged.

**Performance Goals**: `/catalogo` and `searchProperties` answer in the tens of milliseconds against 100 rows; the indexes in FR-003/FR-020 exist so this holds at 10x the seeded volume too, not just at today's row count.

**Constraints**: migrations and seed run only via `docker compose up` / `docker compose exec app …` — no host Node. Seed must be safe to run twice, per FR-008.

**Scale/Scope**: ~9 tables, 1 migration file, 1 seed script, ~6 new source files (schema, migrate runner, seed, `services/properties.ts`, the catalog route, a filter form component).

## Constitution Check

*GATE: passed before Phase 0. Re-checked after Phase 1 — result at the end of this section.*

| # | Principle | How this slice satisfies it | Verified by |
|---|---|---|---|
| I | Document Authority | Schema copies modelo-de-dados.md §1 verbatim; no invented column, no reopened ADR 10–17 decision. | Inspection, FR-001 |
| II | Language Boundaries | Identifiers and code in English; the two pt-BR strings on `/catalogo` (labels, empty-state copy) live in the component, no i18n. | Inspection |
| III | Modular Monolith | `migrate` is a third one-shot container from the **same image**, not a new codebase — same pattern as `app`/`worker` differing only by command. No process-local state. | FR-005, docker-compose.yml |
| IV | One Data Path | `/catalogo` (Server Component) and spec 004's future tool call both go through `services/properties.ts`; nothing under `app/` imports `db/`. | ESLint zone (already in place), FR-014/FR-018 |
| V | Deterministic Slot Machine | Not applicable — no agent in this slice. `searchProperties` takes already-derived criteria; it does not decide what to ask. | — |
| VI | Provider Independence | Not touched — no model call in this slice. | — |
| VII | Observability | Not touched — no LLM call to trace. | — |
| VIII | Privacy and PII | Demo leads carry fabricated PII only; seed data is not real personal data, so no masking is exercised here, but nothing in this slice writes unmasked PII to a log either (seed and migrate log counts and table names, never lead content). | Inspection |
| IX | Resilience | Migration failure is fail-fast and visible (`service_completed_successfully` never reports success): app/worker never start against a broken schema. `searchProperties` never throws for "no match" (FR-019). | FR-006, US1 scenario 3 |
| X | User Experience Discipline | See "Who, what, how" below — `/catalogo`'s one screen gets a stated user, task and interaction before layout begins. | FR-014–FR-016, quickstart SC-004 |

**Who, what, how — `/catalogo`.** The person on this screen is a broker mid-conversation with a lead (or checking the agent's own suggestion), not a shopper browsing casually. They came to answer one question fast: "is the property the agent just proposed real, and does its code match what I'm about to tell the lead?" The interaction this slice optimizes for is exactly that lookup — search by `code` is instant (no debounce beyond the filter's own round trip) and the code is printed on every card, not buried behind a detail click. Everything else — the transaction/neighborhood/price/bedroom filters — is secondary browsing, laid out with less visual weight than the code and price on each card so the primary scan path stays fast.

### Stack and environment gates

| Gate | Status |
|---|---|
| `npm`, not pnpm/yarn | Pass |
| Migrations committed under `src/db/migrations` | Pass — this slice's core deliverable |
| No Redis, no new runtime service beyond what this slice owns | Pass — `migrate` is one-shot, exits, is not a running service |
| Every host-only step recorded in the constraints register | Pass — nothing new is host-only; `migrate` and `db:seed` both run in-container |
| Dependency versions pinned exactly | Pass — `drizzle-kit 0.31.10`, `bcryptjs 3.0.3` |

### Post-design re-check

No new violations after Phase 1. The Complexity Tracking table stays empty: `migrate` is a third command on an existing image, not a new architectural element, and the relaxation ladder is a plain function, not a pattern needing justification.

## Project Structure

### Documentation (this feature)

```text
specs/002-data-model-seed-catalog/
├── spec.md
├── plan.md              # this file
├── research.md          # Phase 0 — migration mechanism, ranking formula, dataset shape
├── data-model.md         # Phase 1 — Drizzle table definitions mapped from modelo-de-dados.md
├── quickstart.md         # Phase 1 — the acceptance script
├── contracts/
│   └── properties-service.md   # listProperties / searchProperties signatures and behavior
├── checklists/
│   └── requirements.md
└── tasks.md              # produced by /speckit-tasks
```

### Source Code (repository root)

```text
src/db/
├── schema.ts                    # single schema module — every table, enum, index
├── client.ts                    # unchanged from 001
├── migrate.ts                   # one-shot runner: drizzle-orm/node-postgres/migrator
├── migrations/                  # drizzle-kit output, committed
│   └── meta/_journal.json       # read by the readiness `migrations` check
└── seed/
    ├── index.ts                 # npm run db:seed entrypoint — idempotent upserts
    ├── properties.json          # 100-entry dataset (content: separate agent)
    └── properties.schema.ts     # zod schema + coherence validation for the dataset

src/services/
├── health.ts                    # gains checkMigrations()
└── properties.ts                # listProperties, searchProperties, relaxation ladder

src/domain/
└── property-ranking.ts          # REMOVED 27/09/2026 — spec 007 FR-034

src/app/(app)/catalogo/
├── page.tsx                     # Server Component: reads searchParams, calls services/properties.ts
├── PropertyCard.tsx
├── FilterBar.tsx
└── catalogo.module.css

drizzle.config.ts                # root — schema path, migrations out dir, dialect

tests/
├── property-ranking.test.ts     # pure, no DB
├── properties-dataset.test.ts   # coherence rules over the committed JSON, no DB
├── migrate.test.ts              # INTEGRATION=1 — apply against a live db, check idempotent rerun
├── seed.test.ts                 # INTEGRATION=1 — run twice, assert stable counts
└── properties-service.test.ts   # INTEGRATION=1 — listProperties/searchProperties over seeded data
```

**Structure Decision**: schema lives in one file (`src/db/schema.ts`) rather than a `schema/` folder — nine tables is small enough that one file reads end-to-end, and splitting it would scatter the cross-table enums (`leads.channel` reused by `conversations.channel`) across files with no boundary benefit. `services/properties.ts` is the only new consumer of `db/`, keeping constitution IV intact; the catalog route calls it exactly as spec 004's tool will.

## Shortest implementation path

**1 · Schema.** `src/db/schema.ts`: nine `pgTable` definitions plus `pgEnum` for every enum in modelo-de-dados.md §1, uuid primary keys (`defaultRandom()`), the unique constraints and indexes from FR-003. `drizzle.config.ts` points `drizzle-kit` at this file and at `src/db/migrations`. `drizzle-kit generate` produces the first migration; it is reviewed, then committed as-is.

**2 · Migration runner and Compose service.** `src/db/migrate.ts` calls `drizzle-orm/node-postgres/migrator`'s `migrate()` against `getPool()`, logs the applied count, and exits 0/1. `docker-compose.yml` gains a `migrate` service: same image, `command: node src/db/migrate.ts`, `depends_on: db: condition: service_healthy`. `app` and `worker` add `migrate: condition: service_completed_successfully` to their existing `depends_on`. No advisory lock needed — exactly one container ever runs the migrator.

**3 · Readiness `migrations` check.** `services/health.ts` gains `checkMigrations()`: reads the migration tags from the committed `src/db/migrations/meta/_journal.json` (bundled in the image, no extra file to maintain), queries drizzle's own migrations-tracking table for applied tags, and reports not-ready naming any tag present in the journal but not yet applied. Wired into both `/api/health/ready` and the worker's `/health/ready`, alongside the existing database check — additive, per FR-007.

**4 · Property dataset contract.** `src/db/seed/properties.schema.ts`: a `zod` schema for one dataset entry, plus a pure `validateDataset(entries)` function checking the aggregate coherence rules (region matches neighborhood's zone, ~70/30 sale/rent, ~15 commercial, `estimatedRent` non-null iff `sale`) — this is what `tests/properties-dataset.test.ts` runs against the real, committed `properties.json`, and what the seed calls before inserting anything (FR-010's "fails loudly" is this function, not a try/catch around the insert).

**5 · Seed.** `src/db/seed/index.ts`: upsert the agency by `slug`; upsert the three users by (`agencyId`,`email`) — `ON CONFLICT DO NOTHING`, since re-hashing an unchanged password on every run buys nothing; upsert properties by (`agencyId`,`code`) with `ON CONFLICT DO UPDATE` so edits to the dataset take effect on rerun; for the three demo leads, look each up by (`agencyId`,`channel`,`externalId` = `seed-hot`/`seed-warm`/`seed-cold`) and skip the whole lead+conversation+messages+events+appointment block if it already exists — there is no natural key to upsert a conversation transcript against, so "already seeded" is the idempotency boundary there, matching FR-008.

**6 · `services/properties.ts`.** `listProperties(agencyId, filters, page)`: a Drizzle query scoped by `agencyId` and `isActive = true`, `WHERE` clauses built from whichever filters are present, `ORDER BY price ASC, id ASC`, `LIMIT 24 OFFSET (page-1)*24`, plus a `count(*)` for pagination. `searchProperties(agencyId, criteria)` delegates ranking to `domain/property-ranking.ts`: fetch the active, `transaction`-matching candidate set once (bounded by the seeded catalog's size, no pagination needed), then run the pure ladder — try exact `neighborhoods`, then their region, then no location filter, then a widened price ceiling (+20%, a named constant) — stopping at the first non-empty step, sorting by `|price - priceMax|` then neighborhood match then `id`, returning the top 3. `property-ranking.ts` takes and returns its own minimal candidate shape (`id`/`price`/`neighborhood`/`region`), never the full `Property` type, so `domain/` never imports outward (constitution III). Kept pure and unit-tested without a database; only the candidate fetch touches `db/`.

**7 · Catalog route.** `src/app/(app)/catalogo/page.tsx`: Server Component reading `searchParams` for `code`, `transaction`, `neighborhood`/`region`, `maxPrice`, `minBedrooms`, `page`; calls `listProperties`; renders `FilterBar` (a small client component updating the URL) and a grid of `PropertyCard`. BRL formatting via `Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" })`. No guard — spec 003 wraps `(app)/*` later; this route sits in that group already so the wrap is a parent-layout change, not a route move.

### What is deliberately not built

Any orchestrator or tool call site for `searchProperties` (004). Score, summary, dashboard (005). Scheduling UI or the follow-up sweep; `followup_jobs` stays empty (006). Row-level security in Postgres — isolation is enforced in `services/`, per ADR 10. A `schema/` folder split — one file is enough at nine tables.

## Complexity Tracking

No constitution violations. Table intentionally empty.
