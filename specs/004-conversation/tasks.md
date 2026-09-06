---
description: "Task list for the conversation slice"
---

# Tasks: Conversation

**Input**: Design documents from `/specs/004-conversation/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [contracts/](contracts/), [data-model.md](data-model.md), [quickstart.md](quickstart.md). **Spec 002 must be merged** — schema, migrations and seed.

**Tests**: Included, split in two. The `domain/` suites are written **before** their subjects — pure functions over a fixed script and fixed weights, the one place here where red-green is cheap. The scenario suites come last, because their subject is a real 4-bit model against a real database.

**Organization**: By user story; config, masking, the provider factory and the pure core sit in Foundational because every story imports them. Format is `[ID] [P?] [Story] Description`, where `[P]` means no ordering constraint and `[Story]` maps to [spec.md](spec.md).

## Phase 1: Setup

- [ ] T001 Add `ai@7.0.93`, `@ai-sdk/openai-compatible@3.0.44`, `@ai-sdk/react@4.0.96`, `@langfuse/otel@5.11.0`, `@langfuse/tracing@5.11.0` and `@opentelemetry/sdk-trace-node` as exact pins in `package.json`
- [ ] T002 Add the `test:integration` script (`INTEGRATION=1 node --test tests/integration/*.test.ts`) to `package.json`, leaving `npm test` on the fast suites
- [ ] T003 [P] Add the seven new keys from [contracts/config.md](contracts/config.md) to `src/core/config.ts` and to `.env.example` **in the same commit**, and change the `MODEL_ID` default to `gemma-4-e4b-it-OptiQ-4bit`

## Phase 2: Foundational — the pure core

**⚠️ Blocks every user story.** Nothing here touches a model, a database or React.

- [ ] T004 [P] Write `tests/slots.test.ts` — script order per intent, first-empty-slot selection, and the five merge rules in [data-model.md](data-model.md) §2
- [ ] T005 [P] Write `tests/score.test.ts` — the weight table and the three bands from `modelo-de-dados.md` §3, including the `qualified` boundary
- [ ] T006 [P] Write `tests/reply-guards.test.ts` — an English reply, two questions, a price no search returned, and leaked tool syntax are each rejected
- [ ] T007 Implement the slot schema, script order, `mergeSlots` and `nextQuestion` (slot key plus pt-BR question text) in `src/domain/slots.ts`
- [ ] T008 [P] Implement `scoreLead` and `temperature` in `src/domain/score.ts`
- [ ] T009 [P] Implement the sentence-level guards in `src/domain/reply-guards.ts`: Portuguese by stopword ratio, cumulative question count, currency scan against an allowed set, tool-syntax scrubber
- [ ] T010 [P] Implement `handoffDecision` in `src/domain/handoff.ts` — `asked`, `fallback`, `score`, or none
- [ ] T011 [P] Implement `maskPII` in `src/core/security.ts` and write `tests/masking.test.ts` covering phone, e-mail, name and free text
- [ ] T012 Wire `maskPII` into `src/core/logging.ts` as the serializer, so the rule has one definition and two sinks
- [ ] T013 Implement `src/agent/provider.ts` — the only importer of `@ai-sdk/openai-compatible`, honouring `PROVIDER_AUTH_HEADER`, `MODEL_TIMEOUT_MS` and `MODEL_MAX_RETRIES`

**Checkpoint**: `npm test` passes with no database and no model running.

## Phase 3: User Story 1 — Qualified one question at a time (P1) 🎯 MVP

**Goal / test**: a turn runs end to end through the service layer — call it directly with the Cenário 1 messages and assert slot state, one question per reply, no re-ask.

- [ ] T014 [US1] Write the idempotency index migration in `src/db/migrations/` per [data-model.md](data-model.md) §5
- [ ] T015 [US1] Implement `loadTurn` in `src/services/conversation.ts` — agency by slug, lead by `externalId`, active conversation, last `CHAT_HISTORY_WINDOW` messages, per-minute lead-message count, all scoped by `agencyId`
- [ ] T016 [US1] Implement `commitTurn` in `src/services/conversation.ts` — one transaction writing both messages, slots, lead fields and the events of [data-model.md](data-model.md) §4, with `maskPII` on payloads
- [ ] T017 [US1] Implement `findStoredReply` in `src/services/conversation.ts`, keyed on `clientMessageId`
- [ ] T018 [P] [US1] Write the pt-BR persona and turn prompt in `src/agent/prompts/system.ts` — one question per message, acknowledge before asking, never invent a property or a price, refuse instruction overrides politely
- [ ] T019 [P] [US1] Write the pt-BR fallback copy in `src/agent/prompts/fallback.ts` — model failure, not understood, consent gate, handoff
- [ ] T020 [US1] Implement the `updateSlots` tool in `src/agent/tools/update-slots.ts` with its schema derived from `domain/slots.ts`, its result passed through `mergeSlots`
- [ ] T021 [US1] Create the tool registry in `src/agent/tools/index.ts` and the scheduling stubs in `src/agent/tools/scheduling.stub.ts` — declared schemas returning "not yet available", so spec 006 edits two files and no others
- [ ] T022 [US1] Implement `src/agent/recovery.ts` — one `generateObject` for the pending slot alone, run only when the lead's message plausibly answered it and no `updateSlots` arrived
- [ ] T023 [US1] Implement `src/agent/orchestrator.ts` — load, compute, prompt, stream with tool calling, apply the guards at sentence boundaries, replace an offending sentence with the deterministic reply, then commit
- [ ] T024 [US1] Verify the consent gate: with `consentAt` null the script stops before `name`, and the reply points at the banner instead of asking

**Checkpoint**: a turn runs and persists; nothing is visible in a browser yet.

## Phase 4: User Story 2 — A widget that feels human, and remembers (P1)

**Goal / test**: the public chat surface, streaming, with continuity — chat, reload, confirm the transcript and the pending question survive.

- [ ] T025 [US2] Define `ChannelAdapter`, `InboundMessage` and `OutboundMessage` in `src/channels/types.ts` per [contracts/chat-api.md](contracts/chat-api.md) §1
- [ ] T026 [US2] Implement the web adapter in `src/channels/web.ts` — `receive` normalises the request, `send` is the streamed response, and the 300–800 ms first-token delay lives here, not in the widget
- [ ] T027 [US2] Implement `POST /api/chat` in `src/app/api/chat/route.ts` — runs a turn, streams the reply with the turn's card and paused data, and returns the status codes of [contracts/chat-api.md](contracts/chat-api.md) §2
- [ ] T028 [US2] Implement `GET /api/chat` in the same route handler — history for a session id, 404 for an unknown agency, empty list for an unknown session
- [ ] T029 [US2] Implement the agency-resolving server component in `src/app/(public)/chat/[agencySlug]/page.tsx`, returning 404 for an unknown slug and importing no `db/`
- [ ] T030 [US2] Implement `ChatWidget.tsx` — session id in `localStorage`, history on mount, bubbles, typing indicator, composer, opt-in banner whose acceptance sends `consent: true`
- [ ] T031 [P] [US2] Write the widget stylesheet as CSS Modules — warm, mobile-first, no component library and no Tailwind
- [ ] T032 [US2] Verify SC-005 by hand per [quickstart.md](quickstart.md) §2 — reload and `docker compose restart app`, and the pending question does not move

## Phase 5: User Story 3 — The properties shown are real (P2)

**Goal / test**: at most three catalog properties as cards — run Cenário 1 to the search and confirm every card matches a seeded row satisfying the filters.

- [ ] T033 [US3] Implement the `searchProperties` tool in `src/agent/tools/search-properties.ts`, calling spec 002's `services/properties.searchProperties` scoped by agency, capped at three
- [ ] T034 [US3] Record the suggestion in `commitTurn` — `properties.suggested` plus `propertyIds` in the agent message metadata
- [ ] T035 [P] [US3] Implement `PropertyCard.tsx` with the payload of [contracts/chat-api.md](contracts/chat-api.md) §4 and BRL formatting in the component
- [ ] T036 [US3] Handle the empty result: the agent says so and offers to relax exactly one filter, with no cards rendered
- [ ] T037 [US3] Verify SC-004 per [quickstart.md](quickstart.md) §2 — every code shown exists in `properties` and satisfies the stated filters

## Phase 6: User Story 4 — The conversation always has a way out (P2)

**Goal / test**: handoff, opt-out, refusal and rate limiting decided in code — the four scripted conversations in [quickstart.md](quickstart.md) §3 each reach their terminal state.

- [ ] T038 [P] [US4] Implement the `requestHandoff` tool in `src/agent/tools/handoff.ts` and the `optOut` tool in `src/agent/tools/opt-out.ts`
- [ ] T039 [US4] Wire `handoffDecision` into the orchestrator — pause the conversation, emit `handoff.requested` with its reason, and maintain `fallbackStreak` in `commitTurn`
- [ ] T040 [US4] Refuse to produce an agent turn on a paused conversation (409), and show the "Falando com um corretor" badge plus `CHAT_POLL_INTERVAL_MS` polling in `ChatWidget.tsx`
- [ ] T041 [US4] Enforce `CHAT_RATE_LIMIT_PER_MINUTE` in the route handler from the count `loadTurn` returns — 429, no model call, nothing persisted
- [ ] T042 [US4] Verify SC-006 and SC-007 per [quickstart.md](quickstart.md) §3 — the four ways out each reach their terminal state, a paused conversation produces zero further agent messages, and five scripted injection attempts each yield a refusal with unchanged slots and no figure quoted

## Phase 7: User Story 5 — Every turn can be inspected afterwards (P3)

**Goal / test**: the trace shape of [contracts/observability.md](contracts/observability.md), and an application that does not notice when it is gone — one conversation with the profile up, then the same with the keys unset.

- [ ] T043 [US5] Implement `src/core/langfuse.ts` — tracer provider and span processor with `maskPII` as the mask, registered only when all three `LANGFUSE_*` keys are present, flushed with a bounded timeout on shutdown
- [ ] T044 [US5] Register it from `src/instrumentation.ts` and from `src/worker/index.ts`
- [ ] T045 [US5] Attach the AI SDK telemetry option to every model call with the trace name and the agency, lead and conversation attributes of [contracts/observability.md](contracts/observability.md) §1
- [ ] T046 [US5] Add the `observability` Compose profile to `docker-compose.yml` — `langfuse-web`, `langfuse-worker`, `clickhouse`, `redis`, `minio`, each with a `mem_limit` summing to 6 GiB, UI on `LANGFUSE_UI_PORT`
- [ ] T047 [US5] Add the Langfuse database init script under `scripts/db/` and mount it into the `db` container
- [ ] T048 [US5] Verify SC-010, SC-011 and SC-012 per [quickstart.md](quickstart.md) §6, and record the measured memory total in `docs/arquitetura/restricoes-de-implantacao.md` §4

## Phase 8: Polish and acceptance

- [ ] T049 Write `tests/integration/scenario-purchase.test.ts` — Cenário 1 through `services/conversation.ts` against the local model, asserting SC-001, SC-003 and SC-004
- [ ] T050 [P] Write `tests/integration/scenario-investment.test.ts` — Cenário 2, asserting SC-002 and SC-003
- [ ] T051 [P] Write `tests/integration/turn-persistence.test.ts` — idempotency (SC-008), the rate limit, and the provider-outage fallback (SC-009)
- [ ] T052 Confirm `npm run lint` and `docker build --target build .` both pass — the dependency rule and the only type-checking gate this project has
- [ ] T053 Update `README.md` with the widget URL and the observability profile, and mark item 004 in `specs/BACKLOG.md`

## Dependencies & Execution Order

Setup → Foundational → US1 → US2 → US3 → US4 → US5 → Polish.

- **US1 needs Foundational entirely.** The orchestrator is meaningless without the slot machine and the guards.
- **US2 needs US1.** The widget renders a turn; there has to be a turn.
- **US3 and US4 both extend the orchestrator** and touch `tools/index.ts` and `ChatWidget.tsx`, so they are sequential rather than parallel despite being independently testable.
- **US5 depends on nothing but US1** and can move earlier if the observability profile turns out to be the risky part — it is the one phase whose position is negotiable.
- **T003 is a single commit** with `.env.example`; splitting it is the drift the Environment Contract gate exists to catch.

**Parallel opportunities**: T004–T006 together; T008–T011 together; T018 and T019 alongside T020; T031 and T035 alongside their phases; T050 and T051 together.

## Implementation Strategy

**MVP is Setup + Foundational + US1 + US2** — a lead can chat and be qualified. That is the demonstration; US3 makes it credible, US4 makes it safe, US5 makes it explicable.

Stop at each checkpoint. If a turn regresses, the fast `domain/` suites are the first thing to run, because they answer "is it the code or is it the model" in under a second.

## Notes

- Everything runs as `docker compose exec app …`; the host has no usable Node, and the scenario suites are slow by design — keep them out of `npm test`
- If a task appears to need a decision, `docs/decisoes-pendentes.md` is empty, so the answer is in `modelo-de-dados.md` or an ADR
