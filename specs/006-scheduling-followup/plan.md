# Implementation Plan: Scheduling and Follow-up

**Branch**: `006-scheduling-followup` | **Date**: 2026-09-06, **revised 2026-09-28** after spec 007 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/006-scheduling-followup/spec.md`

## Summary

> **Revised 2026-09-28.** Written against spec 004's turn; the turn is spec 007's now. What changed:
> **code proposes, the model books** — proposing is a code call when 007's `shouldProposeMeeting` says the offer
> is due, when the lead asks for other times, or never again after a decline; booking is the **only** new tool on
> 007's action loop. The options and the confirmation are **code-written**. The availability editor is cut
> (backlog 34). Booking is transitions of one row, so spec 009 is two small tools on top. Every dependency this
> plan once hedged against has merged; the hedges are gone.

One pure module computes concrete meeting options from a broker's own weekday
availability and busy intervals, and rotates brokers by specialization; code
proposes from it and one tool on spec 007's action loop books against it;
one worker consumer, registered the way 005's registry expects, claims and sends
follow-ups through the Notifier/SSE path. No new table — `conversations.followupState`
and `users.availability` already exist per `modelo-de-dados.md` §7.

Four decisions shape it: the slot search is **one pure function** —
`proposeSlots(busy, now, rules) → Option[]`, taking the broker's availability and
the configured notice/preferred times as arguments — so SC-002's 200 cases run
with no container; a proposal and its booking are **the same row**, moved
`proposed → confirmed`, so both events can name one id with no join table;
eligibility is **checked twice** — at claim and at send — since the window,
opt-out, a newly booked visit and pause state can all change in the gap a claim
leaves open; and follow-up state lives on the conversation (`followupState`), not
the lead, so pipeline stage and reengagement state never collide (ADR 19).

## Technical Context

**Language/Version**: TypeScript 5.x `strict`, Node 24 in containers, as item 1.

**Primary Dependencies**: existing only — Next.js 16.3, React 19.2, `drizzle-orm`,
`zod`, `pino`, `ai` 7.0.93, `@ai-sdk/openai-compatible` 3.0.44 (spec 004),
`@langfuse/{tracing,otel}` 5.11.0. No new dependency: date arithmetic in the agency
timezone is `Intl.DateTimeFormat` with `timeZone`, already in Node.

**Storage**: PostgreSQL 17, schema from spec 002 (`appointments`, `followup_jobs`,
`events`, `users.availability`, `users.specializations`, `conversations.followupState`).
Two indexes only, no new table.

**Testing**: `node:test` — unit for `domain/scheduling.ts` (the 200-case generator
behind SC-002, no database); integration against the container's Postgres for the
claim query, collision check and agency scoping; one `INTEGRATION=1`-tagged test
against local oMLX (`MODEL_ID=gemma-4-e4b-it-OptiQ-4bit`) for follow-up message
generation (SC-006).

**Target Platform**: Linux containers; current Chrome/Safari, 390 px up.
**Project Type**: Modular monolith — two tools and a service in the app, one
consumer in the worker, both from the same image.

**Performance Goals**: two concurrent claimers process 100 due attempts with zero
duplicates, zero loss (SC-005); confirmation visible in the widget under 3 s (SC-003).

**Constraints**: UI never imports `db/`; `domain/` imports nothing; only
`agent/provider.ts` touches a provider SDK; slot computation is a pure function of
busy intervals, the instant and the rules — no clock read inside it.

**Scale/Scope**: ~12 new files — one domain module, one service, one tool, one
worker consumer, one agenda screen, one Server Action file, one drawer action.

### Where this slice plugs into what exists (all merged as of 2026-09-28)

| Seam | Owner | What this slice does to it |
|---|---|---|
| `run()` in `agent/orchestrator.ts` | 007 | Calls `proposeAppointment` where `runProposeMeeting()` is called today; reads the extraction's decline and other-times facts; offers `act()` when a proposal is open, not only when a search is due |
| `actionTools()` / `agent/act.ts` | 007 | Adds `bookMeeting` — the loop's second tool, brought up alone after search (Gemma playbook order) |
| Extraction contract (`tools/update-slots.ts`, extraction prompt) | 004 / 007 | Two more facts beside `askedForHuman`/`optOut`: `declinedOffer`, `askedForTimes` (+ optional weekday/period) |
| `shouldProposeMeeting` + `offerOutstanding` | 007 | Unchanged rule; the outstanding fact now also sees a real `appointment.proposed` event, and a declined proposal keeps it from re-firing |
| `task()` in `agent/prompts/system.ts` | 004 / 007 | The viewing/call branches stop asking "qual dia da semana"; they say a code-written options sentence verbatim |
| `commitTurn` in `services/conversation.ts` | 004 | Enqueue follow-up at the end of a turn; cancel it on an inbound lead message |
| `jobs/consumers.ts` sweep registry | 005 | Registers the follow-up consumer |
| Lead drawer `ActionsRow` | 005 | One button: send the follow-up now |
| `scheduling.stub.ts` | 004 | Deleted; its two stub tools replaced by `bookMeeting` and a code-side `proposeAppointment` |

## Constitution Check

*GATE: passed before Phase 0. Re-checked after Phase 1 — result at the end.*

| # | Principle | How this slice satisfies it |
|---|---|---|
| I | Document Authority | Slot rules, event types and table shapes come from `modelo-de-dados.md`; Clarifications resolve every open question against it, none invented. |
| II | Language Boundaries | Code and plan in English; follow-up message and confirmation card pt-BR, generated in `agent/`. No i18n layer (SC-006). |
| III | Modular Monolith | `domain/scheduling.ts` has zero imports. The consumer joins the existing worker loop via 005's registry — no new process, no process-local state. |
| IV | One Data Path | Agenda screen and drawer action are Server Components/Actions calling `services/`; no `db/` import under `app/` (ESLint zones). |
| V | Deterministic Slot Machine | The model never picks a time or decides eligibility — `proposeSlots` and the eligibility re-check are plain code (FR-002, FR-012). |
| VI | Provider Independence | Only the follow-up message call goes through `agent/provider.ts`; `jobs/followup.ts` imports no provider SDK. |
| VII | Observability Without Coupling | Follow-up generation traces as `followup.send`, session id = conversation id, `functionId: 'followup'`; its `traceId` rides the `followup.sent` event. Langfuse absent changes nothing (FR-013, FR-016). |
| VIII | Privacy and PII | Follow-up prompt input (the summary, masked at write time by 005) and output pass through `core/masking.ts` before any log or trace (FR-014). |
| IX | Resilience | Claiming uses `FOR UPDATE SKIP LOCKED`; a failed send leaves the attempt count untouched; booking's collision check is the second lead's failure path, not a race (SC-005). |
| X | User Experience Discipline | **Who**: the broker, alone, on their own agenda. **What they came to do**: fix a wrong or missing weekly schedule before the agent proposes hours nobody can honor. **The one interaction**: seven always-visible weekday rows — toggle, start, end — saved by one Server Action per row change, no separate edit mode, no modal; the row's own state (saved/saving) is the only feedback needed, and a disabled end-before-start pair is caught inline, not after submit. |

### Gates

| Gate | Status |
|---|---|
| Stack rows unchanged; `npm`; migrations committed | Pass — no new dependency, one migration holding two indexes |
| No Redis; no new runtime service; `docker compose exec app …` for every command | Pass — the consumer joins the existing worker loop |
| Environment Contract (schema ⇄ `.env.example` ⇄ `contracts/`, one commit) | Applies: `FOLLOWUP_FIRST_DELAY_MINUTES` replaces `FOLLOWUP_FIRST_DELAY_HOURS`; `FOLLOWUP_BATCH_SIZE`, `SCHEDULING_MIN_NOTICE_MINUTES`, `SCHEDULING_PREFERRED_TIMES` and `FOLLOWUP_BACKOFF_FACTOR` (replacing the hard-coded ×3) are new — all land with the schema change in one commit (FR-018) |
| Post-design re-check | No new violations; Complexity Tracking stays empty — both seams this slice touches (`JobQueue`, the sweep registry) already carry their justification in 001 and 005 |

## Project Structure

### Documentation (this feature)

```text
specs/006-scheduling-followup/
├── spec.md
├── plan.md              # this file
├── data-model.md         # the two indexes this slice needs, not in modelo-de-dados.md
├── quickstart.md
├── contracts/
│   └── interfaces.md     # domain signatures, tool schemas, consumer and config contract
└── tasks.md
```

### Source Code (repository root)

```text
src/domain/    scheduling.ts (proposeSlots · nextBrokerInRotation · isWithinWindow ·
               nextWindowOpening) — pure, no imports beyond the appointment/slot types
src/services/  scheduling.ts (proposeAppointment · bookAppointment · declineProposal ·
               loadBusyIntervals · loadBrokerAvailability · listAppointments ·
               markAppointmentStatus)
               followup.ts (scheduleFollowup · cancelFollowup · triggerNow)
src/agent/     tools/book-meeting.ts (the one new tool, replacing
               tools/scheduling.stub.ts) · prompts/meeting.ts (the code-written
               options sentence and confirmation) · followup-writer.ts (message
               generation through provider.ts) · orchestrator.ts (edited: propose,
               decline, other-times, act gating)
src/jobs/      followup.ts — the SweepConsumer sending due attempts
src/app/(app)/agenda/   page.tsx · agenda.module.css · actions.ts (markDone ·
               markCancelled) · _components/AppointmentRow.tsx
src/app/(app)/leads/    actions.ts (edited — one action, triggerFollowupNow)
src/db/migrations/      two indexes only
tests/         scheduling.test.ts (SC-002, 200 cases) · rotation.test.ts ·
               followup-claim.test.ts (Postgres, SC-005) · followup-eligibility.test.ts ·
               agenda-scope.test.ts (Postgres) · meeting-escapes.test.ts (decline, other times, pivot — SC-013) ·
               followup-writer.integration.test.ts (oMLX)
```

**Structure Decision**: the layout of `visao-geral.md` §3, unchanged — only
`app/(app)/agenda/` is new ground; everything else fills a placeholder or edits a
file another spec named in advance (`tools/index.ts`, `jobs/consumers.ts`,
`leads/actions.ts`).

## Shortest implementation path

**1 · The pure core.** `domain/scheduling.ts`: `proposeSlots(busy, now, rules) → Option[]` walks ten business days forward, testing `rules.preferredTimes` in order against `busy` and the broker's own enabled weekday/hour window, and the `rules.minNoticeMinutes` floor, stopping at three — no config read inside `domain/`, every rule arrives as an argument. `nextBrokerInRotation(brokerIds, assignmentCounts)` picks the minimum count, ties by list order; the caller pre-filters `brokerIds` by specialization, falling back to the full roster. `isWithinWindow`/`nextWindowOpening` take window bounds and timezone as arguments. `tests/scheduling.test.ts` generates 200 random cases first (SC-002); the only part finishable before any other spec merges.

**2 · Scheduling service.** `services/scheduling.ts`: `loadBusyIntervals(brokerId)` reads confirmed appointments only (FR-004 — proposed never block); `loadBrokerAvailability(brokerId)` reads `users.availability`. Propose filters brokers by `specializations` containing the lead's intent (falling back to every broker), assigns one via rotation, upserts one `proposed` row keyed by conversation (replacing any previous proposal), and for `investment` forces `type: 'call'` with no `propertyId` (FR-003a). Book validates the chosen index or explicit time against `proposeSlots`' own rules, moves that row to `confirmed` under a collision-checking transaction, sets the lead's pipeline stage `scheduled` regardless of conversation state, emits `appointment.confirmed`. A losing second booking gets its reason back; no row touched.

**3 · Propose in code, book by tool.** `proposeAppointment` is called from `run()` in three places and only
there: when `shouldProposeMeeting` fires (the offer is due and nothing is outstanding), when the extraction
reports `askedForTimes` — with an open proposal (other times) or without one (the lead asking to schedule,
including after a decline) — re-proposing with the optional weekday/period as a filter on `proposeSlots`'
output, and never after `declinedOffer` closed one — a decline moves the proposed row to
`cancelled` and records it so `offerOutstanding`'s derived fact stops a re-fire (FR-005a). The options sentence
is **written by code** from the returned options — *"Tenho estes horários com alguém da nossa equipe: 1) qui 02/10 às 10h …"* — never a broker's name (FR-005e) —
and said verbatim, like 007's reconfirmation, because dates and times are exactly what the `unbackedFigure`
guard exists to stop a model inventing (FR-005d). `bookMeeting({ optionIndex } | { scheduledAt })` is the one
tool, added to `actionTools()` with 007's contract discipline: when to call (the lead picked an offered option
or named a time while a proposal is open), when not to (no open proposal; the lead is asking about something
else), and a readable refusal carrying the reason when validation fails (FR-005). `act()` is offered when a
search is due, **or** a proposal is open **and** the extraction reports the lead picked or named a time (FR-005f), so *"pode ser aquela de quinta então"* two turns after a change of
subject still books (FR-005c). The confirmation card renders from the booked row in the commit step.

**3a · Built for 009.** Proposing is **two functions**: `computeOptions` (computes, writes nothing) and
`recordProposal` (cancels the open proposed row and inserts the new one). 009's reschedule reuses
`computeOptions` for a confirmed appointment and moves that row. Booking is transitions of the one appointment row — `proposed → confirmed`,
`proposed → cancelled` (declined or replaced), `confirmed → done | cancelled` from the agenda. Spec 009's
reschedule is `confirmed → confirmed` at a new instant, re-validated by the same `proposeSlots` rules through
the same service function; its cancel is `confirmed → cancelled`. Nothing here may validate a time any other way.

**4 · Follow-up enqueue and cancellation.** `services/followup.ts`: `scheduleFollowup(tx, conversationId, now)` upserts keyed by conversation — a `pending` row at `now + FOLLOWUP_FIRST_DELAY_MINUTES`, setting `conversations.followupState = 'pending'`, or moves an existing one's `scheduledFor`, guarded (paused/closed, opted-out, a confirmed future appointment, nothing pending) in the same statement's `where`. `cancelFollowup(tx, conversationId)` cancels every pending row and resets `followupAttempts` to zero and `followupState` to `none`; if one was already `sent`, emits `followup.recovered` and lets 005's status recompute run. `commitTurn` calls both — scheduling at the end of an agent turn that leaves the lead a question or an open proposal, cancelling on every inbound lead message — and scheduling again when a held conversation returns to the agent (FR-009a). An open proposal counts as waiting on the lead only while it is the last thing the agent asked.

**5 · The consumer.** `jobs/followup.ts`: claim is one transaction, `select … where status = 'pending' and scheduledFor <= now() for update skip locked limit <batch>`, moved to `running`. Right after claiming, re-check eligibility (FR-012): active, not opted out, no confirmed future appointment, attempt ≤ max, instant inside the window. Outside the window → `nextWindowOpening`, still `pending`, attempt untouched — never cancelled. Any other failed check → `cancelled`, nothing sent. Passing → `followup-writer.ts` composes from the stored summary (falling back to slot state); the eligibility check runs once more right before send — composing an oMLX message takes seconds, long enough for the lead to reply — so a conversation that woke up mid-composition gets nothing. Delivery goes through `ChannelAdapter.send` and the Notifier so an open widget updates over SSE, never polling. On send, the message is stored with `metadata.isFollowUp = true`; success moves the row `sent`, increments `followupAttempts`, emits `followup.sent` with `actorType: 'worker'` and the writer call's Langfuse `traceId` (trace name `followup.send`, session id = conversation id), and schedules the next attempt at `FOLLOWUP_BACKOFF_FACTOR` times the interval unless the max was just reached, in which case `followupState` becomes `exhausted`. A model or channel failure, or the second eligibility check failing, leaves the row `pending` at its original time (or cancels it, matching the first check's rule), consuming no attempt.

**6 · Demo trigger.** `triggerNow(scope, leadId)` in `services/followup.ts` sets the lead's one pending row's `scheduledFor = now()`, or returns "nothing pending". One Server Action in `leads/actions.ts` calls it and revalidates; the drawer's `ActionsRow` gets one button, disabled with the reason when nothing applies.

**7 · Agenda.** `listAppointments(scope, range)` in `services/scheduling.ts` — broker sees their own, manager the agency's, grouped by day server-side. `page.tsx` renders the groups plus `markDone`/`markCancelled` Server Actions; `markDone` also sets the lead's stage `visited`, and both emit their event with `actorType: 'user'` and `actorUserId` (FR-008). Empty state is copy, not a spinner.

**7a · The agency's follow-up switch (FR-019).** `agencies.followupEnabled`, default on, set by a sales manager
from the leads dashboard. The worker reads it in **both** eligibility checks and cancels a due attempt if it's
off; enqueueing never reads it, so switching back on needs no backfill. **7b · *Visita marcada* (FR-008b)**
becomes "has a confirmed future appointment" in `services/leads.ts`, so stages can stay forward-only.

**8 · Broker availability.** *Cut 2026-09-28 → backlog 34.* `loadBrokerAvailability` still reads the seeded `users.availability`; nothing writes it.

**9 · Seed and config.** `FOLLOWUP_FIRST_DELAY_MINUTES` replaces `FOLLOWUP_FIRST_DELAY_HOURS`, and `SCHEDULING_MIN_NOTICE_MINUTES`, `SCHEDULING_PREFERRED_TIMES`, `FOLLOWUP_BACKOFF_FACTOR` land new, in `core/config.ts` and `.env.example` in one commit; demo values (`FOLLOWUP_FIRST_DELAY_MINUTES=5`, `WORKER_SWEEP_INTERVAL_MS=15000`) live in `quickstart.md`, apart from the production-shaped defaults in `.env.example`. Spec 002's seed gains the stale lead's due `followup_jobs` row — this slice fixes the row shape, 002 writes it. Verify with [quickstart.md](quickstart.md).

### What is deliberately not built

A calendar UI. Rescheduling or cancelling from the conversation — spec 009, right
after this, built on 3a. The broker availability editor — backlog 34. External
calendar integration or e-mail reminders. Holiday calendars, capacity limits. A generic
rules engine for slot search — one function with named parameters is the whole of
it, now taking availability and configured notice/preferred times as arguments.

## Complexity Tracking

No constitution violations. Table intentionally empty — the sweep registry and
`JobQueue` are both pre-justified exceptions this slice consumes rather than
introduces.
