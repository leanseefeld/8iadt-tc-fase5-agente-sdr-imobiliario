---
description: "Task list for the broker surface"
---

# Tasks: Broker Surface

**Input**: [plan.md](plan.md) · [spec.md](spec.md) · [data-model.md](data-model.md)
· [contracts/surfaces.md](contracts/surfaces.md) · [quickstart.md](quickstart.md)

**Tests**: included and named by the spec. `tests/scoring.test.ts` is written
**before** `domain/scoring.ts` — pure functions over a published weights table are
the one place here where red-green is free; everything else is verified after the
fact, because its subject is a running container.

**Organization**: by user story; config, rules and indexes go to Foundational
because all four stories import them. `[P]` means no ordering constraint. Every
command runs as `docker compose exec app …`.

---

## Phase 1: Setup

- [ ] T001 Add `SUMMARY_DEBOUNCE_SECONDS` (20), `SUMMARY_BATCH_SIZE` (10), `LEADS_PAGE_SIZE` (25), `DASHBOARD_LIVE_WINDOW_MINUTES` (10) and `LANGFUSE_PUBLIC_URL` (optional, default `http://localhost:3102`) to the Zod schema in `src/core/config.ts`
- [ ] T002 Add the same five keys to `.env.example` and to [`configuracoes.md`](../../docs/arquitetura/configuracoes.md) **in the same commit as T001** — the Environment Contract gate, enforced by `tests/env-example.test.ts`
- [ ] T003 [P] Check the inter-spec dependencies listed in [plan.md](plan.md#inter-spec-dependencies-named-so-they-are-not-assumed): create `src/domain/slots.ts`, `src/services/events.ts`, `src/core/masking.ts` or a minimal `src/core/notifier.ts` from the data model / `visao-geral.md` §8 if the owning spec has not landed; stop and rebase if `scopeForUser` is missing

---

## Phase 2: Foundational

**⚠️ Blocks all four user stories.**

- [ ] T004 [P] Write `tests/scoring.test.ts` — a table of at least fifteen slot states covering both scripts, both bonuses, the cap at 100, the 39/40 and 69/70 boundaries, `shouldHandoff`'s two reasons and `shouldProposeMeeting`
- [ ] T005 Implement `src/domain/scoring.ts` — `scoreLead`, `temperatureOf`, `isQualified`, `shouldHandoff`, `shouldProposeMeeting` per [contracts/surfaces.md](contracts/surfaces.md#1--domain-rules--srcdomainscoringts), importing nothing but the slot types (satisfies T004)
- [ ] T006 [P] Implement `src/domain/lead-status.ts` — the FR-007 pipeline table: forward-only `new → qualifying → qualified → scheduled → visited → won | lost`, plus `won`/`lost` reachable from any stage; an illegal transition throws rather than being ignored
- [ ] T007 [P] Implement `src/domain/relative-time.ts` — pt-BR relative formatter ("há 2 min", "há 2 dias"), pure, no date library
- [ ] T008 Add the migration in `src/db/migrations/` creating `events_pending_turns_idx` and `leads_queue_idx` exactly as in [data-model.md](data-model.md#indexes-added)

---

## Phase 3: User Story 1 — Priority the broker can trust (P1) 🎯 MVP

**Goal**: a score, a temperature and a handoff verdict that are the same every time.

**Independent Test**: the scoring table passes with no database and no model.

- [ ] T009 [US1] Implement `recordTurnOutcome` in `src/services/qualification.ts` — recompute the score, write `leads.score` and the FR-007 pipeline stage, all inside the caller's transaction
- [ ] T010 [US1] Append `lead.qualified` in `src/services/qualification.ts` only when `update leads set status='qualified' where id=$1 and status<>'qualified'` touched a row, so idempotence is the database's and not a read-then-write
- [ ] T011 [US1] Append `handoff.requested` with its reason (`asked` or `fallback`) from `shouldHandoff` in `src/services/qualification.ts`, accepting `leadAskedForHuman` and `fallbackStreak` from the caller; `shouldProposeMeeting` is exported for spec 004 to call directly and never touches `conversations.status` here
- [ ] T012 [P] [US1] Write `tests/qualification.test.ts` against Postgres — five consecutive qualified turns produce exactly one `lead.qualified`
- [ ] T013 [US1] Verify SC-001 per [quickstart.md](quickstart.md) §1

---

## Phase 4: User Story 2 — The morning queue (P1)

**Goal**: `/leads` shows four tiles and a scoped, filtered, ordered, paginated,
real-time list.

**Independent Test**: sign in as Ana and as Carla; check tiles, filters, search, the *Meus leads* toggle, ordering and the SSE stream.

- [ ] T014 [US2] Implement `listLeads` in `src/services/leads.ts` — one query joining leads to their active conversation, `ilike` search over name, phone, e-mail and preview line, ordered `score desc, last_lead_message_at desc`, paged by `LEADS_PAGE_SIZE`, scoped by `scopeForUser` plus the `mine` filter (`assignedBrokerId = session.userId` when true)
- [ ] T015 [P] [US2] Implement `getFunnelMetrics` in `src/services/metrics.ts` — one statement: `filter (where type = …)` aggregates for three tiles, `percentile_cont(0.5)` from each `lead.created` to that lead's first `agent` message for the median
- [ ] T016 [P] [US2] Write `tests/leads-scope.test.ts` against Postgres — every role sees the whole agency by default except `mine`: a broker's `mine=true` shows only their own leads by list, by search and by detail; a sales manager's default is `mine=false`
- [ ] T017 [US2] Implement `src/app/(app)/leads/page.tsx` as a Server Component reading `filtro`, `q`, `mine`, `page` and `lead` from `searchParams` (defaulting `mine` by role) and calling only `services/`
- [ ] T018 [P] [US2] Write `src/app/(app)/leads/leads.module.css` and add `--temp-hot`, `--temp-warm`, `--temp-cold` and the accent to the shell stylesheet — 14 px base, 56 px rows, tabular figures
- [ ] T019 [P] [US2] Implement `_components/MetricTiles.tsx`, `_components/FilterChips.tsx` (*Ao vivo* · *Aguardando corretor* · *Visita marcada* · *Sem resposta*) and `_components/MeusLeadsToggle.tsx` as plain links carrying the query string; zero JavaScript
- [ ] T020 [P] [US2] Implement the row in `_components/LeadRow.tsx` plus `_components/ConversationChip.tsx`, `_components/StageChip.tsx` and `_components/LiveDot.tsx` — colored temperature dot **and** label, *Lead anônimo*, intent, the neighborhoods · price · bedrooms line, preview line in quotes, the conversation chip, the stage chip (*Visita <dia> <hora>* when applicable), and a live dot when `lastLeadMessageAt` is within `DASHBOARD_LIVE_WINDOW_MINUTES`
- [ ] T021 [US2] Implement `_components/SearchBox.tsx` — client, debounced, pushes to the router so the term stays in the URL
- [ ] T022 [US2] Implement `src/app/api/leads/stream/route.ts` — agency-scoped SSE endpoint over `Notifier.subscribe`, re-reading each notified id scoped by agency before writing a frame, 15 s pulse, `goodbye` on shutdown
- [ ] T022a [US2] Implement `_components/LiveLeads.tsx` — client, opens `EventSource` against the route above, calls `router.refresh()` per event, shows "Conexão perdida. Reconectando…" after two missed pulses, cleared on unmount
- [ ] T023 [P] [US2] Implement pagination controls and the three empty states (no leads, no matches, no metrics yet) in `src/app/(app)/leads/`
- [ ] T024 [US2] Verify SC-002, SC-003 and SC-004 per [quickstart.md](quickstart.md) §2

---

## Phase 5: User Story 3 — Read the lead, then take it over (P1)

**Goal**: a URL-addressable panel, summary first, with working handoff controls.

**Independent Test**: open a lead by URL, read it, take it over, reply, hand back.

- [ ] T025 [US3] Implement `getLeadDetail` in `src/services/leads.ts` — three queries (lead + conversation, messages, events), returning `null` when out of scope
- [ ] T026 [US3] Implement `src/services/handoff.ts` — `assumeConversation` (any lead, any pipeline stage, appends `conversation.assumed`), `returnToAgent` (`conversation.returned`), `sendBrokerReply`, `setLeadStatus` (`lead.status_changed` with `{ from, to }`), `reassignLead` (`lead.reassigned` with `{ fromBrokerId, toBrokerId }`, salesManager only) — each a conditional update returning `Result` rather than throwing, each event carrying actor `user`, each calling `Notifier.publish` after commit
- [ ] T027 [US3] Implement `src/app/(app)/leads/actions.ts` — five Server Actions that re-read the session, rebuild the scope, call the service and `revalidatePath('/leads')`
- [ ] T028 [US3] Implement `_components/LeadDrawer.tsx` — client shell: Escape closes, focus returns to the originating row, `inert` on the list behind, right panel at 420 px and full screen below 768 px
- [ ] T029 [US3] Compose the panel body in `src/app/(app)/leads/_components/LeadPanel.tsx` in the FR-027 order — header, **RESUMO (IA)** with `summaryUpdatedAt` and a placeholder when none exists, **QUALIFICAÇÃO**, actions, **CONVERSA**, **LINHA DO TEMPO**
- [ ] T030 [P] [US3] Implement `_components/QualificationTable.tsx` — every slot of the lead's script, *— não informado* when empty
- [ ] T031 [P] [US3] Implement `_components/Transcript.tsx` — the whole conversation, never truncated; roles visually distinct, property suggestions compact, broker messages labelled as written by a person
- [ ] T032 [P] [US3] Implement `_components/Timeline.tsx` — one pt-BR sentence per event type from [data-model.md](data-model.md#events-this-slice-appends), naming the actor, never a raw type name; a *ver trace* link on entries carrying a `traceId`, to `<LANGFUSE_PUBLIC_URL ?? LANGFUSE_BASE_URL>/…/traces/<traceId>`
- [ ] T033 [US3] Implement `_components/ActionsRow.tsx` and `_components/ReplyBox.tsx` — assume (any stage)/return, status select along FR-007, manager-only reassign; the reply box enabled only while paused and stating why when not; a reply is delivered through `ChannelAdapter.send` and `Notifier.publish`
- [ ] T034 [US3] Verify SC-008 and SC-010 per [quickstart.md](quickstart.md) §3 and §5

---

## Phase 6: User Story 4 — The summary writes itself (P2)

**Goal**: the worker turns unprocessed turn events into summaries and preview lines.

**Independent Test**: converse, wait a sweep, see the summary; stop oMLX and see nothing lead-facing change.

- [ ] T035 [US4] Implement `src/jobs/consumers.ts` — the `SweepConsumer` type and the exported registry
- [ ] T036 [US4] Edit `src/worker/index.ts` so the sweep iterates the registry, each consumer in its own `try`/`catch` under a child logger bound to its name
- [ ] T037 [US4] Implement `src/agent/summarizer.ts` — the pt-BR prompt, `generateObject` over the two-field schema through `agent/provider.ts`, telemetry with `functionId: 'summary.generate'` and Langfuse session id = `conversationId`, input and output masked through `core/masking.ts`
- [ ] T038 [P] [US4] Write `tests/preview-line.test.ts` — truncation at the last word boundary at or under 90 characters, quotes stripped
- [ ] T039 [US4] Implement `src/jobs/summarize.ts` — the unlocked select with `group by … having max(created_at) < now() - interval`, then one transaction per conversation claiming its turn rows `for update skip locked`, then summary, preview line, `summaryUpdatedAt`, `processedAt` and `summary.updated` in that same transaction
- [ ] T040 [US4] Handle failure in `src/jobs/summarize.ts` — mark the claimed turns processed, leave the stored summary alone, log it; never retry the same conversation in a loop
- [ ] T041 [P] [US4] Write `tests/summarize-claim.test.ts` against Postgres — the debounce defers a fresh conversation, one summary covers many pending turns, and a second concurrent transaction claims zero rows
- [ ] T042 [P] [US4] Write `tests/summarizer.integration.test.ts`, skipped unless `INTEGRATION=1` — against local oMLX with `MODEL_ID=gemma-4-e4b-it-OptiQ-4bit`, asserting a non-empty pt-BR summary and a preview line of at most 90 characters
- [ ] T043 [US4] Verify SC-005, SC-006 and SC-007 per [quickstart.md](quickstart.md) §4, including the two-worker run

---

## Phase 7: Polish

- [ ] T044 [P] Verify SC-009 — read every string on `/leads` and the panel: pt-BR throughout, zero emoji
- [ ] T045 [P] Verify SC-010's viewport half at 390 px — no horizontal scrolling in list or panel, panel full screen
- [ ] T046 Run `npm run lint` — no `db/` import under `src/app/`, `src/domain/` still isolated
- [ ] T047 Run `docker build --target build .` — the only type-checking gate this project has
- [ ] T048 Mark row 005 done in `specs/BACKLOG.md` and move open decisions 1 and 5 to *Resolvidas* if spec 004 has not already

---

## Dependencies & Execution Order

Setup → Foundational → US1 → US2 → US3 → US4 → Polish.

- **US1 needs only Foundational** — the MVP, and the one part provable before specs 002 to 004 are merged.
- **US2 needs US1** for a populated `leads.score`, 002/003 for schema and scope, and 004's `Notifier` for T022/T022a — a minimal one from T003 stands in if 004 has not landed.
- **US3 needs US2** (the panel shares the list's route) and 004's `ChannelAdapter.send`, for T033's reply path only.
- **US4 needs Foundational and 004's `conversation.turn` events** — not US2 or US3, so it can be built alongside them.

Within Phase 1, T001 and T002 share a commit. In Phase 2, T004 precedes T005. In
US2, T017 depends on T014 and T015, and T022a depends on T022. In US4, T039
depends on T035 and T037.

**Parallel**: T006 with T007; T015, T016, T018, T019, T020 and T023 with each other;
T030–T032 with each other; T038, T041 and T042 with each other; T044 with T045.

**MVP is Setup + Foundational + US1** — the rules, tested. US2 makes them visible
and is the demo's centre of gravity, US3 makes them useful, US4 is the graded
flourish that must not block either. Commit per task or logical group, except
T001/T002. If a task needs a decision listed in `docs/decisoes-pendentes.md`, stop.
