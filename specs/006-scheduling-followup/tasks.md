---

description: "Task list for scheduling and follow-up"
---

# Tasks: Scheduling and Follow-up

**Input**: Design documents from `/specs/006-scheduling-followup/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [data-model.md](data-model.md), [contracts/interfaces.md](contracts/interfaces.md), [quickstart.md](quickstart.md)

**Tests**: Included — spec.md's success criteria are assertions (SC-002, SC-005 in
particular), and `domain/scheduling.ts` is finishable with no database, so its tests
are written first. Service and consumer tests need Postgres and are written
alongside their implementation, not before.

**Organization**: By user story, per [spec.md](spec.md): US1 propose/book (P1), US2
follow-up sweep (P1, the graded scenario), US3 agenda (P2).

## Path Conventions

Single project, `src/`/`tests/` at the repository root, per [plan.md](plan.md#source-code-repository-root).
---

## Phase 1: Setup

- [ ] T001 Add `FOLLOWUP_FIRST_DELAY_MINUTES` (replacing `FOLLOWUP_FIRST_DELAY_HOURS`) and `FOLLOWUP_BATCH_SIZE` to `src/core/config.ts` and `.env.example` in one commit — the Environment Contract gate
- [ ] T002 [P] Write migration adding `followup_jobs_claim_idx` and `appointments_broker_busy_idx` per [data-model.md](data-model.md) §1, in `src/db/migrations/`
- [ ] T003 [P] Confirm `src/agent/tools/index.ts` and `tools/scheduling.stub.ts` exist (spec 004); if not yet merged, create the minimal registry shape so T011 has somewhere to register
- [ ] T004 [P] Confirm `src/jobs/consumers.ts` exists (spec 005); if not yet merged, create it with `type SweepConsumer = { name: string; run(db, now): Promise<void> }` and an empty registry
---

## Phase 2: Foundational

**Purpose**: The pure domain module both P1 stories depend on.

**⚠️ Blocks US1 and US2.**

- [ ] T005 Write `tests/scheduling.test.ts` — `proposeSlots` over 200 generated busy-calendar cases: zero collisions, zero weekends, zero outside 09:00–18:00, zero inside 24h (SC-002)
- [ ] T006 [P] Write `tests/rotation.test.ts` — `nextBrokerInRotation` picks the minimum count, ties by list order, across 30 simulated assignments (SC-004)
- [ ] T007 Implement `src/domain/scheduling.ts` — `proposeSlots`, `nextBrokerInRotation`, `isWithinWindow`, `nextWindowOpening` per [contracts/interfaces.md](contracts/interfaces.md) §1 (satisfies T005, T006)

**Checkpoint**: `domain/scheduling.ts` imports nothing and its tests pass under `node --test`.
---

## Phase 3: User Story 1 — Real times, not a preference question (P1) 🎯 MVP

**Goal**: the agent proposes concrete options from the assigned broker's calendar and books one.

**Independent Test**: qualify a lead to the point of interest; the next agent message carries dated options; pick one and find it on the agenda.

- [ ] T008 [US1] Implement `loadBusyIntervals(brokerId)` in `src/services/scheduling.ts` — confirmed appointments only (FR-004)
- [ ] T009 [US1] Implement `proposeAppointment` in `src/services/scheduling.ts` — assigns a broker via `nextBrokerInRotation` on first call, upserts one `proposed` row keyed by conversation, emits `appointment.proposed`
- [ ] T010 [US1] Implement `bookAppointment` in `src/services/scheduling.ts` — validates the choice against `proposeSlots`, moves the row to `confirmed` inside a collision-checking transaction, sets the lead `scheduled`, emits `appointment.confirmed`
- [ ] T011 [US1] Implement `src/agent/tools/scheduling.ts` — `proposeMeeting`, `bookMeeting`, replacing `tools/scheduling.stub.ts`, registered in `tools/index.ts` per [contracts/interfaces.md](contracts/interfaces.md) §3
- [ ] T012 [US1] Wire the orchestrator's commit step to render the compact confirmation card from `bookMeeting`'s result — weekday, date, time, type, property code for a viewing
- [ ] T013 [P] [US1] Write `tests/scheduling-service.test.ts` against Postgres — collision on a losing second booking, re-proposal replaces rather than accumulates, rotation counts differ by at most one across brokers
- [ ] T014 [US1] Verify SC-001–SC-004 per [quickstart.md](quickstart.md) §1

**Checkpoint**: a qualified lead can be proposed times and booked; the agenda (once US3 lands) shows it.
---

## Phase 4: User Story 2 — Reopening a stalled conversation (P1) 🎯 graded scenario

**Goal**: the worker sweep sends a context-aware follow-up on schedule, capped and eligibility-checked.

**Independent Test**: answer two questions and stop; after the first delay the agent writes again with context from the summary; reply and confirm nothing further sends.

- [ ] T015 [US2] Implement `scheduleFollowup(tx, conversationId, now)` in `src/services/followup.ts` — upsert keyed by conversation, guarded (paused/closed, opted out, nothing pending) in the `where`
- [ ] T016 [US2] Implement `cancelFollowup(tx, conversationId)` in `src/services/followup.ts` — cancels every pending row, emits `followup.recovered` when one was already `sent`
- [ ] T017 [US2] Wire spec 004's turn commit to call `scheduleFollowup` when a turn leaves the conversation waiting and `cancelFollowup` on every inbound lead message
- [ ] T018 [US2] Implement `src/jobs/followup.ts` — claim via `for update skip locked` per [contracts/interfaces.md](contracts/interfaces.md) §4, registered in `jobs/consumers.ts`
- [ ] T019 [US2] Implement the eligibility re-check in `src/jobs/followup.ts` (FR-012) — outside the window reschedules to `nextWindowOpening` untouched; any other failure cancels without sending
- [ ] T020 [US2] Implement `src/agent/followup-writer.ts` — message from the stored summary (falling back to slot state), through `provider.ts`, masked via `core/masking.ts`, `functionId: 'followup'`
- [ ] T021 [US2] Wire a successful send in `src/jobs/followup.ts` — store the agent message with `metadata.isFollowUp = true`, increment `followupAttempts`, emit `followup.sent`, schedule the next attempt at 3× the interval or set the lead `unresponsive` at the max
- [ ] T022 [P] [US2] Write `tests/followup-claim.test.ts` against Postgres — two concurrent claimers over 100 due rows, 100 processed, zero duplicated, zero lost (SC-005)
- [ ] T023 [P] [US2] Write `tests/followup-eligibility.test.ts` against Postgres — window, opt-out and paused-conversation cases send nothing; one outside the window reschedules with its attempt number unchanged (SC-007)
- [ ] T024 [P] [US2] Write `tests/followup-writer.integration.test.ts`, `INTEGRATION=1` against local oMLX — the message names the seeded neighborhood and price ceiling and ends with a question (SC-006)
- [ ] T025 [US2] Implement `triggerNow(scope, leadId)` in `src/services/followup.ts`, one Server Action in `src/app/(app)/leads/actions.ts`, and the drawer's `ActionsRow` button, disabled with the reason when nothing is pending (FR-017)
- [ ] T026 [US2] Add the stale demonstration lead's due `followup_jobs` row to spec 002's seed script (SC-009)
- [ ] T027 [US2] Verify SC-005–SC-009 per [quickstart.md](quickstart.md) §2, §3, §5, §6

**Checkpoint**: the sweep sends, recovers and caps correctly under concurrency; the demo trigger and stale-lead boot both work.
---

## Phase 5: User Story 3 — A broker sees the day's meetings (P2)

**Goal**: the agenda lists appointments grouped by day, scoped by role, with status actions.

**Independent Test**: open the agenda as a broker and as a manager; check grouping, rows and scoping; mark one appointment done and one cancelled.

- [ ] T028 [US3] Implement `listAppointments(scope, range)` in `src/services/scheduling.ts` — grouped by day (*Hoje*, *Amanhã*, weekday+date), broker sees own, manager sees the agency's, excludes `proposed` rows (FR-007, FR-008)
- [ ] T029 [US3] Implement `markAppointmentStatus(scope, appointmentId, status)` in `src/services/scheduling.ts`
- [ ] T030 [US3] Build `src/app/(app)/agenda/page.tsx`, `agenda.module.css` and `_components/AppointmentRow.tsx`, replacing spec 003's placeholder route
- [ ] T031 [US3] Add `markDone`/`markCancelled` Server Actions to the agenda page, each revalidating the route
- [ ] T032 [P] [US3] Write `tests/agenda-scope.test.ts` against Postgres — broker vs. manager scoping, ascending order within a day, empty-state copy when nothing lists
- [ ] T033 [US3] Verify US3's acceptance scenarios and SC-003 per [quickstart.md](quickstart.md) §4

**Checkpoint**: all three stories complete; a booked meeting is visible and actionable on the agenda.
---

## Phase 6: Polish

- [ ] T034 [P] Verify SC-010 — `tests/env-example.test.ts` passes with `FOLLOWUP_FIRST_DELAY_MINUTES` present and `FOLLOWUP_FIRST_DELAY_HOURS` gone
- [ ] T035 Run [quickstart.md](quickstart.md) start to finish on the running stack, confirming every scenario in it
- [ ] T036 [P] Confirm `npm run build` (or `docker build --target build .`, per spec 001's implementation note) succeeds
---

## Dependencies & Execution Order

### Phases

Setup → Foundational → US1 → US2 → US3 → Polish. US1 and US2 don't depend on each
other and could build in either order once Foundational is done; US1 comes first
since US2's eligibility tests are more valuable once US1 proves the transaction
pattern the collision check reuses. US3 needs US1's confirmed rows to list.

### Parallel opportunities

- Setup: T002, T003, T004 touch different files
- Foundational: T006 alongside T005
- US1: T013 is independent of T008–T012 once they exist
- US2: T022, T023, T024 are independent of each other and of T025–T026
- US3: T032 alongside T030–T031
- Polish: T034 and T036 alongside anything

## Implementation Strategy

**MVP is Setup + Foundational + US1** — a lead can be proposed times and booked,
which is the requirement the whole slice exists to satisfy. **US2 is the graded
scenario** and should follow immediately; US3 is worth doing once both P1 stories
are stable, since a broker cannot look at what does not yet exist.

## Notes

- Solo project: `[P]` means "no ordering constraint," not "assign to someone else"
- If a task needs a decision listed in `docs/decisoes-pendentes.md`, stop and ask
- The registry signature note in plan.md (`run(db, now)` vs. `run(ctx)`) must be resolved by T004 or T018, whichever runs first — do not let it drift into two shapes
