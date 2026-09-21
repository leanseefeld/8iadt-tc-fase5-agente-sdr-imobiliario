---
description: "Task list for the broker surface"
---

# Tasks: Broker Surface

**Input**: [plan.md](plan.md) · [spec.md](spec.md) · [contracts/surfaces.md](contracts/surfaces.md) · [quickstart.md](quickstart.md)

Revised 2026-09-20: 49 tasks became 14 after 004 landed and the scoring rules left this
slice. Commit per task. `[P]` = no ordering constraint. Stop on anything listed in
`docs/decisoes-pendentes.md`.

## Phase 1: Foundations

- [ ] T001 Add `SUMMARY_DEBOUNCE_SECONDS` (20), `SUMMARY_BATCH_SIZE` (10), `LEADS_PAGE_SIZE` (25) and `DASHBOARD_LIVE_WINDOW_MINUTES` (10) to `src/core/config.ts`, `.env.example` and `docs/arquitetura/configuracoes.md`, one commit — the Environment Contract gate, enforced by `tests/env-example.test.ts`
- [ ] T002 [P] `src/domain/lead-status.ts` — the FR-007 transition table for broker moves (`won`/`lost` from any stage, `visited` for 006); illegal transitions throw. `tests/lead-status.test.ts`
- [ ] T003 [P] Migration `0002`: `events_pending_turns_idx` and `leads_queue_idx` per [data-model.md](data-model.md)
- [ ] T004 [P] `src/db/seed/index.ts` — assign the demo leads to Ana and Bruno, leave `previewLine` null, and emit `conversation.turn` events for seeded agent messages so *Meus leads* and the summariser both have data. Scores stay as they are (ADR 20's spec recomputes them)
- [ ] T005 `src/core/notifier.ts` — `subscribeAgency(agencyId, listener)` and the `conversation_state` channel carrying `{ conversationId, agencyId, status }`; extend `tests/integration/notifier.test.ts`

## Phase 2: US1 — The morning queue (P1)

- [ ] T006 [US1] `src/services/leads.ts` (`listLeads`, `getLeadDetail`) and `src/services/metrics.ts` per [contracts/surfaces.md](contracts/surfaces.md) §2; `tests/integration/leads-scope.test.ts` covers the toggle by list, by search and by detail
- [ ] T007 [US1] `/leads`: `page.tsx` reading `filtro`, `q`, `mine`, `page`, `lead` from `searchParams`; `leads.module.css` plus temperature tokens in the shell; tiles, filter chips, *Meus leads*, debounced search, the row with its chips and live dot, pagination, three empty states
- [ ] T008 [US1] `src/app/api/leads/stream/route.ts` over `subscribeAgency` (15 s pulse, `goodbye` on shutdown) and `_components/LiveLeads.tsx` (`router.refresh()` per event, reconnect notice after two missed pulses)
- [ ] T009 [US1] Verify [quickstart.md](quickstart.md) §1 — SC-002, SC-003, SC-004

## Phase 3: US2 — Panel and handoff (P1)

- [ ] T010 [US2] `src/services/handoff.ts` — `assumeConversation`, `returnToAgent`, `sendBrokerReply`, `setLeadStatus`: conditional updates returning `Result`, events with actor `user`, `conversation_state` published after commit. The reply checks the caller holds the conversation, writes `metadata.userId` through `recordOutboundMessage` and emits `conversation.turn`. `actions.ts` wraps these plus `services/auth.reassignLead`. `tests/integration/handoff.test.ts`: a second assume fails
- [ ] T011 [US2] Widget: the chat SSE route forwards `conversation_state` as a `status` event, `ChatWidget.tsx` reacts to it (a takeover with no message must show the badge) and labels broker bubbles as written by a person; amend `specs/004-conversation/contracts/chat-api.md`
- [ ] T012 [US2] Panel: `LeadDrawer` (Escape, focus return, `inert` behind, full screen below 768 px), `LeadPanel` in the FR-027 order, `QualificationTable`, `Transcript`, `Timeline` (pt-BR sentences, *ver trace* link from `LANGFUSE_UI_PORT`), `ActionsRow`, `ReplyBox`. Verify [quickstart.md](quickstart.md) §2 and §4 — SC-008, SC-010

## Phase 4: US3 — The summary (P2)

- [ ] T013 [US3] `src/agent/summarizer.ts` — the pt-BR prompt, `getJsonModel()` with `modelTelemetry('summary.generate')` and the conversation id as session id, preview line truncated at a word boundary at or under 90 characters, input and output masked. `tests/preview-line.test.ts` and `tests/integration/summarizer.test.ts` (oMLX)
- [ ] T014 [US3] `src/jobs/summarize.ts`, appended to `consumers.ts` — select by debounce, claim `for update skip locked`, write summary, preview, `processed_at` and `summary.updated` in one transaction, publish `conversation_state`; the failure path clears the turns and keeps the summary. `tests/integration/summarize-claim.test.ts`. Verify [quickstart.md](quickstart.md) §3 — SC-005, SC-006, SC-007

## Phase 5: Polish

- [ ] T014a [US3] FR-039: `getLeadDetail` computes `summaryStale` from the newest message against `summaryUpdatedAt`; the panel shows a pulsing mark and one sentence, and `WORKER_SWEEP_INTERVAL_MS=15000` is the demo value so "shortly" is true

- [ ] T015 SC-009 (pt-BR, no emoji) and SC-010's 390 px half; `npm run lint`; `npx tsc --noEmit`; `npm test`; `npm run test:integration`; mark 005 done in `specs/BACKLOG.md`

## Order

T001–T005 first (T002, T003, T004 in parallel) → T006 → T007, T008 → T009 → T010 → T011,
T012 → T015. T013 and T014 need only T001 and T005, so they can run beside US1 and US2.
