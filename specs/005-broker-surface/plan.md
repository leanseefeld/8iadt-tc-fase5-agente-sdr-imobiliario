# Implementation Plan: Broker Surface

**Branch**: `005-broker-surface` | **Revised**: 2026-09-20 | **Spec**: [spec.md](spec.md)

## Summary

One screen at `/leads` with a URL-addressed panel, an agency-scoped SSE stream, four
handoff actions, and one worker consumer turning `conversation.turn` events into
summaries. No new table, no new dependency, no rule this slice owns: the score and
the conversation's behaviour belong to the spec that implements ADR 20 and decision 6.
All list state lives in the query string; the panel is the same route, so the list
never unmounts.

## Drift from the original plan (004 landed, then 005 was cut)

| Original plan | Reality | Consequence |
|---|---|---|
| `domain/scoring.ts`, `services/qualification.ts`, `lead.qualified` | `domain/score.ts` and `domain/handoff.ts` exist; `commitTurn` writes score and stage | All of it leaves this slice with FR-001…FR-006 (ADR 20 + decision 6). |
| Seed scores consistent with §3 | They are not, and the formula is being replaced | Left alone on purpose. The seed fix here is brokers, preview line and turn events only. |
| Qualification-rate tile from `lead.qualified` | The event is never written | Tile reads `leads.status` instead — one fewer dependency, same number. |
| `jobs/consumers.ts` + worker loop to build | Exists | Append `summarize`. |
| `core/masking.ts` | `core/security.ts` (`maskPII`, `maskText`), plus `rememberLeadName` in `core/langfuse.ts` | Use these. |
| `services/events.ts` helper | Absent; services insert events inline | Keep inline. |
| `Notifier.publish(agencyId, e)` / `subscribe(agencyId)` | `publish(channel, payload)` and `subscribe(conversationId, …)` | Add `subscribeAgency` and one channel, `conversation_state`. |
| `scopeForUser` returns `{ agencyId }` | `{ agencyId, defaultOwnLeadsOnly }` | `mine` defaults from it. |
| `reassignLead` in `handoff.ts` | `services/auth.reassignLead` exists and throws | The Server Action wraps it into `Result`. |
| `ChannelAdapter.send` for broker replies | `recordOutboundMessage({ role: 'broker' })` persists and notifies, nothing more | `handoff.ts` adds the hold check, `metadata.userId` and a `conversation.turn` event. |
| Widget learns status from a message | It re-reads `GET /api/chat` after each non-lead `message` | A takeover sends no message, so the chat stream gains a `status` event fed by `conversation_state`. Amends 004's `contracts/chat-api.md`. |
| `LANGFUSE_PUBLIC_URL` key | `LANGFUSE_UI_PORT` exists | No new key; verify the trace path against the running UI. |
| Structured model call | `getJsonModel()`, `modelCall()`, `modelTelemetry()`; `generateObject` needs `AbortSignal.timeout` | The summariser follows `agent/recovery.ts`. |
| `domain/relative-time.ts` | Not needed | `Intl.RelativeTimeFormat('pt-BR')`. |
| Complexity Tracking: the sweep registry | Already built and justified by 004 | Entry dropped; this plan has none. |

## Technical Context

TypeScript strict, Node 24 in containers, Next.js 16.3, React 19.2, drizzle, zod, pino,
`ai` 7.0.93. PostgreSQL 17. `node:test`: unit in `tests/`, integration against Postgres
and oMLX `gemma-4-e4b-it-OptiQ-4bit` in `tests/integration/`. Every command runs as
`docker compose exec app …`.

## Constitution Check

Passes. Rules stay in `domain/` (III, V — and this slice adds no rule); screens and
actions call `services/` only, with no `db/` import under `app/` (IV); the summariser
reaches the model only through `agent/provider.ts` (VI); tracing is optional and masked
(VII, VIII); the claim is `for update skip locked`, takeovers are conditional updates,
SSE replays from rows (IX). Principle X: the list answers *who do I call first* through
score and chips; the panel answers *what does this person want* above the fold, with
Assumir/Devolver as its one primary action.

## Source

```text
src/domain/        lead-status.ts
src/services/      leads.ts · metrics.ts · handoff.ts
                   conversation.ts (edit: broker author, turn event)
src/core/          notifier.ts (edit: subscribeAgency, conversation_state)
src/agent/         summarizer.ts
src/jobs/          summarize.ts · consumers.ts (edit: one line)
src/db/            migrations/0002 (two indexes) · seed/index.ts (edit)
src/app/api/leads/stream/route.ts
src/app/api/chat/[conversationId]/events/route.ts (edit: status event)
src/app/(public)/chat/[agencySlug]/ChatWidget.tsx (edit: status event, broker label)
src/app/(app)/leads/  page.tsx · actions.ts · leads.module.css · _components/
```

## Key decisions

- **Live list**: `/api/leads/stream` subscribes by agency to `conversation_message` and `conversation_state` and forwards `{ conversationId }` only; the client calls `router.refresh()`, which re-reads through scoped services. Nothing the browser receives is anything the query would not already scope.
- **Summariser claim**: an unlocked `group by conversation_id having max(created_at) < now() - debounce` (a lock cannot sit beside `group by`), then one transaction per conversation claiming its turn rows `for update skip locked`; zero rows means another worker has it. Summary, preview, `processed_at` and `summary.updated` land in that same transaction. On failure the turns are marked processed and the stored summary is left alone.
- **Handoff**: assume is `update conversations set status='paused', held_by_user_id=$u where id=$c and held_by_user_id is null and status <> 'closed'`; zero rows fails with a pt-BR message. Every write publishes `conversation_state` after commit.
- **Queries per render** (SC-003): one for the list, one for the tiles, three for the panel. No query inside a component, no N+1 over rows.
- **Metrics**: one statement — `filter (where …)` aggregates plus `percentile_cont(0.5)` for the median.

## Not built

Charts, a date or table library, WebSockets, a retry ledger, notifications, optimistic UI.
