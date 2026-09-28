# Tasks: Scheduling and Follow-up

**Feature**: `006-scheduling-followup` | **Spec**: [spec.md](spec.md) | **Plan**: [plan.md](plan.md)

**Regenerated 2026-09-28** after spec 007 merged. It replaces the 2026-09-06 list, which hedged against specs
004 and 005 not being merged yet and wired proposing and booking into 004's turn. Everything this slice plugs
into now exists: see plan.md, *Where this slice plugs into what exists*.

## The shape of it

| Phase | Tasks | Story | Closes |
|---|---|---|---|
| 1 · Setup | T001–T003 | — | SC-010 |
| 2 · Foundational — slots and the one appointment row | T004–T010 | — | SC-002, SC-004 |
| 3 · Propose, book, and the three ways out | T011–T022 | **US1 (P1)** | SC-001, SC-003, SC-012, SC-013 |
| 4 · Follow-up — graded scenario 3 | T023–T032 | **US2 (P1)** | SC-005–SC-009 |
| 5 · Agenda | T033–T036 | US3 (P2) | SC-003 (agenda half) |
| 6 · Replay, records, verification | T037–T041 | — | all, end to end |

**MVP checkpoint is the end of Phase 4.** US1 and US2 are both P1: the minimum in the challenge statement needs
a booked meeting *and* an automatic follow-up. **Spec 009 starts the day after this lands** (backlog, plan
step 3a), so Phase 2's rule is non-negotiable: every time is validated by one function, and booking is
transitions of one appointment row.

## Conventions

- Run every test in the container: `docker compose exec -T app npm test`. On the host, test files that import
  services fail at load time because `DATABASE_URL`/`AUTH_SECRET` are unset. That's the environment, not a
  regression.
- Model-dependent tests are tagged `INTEGRATION=1` and run against local `gemma-4-e4b-it-OptiQ-4bit`.
- After changing code the worker runs, restart it (`docker compose restart worker`). It does not hot-reload the
  way the app's `next dev` does.
- Every task that edits `run()` in `src/agent/orchestrator.ts` is sequential with every other such task:
  T013, T015, T016, T018, T021.

---

## Phase 1: Setup

- [ ] T001 Record the starting baseline in a new `specs/006-scheduling-followup/implementation-log.md`: `docker compose exec -T app npm test` pass/fail/skip counts, plus `npm run lint` and `npx tsc --noEmit`, on the branch before any change. 007 closed at 229 pass
- [ ] T002 Environment Contract, in **one commit** (FR-018, SC-010). In `src/core/config.ts`: replace `FOLLOWUP_FIRST_DELAY_HOURS` with `FOLLOWUP_FIRST_DELAY_MINUTES`, and add `FOLLOWUP_BATCH_SIZE`, `FOLLOWUP_BACKOFF_FACTOR`, `SCHEDULING_MIN_NOTICE_MINUTES` and `SCHEDULING_PREFERRED_TIMES` per [contracts/interfaces.md](contracts/interfaces.md) §5. Mirror them in `.env.example`, and keep `tests/env-example.test.ts` passing with the replaced key gone. Demo values (`FOLLOWUP_FIRST_DELAY_MINUTES=5`, `WORKER_SWEEP_INTERVAL_MS=15000`) stay in [quickstart.md](quickstart.md) §0, not in `.env.example`
- [ ] T003 [P] Add the two partial indexes from [data-model.md](data-model.md) §1 — `followup_jobs_claim_idx` and `appointments_broker_busy_idx` — to `src/db/schema.ts`, generate the migration with `npm run db:generate` into `src/db/migrations/`, and confirm `docker compose exec -T app npm run db:migrate` applies it

---

## Phase 2: Foundational — slots and the one appointment row

**Blocks US1 and US2.** US2's eligibility check needs "a confirmed future appointment", which exists only once
booking does.

- [ ] T004 [P] Write `tests/scheduling.test.ts`: `proposeSlots` over **200 generated cases** of broker availability and busy calendars. Zero options collide with a confirmed appointment, zero fall on a day or hour the broker has not enabled, zero fall inside `SCHEDULING_MIN_NOTICE_MINUTES`, never more than three, preferred times first (SC-002). Also cover the preference filter: a weekday or a period (`morning` before 12:00, `afternoon` after) only narrows the options, never widens them
- [ ] T005 [P] Write `tests/rotation.test.ts`: `nextBrokerInRotation` picks the minimum count with ties broken by list order. Across 30 simulated assignments restricted to one specialization, counts differ by at most one. When no broker matches, it falls back to the full roster (SC-004)
- [ ] T006 (FR-002) Implement `src/domain/scheduling.ts` per [contracts/interfaces.md](contracts/interfaces.md) §1: `proposeSlots(busy, now, rules)`, `nextBrokerInRotation`, `isWithinWindow`, `nextWindowOpening`, and a pure `filterByPreference(options, { weekday?, period? })`. Every rule is an argument, with no config read and no clock read inside `domain/`. Search ten business days forward (Mon–Fri, no holidays). Satisfies T004 and T005
- [ ] T007 Implement `loadBusyIntervals(brokerId)` and `loadBrokerAvailability(brokerId)` in `src/services/scheduling.ts`. Only confirmed appointments count as busy (FR-004); availability is the seeded `users.availability` — nothing writes it (backlog 34)
- [ ] T008 Implement `proposeAppointment(ctx)` in `src/services/scheduling.ts` per [contracts/interfaces.md](contracts/interfaces.md) §3. It assigns a broker by rotation among those whose `specializations` include the lead's intent, falling back to all brokers (FR-003). It **upserts the conversation's single `proposed` row**, so a further proposal replaces the previous one instead of accumulating (FR-004). For `investment` it forces `type: 'call'` with no property (FR-003a). It applies the optional constraint through `filterByPreference`, emits `appointment.proposed`, and returns `{ unavailable, reason }` for no brokers, no free hour, or a constraint nothing satisfies (FR-001)
- [ ] T009 Implement `bookAppointment` and `declineProposal` in `src/services/scheduling.ts` as **transitions of that one row**:
  - **Booking** validates the chosen index or explicit time through **the same function `proposeAppointment` uses** — there is no second validation path (FR-002). It moves `proposed → confirmed` inside a transaction that checks for a collision, sets the lead's pipeline stage to `scheduled` whatever the conversation state (FR-006), and emits `appointment.confirmed`. A failure returns its reason and touches no row (FR-005).
  - **Declining** moves `proposed → cancelled` (FR-005a).
  - Put a comment at the transition function saying that spec 009's reschedule (`confirmed → confirmed` at a new instant) and cancel (`confirmed → cancelled`) must go through it (plan step 3a)
- [ ] T010 [P] Write `tests/scheduling-service.test.ts` against the container's Postgres:
  - a losing second booking of the same hour fails with a reason;
  - a re-proposal replaces rather than accumulates;
  - rotation counts stay even;
  - `investment` always yields a `call` with no property;
  - a decline leaves the row `cancelled`;
  - booking an explicit time that `proposeSlots`' rules reject fails even when that time looks free

---

## Phase 3: User Story 1 — Real times, and the three ways out (P1)

**Goal**: at the moment of interest the lead gets three concrete, code-written options and books one by
answering in their own words — or declines, asks for other times, or changes the subject, without the offer
taking over.

**Independent test**: [quickstart.md](quickstart.md) §1 and §1a.

- [ ] T011 [US1] Create `src/agent/prompts/meeting.ts` with the **code-written** pt-BR sentences (FR-005d). The options sentence names the broker's first name, weekday, date and time in the agency timezone, and the type — for example *"Tenho estes horários com a Ana: 1) qui 02/10 às 10h · 2) qui 02/10 às 14h · 3) sex 03/10 às 10h. Qual fica melhor?"* A call says *"conversa"*, a viewing *"visita"*. Also the confirmation sentence, and the no-options sentence that asks the lead for a time (FR-001)
- [ ] T012 [US1] Add `declinedOffer`, `askedForTimes` and the optional `timePreference { weekday?, period? }` to the extraction contract in `src/agent/tools/update-slots.ts`. Describe them in the extraction prompt in `src/agent/prompts/system.ts`: `askedForTimes` covers *"tem outro horário?"*, *"só de manhã"* **and** an explicit *"quero marcar uma visita"*. Read them in `src/agent/orchestrator.ts` with the same `isTrue` coercion as `askedForHuman`, per [contracts/interfaces.md](contracts/interfaces.md) §3
- [ ] T013 [US1] In `run()` in `src/agent/orchestrator.ts`, call `proposeAppointment` where `runProposeMeeting()` is called today, when `shouldProposeMeeting` fires (FR-004a). Carry the options sentence to `task()` to be said verbatim. On `unavailable`, use FR-001's path: say the no-options sentence and raise a handoff
- [ ] T014 [US1] In `task()` in `src/agent/prompts/system.ts`, replace the viewing and call branches' *"pergunte qual dia da semana é melhor"* with saying the options sentence verbatim, as the reconfirmation branch already does. Add the confirmation branch
- [ ] T015 [US1] Handle `declinedOffer` in `run()`:
  - call `declineProposal`, acknowledge without insisting, and don't count the turn as a misunderstanding (FR-005a).
  - Confirm that `offerOutstanding` in `src/services/conversation.ts` stays true after the row is cancelled, because the earlier offer message still records `meeting`, so the agent never re-offers on its own. Add a note there that this depends on the offer message staying inside the loaded history window
- [ ] T016 [US1] Handle `askedForTimes` in `run()`. With or without an open proposal, call `proposeAppointment` with the `timePreference` as its constraint, bypassing `shouldProposeMeeting` (FR-005b, and FR-005a's "the lead can still ask"). The new proposal replaces the old one, and the new options sentence is said
- [ ] T017 [US1] Create `src/agent/tools/book-meeting.ts`: the `bookMeeting({ optionIndex } | { scheduledAt })` tool, **contract first**, meeting the five points in spec 007's [contracts/interfaces.md](../007-revisable-orchestration/contracts/interfaces.md) §5. Its description states when to call (the lead picked an offered option or named a time while a proposal is open) and when not to (no open proposal; the lead is talking about something else). It returns 007's `ToolRefusal` shape with the validation reason when booking fails. Agency and conversation come from the turn context, never from arguments (FR-005)
- [ ] T018 [US1] Register `bookMeeting` in `actionTools()` in `src/agent/tools/index.ts` and delete `src/agent/tools/scheduling.stub.ts`. In `run()`, offer `act()` when a search is due **or** `turn.appointmentProposed` is true. Give `act()` a briefing that names which tool is relevant this turn
- [ ] T019 [US1] Bring-up, obvious case, as an `INTEGRATION=1` test in `tests/integration/booking.test.ts`: qualify, receive the options, answer *"a segunda"*. Assert that exactly one `bookMeeting` step ran, the row is `confirmed`, the lead's stage is `scheduled`, and the reply is the confirmation. Record in the implementation log whether e4b drove the tool unaided (spec 007 FR-030's escalation rule applies if not: narrow the contract first)
- [ ] T020 [US1] Bring-up, refusal path, in `tests/integration/booking.test.ts`: a named time outside availability, and a second lead taking the same hour, each come back as a readable refusal and a fresh proposal, and no row is confirmed (FR-005)
- [ ] T021 [US1] Change of subject (FR-005c). After the offer turn, `task()` must not say the options again. `run()` keeps offering `act()` while the proposal is open, so a later pick still books. Verify that a revision after an offer is handled by 007's normal path (search, cards, no-match) with the proposal left `proposed`
- [ ] T022 [US1] Render the booked meeting as a compact card in the widget: in `src/app/(public)/chat/[agencySlug]/ChatWidget.tsx` (a new `MeetingCard.tsx` beside `PropertyCard.tsx`), from the confirmation message's metadata written by `commitTurn` in `src/services/conversation.ts`. It shows weekday, date, time, type and — for a viewing — the property code (FR-006)
- [ ] T022a [P] [US1] Write `tests/integration/meeting-escapes.test.ts` (`INTEGRATION=1`), covering quickstart §1a: a decline followed by three unrelated messages gets no new offer; *"tem outro horário? só de manhã"* gets a replacing, all-morning proposal; after a change of subject the options aren't repeated, and *"pode ser aquela de quinta"* two turns later books (SC-013)

**Checkpoint — US1**: SC-001, SC-003's first half, SC-012 and SC-013 hold. Scenarios 1 and 2 end in a booked
meeting.

---

## Phase 4: User Story 2 — Reopening a stalled conversation (P1, graded scenario 3)

**Goal**: a lead who goes quiet is written to again, with context, up to three times, never outside the window
and never after an opt-out. A drawer button makes it happen immediately for the demo.

**Independent test**: [quickstart.md](quickstart.md) §2, §3, §5 and §6.

- [ ] T023 [US2] Implement `scheduleFollowup(tx, conversationId, now)` and `cancelFollowup(tx, conversationId)` in `src/services/followup.ts` per [contracts/interfaces.md](contracts/interfaces.md) §2:
  - **Schedule** upserts keyed by conversation at `now + FOLLOWUP_FIRST_DELAY_MINUTES` and sets `followupState = 'pending'`. It is guarded in the statement's own `where`: paused or closed conversation, opted out, a confirmed future appointment, attempts at the max, nothing pending (FR-009).
  - **Cancel** cancels every pending row and resets `followupAttempts` to zero and `followupState` to `none`. It emits `followup.recovered` and recomputes the lead's stage out of *Sem resposta* when one was already sent (FR-010)
- [ ] T024 [US2] Wire both into `commitTurn` in `src/services/conversation.ts`:
  - schedule at the end of an agent turn that leaves the lead a pending question, or an open proposal as the last thing asked;
  - cancel on every inbound lead message.
  In `src/services/handoff.ts`'s `conversation.returned` path, schedule again when something is still open (FR-009a). An appointment reaching done or cancelled never schedules
- [ ] T025 [US2] Implement the consumer in `src/jobs/followup.ts`: claim with `for update skip locked`, batch size `FOLLOWUP_BATCH_SIZE`, and move claimed rows to `running`. Re-check eligibility right after claiming (FR-012). Outside the window, move to `nextWindowOpening` with the attempt unchanged; any other failed check cancels without sending (FR-013). Register it in `src/jobs/consumers.ts` and report in the structured log (FR-011)
- [ ] T026 [US2] Implement `src/agent/followup-writer.ts`: compose from the stored summary, falling back to slot state, through `src/agent/provider.ts`. Name a concrete detail and end with the pending question (FR-014). Mask via `src/core/masking.ts`. Telemetry: trace `followup.send`, session id = conversation id. Model and channel failures come back as results, not exceptions
- [ ] T027 [US2] In `src/jobs/followup.ts`, after composing, re-run eligibility once more — the lead may have replied mid-composition — then deliver through `ChannelAdapter.send` and the Notifier/SSE path, never a poll (FR-015). Store the message with `metadata.isFollowUp = true`, increment `followupAttempts`, and emit `followup.sent` with `actorType: 'worker'` and the writer's `traceId`. Schedule the next attempt at `FOLLOWUP_BACKOFF_FACTOR` × the interval, or set `followupState = 'exhausted'` at the max (FR-016). On a model or channel failure, leave the row `pending` at its original time with no attempt consumed (FR-013)
- [ ] T028 [P] [US2] Write `tests/followup-claim.test.ts` against Postgres: two concurrent claimers over 100 due rows — 100 processed, zero duplicated, zero lost (SC-005)
- [ ] T029 [P] [US2] Write `tests/followup-eligibility.test.ts` against Postgres. Due outside the window, opted out, paused conversation, and a confirmed future appointment each send nothing. The one outside the window reschedules with its attempt number unchanged (SC-007). A lead replying after a follow-up is counted as recovered **exactly once**, leaving `followupState` `none` and `followupAttempts` zero, clear of *Sem resposta*, in the same turn (SC-008)
- [ ] T030 [P] [US2] Write `tests/followup-writer.integration.test.ts` (`INTEGRATION=1`): from a seeded summary, the message names the neighbourhood and the price ceiling and ends with a question (SC-006)
- [ ] T031 [US2] Demo trigger (FR-017): `triggerNow(scope, leadId)` in `src/services/followup.ts`, one Server Action in `src/app/(app)/leads/actions.ts`, and one button in `src/app/(app)/leads/_components/ActionsRow.tsx`. When nothing is pending the button is disabled and explains why
- [ ] T032 [US2] In `src/db/seed/index.ts`, give the stale demonstration lead (already seeded with `followupState: "pending"`) its due `followup_jobs` row, so the first sweep after a fresh start sends a follow-up unaided (SC-009)

**Checkpoint — MVP**: all three graded scenarios and all eight functional requirements of the challenge
statement are met. **Spec 009 can start.**

---

## Phase 5: User Story 3 — A broker sees the day's meetings (P2)

**Goal**: *Agenda* lists booked meetings by day, scoped to the broker, or to the agency for a manager.

**Independent test**: [quickstart.md](quickstart.md) §4, minus its cut step 5.

- [ ] T033 [US3] Implement `listAppointments(scope, range)` and `markAppointmentStatus(scope, appointmentId, status)` in `src/services/scheduling.ts`:
  - grouped by day — *Hoje*, *Amanhã*, then weekday and date — ascending within a day, excluding `proposed`;
  - a broker sees their own, a manager the agency's (FR-007, FR-008).
  `done` also sets the lead's stage to `visited`; both transitions go through T009's transition function and emit their event with `actorType: 'user'` and `actorUserId`
- [ ] T034 [US3] Replace spec 003's placeholder with `src/app/(app)/agenda/page.tsx`, `src/app/(app)/agenda/agenda.module.css` and `src/app/(app)/agenda/_components/AppointmentRow.tsx`. Each row shows time, lead name, meeting type, property code with neighbourhood, and status, plus explanatory copy when empty (FR-007). Per constitution principle X: the broker came to see today, so today comes first and is readable at 390 px
- [ ] T035 [US3] Add `markDone` and `markCancelled` Server Actions in `src/app/(app)/agenda/actions.ts`, each revalidating the route
- [ ] T036 [P] [US3] Write `tests/agenda-scope.test.ts` against Postgres: broker vs. manager scoping, ascending order within a day, `proposed` rows never listed, empty-state copy when nothing is listed

---

## Phase 6: Replay, records and verification

- [ ] T037 Replay 006's conversations through the real API, following spec 007's closing harness: a Node script in the session scratchpad that `POST`s to `/api/chat` (`agencySlug: "demo"`, `consent: true`) and reads replies back via `GET /api/chat?agencySlug=demo&sessionId=…`, **up to 4 conversations in parallel**. Cover:
  - scenario 1 to a booking (SC-001, and SC-003's first half);
  - scenario 2 to a specialist call (SC-012);
  - the escape routes (SC-013);
  - one conversation left idle so the sweep writes to it — with `FOLLOWUP_FIRST_DELAY_MINUTES=5` and `WORKER_SWEEP_INTERVAL_MS=15000`, restarting the worker first.
  Report transcripts with each turn's stored flags in the implementation log
- [ ] T038 Run [quickstart.md](quickstart.md) end to end on the running stack, including the drawer's *send the follow-up now* button and the stale lead's first-sweep follow-up (SC-009)
- [ ] T039 [P] Confirm SC-010 and the build: `docker compose exec -T app npm test` green, `npm run lint`, `npx tsc --noEmit` and `npm run build` all succeed
- [ ] T040 [P] Update `specs/BACKLOG.md`: the 006 row's status, and a note that 009 starts next on top of plan step 3a
- [ ] T041 Record in the implementation log anything the replay or the quickstart contradicted in the spec, and stop for direction if any of it changes a requirement

---

## Dependencies

```
Setup (T001–T003)
   └─> Foundational (T004–T010) — the slot function and the one-row transitions
          ├─> US1 (T011–T022a) — propose in code, book by tool, three ways out
          │      └─> US2 (T023–T032) — follow-up; its eligibility needs confirmed bookings
          │             └─> MVP checkpoint → spec 009 may start
          └─> US3 (T033–T036) — needs only Phase 2; may run beside US2
                 └─> Phase 6 (T037–T041)
```

**Hard ordering constraints:**

- **T017 before T018.** The tool's contract is written before it goes on the loop, so a failure can be blamed on the loop and not on an ambiguous schema (Gemma playbook; 007 FR-013a).
- **T019 before T020.** Obvious case first, refusal path second — the playbook's bring-up order.
- **T009 before every task that changes an appointment's status.** T013, T015, T016, T018 and T033 all go through its transition function. That is what keeps 009 small.
- **T012 before T015 and T016.** They act on the facts it adds.

## Parallel opportunities

- T003 beside T002.
- T004 and T005 — separate new test files.
- T010, T022a, T028, T029, T030, T036 — separate test files, once their code exists.
- US3 (T033–T036) beside US2, once Phase 2 is done. They touch different files, apart from `src/services/scheduling.ts`, which T033 extends and US2 doesn't edit.
- T039 and T040.

## Implementation strategy

1. **Phases 1–2**, then stop and run the suite. The slot function and the transitions are pure or near-pure, and SC-002's 200 cases prove them without a model.
2. **Phase 3 (US1).** The one new tool comes up alone. If e4b won't drive it after the contract is narrowed, 007's escalation order applies: contract, then the 12B model, then Azure.
3. **Phase 4 (US2)** — the graded scenario. **This is the MVP line and the moment 009 can start.**
4. **Phase 5 (US3)**, then **Phase 6**, including the parallel replay.
