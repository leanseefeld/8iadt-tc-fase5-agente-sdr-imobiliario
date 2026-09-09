---
description: "Task list for the conversation slice"
---

# Tasks: Conversation

**Input**: Design documents from `/specs/004-conversation/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [contracts/](contracts/), [data-model.md](data-model.md), [quickstart.md](quickstart.md). **Spec 002 must be merged** — schema, migrations and seed.

**Tests**: Included, split in two. The `domain/` suites are written **before** their subjects — pure functions over a fixed script and fixed weights, the one place here where red-green is cheap. The scenario suites come last, because their subject is a real 4-bit model against a real database.

**Organization**: By user story; config, masking, the provider factory and the pure core sit in Foundational because every story imports them. Format is `[ID] [P?] [Story] Description`, where `[P]` means no ordering constraint and `[Story]` maps to [spec.md](spec.md).

## Phase 1: Setup

- [x] T001 Add `ai@7.0.93`, `@ai-sdk/openai-compatible@3.0.44`, `@ai-sdk/react@4.0.96`, `@langfuse/otel@5.11.0`, `@langfuse/tracing@5.11.0` and `@opentelemetry/sdk-trace-node` as exact pins in `package.json`
- [x] T002 Add the `test:integration` script (`INTEGRATION=1 node --test tests/integration/*.test.ts`) to `package.json`, leaving `npm test` on the fast suites
- [x] T003 [P] Add the eleven new keys from [contracts/config.md](contracts/config.md) to `src/core/config.ts` and to `.env.example` **in the same commit**, and change the `MODEL_ID` default to `gemma-4-e4b-it-OptiQ-4bit`

## Phase 2: Foundational — the pure core

**⚠️ Blocks every user story.** Nothing here touches a model, a database or React.

- [x] T004 [P] Write `tests/slots.test.ts` — script order per intent, first-empty-slot selection, and the five merge rules in [data-model.md](data-model.md) §2
- [x] T005 [P] Write `tests/score.test.ts` — the weight table and the three bands from `modelo-de-dados.md` §3, including the `qualified` boundary
- [x] T006 [P] Write `tests/reply-guards.test.ts` — an English reply, three questions, a second question that refines neither the pending nor the next slot, a price or a percentage no search returned, and leaked tool syntax are each rejected; a refining second question ("Quantos quartos? E suíte?") is accepted
- [x] T007 Implement the slot schema, script order, `mergeSlots` and `nextQuestion` (slot key plus pt-BR question text) in `src/domain/slots.ts`
- [x] T008 [P] Implement `scoreLead` and `temperature` in `src/domain/score.ts`
- [x] T009 [P] Implement the sentence-level guards in `src/domain/reply-guards.ts`: Portuguese by stopword ratio, a question-count check allowing a refining second question, a currency-and-percentage scan against an allowed set, tool-syntax scrubber
- [x] T010 [P] Implement `handoffDecision` in `src/domain/handoff.ts` — `asked`, `fallback`, or none; a hot score is deliberately not a trigger (ADR 19)
- [x] T011 [P] Implement `maskPII` in `src/core/security.ts` and write `tests/masking.test.ts` covering phone, e-mail, name and free text
- [x] T012 Wire `maskPII` into `src/core/logging.ts` as the serializer, so the rule has one definition and two sinks
- [x] T013 Implement `src/agent/provider.ts` — the only importer of `@ai-sdk/openai-compatible`, honouring `PROVIDER_AUTH_HEADER`, `MODEL_TIMEOUT_MS`, `MODEL_MAX_RETRIES`, `MODEL_MAX_OUTPUT_TOKENS`, and injecting `chat_template_kwargs: { enable_thinking: true }` when `MODEL_THINKING` is true

**Checkpoint**: `npm test` passes with no database and no model running.

## Phase 3: User Story 1 — Qualified one question at a time (P1) 🎯 MVP

**Goal / test**: a turn runs end to end through the service layer — call it directly with the Cenário 1 messages and assert slot state, one question per reply, no re-ask.

- [x] T014 [US1] Write the idempotency index migration in `src/db/migrations/` per [data-model.md](data-model.md) §5
- [x] T015 [US1] Implement `loadTurn` in `src/services/conversation.ts` — agency by slug, lead by `externalId`, active conversation, last `MODEL_HISTORY_WINDOW` messages, the session's message count within `CHAT_BUDGET_WINDOW_MINUTES`, all scoped by `agencyId`
- [x] T016 [US1] Implement `claimTurn` in `src/services/conversation.ts` — an `UPDATE … SET processingSince = now() WHERE processingSince IS NULL` that at most one caller wins, per FR-043
- [x] T017 [US1] Implement `commitTurn` in `src/services/conversation.ts` — one transaction answering every unanswered lead message, recording `repliesToMessageId`, writing slots, lead fields, `lead.status_changed` on a stage advance, the events of [data-model.md](data-model.md) §4 (`actorType`/`traceId`, `maskPII` on payloads), closed by a `NOTIFY` carrying only the conversation id (`visao-geral.md` §8)
- [x] T018 [US1] Implement duplicate detection in `src/services/conversation.ts` via the `clientMessageId` unique index — a repeat produces no second lead message and triggers no second turn (FR-035)
- [x] T019 [P] [US1] Write the pt-BR persona and turn prompt in `src/agent/prompts/system.ts` — one question per message, a second only to refine or preview a slot, acknowledge before asking, never invent a property or a price, refuse instruction overrides politely
- [x] T020 [P] [US1] Write the pt-BR fallback copy in `src/agent/prompts/fallback.ts` — model failure, not understood, the pre-consent template, the budget/length template, handoff
- [x] T021 [US1] Implement the `updateSlots` tool in `src/agent/tools/update-slots.ts` with its schema derived from `domain/slots.ts`, its result passed through `mergeSlots`
- [x] T022 [US1] Create the tool registry in `src/agent/tools/index.ts` and the scheduling stubs (`proposeMeeting`, `bookMeeting`) in `src/agent/tools/scheduling.stub.ts` — declared schemas returning "not yet available", so spec 006 edits two files and no others
- [x] T023 [US1] Implement `src/agent/recovery.ts` — one `generateObject` for the pending slot alone, run only when the lead's message plausibly answered it and no `updateSlots` arrived
- [x] T024 [US1] Implement `src/agent/orchestrator.ts` — load, compute, prompt, stream with tool calling, apply the guards at sentence boundaries, call `proposeMeeting` when the intent is `purchase`/`rental` with a hot score and known contact or when `investment`'s script ends (FR-040/041), decide handoff on the two remaining triggers, then commit
- [x] T025 [US1] Enforce the consent gate ahead of the model call: lead text before `consentAt` gets the fixed pt-BR template reply, no model call, not persisted as a turn; the script starts only once "Aceito" is recorded (FR-018/019)
- [x] T026 [US1] Register `unanswered-turns` in `src/jobs/consumers.ts` (create the registry per `modelo-de-dados.md` §6 if spec 005 has not merged it) — re-runs turns whose lead messages are older than `CHAT_DEBOUNCE_MS` with no live, non-stale `processingSince` (FR-046)
- [x] T027 [US1] Wire the consumer registry into `src/worker/index.ts`'s sweep loop, iterating with try/catch per consumer

**Checkpoint**: a turn runs and persists; nothing is visible in a browser yet.

## Phase 4: User Story 2 — A widget that feels human, and remembers (P1)

**Goal / test**: the public chat surface, real-time delivery, with continuity — chat, reload, confirm the transcript and the pending question survive.

- [x] T028 [US2] Define `ChannelAdapter`, `InboundMessage` and `OutboundMessage` in `src/channels/types.ts` per [contracts/chat-api.md](contracts/chat-api.md) §1 — `send` returns `Promise<void>`, delivery is no longer its job
- [x] T029 [US2] Implement the web adapter in `src/channels/web.ts` — `receive` normalises the request, `send` persists through the shared commit path
- [x] T030 [US2] Implement `src/core/notifier.ts` — one `LISTEN` connection per replica, an in-memory map of open streams by conversation id, `publish`/`subscribe` per [contracts/chat-api.md](contracts/chat-api.md) §4 and `visao-geral.md` §8
- [x] T031 [US2] Implement `POST /api/chat` in `src/app/api/chat/route.ts` — persists the lead message and returns `202`, or `200` with the fixed template reply pre-consent or over `CHAT_MESSAGE_BUDGET`/`CHAT_MAX_MESSAGE_CHARS`, per [contracts/chat-api.md](contracts/chat-api.md) §2
- [x] T032 [US2] Implement `GET /api/chat` in the same route handler — history for a session id, 404 for an unknown agency, empty list for an unknown session, per §3
- [x] T033 [US2] Implement `GET /api/chat/[conversationId]/events/route.ts` — the SSE stream: sentence-sized `chunk` events then a final `message` event, the 300–800 ms first-chunk delay, a pulse every `SSE_PULSE_INTERVAL_MS`, `goodbye` on `SIGTERM`, replay from `Last-Event-ID`, authorised by the signed widget session, per §4
- [x] T034 [US2] Implement the agency-resolving server component in `src/app/(public)/chat/[agencySlug]/page.tsx`, returning 404 for an unknown slug and importing no `db/`
- [x] T035 [US2] Implement `ChatWidget.tsx` — session id in `localStorage`, history on mount, an `EventSource` connection, the consent notice with its "Aceito" button as the first bubble, message state `enviando → recebido`, a typing indicator from turn start to first `chunk`, "Conexão perdida. Reconectando…" with sending disabled after two missed pulses, and — when a `message` event's `repliesToMessageId` is not the lead's latest — quoting that message's first line atop the bubble (FR-045)
- [x] T036 [P] [US2] Write the widget stylesheet as CSS Modules — warm, mobile-first, no component library and no Tailwind
- [x] T037 [US2] Verify SC-005 by hand per [quickstart.md](quickstart.md) §2 — reload and `docker compose restart app`, and the pending question does not move

## Phase 5: User Story 3 — The properties shown are real (P2)

**Goal / test**: at most three catalog properties as cards — run Cenário 1 to the search and confirm every card matches a seeded row satisfying the filters.

- [x] T038 [US3] Implement the `searchProperties` tool in `src/agent/tools/search-properties.ts`, calling spec 002's `services/properties.searchProperties` scoped by agency, capped at three, never invoked for `investment` (FR-024)
- [ ] T039 [US3] Record the suggestion in `commitTurn` — `properties.suggested` plus `propertyIds` in the agent message metadata
- [ ] T040 [P] [US3] Implement `PropertyCard.tsx` with the payload of [contracts/chat-api.md](contracts/chat-api.md) §5 and BRL formatting in the component
- [ ] T041 [US3] Handle the empty result: the agent says so and offers to relax exactly one filter, with no cards rendered
- [ ] T042 [US3] Verify SC-004 per [quickstart.md](quickstart.md) §2 — every code shown exists in `properties` and satisfies the stated filters

## Phase 6: User Story 4 — The conversation always has a way out (P2)

**Goal / test**: handoff, opt-out, refusal and the message budget decided in code — the three scripted conversations in [quickstart.md](quickstart.md) §3 each reach their terminal state, and a hot lead is offered a meeting instead of a handoff.

- [ ] T043 [P] [US4] Implement the `requestHandoff` tool in `src/agent/tools/handoff.ts` (`asked`, `fallback`) and the `optOut` tool in `src/agent/tools/opt-out.ts`
- [ ] T044 [US4] Wire `handoffDecision` into the orchestrator — set `conversations.status = paused` with `heldByUserId` null, emit `handoff.requested` with its reason, and maintain `fallbackStreak` in `commitTurn`
- [ ] T045 [US4] Verify the `proposeMeeting` paths: hot score plus known contact for `purchase`/`rental`, and the end of the `investment` script — the conversation stays `active` in both (FR-040/041)
- [ ] T046 [US4] Enforce `CHAT_MESSAGE_BUDGET`/`CHAT_BUDGET_WINDOW_MINUTES` and `CHAT_MAX_MESSAGE_CHARS` in `POST /api/chat` — the fixed template reply, no model call, nothing persisted
- [ ] T047 [US4] Verify SC-006 and SC-007 per [quickstart.md](quickstart.md) §3 — the two handoff paths and opt-out each reach their terminal state, a paused conversation produces zero further agent messages, and the five scripted injection attempts each yield a refusal with unchanged slots, no figure quoted, and the layer that caught it recorded

## Phase 7: User Story 5 — Every turn can be inspected afterwards (P3)

**Goal / test**: the trace shape of [contracts/observability.md](contracts/observability.md), and an application that does not notice when it is gone — one conversation with the profile up, then the same with the keys unset.

- [ ] T048 [US5] Implement `src/core/langfuse.ts` — tracer provider and span processor with `maskPII` as the mask, registered only when all three `LANGFUSE_*` keys are present, flushed with a bounded timeout on shutdown
- [ ] T049 [US5] Register it from `src/instrumentation.ts` and from `src/worker/index.ts`
- [ ] T050 [US5] Attach the AI SDK telemetry option to every model call with the trace name and the agency, lead and conversation attributes of [contracts/observability.md](contracts/observability.md) §1
- [ ] T051 [US5] Add the `observability` Compose profile to `docker-compose.yml` — `langfuse-web`, `langfuse-worker`, `clickhouse`, `redis`, `minio`, each with a `mem_limit` summing to 6 GiB, UI on `LANGFUSE_UI_PORT`
- [ ] T052 [US5] Add the Langfuse database init script under `scripts/db/` and mount it into the `db` container
- [ ] T053 [US5] Verify SC-010, SC-011 and SC-012 per [quickstart.md](quickstart.md) §6, and record the measured memory total in `docs/arquitetura/restricoes-de-implantacao.md` §4

## Phase 8: Polish and acceptance

- [ ] T054 Write `tests/integration/scenario-purchase.test.ts` — Cenário 1 through `services/conversation.ts` against the local model, asserting SC-001, SC-003, SC-004 and the `proposeMeeting` call at the end
- [ ] T055 [P] Write `tests/integration/scenario-investment.test.ts` — Cenário 2, asserting SC-002, SC-003, no catalog search, and `proposeMeeting` called for a call with a specialist
- [ ] T056 [P] Write `tests/integration/turn-persistence.test.ts` — idempotency (SC-008), the message budget, the provider-outage fallback (SC-009), and `unanswered-turns` recovering a turn left with a stale `processingSince`
- [ ] T057 Confirm `npm run lint` and `docker build --target build .` both pass — the dependency rule and the only type-checking gate this project has
- [ ] T058 Update `README.md` with the widget URL and the observability profile, and mark item 004 in `specs/BACKLOG.md`

## Dependencies & Execution Order

Setup → Foundational → US1 → US2 → US3 → US4 → US5 → Polish.

- **US1 needs Foundational entirely.** The orchestrator is meaningless without the slot machine and the guards.
- **US2 needs US1.** The widget renders a turn; there has to be a turn, and `core/notifier.ts` (T030) needs `commitTurn`'s closing `NOTIFY` (T017) to have something to listen for.
- **US3 and US4 both extend the orchestrator** and touch `tools/index.ts` and `ChatWidget.tsx`, so they are sequential rather than parallel despite being independently testable.
- **US5 depends on nothing but US1** and can move earlier if the observability profile turns out to be the risky part — it is the one phase whose position is negotiable.
- **T003 is a single commit** with `.env.example`; splitting it is the drift the Environment Contract gate exists to catch.
- **T026 and T027 depend on T016 and T017** (`processingSince`, `NOTIFY`) — the consumer re-runs exactly what the route handler would have.

**Parallel opportunities**: T004–T006 together; T008–T011 together; T019 and T020 alongside T021; T036 and T040 alongside their phases; T055 and T056 together.

## Implementation Strategy

**MVP is Setup + Foundational + US1 + US2** — a lead can chat and be qualified. That is the demonstration; US3 makes it credible, US4 makes it safe, US5 makes it explicable.

Stop at each checkpoint. If a turn regresses, the fast `domain/` suites are the first thing to run, because they answer "is it the code or is it the model" in under a second.

## Notes

- Everything runs as `docker compose exec app …`; the host has no usable Node, and the scenario suites are slow by design — keep them out of `npm test`
- If a task appears to need a decision, `docs/decisoes-pendentes.md` is empty, so the answer is in `modelo-de-dados.md` or an ADR
