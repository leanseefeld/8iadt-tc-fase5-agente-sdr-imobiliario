---
description: "Task list for the broker surface"
---

# Tasks: Broker Surface

**Input**: [plan.md](plan.md) · [spec.md](spec.md) · [contracts/surfaces.md](contracts/surfaces.md) · [quickstart.md](quickstart.md)

Revised 2026-09-16 after 004 landed: 49 tasks collapsed to 16. T005 waits on decisions 6 and 7. Commit per task.
`[P]` = no ordering constraint. Stop on anything listed in `docs/decisoes-pendentes.md`.

## Phase 1: Setup and foundations

- [ ] T001 Add `SUMMARY_DEBOUNCE_SECONDS` (20), `SUMMARY_BATCH_SIZE` (10), `LEADS_PAGE_SIZE` (25), `DASHBOARD_LIVE_WINDOW_MINUTES` (10) to `src/core/config.ts`, `.env.example` and `docs/arquitetura/configuracoes.md` in one commit
- [ ] T002 [P] `src/domain/lead-status.ts` (FR-007 broker transitions; illegal throws) and `src/domain/relative-time.ts` (pt-BR), with `tests/lead-status.test.ts` and `tests/relative-time.test.ts`
- [ ] T003 [P] Migration `0002` with `events_pending_turns_idx` and `leads_queue_idx` per [data-model.md](data-model.md)
- [ ] T003a [P] Seed (`src/db/seed/index.ts`): scores from `scoreLead`, Ana and Bruno assigned, `previewLine` null, `conversation.turn` events on seeded agent messages
- [ ] T004 `src/core/notifier.ts`: `subscribeAgency(agencyId, listener)` and the `conversation_state` channel `{ conversationId, agencyId, status }`; widget events route forwards it as `status`, `ChatWidget.tsx` sets status from it and labels `broker` bubbles as a person; extend `tests/integration/notifier.test.ts`; amend 004 `contracts/chat-api.md`

## Phase 2: US1 — Priority (P1)

- [ ] T005 [US1] *(blocked: decisions 6, 7)* Emit `lead.qualified { score }` in `commitTurn` on the move to `qualified`; `tests/integration/turn-persistence.test.ts` asserts five qualified turns yield one event; confirm SC-001 against the existing rule suites

## Phase 3: US2 — The queue (P1)

- [ ] T006 [US2] `src/services/leads.ts` (`listLeads`, `getLeadDetail`) and `src/services/metrics.ts` per [contracts/surfaces.md](contracts/surfaces.md) §2; `tests/integration/leads-scope.test.ts` covers the toggle by list, search and detail
- [ ] T007 [US2] `/leads`: `page.tsx`, `leads.module.css` (+ temperature tokens in the shell), tiles, filter chips, toggle, debounced search, row with chips and live dot, pagination, three empty states
- [ ] T008 [US2] `src/app/api/leads/stream/route.ts` over `subscribeAgency` (15 s pulse, `goodbye` on shutdown) and `_components/LiveLeads.tsx` (`router.refresh()` per event, reconnect notice after two missed pulses)
- [ ] T009 [US2] Verify quickstart §2 (SC-002–SC-004)

## Phase 4: US3 — Panel and handoff (P1)

- [ ] T010 [US3] `src/services/handoff.ts` — `assumeConversation`, `returnToAgent`, `sendBrokerReply` (hold check, `recordOutboundMessage` with `metadata.userId`, a `conversation.turn` event), `setLeadStatus`; conditional updates returning `Result`, events with actor `user`, `conversation_state` published after commit. `actions.ts` wraps these plus `reassignLead`. `tests/integration/handoff.test.ts`: a second assume fails
- [ ] T011 [US3] Panel UI: `LeadDrawer` (Escape, focus return, `inert`, full screen < 768 px), `LeadPanel` in FR-027 order, `QualificationTable`, `Transcript`, `Timeline` (pt-BR sentences, trace link), `ActionsRow`, `ReplyBox`
- [ ] T012 [US3] Verify quickstart §3 and §5 (SC-008, SC-010)

## Phase 5: US4 — Summary (P2)

- [ ] T013 [US4] `src/agent/summarizer.ts` (`getJsonModel`, `modelTelemetry('summary.generate')`, preview truncation) with `tests/preview-line.test.ts` and `tests/integration/summarizer.test.ts` (oMLX)
- [ ] T014 [US4] `src/jobs/summarize.ts` appended to `consumers.ts` — select, claim, write, failure path, `conversation_state` publish; `tests/integration/summarize-claim.test.ts` (debounce, many turns → one summary, concurrent claim gets zero). Verify quickstart §4 (SC-005–SC-007)

## Phase 6: Polish

- [ ] T015 SC-009 and the 390 px half of SC-010; `npm run lint`; `npx tsc --noEmit`; both test suites; mark 005 done in `specs/BACKLOG.md`; fix decision 5's row in `docs/decisoes-pendentes.md` to cite ADR 19 (two triggers, not three)

## Order

T001–T004 → T005 → T006–T009 → T010–T012 → T015. T013–T014 need only T001 and
can run beside US2/US3. T007 needs T006; T008 needs T004; T010 needs T004.
