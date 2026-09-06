# Implementation Plan: Conversation

**Branch**: `004-conversation` | **Date**: 2026-09-05 | **Spec**: [spec.md](spec.md)

## Summary

One turn, end to end: a lead message arrives on the web channel, a pure slot machine
computes state, score and the single next question, the model phrases the reply and
calls tools, guards inspect the reply as it streams, and one transaction writes
messages, slots, lead fields and events. Around it: a public widget, a provider
factory, and Langfuse behind a Compose profile that is off by default.

Four decisions shape the build.

1. **The guards are pure functions in `domain/`, applied at sentence boundaries.**
   Everything a 4-bit model gets wrong — English, two questions, a hallucinated
   price, leaked tool syntax — is caught by code testable without a model, and per
   sentence keeps the reply streaming instead of buffering it whole.
2. **`services/conversation.ts` owns the transaction, and the orchestrator calls it**,
   which keeps `agent → services` one-directional and gives the turn one commit point
   — what makes a failed turn leave nothing behind.
3. **Rate limiting and idempotency are SQL, not memory.** A stateless app cannot hold
   a counter and the constitution forbids Redis; both are one query against an index
   the data model already has.
4. **Telemetry is one module and two registrations** — `core/langfuse.ts`, called
   from `instrumentation.ts` and from the worker entrypoint. Everything else is the
   AI SDK's own telemetry option, so no call site knows Langfuse exists.

### Boundary notes agreed before planning

| Item | Call | Reason |
|---|---|---|
| `scoreLead` in `domain/` | Built here, consumed by 005 | The hot-score handoff trigger needs the number this turn. ADR 11 fixes the weights; 005 adds the badge and `lead.qualified`. |
| `handoff.requested` event | Emitted here | `modelo-de-dados.md` §4 attributes it to 005, but 004 owns the three triggers. Recorded rather than silently swapped. |
| One migration in this slice | Allowed | A unique index over `messages.metadata->>'clientMessageId'` for idempotency. No column, no table — the data model is untouched. |

## Technical Context

- **Language/Version**: TypeScript 5.x `strict`, Node 24 in containers, as in 001.
- **Primary Dependencies**: `ai` 7.0.93 · `@ai-sdk/openai-compatible` 3.0.44 (the only provider SDK) · `@ai-sdk/react` 4.0.96 · `@langfuse/otel` and `@langfuse/tracing` 5.11.0 · `@opentelemetry/sdk-trace-node` for the tracer registration. `zod`, `pino` and `drizzle-orm` already present. No UI library, no Tailwind — CSS Modules.
- **Storage**: PostgreSQL 17, schema from spec 002; this slice adds one index.
- **Testing**: `node:test`. Unit tests over `domain/` run in `npm test`; scenario tests against the local model and the real database run under `npm run test:integration` with `INTEGRATION=1`, because they take minutes.
- **Target Platform**: Linux containers, provider on the host or hosted (ADR 16), everything driven through `docker compose exec app …`.
- **Performance Goals**: first visible token 300–800 ms after send when the model is faster than that; one model round trip per turn, two when the local model skips the extraction tool (ADR 14).
- **Constraints / Scope**: no Redis in the application stack, no process-local state, every query scoped by `agencyId`, observability capped at 6 GiB (ADR 13). ~30 new files: one route group, one handler, one service, one orchestrator, four tools, five pure modules.

## Constitution Check

| # | Principle | How this slice satisfies it | Verified by |
|---|---|---|---|
| I | Document Authority | Slots, scripts, score and events come from `modelo-de-dados.md`. `reference/exemplos de conversas.md` informs the agent's *voice* only. `decisoes-pendentes.md` is empty. | Inspection |
| II | Language Boundaries | Code in English; every string the lead reads in pt-BR, inline in the component or the prompt module. No i18n layer. | FR-006, FR-012 |
| III | Modular Monolith | `domain/` holds the slot machine, score, handoff rule and guards, and imports nothing. The orchestrator holds no state between turns. | Lint zone, unit tests |
| IV | One Data Path | Widget → route handler → adapter and orchestrator; only `services/` touches `db/`. | ESLint zone |
| V | Deterministic Slot Machine | `domain/slots.ts` picks the next question; the prompt receives it already chosen. `updateSlots` extracts, never decides. | SC-003 |
| VI | Provider Independence | `agent/provider.ts` is the only importer of `@ai-sdk/openai-compatible`; `PROVIDER_AUTH_HEADER` is the third permitted variable (ADR 16). | Inspection |
| VII | Observability Without Coupling | AI SDK telemetry → OTel → Langfuse exporter, registered only when configured, exported in batches, never awaited. | SC-010 |
| VIII | Privacy and PII | One `core/security.ts` masking function used by the logger, the span mask and the event payloads. Consent gates the contact slots. | SC-011 |
| IX | Resilience | Bounded timeout and retries, generic pt-BR fallback, SQL rate limit, idempotent inbound ids, injection refusal. | SC-007/8/9 |

**Gates.** Stack rows unchanged (the AI SDK and Langfuse are already rows); `npm` with
exact pins; one committed index-only migration; `docker compose up` still the only
entrypoint; no Redis in the application stack — Langfuse's own Redis lives inside the
`observability` profile and no application code touches it. The Environment Contract
gate from 001 holds: every new key lands in the schema, `.env.example` and
[contracts/config.md](contracts/config.md) in one commit, and `tests/env-example.test.ts`
already fails otherwise.

**Post-design re-check.** No violations. The only pattern with a single implementation
is `ChannelAdapter`, which the Governance section permits by name.

## Project Structure

```text
src/
├── domain/                     # pure, imports nothing
│   ├── slots.ts                # schema · script order · merge rules · nextQuestion
│   ├── score.ts                # scoreLead + temperature bands (ADR 11)
│   ├── handoff.ts              # the three triggers as one pure decision
│   └── reply-guards.ts         # language · one question · unbacked money · leaks
├── agent/
│   ├── orchestrator.ts         # one turn, stateless
│   ├── provider.ts             # only importer of the provider SDK
│   ├── recovery.ts             # single-slot generateObject fallback
│   ├── prompts/{system.ts,fallback.ts}
│   └── tools/{index.ts,update-slots.ts,search-properties.ts,handoff.ts,opt-out.ts,scheduling.stub.ts}
├── channels/{types.ts,web.ts}
├── services/conversation.ts    # loadTurn · findStoredReply · commitTurn (one tx)
├── core/{security.ts,langfuse.ts}
├── db/migrations/              # one index-only migration
└── app/
    ├── (public)/chat/[agencySlug]/{page.tsx,ChatWidget.tsx,PropertyCard.tsx,*.module.css}
    └── api/chat/route.ts       # POST streams a turn · GET returns history
```

Tests: `tests/{slots,score,handoff,reply-guards,masking}.test.ts` run by default, and
`tests/integration/{scenario-purchase,scenario-investment,turn-persistence}.test.ts`
behind `INTEGRATION=1`.

**Structure Decision**: the layout fixed by `visao-geral.md` §3, filling the `agent/`,
`channels/` and `domain/` placeholders 001 created. One file per tool, so spec 006
replaces `scheduling.stub.ts` and edits `tools/index.ts` — FR-009's one-file extension.

## Shortest implementation path

**1 · The pure core.** `domain/slots.ts`, `score.ts`, `handoff.ts` and
`reply-guards.ts` with their unit tests — no model, no database, no framework.
`nextQuestion` returns the slot key *and* its pt-BR question text, so the prompt never
invents one and the fallback path always has something to say.

The guards are the answer to "what does a 4-bit model get wrong": a Portuguese check by
stopword ratio; a cumulative question-mark count; a currency scan whose allowed set is
the prices this turn's search returned plus figures the lead already wrote; and a
scrubber for tool syntax and system text — each a string in, a verdict out, which is
why none of it lives in the prompt.

**2 · Config, masking, provider.** New keys land in `core/config.ts` and `.env.example`
in one commit (the 001 gate). `core/security.ts` exports `maskPII`, used in three places
and nowhere else. `agent/provider.ts` builds the model from the four provider variables,
`MODEL_TIMEOUT_MS` as an abort signal and `MODEL_MAX_RETRIES` as the retry bound.

**3 · The turn service.** `services/conversation.ts`: `loadTurn` (agency by slug, lead
by `externalId`, active conversation, last `CHAT_HISTORY_WINDOW` messages, the
per-minute lead-message count), `findStoredReply` (idempotency by `clientMessageId`) and
`commitTurn` (one transaction: both messages, slots, lead fields, events). Every query
carries `agencyId`; lead and conversation are created here on first contact, which is
why opening the widget creates nothing.

**4 · Tools.** `updateSlots` takes the Zod slot schema from `domain/` and its result
goes through `mergeSlots`, so never-overwrite and intent-immutability are enforced
after the model rather than requested of it. `searchProperties` calls spec 002's
`services/properties.searchProperties` with the filled slots, caps at three, and returns
the rows the cards render from. `requestHandoff(reason)` and `optOut` set flags the
commit reads. `tools/index.ts` is the registry, where the scheduling stubs are declared
with their schemas and a "not yet available" result.

**5 · Orchestrator.** Load, compute, prompt, stream, guard, commit. The system prompt
carries the persona, the slot state, the one next question, the consent state and the
refusal rule; tool calling is the AI SDK's own. If no `updateSlots` arrived and the
lead's message plausibly answered the pending slot, `recovery.ts` runs one
`generateObject` for that slot alone. Handoff, opt-out and the consent gate are decided
in code after the tools resolve, never by the model.

**6 · Channel, route and widget.** `channels/types.ts` declares `ChannelAdapter`,
`InboundMessage` and `OutboundMessage`; `channels/web.ts` normalises the request and
implements `send` as the streamed response, applying the 300–800 ms first-token delay so
the pause belongs to the channel, not the widget. `POST /api/chat` runs a turn, `GET
/api/chat` returns history for a session id — what the widget loads on mount and polls
while paused. A server component resolves `agencySlug` and 404s when it does not exist;
the client component owns the session id in `localStorage`, the opt-in banner, the
bubbles, the typing indicator, the cards, the paused badge and the composer.

**7 · Observability.** `core/langfuse.ts` builds the span processor with `maskPII` as
its mask and registers a Node tracer provider — only when the Langfuse keys are
present, so an unset environment registers nothing at all. `instrumentation.ts` calls it
for the app and the worker entrypoint for the worker; every model call passes the AI SDK
telemetry option with the trace name and the three identifiers. The taxonomy is written
in [contracts/observability.md](contracts/observability.md) before the code.

**8 · Compose profile.** `langfuse-web`, `langfuse-worker`, `clickhouse`, `redis` and
`minio` under `profiles: [observability]`, each with a `mem_limit`, summing to 6 GiB,
ClickHouse capped by `max_server_memory_usage`, Redis by `maxmemory` and the two Node
services by `--max-old-space-size`. Langfuse's Postgres is a second database in the
existing `db` container created by an init script — which only runs on an empty data
volume, so the quickstart says how to create it on a database that already exists.

**9 · Scenario tests.** Cenário 1 and Cenário 2 driven through
`services/conversation.ts`, not over HTTP, against the local model and the seeded
catalog: slot state per turn, one question per agent message, no re-asked slot, every
suggested property a seeded row matching the filters, handoff at the end.

**Deliberately not built.** No broker UI, summary, dashboard, appointment, follow-up
job, second channel, websocket, eval harness or Langfuse dashboard; no schema beyond one
index; no in-memory cache of anything.

## Complexity Tracking

No constitution violations. Table intentionally empty.
