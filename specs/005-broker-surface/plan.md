# Implementation Plan: Broker Surface

**Branch**: `005-broker-surface` | **Revised**: 2026-09-16 (post-004) | **Spec**: [spec.md](spec.md)

## Summary

One screen at `/leads` with a URL-addressed panel, an agency-scoped SSE stream, four
handoff actions, and one worker consumer turning `conversation.turn` events into
summaries. No new table, no new dependency. All list state lives in the query
string; the panel is the same route, so the list never unmounts.

## Drift from the original plan (004 landed)

| Original plan | Reality | Consequence |
|---|---|---|
| `domain/scoring.ts` with `temperatureOf`, `shouldHandoff`, `shouldProposeMeeting(score, slots)` | `domain/score.ts`, `domain/handoff.ts` exist and match §3 | Reuse; weights change if decision 7 lands. |
| `services/qualification.recordTurnOutcome` | `commitTurn` writes score, stage, `handoff.requested`, pause | Add `lead.qualified`. False handoffs and the repeated meeting offer after qualification are decision 6's, not patched here. |
| Seed consistent with the rules | Seed scores contradict §3, no lead assigned, `previewLine` = last agent message, no `conversation.turn` events | Fix the seed: scores from `scoreLead`, assign brokers, null preview, turn events so the summariser has work. |
| `jobs/consumers.ts` + worker loop to build | Exists | Append `summarize` to the array. |
| `core/masking.ts` | `core/security.ts` (`maskPII`, `maskText`); name redaction via `core/langfuse.rememberLeadName` | Use these. |
| `services/events.ts` helper | Absent; services insert events inline | Keep inline. |
| `Notifier.publish(agencyId, e)` / `subscribe(agencyId)` | `publish(channel, payload)`, `subscribe(conversationId, …)`; channels `conversation_message`, `conversation_chunk` | Add `subscribeAgency` and one channel, `conversation_state`. |
| `scopeForUser` returns `{ agencyId }` | `{ agencyId, defaultOwnLeadsOnly }` | `mine` defaults from it. |
| `reassignLead` in `handoff.ts` | `services/auth.reassignLead` (throws) | The action wraps it into `Result`. |
| `ChannelAdapter.send` for broker replies | `recordOutboundMessage({ role: 'broker' })` persists + notifies, nothing more | `handoff.ts` adds the hold check, `metadata.userId` and a `conversation.turn` event; widget labels broker bubbles. |
| Widget learns status from a message | It re-reads `GET /api/chat` after each non-lead `message` | A takeover with no message is invisible → widget stream gains a `status` event from `conversation_state`. Amends 004 `contracts/chat-api.md`. |
| `LANGFUSE_PUBLIC_URL` key | `LANGFUSE_UI_PORT` exists | No new key; link is `http://localhost:${LANGFUSE_UI_PORT}`. Verify the trace path against the running UI. |
| Structured model call | `getJsonModel()` + `modelCall()` + `modelTelemetry(name)`; `generateObject` needs `AbortSignal.timeout` | Summariser follows `agent/recovery.ts`. |
| Gates: `docker build --target build` only | `npx tsc --noEmit`, `npm run test:integration` exist | Use them. |
| Complexity Tracking: registry | Registry already justified and built | Entry dropped. |

Spec changes carried in [spec.md](spec.md): FR-005 (investment → call), FR-019
(scope shape), FR-030 (link base), FR-034 (status push), FR-035 (reply box needs the
user to hold the conversation, not just `paused`).

## Technical Context

TypeScript strict, Node 24 in containers, Next.js 16.3, React 19.2, drizzle,
zod, pino, `ai` 7.0.93. PostgreSQL 17. `node:test`: unit (`tests/`), integration
against Postgres and oMLX `gemma-4-e4b-it-OptiQ-4bit` (`tests/integration/`).
Every command is `docker compose exec app …`.

## Constitution Check

Passes. Rules stay in `domain/` (III, V); screens and actions call `services/`
only, no `db/` under `app/` (IV); the summariser reaches the model only through
`agent/provider.ts` (VI); tracing is optional and masked (VII, VIII); claims are
`for update skip locked`, takeovers are conditional updates, SSE replays from rows
(IX). Principle X: the list answers *who do I call first* by score and chips; the
panel answers *what does this person want* above the fold, with Assumir/Devolver
as its one primary action.

## Source

```text
src/domain/        lead-status.ts · relative-time.ts
src/services/      leads.ts (list, detail) · metrics.ts · handoff.ts
                   conversation.ts (edit: lead.qualified, broker userId)
src/core/          notifier.ts (edit: subscribeAgency, conversation_state)
src/agent/         summarizer.ts
src/jobs/          summarize.ts · consumers.ts (edit)
src/db/migrations/ 0002 — two indexes
src/app/api/leads/stream/route.ts
src/app/api/chat/[conversationId]/events/route.ts (edit: status event)
src/app/(public)/chat/[agencySlug]/ChatWidget.tsx (edit: status event, broker label)
src/app/(app)/leads/  page.tsx · actions.ts · leads.module.css · _components/
```

## Key decisions

- **`lead.qualified`**: in `commitTurn`, when `nextLeadStatus` moves to `qualified`. Stages are forward-only, so it fires once.
- **Summariser claim**: unlocked `group by conversation_id having max(created_at) < now() - debounce` (locks cannot sit beside `group by`), then per conversation `select … for update skip locked`; zero rows = another worker has it. Write summary, preview, `processed_at`, `summary.updated` in that transaction. On failure mark processed, keep the summary.
- **Live list**: `/api/leads/stream` subscribes by agency to `conversation_message` and `conversation_state`, forwards `{ conversationId }` only; the client calls `router.refresh()`, which re-reads through scoped services.
- **Handoff**: assume = `update … set status='paused', held_by_user_id=$u where id=$c and held_by_user_id is null and status<>'closed'`; zero rows fails with a message. Each write publishes `conversation_state` after commit.
- **Metrics**: one statement; median = `percentile_cont(0.5)` over `lead.created` → first agent message.

## Not built

Charts, a date library, a table abstraction, WebSockets, a retry ledger,
notifications, optimistic UI.
