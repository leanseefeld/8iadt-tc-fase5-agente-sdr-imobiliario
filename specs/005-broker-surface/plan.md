# Implementation Plan: Broker Surface

**Branch**: `005-broker-surface` | **Date**: 2026-09-05 | **Spec**: [spec.md](spec.md)

## Summary

Four pure rule functions in `domain/`, one worker consumer turning the event outbox
into summaries, one screen at `/leads` with a URL-addressable panel, and five Server
Actions for handoff. No new table. Four decisions shape it: **all list state lives
in the query string**, so filters, search, page and the open panel survive reloads
and are shareable with no client state; **the panel is the same route**, so the list
never unmounts; **refresh is `router.refresh()` on a ten-second timer**, so
"live-ish" costs one client component and no socket; and **the summariser claims in
two steps** — pick conversations, then lock their turn rows — because `FOR UPDATE`
cannot be combined with the aggregate that finds them. `research.md` is deliberately
not produced, following spec 001: each rationale is inline below, next to the
decision it explains.

### Spec amendments agreed before planning

| ID | Change | Reason |
|---|---|---|
| FR-011 | "Two to four sentences" is a prompt instruction verified by review, not a validator. Only the 90-character preview limit is enforced in code, by truncation at a word boundary. | A sentence counter on a 4-bit model would reject good summaries with no repair path. The limit that must hold is the one a table cell cannot absorb. |
| Key Entities | "No new tables" stands, but this slice contributes one migration adding **indexes**: a partial index on unprocessed turn events and a covering index for the list ordering. | Spec 002 cannot know the queries this slice writes. The constitution's performance rule says index what you query. |

## Technical Context

- **Language/Version**: TypeScript 5.x `strict`, Node 24 in containers, as item 1.
- **Primary Dependencies**: existing only — Next.js 16.3, React 19.2, `drizzle-orm`, `zod`, `pino`, plus `ai` 7.0.93, `@ai-sdk/openai-compatible` 3.0.44 and `@langfuse/{tracing,otel}` 5.11.0 introduced by spec 004. **This slice adds no dependency**: no component, charting or date library; relative times are a twenty-line pt-BR formatter in `domain/`.
- **Storage**: PostgreSQL 17, schema from spec 002. One migration, indexes only.
- **Testing**: `node:test` — unit for `domain/scoring.ts` and preview-line truncation; integration against the container's Postgres for the claim query and the scoping rules; one `INTEGRATION=1`-tagged test against local oMLX (`MODEL_ID=gemma-4-e4b-it-OptiQ-4bit`) for the summariser.
- **Target Platform**: Linux containers; current Chrome/Safari, 390 px up.
- **Project Type**: Modular monolith — screens in the app, one consumer in the worker, both from the same image.
- **Performance Goals**: `/leads` under 1.5 s with 500 leads (SC-003), constant query count per render, a sweep bounded by its batch size.
- **Constraints**: UI never imports `db/`; `domain/` imports nothing; only `agent/provider.ts` touches a provider SDK; summarisation never on the reply path.
- **Scale/Scope**: ~26 new files — one screen, one panel, five Server Actions, five services, one worker consumer, four rule functions.

### Inter-spec dependencies, named so they are not assumed

| Needed | Owner | If absent when this lands |
|---|---|---|
| `domain/slots.ts` — slot Zod schema and `Intent` | 002 or 004 | Create it from data model §2; it is 30 lines and both specs need the same one. |
| `services/events.ts` — append-event helper | 004 | Create it; this slice writes five of the catalog's types. |
| `core/masking.ts` — the single PII rule | 002 | Create it; FR-013 depends on it. |
| `scopeForUser` — session and role scoping | 003 | Blocking. Do not fake it. |
| `ChannelAdapter.send` | 004 | Blocking for FR-033 only; the rest of the slice stands. |

## Constitution Check

*GATE: passed before Phase 0. Re-checked after Phase 1 — result at the end.*

| # | Principle | How this slice satisfies it | Verified by |
|---|---|---|---|
| I | Document Authority | Score weights, bands, statuses and every event type come from `modelo-de-dados.md` and ADR 11. `reference/` informed screen shape only. No open decision is answered by invention. | Inspection |
| II | Language Boundaries | Code and this plan in English; every rendered string pt-BR, in the component. No i18n layer, no emoji (FR-023). | SC-009 |
| III | Modular Monolith | Rules in `domain/` with zero imports. The consumer is registered into the existing worker loop, not a new process. No process-local state: the sweep reads its work from Postgres each pass. | ESLint zones |
| IV | One Data Path | Screens are Server Components calling `services/`; Server Actions call the same services. No `db/` import under `app/`. | ESLint, T-check |
| V | Deterministic Slot Machine | This slice owns the deterministic half — score, qualification, handoff — and hands it to 004's orchestrator. The model never sees a score. | FR-005, SC-001 |
| VI | Provider Independence | The summariser calls the model through `agent/provider.ts`. `jobs/summarize.ts` imports no provider SDK. | Inspection |
| VII | Observability Without Coupling | The summary call carries AI SDK telemetry with `functionId: summarize` and lead/conversation ids. Langfuse absent changes nothing; the summariser failing changes nothing lead-facing. | FR-014, SC-006 |
| VIII | Privacy and PII | Summary input and output are masked through `core/masking.ts` before reaching logs or traces. The summary itself is broker-only and never returned to the widget. | FR-013 |
| IX | Resilience | The claim is transactional; a failed summary clears its turns rather than looping; taking over an already-held conversation loses to a conditional update. | SC-007, FR-015 |

### Gates

| Gate | Status |
|---|---|
| Stack rows unchanged; `npm`; migrations committed | Pass — no new dependency, one migration holding indexes only |
| No Redis; no new runtime service; `docker compose exec app …` for every command | Pass — the consumer joins the existing worker |
| Environment Contract (schema ⇄ `.env.example` ⇄ `contracts/`, one commit) | Applies: `SUMMARY_DEBOUNCE_SECONDS`, `SUMMARY_BATCH_SIZE`, `LEADS_PAGE_SIZE` |
| Post-design re-check | No new violations; one Complexity Tracking entry, for the registry |

## Project Structure

### Documentation (this feature)

`spec.md` · `plan.md` · `tasks.md` · `data-model.md` (columns filled, read models,
indexes) · `quickstart.md` · `contracts/surfaces.md` · `checklists/requirements.md`.

### Source Code (repository root)

```text
src/domain/    scoring.ts (scoreLead · temperatureOf · isQualified · shouldHandoff)
               lead-status.ts (FR-006 transitions) · relative-time.ts (pt-BR)
src/services/  qualification.ts · leads.ts (list + panel) · metrics.ts (four tiles,
               one statement) · handoff.ts (assume · reply · return · status · reassign)
src/agent/     summarizer.ts — prompt + generateObject through provider.ts
src/jobs/      consumers.ts (SweepConsumer type + registry) · summarize.ts
src/worker/    index.ts — the sweep iterates the registry (edited)
src/db/migrations/    indexes only
src/app/(app)/leads/  page.tsx · actions.ts · leads.module.css · _components/
               (MetricTiles · FilterChips · SearchBox · AutoRefresh · LeadRow ·
               LeadDrawer · LeadPanel · QualificationTable · Transcript · Timeline
               · ActionsRow · ReplyBox)
tests/         scoring.test.ts · preview-line.test.ts · summarize-claim.test.ts ·
               leads-scope.test.ts (Postgres) · summarizer.integration.test.ts (oMLX)
```

**Structure Decision**: the layout of `visao-geral.md` §3, unchanged — only
`app/(app)/leads/` is new ground.

## Shortest implementation path

**1 · The rules.** `domain/scoring.ts`: four exported functions, no imports beyond
the slot types. `tests/scoring.test.ts` first — a table covering both scripts, both
bonuses, the cap and each band boundary (39/40, 69/70). This is the only part
finishable before any other spec merges, and it is what SC-001 measures.
`lead-status.ts` is a frozen map of allowed transitions; illegal ones throw.

**2 · Qualification service.** `services/qualification.ts` exposes
`recordTurnOutcome({ leadId, conversationId, tx })`: recompute the score, write it
with the status, and append `lead.qualified` on the first crossing plus
`handoff.requested` with its reason — all in the caller's transaction. "First
crossing" is `update leads set status='qualified' where id=$1 and status<>
'qualified'`, with the event appended only if a row was touched: idempotence is the
database's job, not a read-then-write. Spec 004 calls this once per turn.

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
string; run(ctx): Promise<void> }` and exports an array. `worker/index.ts` iterates
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

**7 · The screen.** `page.tsx` reads `searchParams` — `filtro`, `q`, `page`, `lead`
— and renders tiles, list and, when `lead` is present, the panel. Only four things
are client components: `SearchBox` (debounced, pushes to the router), `AutoRefresh`
(`setInterval` calling `router.refresh()` every 10 s), `LeadDrawer` (Escape, focus
restore, `inert` on the list behind it) and the action controls; filter chips are
plain links. The visual system is one CSS Module plus four tokens in the shell's
stylesheet — neutral warm-grey ground, one accent, `--temp-hot` warm red /
`--temp-warm` amber / `--temp-cold` slate — with a 14 px base, 56 px rows, tabular
figures in the tiles, and a 420 px panel that goes full screen below 768 px.

**8 · Handoff.** Assume is `update conversations set status='paused' where id=$1 and
status='active'`; zero rows means someone else took it and the action says so. Reply
appends a `broker` message and calls `ChannelAdapter.send`; return sets `active`.
Every action re-reads the session and re-applies the scope before touching anything
— a Server Action is a public endpoint, and the client's claim about who it is is
worth nothing. Each ends with `revalidatePath('/leads')`. Verify the whole slice
with [quickstart.md](quickstart.md).

### What is deliberately not built

A charting or date library. A generic filter or table abstraction over one list. A
websocket or SSE channel. A summary retry ledger. Any notification. A
`repositories/` layer. Optimistic UI — a `revalidatePath` round trip on a local Postgres is faster than the animation would be.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| `SweepConsumer` registry — an abstraction with one implementation in this slice | Spec 006 adds the second implementation immediately and by name. The constitution rejects a pattern with "no concrete second case"; here the second case is a merged backlog row, not a hypothesis. The alternative is that 006 edits this slice's loop, which makes the two slices conflict in one file. | Calling `summarize()` directly from `worker/index.ts` is two lines shorter and forces every later consumer to modify the loop, its error handling and its logging — the drift the registry prevents. |
