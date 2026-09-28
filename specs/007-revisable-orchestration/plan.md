# Implementation Plan: Revisable Orchestration

**Branch**: `007-revisable-orchestration` | **Date**: 2026-09-22 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/007-revisable-orchestration/spec.md`

## Summary

The whole defect is one line of accounting: `MergeResult.filled` counts only
`empty → filled`, so a lead who changes their mind is invisible to
`learnedSomething` and reads as a misunderstanding. Adding a `revised` set beside
`filled` and `dropped` fixes the three symptoms at once — the false apology, the
search that never re-runs, and the meeting offer that repeats. That change is
small, pure and testable with no database.

Everything else in this slice exists because that fix makes it worth having. A
criterion that can change needs a search that can run again, so the turn gains a
**third, conditional model call** carrying exactly one tool, between the existing
extraction and phrasing calls. A change that can cascade needs a **reconfirmation
turn** driven by a declared dependant table. An offer that must not repeat needs
its "already offered" fact read **from Postgres** rather than recomputed from slot
state.

Four decisions shape it. The loop is **its own call**, because folding tools into
the sentence-guarded stream would mean a tool arriving after guarded sentences
already reached the lead, and folding them into extraction relitigates a reverted
decision. The loop is **bounded at three steps** and forced to answer at the
bound, because an unbounded loop on a local model is a lead watching a typing
indicator. The first production tool set is **exactly one tool**, which makes the
Gemma playbook's incremental bring-up structural rather than a discipline anyone
has to remember. And a revision emits the **existing** `slot.filled` event with
its existing payload — closing a real gap at the lowest cost that closes it.

## Technical Context

**Language/Version**: TypeScript 5.7 `strict`, Node 24 in containers.

**Primary Dependencies**: existing only — `ai` 7.0.93, `@ai-sdk/openai-compatible`
3.0.44, `zod` 4.5.4, `drizzle-orm` 0.45.2, `pino` 10.3.1, `@langfuse/{tracing,otel}`
5.11.0. **No new dependency.** The step bound is a stop condition the installed AI
SDK already provides.

**Storage**: PostgreSQL 17. **No migration, no new table, no new column.** The
"already offered" fact and the "previous turn was a reconfirmation" fact are both
read from rows that already exist — `events` and `messages`.

**Testing**: `node:test`. Pure-unit for the merge accounting and the cascade
resolution (no database, no model); integration against the container's Postgres
for the derived facts; `INTEGRATION=1`-tagged against the local model for the loop
itself and the reconfirmation wording.

**Target Platform**: Linux containers, `docker compose up`.

**Project Type**: Modular monolith. This slice touches `agent/`, `domain/` and one
service; it adds no screen and no route.

**Performance Goals**: A turn that takes no action costs exactly what it costs
today — the third call is conditional, not unconditional. A turn that acts adds
one round trip per step, bounded at three.

**Constraints**: `domain/` imports nothing. Only `agent/provider.ts` touches a
provider SDK. Protected lead assessment never enters a prompt. The script, not the
model, still decides what to ask.

**Scale/Scope**: No new files in `app/` or `db/`. Roughly six touched modules and
three new ones; the largest single edit is inside `orchestrator.ts`'s `run()`.

### What this plan had to discover first

Two findings from [research.md](research.md) change the shape of the work and are
repeated here because a reader who skips that file would plan the wrong thing:

1. **There is no tool calling in the turn today.** `conversationTools()` is
   defined and never called; both model calls pass no tools. ADR 14 decided native
   tool calling and it was not built that way. This slice introduces it, which is
   a larger step than "add a round trip" and is why bring-up is incremental.
2. **A revision currently emits no event at all**, so the broker's timeline cannot
   show that anything changed.

## Constitution Check

*GATE: passed before Phase 0. Re-checked after Phase 1 — result at the end.*

| # | Principle | How this slice satisfies it |
|---|---|---|
| I | Document Authority | Behaviour comes from the spec and ADR 22; the cascade values come from the developer's 22/09 decision, recorded in `data-model.md`. `reference/` is not cited. |
| II | Language Boundaries | Code and plan English; the reconfirmation, the re-entry line and the "ainda não consigo" reply are pt-BR written in `agent/`. No i18n layer. |
| III | Modular Monolith | The accounting fix and the cascade resolution are pure functions in `domain/` importing nothing. The loop lives in `agent/`. No new process. |
| IV | One Data Path | The derived facts are read through `services/`, never by `agent/` reaching into `db/`. No UI change at all. |
| V | **Deterministic Slot Machine** | **See the dedicated note below — this is the principle this slice is closest to.** |
| VI | Provider Independence | The loop is built on the AI SDK's provider-agnostic surface through the existing factory. Swapping to Azure stays two env vars (ADR 16, plan B for the model change). |
| VII | Observability Without Coupling | Each step emits its own span extending `004`'s contract, fire-and-forget. Langfuse absent changes no behaviour. |
| VIII | Privacy and PII | The revision event reuses `slot.filled`'s existing key-aware masking untouched. FR-019 keeps assessment out of prompts structurally. |
| IX | Resilience | A failed action returns a refusal the model reads; a failed loop still phrases a reply; the bound guarantees termination. |
| X | User Experience Discipline | No screen changes. The lead-facing judgements — a reconfirmation that restates before asking, an honest "ainda não consigo te ajudar com isso" instead of a false apology, a written re-entry line — are all "say the true thing plainly". |

### Principle V, in full, because ADR 22 requires it said out loud

Principle V has four bullets. This slice touches one of them and honours the rest:

- *"Slot extraction uses structured output against a Zod schema"* — **unchanged.**
  Extraction stays its own call with its own schema.
- *"Deciding what to ask next is deterministic code. The model never chooses"* —
  **unchanged and honoured.** `nextQuestion` survives. The briefing still names the
  one question. What the model gains is the ability to **act** (call a search and
  read the result) and to have a **revision accepted**. Neither is choosing the
  subject. A turn where the model calls no tool asks exactly the question the
  script chose, as today.
- *"One question per message"* — **unchanged.** The reconfirmation restates
  several values but asks one question, and the existing `questionCount` guard
  still enforces it with no exemption.
- *"A filled slot is never asked again"* — **this is the amended bullet**
  (constitution 1.4.0, 22/09/2026): re-asking is discouraged in the prompt, not
  forbidden in code. The only code change it licenses is softening the prompt line
  that currently says *"Nunca pergunte de novo…"*.

**No new violation, no Complexity Tracking entry.** The one thing that could look
like added machinery — the reconfirmation — removes more than it adds. The slice
as a whole deletes `cardsJustShown`, the fallback-shielding half of the steering
check, merge rule 3, and `plausiblyAnswers`'s mis-use in the misunderstanding
decision. Those deletions are ordered: the card shield goes **after** the
attempted-answer fact replaces it, never before.

## Project Structure

### Documentation (this feature)

```text
specs/007-revisable-orchestration/
├── plan.md              # This file
├── research.md          # Phase 0 — five questions, settled against the code
├── data-model.md        # Phase 1 — accounting shapes, the cascade table, derived facts
├── quickstart.md        # Phase 1 — how to prove it works
├── contracts/
│   ├── interfaces.md    # The action contract and the pure functions
│   └── observability.md # The step span, extending 004's contract
├── checklists/
│   └── requirements.md  # From /speckit-specify, 16/16
└── tasks.md             # /speckit-tasks — not created here
```

### Source code

```text
src/
├── domain/
│   ├── slots.ts              # EDIT  merge rule 3 withdrawn; MergeResult gains `revised`
│   ├── revision.ts           # NEW   the dependant table + which reconfirmation a revision implies
│   ├── handoff.ts            # EDIT  shouldProposeMeeting takes "already offered" as an argument
│   └── reply-guards.ts       # UNCHANGED — guards stay exactly as they are
├── agent/
│   ├── orchestrator.ts       # EDIT  the accounting in run(); the conditional act() call
│   ├── act.ts                # NEW   the bounded tool loop and its span emission
│   ├── tools/
│   │   ├── search-properties.ts  # EDIT  contract rewritten to the playbook standard
│   │   ├── index.ts              # EDIT  the one-tool action set
│   │   └── scheduling.stub.ts    # UNCHANGED — stays inert (FR-015)
│   └── prompts/
│       ├── system.ts         # EDIT  reconfirmation briefing; soften the never-re-ask line
│       └── reconfirm.ts      # NEW   the restatement, pt-BR
├── services/
│   └── conversation.ts       # EDIT  emit slot.filled for revisions; expose the derived facts
└── scripts/
    └── tool-smoke.ts         # EDIT  N=1 vs N=4 concurrency measurement
```

**Structure Decision**: No new top-level directory and no new layer. Three new
modules, each with one job: `domain/revision.ts` is pure and testable with no I/O,
`agent/act.ts` isolates the loop so the rest of the orchestrator does not learn
about steps, and `agent/prompts/reconfirm.ts` keeps pt-BR copy where the other
copy already lives.

## Phase sequencing

The order is chosen so that the riskiest thing is not also the first thing.

**Phase A — the accounting fix.** `MergeResult.revised`, merge rule 3 withdrawn,
`learnedSomething` and `notUnderstood` redefined, `searchDue` widened and its
false comment corrected. Mostly pure functions and unit tests, no loop, no new
call. **This alone closes SC-001, SC-002 and SC-004a** and is independently
shippable. If everything after it were cut, the defect would still be fixed.

One part of Phase A does touch the model: the extraction JSON gains the
"attempted an answer" fact (FR-003b) in the call it already makes. This replaces
`plausiblyAnswers` in the misunderstanding decision, where it never belonged — it
was written to decide whether a recovery call was worth making, and its 28-token
noise list counts *"nossa"* and *"tá"* as attempted answers. That mis-reuse is why
*"Nossa, isso seria bom haha"* and *"opa, tá aí?"* currently earn an apology and a
step toward handoff.

**Phase B — the derived facts.** "Was the previous turn a reconfirmation" and "is
an offer already outstanding", both read from existing rows through `services/`.
Closes SC-008.

**Phase C — the reconfirmation.** `domain/revision.ts` plus the pt-BR restatement.
Closes SC-005.

**Phase D — the loop, one tool.** The rewritten `searchProperties` contract, then
`act.ts` with a bound of three, then the spans. Brought up in the playbook's order:
the one tool on an obvious case, then the retry-with-different-arguments case, then
the refusal path. Closes SC-003 and SC-007.

**Phase E — the edges.** Re-entry line, the "ainda não consigo" reply, prompt
softening, the removal of `cardsJustShown` and the steering shield.

**Phase F — measurement.** The N=1 vs N=4 concurrency numbers and the record
correction in the exploration doc. The model switch is **not** here and is not
scheduled at all: it is an escalation in Phase D, taken only if e4b fails the
loop after the contract has been narrowed.

Phases A–C touch no model behaviour and can be verified entirely in the unit
suite. Phase D is where the risk is, and it arrives with A–C already proving the
accounting works.

## Risks, and what each one costs

| Risk | Signal it is happening | Response |
|---|---|---|
| The local model will not drive one tool reliably | The loop's smoke test fails on obvious cases | Fix the contract first (playbook §3) — narrow schema, explicit non-use boundary. Only then escalate to 12b, then to Azure per ADR 16. **Do not** revert to code-invoked search without recording why. |
| The third call makes turns feel slow | Wall-clock on an action turn | It is conditional by design. If it still bites, lower the bound before removing the loop. |
| Withdrawing merge rule 3 lets the model flip intent on noise | Intent changes in traces with no lead sentence supporting it | The evidence gate (FR-025) stays in this slice precisely so this is observable before anything is loosened. |
| Removing `cardsJustShown` regresses something it silently protected | Reply-guard tests, and the scripted scenarios | It is removed **last** (Phase E), after the accounting it compensated for is proven. |

## Complexity Tracking

> No constitution violations. Table intentionally empty.

## Post-Design Constitution Re-check

Re-evaluated after Phase 1 artifacts were written: **passes.** The design adds no
new table, no new dependency, no new process and no new layer. It removes two
compensating mechanisms and one merge rule. The single genuinely new concept — a
bounded action loop — is required by ADR 22 and has exactly one implementation
with no speculative second case: it is built for one tool, and the scheduling
tools it will later carry are already declared.
