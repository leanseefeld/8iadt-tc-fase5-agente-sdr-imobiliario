# Tasks: Revisable Orchestration

**Feature**: `007-revisable-orchestration` | **Spec**: [spec.md](spec.md) | **Plan**: [plan.md](plan.md)

## How this list is ordered

By [plan.md](plan.md)'s six phases, **not** strictly by user-story priority. The
plan orders the work so the riskiest thing is not the first thing: the accounting
fix lands with no model involved, and the tool loop arrives only after three
phases have proven the accounting works.

| Plan phase | Tasks | Story | Closes |
|---|---|---|---|
| A — accounting | T004–T020 | US1 (P1) | SC-001, SC-002, SC-004a, SC-004b |
| B — derived facts | T021–T025 | US6 (P3) | SC-008 |
| C — reconfirmation | T026–T033 | US4 (P2) | SC-005 |
| D — the loop | T034–T043 | US2 (P1) | SC-003, SC-007 |
| E — edges | T044–T052 | US3, US5 (P2) | SC-004, SC-009 |
| F — measurement & records | T053–T059 | — | SC-010, SC-011 |

**US6 is P3 but runs second**, because it is cheap, independent, and part of the
same accounting family as US1. **US2 is P1 but runs fourth**, because it is the
risky one. Both departures are the plan's, deliberately.

## Path conventions

Repository root is the project root. Unit tests run on the host with Node 24
(`nvm use 24 && npm test`); anything touching Postgres runs as
`docker compose exec app npm test`; model-dependent tests are tagged
`INTEGRATION=1` so the default suite skips them.

---

## Phase 1: Setup

- [ ] T001 Record the starting baseline: run `docker compose exec app npm test` and note the pass/fail counts in the implementation log. On the host the expected figure is 177 pass / 15 fail, where all 15 are `loadConfig` errors from unset `DATABASE_URL`/`AUTH_SECRET` — those are environment artifacts, not regressions, and must not be "fixed"
- [ ] T002 [P] Switch `MODEL_ID` to `gemma-4-12B-it-OptiQ-4bit` in `.env.example` and confirm `tests/env-example.test.ts` still passes. *(plan.md lists the switch under phase F; it moves here because phase D cannot be evaluated on the old model)*
- [ ] T003 [P] Confirm the model is reachable and answers a trivial tool call via `scripts/tool-smoke.ts` before any code changes, so a later failure is attributable to this slice rather than to the environment

---

## Phase 2: Foundational — the merge reports revisions

**Blocking**: US1 and US4 both depend on the merge telling a revision apart from a
first fill. Nothing else can be correct until it does.

- [ ] T004 Add `revised: SlotKey[]` and `intentChanged: boolean` to `MergeResult` in `src/domain/slots.ts` per [contracts/interfaces.md](contracts/interfaces.md) §1, populating `revised` when a filled slot receives a different valid non-empty value
- [ ] T005 Withdraw merge rule 3 in `src/domain/slots.ts` (the branch at the intent check that drops an intent moving between two defined values): the intent now updates and reports `intentChanged`
- [ ] T006 Ensure re-supplying an identical value puts the slot in **none** of `filled`/`revised`/`dropped` in `src/domain/slots.ts` — spec US1 scenario 4 depends on this, and it is the easiest invariant to get wrong
- [ ] T007 Write `tests/slots.test.ts` cases for the four invariants in [contracts/interfaces.md](contracts/interfaces.md) §1: a key appears in at most one set; an identical value appears in none; an empty value over a filled slot is still `dropped`; an unconsented contact slot is still `dropped`
- [ ] T008 [P] Update `docs/arquitetura/modelo-de-dados.md` §4 so the `slot.filled` row states it covers revisions as well as first fills

---

## Phase 3: User Story 1 — Revision and conversation are not misunderstandings (P1) 🎯 MVP

**Goal**: A lead who changes their mind, reacts, or greets is never told the agent
did not understand, and never walks toward a handoff for it.

**Independent test**: Drive a purchase script to completion, send *"na verdade, e
na zona norte?"*, and assert the slot changed, the streak is zero, a new search
ran and the reply is not an apology. Then send *"Nossa, isso seria bom haha"* and
*"opa, tá aí?"* and assert neither advances the streak.

**This phase alone fixes the defect.** If everything after it were cut, the slice
would still be worth shipping.

- [ ] T009 [US1] Extend the extraction JSON contract in `src/agent/prompts/system.ts` (the extraction system prompt) to report whether the lead attempted to convey something, alongside the existing `askedForHuman` and `optOut`
- [ ] T010 [US1] Read that field into `Extraction.attemptedAnswer` in `src/agent/orchestrator.ts` using the same `isTrue` coercion as the existing two booleans, per [contracts/interfaces.md](contracts/interfaces.md) §2a
- [ ] T011 [US1] Redefine `learnedSomething` in `src/agent/orchestrator.ts` `run()` to include `revised.length > 0` and `intentChanged` (FR-003)
- [ ] T012 [US1] Redefine `notUnderstood` in `src/agent/orchestrator.ts` to gate on `attemptedAnswer` instead of `plausiblyAnswers(leadText)` (FR-003a/FR-003b). Leave `plausiblyAnswers` in `src/agent/recovery.ts` untouched and still used for its original job — deciding whether a recovery call is worth making
- [ ] T013 [US1] Handle the failed-extraction path in `src/agent/orchestrator.ts`: when `extraction.failed` is true, hold the streak and produce a written technical reply asking the lead to repeat, never an apology for not understanding (FR-003c). Add the written sentence beside the other written replies
- [ ] T014 [US1] Implement the three-state streak rule in `src/agent/orchestrator.ts` per [data-model.md](data-model.md) §2a: learning **resets** to zero; a conversational or failed turn **holds**; an unusable attempt **advances** (FR-003d)
- [ ] T015 [US1] Widen `searchDue` in `src/agent/orchestrator.ts` so a **revised** search-relevant criterion re-runs the search, and **delete the comment** above it that claims `mergeSlots` never overwrites a filled slot — it is false today and has been since the module was written
- [ ] T016 [US1] Emit `slot.filled` for revisions in `src/services/conversation.ts` (the loop over `input.filled` around line 668), with the same payload and the same key-aware masking, so a changed criterion stops being invisible to the summariser and the broker timeline (FR-029)
- [ ] T017 [P] [US1] Write `tests/integration/revision.test.ts` against the container's Postgres: a revision after qualification changes the slot, leaves the streak at zero, re-runs the search, and produces no apology (SC-001, SC-003 partial)
- [ ] T018 [P] [US1] Write `tests/conversational.test.ts`: reactions, greetings, check-ins, thanks and emoji do not advance the streak; two in a row raise no handoff; the mixed case *"opa! pode ser até 900 mil"* still merges its slot (SC-004a)
- [ ] T019 [P] [US1] Write the provider-failure case in `tests/provider-failure.test.ts`: with the provider unreachable, ten turns produce ten technical replies, zero handoffs and an unmoved streak (SC-004b)
- [ ] T020 [US1] Replay the decision register's three conversations end to end and confirm none reaches a handoff for the wrong reason, per [quickstart.md](quickstart.md) §1 (SC-002)

**Checkpoint**: the defect is fixed and shippable. Everything below adds value on
top of a working fix.

---

## Phase 4: User Story 6 — The meeting offer is made once (P3, runs second)

**Goal**: Once the agent has offered to book, it stops offering every turn.

**Independent test**: Complete a qualification, send three unrelated messages,
count the offers. Expect one.

- [ ] T021 [US6] Implement `offerOutstanding(turn)` in `src/services/conversation.ts` per [contracts/interfaces.md](contracts/interfaces.md) §6, reading the `appointment.proposed` event and the last agent message's metadata — from rows the turn already loads, adding no query
- [ ] T022 [US6] Add the `offerOutstanding` parameter to `shouldProposeMeeting` in `src/domain/handoff.ts`, returning `null` whenever it is true, before any other rule. The function stays pure — the fact is passed in, not looked up (FR-017)
- [ ] T023 [US6] Pass the fact from `src/agent/orchestrator.ts` `run()` at the `shouldProposeMeeting` call site
- [ ] T024 [P] [US6] Update `tests/handoff.test.ts` for the new parameter, including the case where a hot lead with contact is **not** re-offered
- [ ] T025 [P] [US6] Write the three-unrelated-messages case in `tests/integration/offer-once.test.ts` asserting exactly one offer (SC-008)

---

## Phase 5: User Story 4 — The reconfirmation (P2)

**Goal**: A correction to one settled answer invites correction of the two most
likely to have moved with it.

**Independent test**: Revise `priceMax` after qualification; assert the reply
restates `bedrooms` and `neighborhoods`, asks exactly one question, and that a
second revision next turn triggers no second reconfirmation.

- [ ] T026 [US4] Create `src/domain/revision.ts` with the `DEPENDANTS` table exactly as recorded in [data-model.md](data-model.md) §3 — one declared constant, read by everything, written by nobody (FR-007)
- [ ] T027 [US4] Implement `reconfirmationFor(changed, slots)` in `src/domain/revision.ts` per [contracts/interfaces.md](contracts/interfaces.md) §2: pure, union of dependants for multiple revisions, deduplicated, script order, unfilled dependants omitted (FR-010)
- [ ] T028 [US4] Implement `lastTurnWasReconfirmation(turn)` in `src/services/conversation.ts` from the last agent message's metadata (FR-009)
- [ ] T029 [US4] Mark reconfirmation turns in the agent message metadata written by `commitTurn` in `src/services/conversation.ts`, so T028 has something to read
- [ ] T030 [US4] Create `src/agent/prompts/reconfirm.ts` with the pt-BR restatement, in the shape *"Só pra confirmar: até R$ 1,2 mi, 3 quartos, Moema. Continua assim?"* — a restatement of facts followed by exactly one question (FR-008)
- [ ] T031 [US4] Wire the reconfirmation into the briefing in `src/agent/prompts/system.ts` and into `run()` in `src/agent/orchestrator.ts`, suppressed when the previous turn was one
- [ ] T032 [US4] Handle the intent-change case in `src/domain/revision.ts` and `src/agent/orchestrator.ts`: a script switch reconfirms the carried criteria whose meaning the switch puts in doubt, and orphaned slots are kept in storage but never restated as current criteria (FR-005, FR-005a)
- [ ] T033 [P] [US4] Write `tests/revision.test.ts`: the four table invariants from [data-model.md](data-model.md) §3 enforced as assertions, plus exactly-one-question over generated revision cases and never-two-in-a-row (SC-005)

---

## Phase 6: User Story 2 — The agent acts, reads, and acts again (P1, runs fourth)

**Goal**: The model calls a search, reads the result, and may call again before
any reply text exists.

**Independent test**: Force a turn whose first search returns nothing; assert a
second search ran within the same turn and the trace shows both calls in order.

**Bring-up order is the Gemma playbook's and is not optional**: the contract
first, then one tool on an obvious case, then the retry case, then refusal, then
the bound.

- [ ] T034 [US2] Rewrite `searchProperties`'s tool contract in `src/agent/tools/search-properties.ts` to the five-point standard in [contracts/interfaces.md](contracts/interfaces.md) §5 — narrow schema, explicit when-to-call **and when-not-to-call**, defined error handling, nothing security-bearing in the arguments (FR-013a, FR-014)
- [ ] T035 [US2] Add the `ToolRefusal` shape in `src/agent/tools/index.ts` and make `src/agent/tools/search-properties.ts` return it when its preconditions do not hold, rather than throwing or returning silence (FR-013b)
- [ ] T036 [US2] Create `src/agent/act.ts` implementing the bounded loop per [contracts/interfaces.md](contracts/interfaces.md) §4, with `MAX_ACTION_STEPS = 3`; reaching the bound stops tool offering and returns what it holds (FR-012)
- [ ] T037 [US2] Make the loop in `src/agent/act.ts` never throw: a provider error, timeout or tool exception becomes a recorded step plus a `failed` flag, and the turn continues to phrasing (FR-016)
- [ ] T038 [US2] Call `act()` conditionally from `src/agent/orchestrator.ts` `run()`, between extraction and phrasing, only when the turn has an action worth considering — a turn with none must make no extra call and cost what it costs today
- [ ] T039 [US2] Ensure `src/agent/act.ts` takes no `ReplySink` and its text output is **discarded**: only `phrase()` and the written-reply path in `finish()` may write to the sink, so the model's reasoning and refinement have no path to the lead
- [ ] T040 [US2] Set the tool set to exactly one entry in `src/agent/tools/index.ts`; `proposeMeeting` and `bookMeeting` stay declared and inert, and a model calling one receives today's unavailable result and cannot create a booking (FR-015)
- [ ] T041 [US2] Emit `model.act` and per-step `tool.*` spans with `step.index`, `step.refused`, `steps.count` and `steps.bounded` per [contracts/observability.md](contracts/observability.md) §1–§2 (FR-027, FR-028)
- [ ] T042 [P] [US2] Write the four bring-up cases from [quickstart.md](quickstart.md) §3 as `INTEGRATION=1` tests: obvious case, retry case, refusal case, bound case
- [ ] T043 [US2] Verify the trace shape in Langfuse matches [contracts/observability.md](contracts/observability.md) §3 exactly — a `steps.count` that disagrees with the number of `tool.*` children is a defect (SC-007)

---

## Phase 7: User Stories 3 and 5 — The edges (P2)

**Goal**: The agent can say what it is filtering by, and a conversation returning
from a broker does not produce an apology.

**Independent test**: Ask *"como você tá filtrando?"* in three phrasings; hand a
conversation to a broker and back and send a slot-free message.

- [ ] T044 [US3] Teach the briefing in `src/agent/prompts/system.ts` to answer a question about the current criteria with a plain restatement that invites a change, without counting the turn as a misunderstanding (FR-018, FR-020)
- [ ] T045 [P] [US3] Write one assertion in `tests/briefing-boundary.test.ts` that the `TurnPromptInput` payload carries only the permitted fields — score, temperature, streak and pipeline stage never enter it (FR-019, SC-004). One boundary assertion, not a sweep over generated states
- [ ] T046 [US5] Post the written re-entry message on handback in `src/services/handoff.ts` (the `conversation.returned` path), composed with no model call, templated with the broker's first name: *"Sofia de volta! {Broker} saiu da conversa, mas se precisar de alguma coisa, é só chamar!"* (FR-021)
- [ ] T047 [US5] Add the greeting-beats-apology precedence in `src/agent/orchestrator.ts`, **with a comment at that point** explaining that T046 makes the collision nearly unreachable and why the rule remains (FR-022)
- [ ] T048 [US5] Add the honest "cannot act" reply in `src/agent/prompts/fallback.ts` — *"ainda não consigo te ajudar com isso"* — for a question the agent structurally cannot answer, which still advances the streak but never claims incomprehension (FR-023)
- [ ] T049 Soften the prompt line in `src/agent/prompts/system.ts` that reads *"Nunca pergunte de novo algo que já está preenchido"* to a discouragement, per constitution 1.4.0
- [ ] T050 Delete `cardsJustShown` from `src/agent/orchestrator.ts`. **Only after T012 is merged and green** — it is currently the sole cover for a reaction to a property, and removing it earlier regresses that case (FR-026)
- [ ] T051 Delete the fallback-shielding half of `looksLikeSteering`'s use in `src/agent/orchestrator.ts`, keeping the guard's own recording role intact, and confirm `tests/reply-guards.test.ts` stays green (FR-024, FR-026)
- [ ] T052 [P] [US5] Write the handback case in `tests/integration/handback.test.ts`: the re-entry line exists before the lead's next message is processed, and the following slot-free turn produces no apology (SC-009)

---

## Phase 8: Measurement, records and verification

- [ ] T053 Extend `scripts/tool-smoke.ts` with a concurrency flag and report per-request latency at N=1 and N=4, run **serially** — running both at once measures neither (FR-031)
- [ ] T054 Replace the unverified claim in `docs/exploracoes/roteiro-por-topicos.md` (the "Correção de 22/09/2026" block) with the measured numbers, whichever way they fall (SC-010)
- [ ] T055 [P] Correct ADR 14's consequences paragraph in `docs/arquitetura/adr/decisoes.md`: it states the model calls tools natively, which was never built — `conversationTools()` has never been called. Record what was actually built and what this slice changed
- [ ] T056 [P] Amend `specs/004-conversation/contracts/observability.md` §2's paragraph claiming the agent invokes every tool from code so the SDK never sees them execute — true for every tool except the one now running inside the loop
- [ ] T057 Confirm SC-011: the existing suite passes except where a test asserts behaviour this spec deliberately changes, and each such change traces to a requirement here. List them in the implementation log
- [ ] T058 Run [quickstart.md](quickstart.md) start to finish on the running stack
- [ ] T059 [P] Confirm `docker compose exec app npm run lint` and `npm run build` both succeed

---

## Dependencies

```
Setup (T001–T003)
   └─> Foundational (T004–T008)          ← blocks US1 and US4
          ├─> Phase 3 · US1 (T009–T020)  ← MVP, the defect fixed
          │      ├─> Phase 4 · US6 (T021–T025)
          │      ├─> Phase 5 · US4 (T026–T033)
          │      └─> Phase 6 · US2 (T034–T043)
          │             └─> Phase 7 · edges (T044–T052)
          │                    └─> Phase 8 · records (T053–T059)
```

**Hard ordering constraints, not preferences:**

- **T050 after T012.** The card shield is the only thing covering a reaction to a
  property until `attemptedAnswer` replaces it. Deleting it first makes that case
  worse, which is the opposite of the point.
- **T029 before T028.** Nothing can read the reconfirmation marker until
  `commitTurn` writes it.
- **T034 before T036.** The contract is rewritten before the loop is built, so a
  loop failure is attributable to the loop rather than to an ambiguous schema.
- **T002 before Phase 6.** The loop is evaluated on the working model, not the old one.

**Not parallel, despite touching different concerns:** every task editing
`src/agent/orchestrator.ts` — T010–T015, T023, T031, T038–T039, T047–T048,
T050–T051. They share one function.

## Parallel opportunities

- T002, T003 in setup
- T017, T018, T019 — three separate new test files
- T024, T025 in US6
- T045, T052 in phase 7
- T055, T056, T059 in phase 8 — three unrelated documents

## Implementation strategy

**Ship Phase 3 on its own if time is short.** It closes the defect, four success
criteria and both P1 acceptance paths of US1, with no model-behaviour risk. The
rest is value layered on a working fix, in increasing order of risk.

**Stop and reconsider at T036** if the loop will not drive one tool reliably. The
response order is fixed by [research.md](research.md) §3: fix the contract, then
try the larger model, then Azure per ADR 16. Reverting to a code-invoked search is
allowed only with the reason written down — it is the decision ADR 22 overturned.
