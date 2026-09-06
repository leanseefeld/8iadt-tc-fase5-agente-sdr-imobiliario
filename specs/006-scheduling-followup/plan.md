# Implementation Plan: Scheduling and Follow-up

**Branch**: `006-scheduling-followup` | **Date**: 2026-09-06 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/006-scheduling-followup/spec.md`

## Summary

One pure module computes concrete meeting options and broker rotation from busy
intervals with no database; two tools replacing 004's declared stubs let the
orchestrator propose and book against it; one worker consumer, registered the way
005's registry expects, claims and sends follow-ups. No new table.

Three decisions shape it: the slot search is **one pure function** —
`proposeSlots(busy, now, rules) → Option[]` — so SC-002's 200 cases run with no
container; a proposal and its booking are **the same row**, moved
`proposed → confirmed`, so both events can name one id with no join table; and
eligibility is **checked twice** — at claim and at send — since the window,
opt-out and pause state can all change in the gap a claim leaves open.

## Technical Context

**Language/Version**: TypeScript 5.x `strict`, Node 24 in containers, as item 1.

**Primary Dependencies**: existing only — Next.js 16.3, React 19.2, `drizzle-orm`,
`zod`, `pino`, `ai` 7.0.93, `@ai-sdk/openai-compatible` 3.0.44 (spec 004),
`@langfuse/{tracing,otel}` 5.11.0. No new dependency: date arithmetic in the agency
timezone is `Intl.DateTimeFormat` with `timeZone`, already in Node.

**Storage**: PostgreSQL 17, schema from spec 002 (`appointments`, `followup_jobs`,
`events`). Two indexes only, no new table.

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

**Scale/Scope**: ~14 new files — one domain module, one service, two tools, one
worker consumer, one agenda screen, two Server Actions, one drawer action.

### Inter-spec dependencies, named so they are not assumed

| Needed | Owner | If absent when this lands |
|---|---|---|
| `tools/scheduling.stub.ts`, `tools/index.ts` registry | 004 | Create the registry with four stub tools; replace on merge. |
| `jobs/consumers.ts` registry, sweep iterating it | 005 | Create it as spec.md fixes: `register({ name, run(db, now) })` — 005's plan says `run(ctx)`; reconcile at first implementer, not silently. |
| `services/events.ts`, `core/masking.ts` | 002/004 | Create the minimal helper needed. |
| `scopeForUser` | 003 | Blocks the agenda screen only; propose/book need no session. |
| `ChannelAdapter.send` | 004 | Blocks FR-015 only; domain and claim logic stand without it. |
| Lead drawer `ActionsRow` | 005 | Stand in locally if absent; wire in on merge. |

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
| VII | Observability Without Coupling | Follow-up generation carries `functionId: 'followup'` with lead/conversation ids; Langfuse absent changes nothing (FR-013). |
| VIII | Privacy and PII | Follow-up prompt input (the summary, masked at write time by 005) and output pass through `core/masking.ts` before any log or trace (FR-014). |
| IX | Resilience | Claiming uses `FOR UPDATE SKIP LOCKED`; a failed send leaves the attempt count untouched; booking's collision check is the second lead's failure path, not a race (SC-005). |

### Gates

| Gate | Status |
|---|---|
| Stack rows unchanged; `npm`; migrations committed | Pass — no new dependency, one migration holding two indexes |
| No Redis; no new runtime service; `docker compose exec app …` for every command | Pass — the consumer joins the existing worker loop |
| Environment Contract (schema ⇄ `.env.example` ⇄ `contracts/`, one commit) | Applies: `FOLLOWUP_FIRST_DELAY_MINUTES` replaces `FOLLOWUP_FIRST_DELAY_HOURS`; `FOLLOWUP_BATCH_SIZE` is new — both land with the schema change in one commit (FR-018) |
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
src/services/  scheduling.ts (proposeAppointment · bookAppointment · loadBusyIntervals)
               followup.ts (scheduleFollowup · cancelFollowup · triggerNow)
src/agent/     tools/scheduling.ts (proposeMeeting · bookMeeting, replacing
               tools/scheduling.stub.ts) · followup-writer.ts (message generation
               through provider.ts)
src/jobs/      followup.ts — the SweepConsumer sending due attempts
src/app/(app)/agenda/   page.tsx · agenda.module.css · _components/AppointmentRow.tsx
src/app/(app)/leads/    actions.ts (edited — one action, triggerFollowupNow)
src/db/migrations/      two indexes only
tests/         scheduling.test.ts (SC-002, 200 cases) · rotation.test.ts ·
               followup-claim.test.ts (Postgres, SC-005) · followup-eligibility.test.ts ·
               agenda-scope.test.ts (Postgres) · followup-writer.integration.test.ts (oMLX)
```

**Structure Decision**: the layout of `visao-geral.md` §3, unchanged — only
`app/(app)/agenda/` is new ground; everything else fills a placeholder or edits a
file another spec named in advance (`tools/index.ts`, `jobs/consumers.ts`,
`leads/actions.ts`).

## Shortest implementation path

**1 · The pure core.** `domain/scheduling.ts`: `proposeSlots(busy, now, rules) → Option[]` walks ten business days forward, testing 10:00/14:00/16:30 in order against `busy` and the 24-hour floor, stopping at three. `nextBrokerInRotation(brokerIds, assignmentCounts)` picks the minimum count, ties by list order. `isWithinWindow`/`nextWindowOpening` take window bounds and timezone as arguments — no config read inside `domain/`. `tests/scheduling.test.ts` generates 200 random cases first (SC-002); the only part finishable before any other spec merges.

**2 · Scheduling service.** `services/scheduling.ts`: `loadBusyIntervals(brokerId)` reads confirmed appointments only (FR-004 — proposed never block). Propose assigns a broker via rotation on first call, upserts one `proposed` row keyed by conversation (replacing any previous proposal), emits `appointment.proposed`. Book validates the chosen index or explicit time against `proposeSlots`' own rules, moves that row to `confirmed` under a collision-checking transaction, sets the lead `scheduled`, emits `appointment.confirmed`. A losing second booking gets its reason back; no row touched.

**3 · Tools.** `agent/tools/scheduling.ts` replaces `scheduling.stub.ts`: `proposeMeeting` (reads the active conversation) and `bookMeeting({ optionIndex } | { scheduledAt })`, registered in `tools/index.ts` with the schemas 004 left as placeholders. Both return structured results; the orchestrator's commit step renders the confirmation card, not the tool.

**4 · Follow-up enqueue and cancellation.** `services/followup.ts`: `scheduleFollowup(tx, conversationId, now)` upserts keyed by conversation — a `pending` row at `now + FOLLOWUP_FIRST_DELAY_MINUTES`, or moves an existing one's `scheduledFor`, guarded (paused/closed, opted-out, nothing pending) in the same statement's `where`. `cancelFollowup(tx, conversationId)` cancels every pending row; if one was already `sent`, emits `followup.recovered` and lets 005's status recompute run. Spec 004 calls both at the two points its Assumptions name.

**5 · The consumer.** `jobs/followup.ts`: claim is one transaction, `select … where status = 'pending' and scheduledFor <= now() for update skip locked limit <batch>`, moved to `running`. Per row, re-check eligibility (FR-012): active, not opted out, attempt ≤ max, instant inside the window. Outside the window → `nextWindowOpening`, still `pending`, attempt untouched — never cancelled. Any other failed check → `cancelled`, nothing sent. Passing → `followup-writer.ts` composes from the stored summary (falling back to slot state) and sends through `ChannelAdapter`, stored with `metadata.isFollowUp = true`; success moves the row `sent`, increments `followupAttempts`, emits `followup.sent`, and schedules the next attempt at 3× the interval unless the max was just reached, in which case the lead becomes `unresponsive`. A model or channel failure leaves the row `pending` at its original time, consuming nothing.

**6 · Demo trigger.** `triggerNow(scope, leadId)` in `services/followup.ts` sets the lead's one pending row's `scheduledFor = now()`, or returns "nothing pending". One Server Action in `leads/actions.ts` calls it and revalidates; the drawer's `ActionsRow` gets one button, disabled with the reason when nothing applies.

**7 · Agenda.** `listAppointments(scope, range)` in `services/scheduling.ts` — broker sees their own, manager the agency's, grouped by day server-side. `page.tsx` renders the groups plus `markDone`/`markCancelled` Server Actions. Empty state is copy, not a spinner.

**8 · Seed and config.** `FOLLOWUP_FIRST_DELAY_MINUTES` replaces `FOLLOWUP_FIRST_DELAY_HOURS` in `core/config.ts` and `.env.example` in one commit; demo values (short delay, short sweep) live in `quickstart.md`, apart from the production-shaped defaults in `.env.example`. Spec 002's seed gains the stale lead's due `followup_jobs` row — this slice fixes the row shape, 002 writes it. Verify with [quickstart.md](quickstart.md).

### What is deliberately not built

A calendar UI. Rescheduling or cancelling from the widget. External calendar
integration or e-mail reminders. Per-broker working hours or holiday calendars. A
generic rules engine for slot search — one function with named parameters is the
whole of it.

## Complexity Tracking

No constitution violations. Table intentionally empty — the sweep registry and
`JobQueue` are both pre-justified exceptions this slice consumes rather than
introduces.
