# Feature Specification: Data Model, Seed and Catalog

**Feature Branch**: `002-data-model-seed-catalog`

**Created**: 2026-09-05

**Status**: Draft

**Input**: User description: "Backlog spec 002 — Data model, seed and catalog." Full text in `specs/BACKLOG.md` row 002.

Backlog item 002 *(original items 2 + 12)*: Drizzle schema per `docs/arquitetura/modelo-de-dados.md`, migrations applied automatically, an idempotent seed (one agency, three users, 100 coherent São Paulo properties, three demo leads), and the read-only catalog screen. Covers *Integração com base simulada de imóveis* and *credibilidade da demonstração*. Second slice on the walking skeleton (001): the shared schema every later spec reads and writes, demo data credible on first boot, and the screen proving the catalog is real, not invented.

## Clarifications

- Q: Seed `events` for the demo leads, though `events` is described as emitted by 004–006? → A: Yes, a static trail per lead's state so the timeline isn't empty on first boot; no runtime emission logic added here.
- Q: Seed a `followup_jobs` row for the cold lead? → A: No — spec 006 populates that table. The cold lead's `lastLeadMessageAt` is two days past so 006 has a candidate once built.
- Q: One-shot migrate service or migrate-on-boot with an advisory lock? → A: One-shot `migrate` Compose service; `app`/`worker` depend on it via `service_completed_successfully` — no lock, no race, one more service.
- Q: Do catalog/`searchProperties` ever return an inactive property? → A: No, both filter to `isActive = true`.
- Q: `listProperties` pagination tie-break? → A: Price ascending, then `id`.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - The schema migrates itself on every start (Priority: P1)

The documented start command, against a database that has never seen this schema, brings every table, enum and index in the data model document into existence with no manual step; neither process serves traffic until it has.

**Why/Test**: every later spec assumes this schema exists. Start against an empty database, confirm both processes reach ready with every §1 table present, and that a killed migration keeps both from starting on a half schema.

**Acceptance Scenarios**:

1. **Given** a fresh database, **When** the system starts, **Then** every table/enum/index exists before either process reports ready.
2. **Given** the schema is current, **When** started again, **Then** the migration step is a no-op.
3. **Given** a migration fails, **When** either process starts, **Then** neither reaches ready and the failure names the migration.
4. **Given** the system is running, **When** readiness is queried, **Then** it reports a new `migrations` check, spec 001's fields unchanged.

---

### User Story 2 - The demo data is there on first boot, safely, every time (Priority: P1)

`npm run db:seed` against a freshly migrated database produces one agency, three broker/manager accounts, 100 São Paulo properties and three leads mid-journey, whether or not it ran before.

**Why/Test**: every later spec's demo depends on this data staying trustworthy across reruns. Run the seed twice; row counts must match after both runs.

**Acceptance Scenarios**:

1. **Given** an empty, migrated database, **When** seeded, **Then** one agency, three users, 100 properties, three leads (each with a conversation, messages, events) exist.
2. **Given** the seed already ran, **When** it runs again, **Then** counts are unchanged.
3. **Given** the dataset is missing or short of 100 entries, **When** seeded, **Then** it fails loudly, naming the problem, no partial insert.
4. **Given** the seed completed, **When** credentials are inspected, **Then** every password is a bcrypt hash only.

---

### User Story 3 - A broker browses the real catalog (Priority: P2)

`/catalogo` shows the agency's active inventory as cards — photo, BRL price, bedrooms, area, neighborhood — filterable by transaction, neighborhood/region, max price, min bedrooms, 24 per page.

**Why/Test**: proves recommended properties are real rows; no business logic of its own. Open the page, confirm cards and fields, confirm each filter narrows the grid, confirm paging preserves filters.

**Acceptance Scenarios**:

1. **Given** the seeded catalog, **When** opened unfiltered, **Then** the first 24 active properties render with all required fields.
2. **Given** a filter matching zero properties, **When** applied, **Then** the grid renders empty, no error.
3. **Given** more than 24 matches, **When** the next page is requested, **Then** the next 24 render in stable order, filters unchanged.
4. **Given** no session, **When** opened, **Then** it still renders — unguarded here; spec 003 adds the guard.

---

### User Story 4 - The agent's property search returns real, ranked matches (Priority: P2)

`searchProperties` — spec 004's tool, in practice — takes intent-shaped criteria (transaction, price ceiling, bedroom minimum, neighborhoods) and returns up to three properties, best first, even when nothing matches exactly.

**Why/Test**: the seam spec 004 builds its suggestion tool on. Call it with criteria matching many, matching none until relaxed, and against an agency with no active properties; confirm count and order each time.

**Acceptance Scenarios**:

1. **Given** criteria several properties satisfy, **When** it runs, **Then** it returns up to three, ordered by price proximity then neighborhood.
2. **Given** criteria nothing matches for the neighborhoods, **When** it runs, **Then** it relaxes to region, then drops location, then widens price, in that order.
3. **Given** an agency with no active properties, **When** it runs, **Then** it returns an empty list, not an error.
4. **Given** criteria scoped to another agency, **When** it runs, **Then** that agency's properties never appear.

---

### Edge Cases

- Migration fails mid-run: neither process starts on a half schema.
- Seed run against a database with runtime data already in it: touches only rows it recognizes (slug, email, code).
- `properties.json` violates its own coherence rules: caught before insert.
- Catalog page past the last page: empty grid, not an error.
- `searchProperties` with an empty `neighborhoods` list (a valid slot value): skips that ranking step rather than matching nothing.
- Two properties tie on price: neighborhood breaks the tie, then `id`.

## Requirements *(mandatory)*

### Functional Requirements

**Schema and migrations**

- **FR-001**: MUST define, via Drizzle, exactly the tables in modelo-de-dados.md §1 — `agencies`, `users`, `leads`, `conversations`, `messages`, `properties`, `appointments`, `events`, `followup_jobs` — with the columns, types and enums documented there (authoritative; not restated).
- **FR-002**: Every table besides `agencies` and `messages` MUST carry a not-null `agencyId` foreign key, matching ADR 10's table list exactly; `messages` is scoped transitively through its `conversation`.
- **FR-003**: Uniqueness/indexes MUST match the model document: `users` on (`agencyId`,`email`); `properties` on (`agencyId`,`code`); `leads` on (`agencyId`,`channel`,`externalId`); `agencies` on `slug`; `messages` on (`conversationId`,`createdAt`); `followup_jobs` supporting `where status='pending' and scheduledFor<=now()` without a full scan.
- **FR-004**: Migrations MUST be generated by drizzle-kit, committed under `src/db/migrations`, never hand-edited after commit.
- **FR-005**: Migrations MUST apply automatically before either process serves traffic, no manual step.
- **FR-006**: Both readiness surfaces MUST gain a `migrations` check, reporting not-ready and naming the gap when the schema isn't fully applied.
- **FR-007**: Spec 001's health contract MUST NOT change; `migrations` is additive.

**Seed**

- **FR-008**: `npm run db:seed` MUST be idempotent: any number of runs MUST leave exactly one agency, three users, 100 properties, three leads with conversations, messages and events.
- **FR-009**: MUST create agency "Imobiliária Demo", slug `demo`, and three users per modelo-de-dados.md §5, each broker's `specializations` and Mon–Fri 09:00–18:00 `availability` set per data-model.md's seed data shape (ADR 19), password stored only as a bcrypt hash of `demo1234`.
- **FR-010**: MUST load exactly 100 properties from committed `src/db/seed/properties.json`, failing with a specific error if missing, malformed, or not exactly 100 entries.
- **FR-011**: The dataset MUST distribute ~70 `sale`/30 `rent` and ~15 `commercial`, every neighborhood in a region named in modelo-de-dados.md §5, every price within that neighborhood's documented price band (concrete ranges in data-model.md's Seed data shape section — exact figures are a dataset-validation detail, not a business rule this spec fixes); every `sale` row non-null `estimatedRent`, every `rent` row null.
- **FR-012**: Each property's `imageUrl` MUST be a `picsum.photos` URL deterministically derived from its `code`.
- **FR-013**: MUST create three demo leads per modelo-de-dados.md §5 — hot (`leads.status='scheduled'`, `conversations.status='active'`, `followupState='none'`, one confirmed future appointment), warm (`qualifying`/`active`/`none`, mid-qualification), cold (`qualifying`/`active`/`pending`, `lastLeadMessageAt` two days past) — each with a conversation, messages and a plausible `events` trail whose rows carry `actorType` (`agent`/`system`) with `actorUserId` null.

**Catalog**

- **FR-014**: MUST expose `/catalogo`: a responsive grid of the agency's active properties, cards showing `code`, photo, BRL price, bedrooms, area, neighborhood — `code` printed on every card, not only on a detail view (constitution X: the broker's task here is confirming a suggested property is real).
- **FR-015**: The route MUST offer combinable filters — `code` (instant, exact or prefix match), transaction, neighborhood/region, max price, min bedrooms — reflected in the URL.
- **FR-016**: MUST paginate at 24 per page, sorted price ascending then `id` ascending, so paging never repeats or skips a row.
- **FR-017**: MUST be reachable with no session and implement no guard of its own — spec 003 wraps `(app)/*`, this route included.

**Services**

- **FR-018**: `services/properties.ts` MUST expose `listProperties(agencyId, filters, page)` — up to 24 active properties matching the filters plus the total matching count.
- **FR-019**: `services/properties.ts` MUST expose `searchProperties(agencyId, criteria)` — up to 3 active properties ranked by price proximity to the ceiling, then neighborhood match, relaxing on no match in order — neighborhood → region → drop location → widen price band — stopping at the first match or the ladder's end, never erroring for "no match."
- **FR-020**: Every query MUST be scoped by `agencyId`; `properties` MUST carry indexes covering `agencyId` plus `transaction` and `neighborhood`.

### Key Entities

Column detail lives in modelo-de-dados.md §1, implemented verbatim: `Agency` (tenant boundary), `User` (broker/manager per agency), `Lead` (intent, status, score, consent), `Conversation` (slots as JSON, follow-up timestamps), `Message` (one turn, ordered by `createdAt`), `Property` (transaction, price, location), `Appointment` (viewing/call tied to a lead), `Event` (append-only, typed per §4), `FollowupJob` (created here, left empty — see Clarifications).

**Property dataset** (`src/db/seed/properties.json`): 100 entries matching `properties` columns except `id`/`agencyId`/`imageUrl` (generated at seed time). Rules: neighborhood from modelo-de-dados.md §5's zones (zona sul: Moema, Vila Mariana, Brooklin, Campo Belo, Saúde; zona oeste: Pinheiros, Vila Madalena, Perdizes, Butantã; centro; zona norte: Santana); `region` matching that zone; price coherent with the neighborhood (Moema, Vila Madalena, Pinheiros pricier than Santana/centro; concrete per-zone bands in data-model.md) for both `sale` and `rent`; ~70/30 split; ~15 `commercial`; `estimatedRent` non-null only on `sale`. Literal content is produced separately; this spec fixes shape and validation.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Starting against a brand-new database reaches both processes ready, schema fully applied, no manual step, within spec 001's cold-start budget (under 90 seconds).
- **SC-002**: Seeding twice leaves identical row counts for agency, users, properties, leads.
- **SC-003**: 100% of seeded properties satisfy every coherence rule in Key Entities, verified by an automated check over the committed dataset.
- **SC-004**: `/catalogo` renders correctly for a filter returning zero properties and one returning the full catalog; paging never repeats or skips a property.
- **SC-005**: `searchProperties` returns at least one result for every criteria combination satisfiable somewhere in the relaxation ladder, zero only when the agency has no active properties.
- **SC-006**: A fresh, unmigrated database makes readiness report not-ready and name `migrations` as the failing check.
- **SC-007**: Every field spec 001's health/readiness responses defined is still present, unchanged.

## Assumptions

- `properties.json`'s literal contents are generated separately; this spec is the contract that content must satisfy. That 100-row dataset is already produced — a deterministic generator, run and validated by the orchestrator — and lands in `src/db/seed/properties.json` at implementation time; `validateDataset()` (FR-010) still runs over it before any insert, exactly as it would over any other candidate dataset.
- Cross-tenant isolation is enforced in `services/` per ADR 10; no row-level security added.
- "One active conversation per lead" (§5) is enforced by the seed and later write paths, not a database constraint — the model document lists none, and adding one uninvited risks disagreeing with spec 004's write pattern.
- The hot lead's "reunião marcada" needs one `appointments` row; seeding it is a static fact, not the scheduling flow, which stays spec 006's.
- `/catalogo` is a Server Component calling `services/properties.ts` directly, per constitution IV — no internal HTTP hop, no `db/` import under `app/`.

## Out of Scope

- Any session guard on `/catalogo` or elsewhere — backlog item 3.
- The orchestrator, slot machine, chat widget and the call site invoking `searchProperties` — backlog item 4. This spec ships the service function.
- Score computation, summaries, the leads dashboard — backlog item 5.
- The scheduling UI, follow-up worker sweep, any `followup_jobs` row — backlog item 6. The table exists; nothing populates or drains it here.
- Generating the actual 100 rows of `src/db/seed/properties.json` — already done by the orchestrator's deterministic generator, against the rules this spec fixes; this spec only validates and consumes it.
