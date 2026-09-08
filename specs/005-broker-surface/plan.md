# Implementation Plan: Broker Surface

**Branch**: `005-broker-surface` | **Date**: 2026-09-05 | **Spec**: [spec.md](spec.md)

## Summary

Five pure rule functions in `domain/`, one worker consumer turning the event outbox into summaries, one screen at `/leads` with a URL-addressable panel fed by an agency-scoped SSE stream, and five Server Actions for takeover. No new table. Four decisions shape it: **all list state lives in the query string**, so filters, search, the *Meus leads* toggle, page and the open panel survive reloads with no client state; **the panel is the same route**, so the list never unmounts; **live updates ride the `Notifier` interface of `visao-geral.md` §8** (Postgres `LISTEN/NOTIFY`, one connection per replica, ids only, re-read scoped by agency) rather than a refresh timer, so "live" costs one `EventSource` and no socket server; and **the summariser claims in two steps** — pick conversations, then lock their turn rows — because `FOR UPDATE` cannot combine with the aggregate that finds them. `research.md` is deliberately not produced, following spec 001: each rationale is inline below, next to the decision it explains.

### Spec amendments agreed before planning

| ID | Change | Reason |
|---|---|---|
| FR-012 | "Two to four sentences" is a prompt instruction verified by review, not a validator. Only the 90-character preview limit is enforced in code, by truncation at a word boundary. | A sentence counter on a 4-bit model would reject good summaries with no repair path. The limit that must hold is the one a table cell cannot absorb. |
| Key Entities | "No new tables" stands, but this slice contributes one migration adding **indexes**: a partial index on unprocessed turn events and a covering index for the list ordering. | Spec 002 cannot know the queries this slice writes. The constitution's performance rule says index what you query. |

## Technical Context

- **Language/Version**: TypeScript 5.x `strict`, Node 24 in containers, as item 1.
- **Primary Dependencies**: existing only — Next.js 16.3, React 19.2, `drizzle-orm`, `zod`, `pino`, plus `ai` 7.0.93, `@ai-sdk/openai-compatible` 3.0.44 and `@langfuse/{tracing,otel}` 5.11.0 introduced by spec 004. **This slice adds no dependency**: no component, charting or date library; relative times are a twenty-line pt-BR formatter in `domain/`.
- **Storage**: PostgreSQL 17, schema from spec 002. One migration, indexes only.
- **Testing**: `node:test` — unit for `domain/scoring.ts` and preview-line truncation; integration against the container's Postgres for the claim query and the scoping rules; one `INTEGRATION=1`-tagged test against local oMLX (`MODEL_ID=gemma-4-e4b-it-OptiQ-4bit`) for the summariser.
- **Target Platform**: Linux containers; current Chrome/Safari, 390 px up.
- **Project Type**: Modular monolith — screens in the app, one consumer in the worker, both from the same image.
- **Performance Goals**: `/leads` under 1.5 s with 500 leads (SC-003), constant query count per render, a sweep bounded by its batch size.
- **Constraints**: UI never imports `db/`; `domain/` imports nothing; only `agent/provider.ts` touches a provider SDK; summarisation never on the reply path; real-time delivery is `Notifier`/SSE only, no polling.
- **Scale/Scope**: ~29 new files — one screen, one panel, one SSE route, five Server Actions, five services, one worker consumer, five rule functions.

### Inter-spec dependencies, named so they are not assumed

| Needed | Owner | If absent when this lands |
|---|---|---|
| `domain/slots.ts` — slot Zod schema and `Intent` | 002 or 004 | Create it from data model §2; it is 30 lines and both specs need the same one. |
| `services/events.ts` — append-event helper | 004 | Create it; this slice writes five of the catalog's types. |
| `core/masking.ts` — the single PII rule | 002 | Create it; FR-014 depends on it. |
| `scopeForUser` — session and role scoping, now `{ agencyId }` for both roles (FR-019) | 003 | Blocking. Do not fake it — and confirm 003 dropped the broker-only branch before wiring the *Meus leads* toggle here. |
| `ChannelAdapter.send` | 004 | Blocking for FR-034 only; the rest of the slice stands. |
| `Notifier` — `publish(agencyId, event)` / `subscribe` over `LISTEN/NOTIFY` | 004 (introduced alongside the widget's own stream) | Create a minimal version scoped to this slice's needs if 004 has not landed; the interface is one module per `visao-geral.md` §8, so a later swap costs nothing here. |

## Constitution Check

*GATE: passed before Phase 0. Re-checked after Phase 1 — result at the end.*

| # | Principle | How this slice satisfies it | Verified by |
|---|---|---|---|
| I | Document Authority | Score weights, bands, the three state axes and every event type come from `modelo-de-dados.md` §§2–7 and ADR 11/19. `reference/` informed screen shape only. No open decision is answered by invention. | Inspection |
| II | Language Boundaries | Code and this plan in English; every rendered string pt-BR, in the component. No i18n layer, no emoji (FR-024). | SC-009 |
| III | Modular Monolith | Rules in `domain/` with zero imports. The consumer is registered into the existing worker loop, not a new process. `Notifier` is one module, no new runtime service. No process-local state: the sweep reads its work from Postgres each pass. | ESLint zones |
| IV | One Data Path | Screens are Server Components calling `services/`; Server Actions call the same services; the SSE route reads through `Notifier`, never `db/` directly. No `db/` import under `app/`. | ESLint, T-check |
| V | Deterministic Slot Machine | This slice owns the deterministic half — score, qualification, handoff, meeting proposal — and hands it to 004's orchestrator. The model never sees a score. | FR-006, SC-001 |
| VI | Provider Independence | The summariser calls the model through `agent/provider.ts`. `jobs/summarize.ts` imports no provider SDK. | Inspection |
| VII | Observability Without Coupling | The summary call carries AI SDK telemetry with `functionId: 'summary.generate'`, session id = conversation id. Langfuse absent changes nothing; the summariser failing changes nothing lead-facing. | FR-014, SC-006 |
| VIII | Privacy and PII | Summary input and output are masked through `core/masking.ts` before reaching logs or traces. The summary itself is broker-only and never returned to the widget. | FR-014 |
| IX | Resilience | The claim is transactional; a failed summary clears its turns rather than looping; taking over an already-held conversation loses to a conditional update; a dropped SSE connection replays from the database, never from memory. | SC-007, FR-016 |
| X | User Experience Discipline | See the who/what/how paragraph below, for the dashboard and the drawer. | Inspection, SC-002, SC-010 |

### Who, what, how (Principle X)

**Dashboard.** Who: a broker or manager opening the tab first each morning. What:
find out, at a glance, who to call first and what needs them now. How: scan
top-to-bottom by score, letting the conversation and stage chips answer "does this
need me" before a click — never a grid where every column carries equal weight.

**Drawer.** Who: the same broker, committed to one lead. What: read the
conversation in twenty seconds and, if it is theirs, run it. How: summary and
qualification above the fold answer "what does this person want" first;
**Assumir**/**Devolver** is the one primary action, status and reassign secondary.

### Gates

| Gate | Status |
|---|---|
| Stack rows unchanged; `npm`; migrations committed | Pass — no new dependency, one migration holding indexes only |
| No Redis; no new runtime service; `docker compose exec app …` for every command | Pass — the consumer joins the existing worker; `Notifier` rides the existing Postgres connection, not a new service |
| Environment Contract (schema ⇄ `.env.example` ⇄ `contracts/`, one commit) | Applies: `SUMMARY_DEBOUNCE_SECONDS`, `SUMMARY_BATCH_SIZE`, `LEADS_PAGE_SIZE`, `DASHBOARD_LIVE_WINDOW_MINUTES`, `LANGFUSE_PUBLIC_URL` |
| Post-design re-check | No new violations; one Complexity Tracking entry, for the registry |

## Project Structure

### Documentation (this feature)

`spec.md` · `plan.md` · `tasks.md` · `data-model.md` (columns filled, read models,
indexes) · `quickstart.md` · `contracts/surfaces.md` · `checklists/requirements.md`.

### Source Code (repository root)

```text
src/domain/    scoring.ts (scoreLead · temperatureOf · isQualified · shouldHandoff ·
               shouldProposeMeeting) · lead-status.ts (FR-007) · relative-time.ts
src/services/  qualification.ts · leads.ts (list + panel) · metrics.ts ·
               handoff.ts (assume · reply · return · status · reassign)
src/core/      notifier.ts — the `Notifier` interface, if 004 has not created it
src/agent/     summarizer.ts — prompt + generateObject through provider.ts
src/jobs/      consumers.ts (SweepConsumer type + registry) · summarize.ts
src/worker/    index.ts — the sweep iterates the registry (edited)
src/db/migrations/    indexes only
src/app/api/leads/stream/  route.ts — agency-scoped SSE endpoint over `Notifier`
src/app/(app)/leads/  page.tsx · actions.ts · leads.module.css · _components/
               (MetricTiles · FilterChips · MeusLeadsToggle · SearchBox · LiveLeads
               · LeadRow · ConversationChip · StageChip · LiveDot · LeadDrawer ·
               LeadPanel · QualificationTable · Transcript · Timeline · ActionsRow · ReplyBox)
tests/         scoring.test.ts · preview-line.test.ts · summarize-claim.test.ts ·
               leads-scope.test.ts (Postgres) · summarizer.integration.test.ts (oMLX)
```

**Structure Decision**: the layout of `visao-geral.md` §3, unchanged — only
`app/(app)/leads/` is new ground.

## Shortest implementation path

**1 · The rules.** `domain/scoring.ts`: five exported functions — `scoreLead`,
`temperatureOf`, `isQualified`, `shouldHandoff` (only `'asked'` / `'fallback'`) and
`shouldProposeMeeting` (hot and contact known) — no imports beyond the slot types.
`tests/scoring.test.ts` first — a table covering both scripts, both bonuses, the
cap and each band boundary (39/40, 69/70). This is the only part finishable before
any other spec merges, and it is what SC-001 measures. `lead-status.ts` is a frozen
map of FR-007's pipeline transitions — forward-only, plus `won`/`lost` from any
stage and `visited` for 006's appointment-done action; illegal ones throw.

**2 · Qualification service.** `services/qualification.ts` exposes
`recordTurnOutcome({ leadId, conversationId, tx })`: recompute the score, write it
with the pipeline stage, and append `lead.qualified` on the first crossing plus
`handoff.requested` with its reason — all in the caller's transaction. "First
crossing" is `update leads set status='qualified' where id=$1 and status<>
'qualified'`, with the event appended only if a row was touched: idempotence is the
database's job, not a read-then-write. Spec 004 calls this once per turn, and calls
`shouldProposeMeeting` itself to decide whether to offer a visit — that call never
touches `conversations.status`.

**3 · Indexes.** One migration: a partial index on `events (conversation_id) where
type='conversation.turn' and processed_at is null` for the claim, and `leads
(agency_id, assigned_broker_id, score desc, updated_at desc)` for the list. Each
exists because a query here needs it.

**4 · The summariser.** `jobs/summarize.ts`, three steps per sweep. *Select*:
`select conversation_id from events where type='conversation.turn' and processed_at
is null group by conversation_id having max(created_at) < now() - interval
'<debounce>' order by min(created_at) limit <batch>` — unlocked, because `FOR
UPDATE` is illegal beside `GROUP BY`. *Claim*: one transaction per conversation,
`select id … where conversation_id=$1 and processed_at is null for update skip
locked`; zero rows means another worker has it, so skip. *Write*: summarise, then
set `summary`, `previewLine` and `summaryUpdatedAt`, mark the claimed events
processed and append `summary.updated` — same transaction. On failure the turns are
marked processed anyway and the stored summary is left alone; the spec's
clarification explains why a stale summary beats a poison pill.
`agent/summarizer.ts` calls `generateObject` over a two-field Zod schema with the
stored summary plus the messages after `summaryUpdatedAt`, and truncates
`previewLine` at the last word boundary under 90 characters.

**5 · The registry.** `jobs/consumers.ts` declares `type SweepConsumer = { name:
string; run(ctx: { db: Database; now: Date; log: Logger }): Promise<void> }` and exports an array. `worker/index.ts` iterates
it, each consumer in its own `try`/`catch` under a child logger bound to its name,
so one failure never stops another. Spec 006 appends `followup.ts` and edits no loop.

**6 · Reads.** `services/leads.ts` returns the list in one query — leads joined to
their active conversation, filtered, searched with `ilike` over name, phone, e-mail
and preview line, ordered `score desc, last_lead_message_at desc`, paged — and the
panel in three (lead + conversation, messages, events). `services/metrics.ts` is one
statement: `filter (where type = …)` aggregates for three tiles, and
`percentile_cont(0.5)` over the gap from each `lead.created` to that lead's first
`agent` message for the median. Both take the scope from `scopeForUser` and never
accept a raw `agencyId` from a caller.

**7 · The screen.** `page.tsx` reads `searchParams` — `filtro`, `q`, `mine`, `page`,
`lead` — and renders tiles, list and, when `lead` is present, the panel. `mine`
defaults server-side to `true` for a broker session, `false` for a manager's, so
the toggle needs no client state either. Client components: `SearchBox`
(debounced), `MeusLeadsToggle` (flips `mine` in the query string), `LiveLeads`
(`EventSource` against `/api/leads/stream`, `router.refresh()` per event,
"Conexão perdida. Reconectando…" after two missed pulses, `visao-geral.md` §8),
`LeadDrawer` (Escape, focus restore, `inert` behind it) and the action controls;
filter chips, `ConversationChip`, `StageChip` and `LiveDot` are plain server-
rendered links and fields — no client state for a label. One CSS Module plus four
shell tokens — neutral warm-grey ground, one accent, `--temp-hot`/`--temp-warm`/
`--temp-cold` — 14 px base, 56 px rows, tabular figures, 420 px panel going full
screen below 768 px.

**8 · Handoff.** Assume is `update conversations set status='paused',
held_by_user_id=$2 where id=$1 and status<>'paused'`, available for any lead at any
pipeline stage; zero rows means someone else took it and the action says so. Reply
appends a `broker` message, calls `ChannelAdapter.send`, and publishes through
`Notifier` so the widget's stream carries it; return clears `heldByUserId` and sets
`active`. Reassignment (manager only) writes `assignedBrokerId` and appends
`lead.reassigned` with `{ fromBrokerId, toBrokerId }` and actor `user`. Every
action re-reads the session and re-applies the scope first — a Server Action is a
public endpoint, and the client's claim about who it is is worth nothing — then
ends with `revalidatePath('/leads')` plus a `Notifier.publish` for other viewers.
Verify with [quickstart.md](quickstart.md).

### What is deliberately not built

A charting or date library. A generic filter/table abstraction over one list. A
WebSocket server — SSE over the existing Postgres connection covers it. A summary
retry ledger. Any notification beyond the dashboard. A `repositories/` layer.
Optimistic UI on the panel's actions — a `revalidatePath` round trip on a local
Postgres is faster than the animation would be.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| `SweepConsumer` registry — an abstraction with one implementation in this slice | Spec 006 adds the second implementation immediately and by name. The constitution rejects a pattern with "no concrete second case"; here the second case is a merged backlog row, not a hypothesis. The alternative is that 006 edits this slice's loop, which makes the two slices conflict in one file. | Calling `summarize()` directly from `worker/index.ts` is two lines shorter and forces every later consumer to modify the loop, its error handling and its logging — the drift the registry prevents. |
