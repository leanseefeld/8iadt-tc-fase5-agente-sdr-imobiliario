# Implementation Plan: Conversation

**Branch**: `004-conversation` | **Date**: 2026-09-05 | **Spec**: [spec.md](spec.md)

## Summary

One turn, end to end: a lead message is stored and `POST /api/chat` returns `202`;
once `CHAT_DEBOUNCE_MS` has passed with no new lead message, the turn claims the
conversation, a pure slot machine computes state, score and the single next
question, the model phrases the reply and calls tools, guards inspect the reply as
it streams, and one transaction writes messages, slots, lead fields and events.
Delivery is Server-Sent Events fed by Postgres `LISTEN/NOTIFY`. Around it: a public
widget gated by an explicit consent step, a provider factory, and Langfuse behind a
Compose profile that is off by default.

Five decisions shape the build.

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
5. **Turns are coalesced and delivered off the request/response cycle.**
   `processingSince` claims one turn per conversation; a lead who sends three
   messages in a burst gets one reply to all three. `core/notifier.ts` is the only
   module that knows Postgres `LISTEN/NOTIFY`, so a later swap to Redis is one file.
   The worker's `unanswered-turns` consumer is the backstop when a replica dies
   mid-turn — the same reason `SKIP LOCKED` exists for `followup_jobs`.

### Boundary notes agreed before planning

| Item | Call | Reason |
|---|---|---|
| `scoreLead` in `domain/` | Built here, consumed by 005 | The hot-score `proposeMeeting` trigger (FR-040) needs the number this turn — ADR 19 dropped it as a handoff condition. ADR 11 fixes the weights; 005 adds the badge and `lead.qualified`. |
| `handoff.requested` event | Emitted here | `modelo-de-dados.md` §4 attributes it to 005, but 004 owns the two triggers left after ADR 19. Recorded rather than silently swapped. |
| `proposeMeeting` call | Called here, stub result | 006 implements the tool; 004 calls it for the hot-lead and investment endings (FR-040/041) and phrases whatever the stub returns. |
| `src/core/notifier.ts` | Built here, Postgres-only | The `Notifier` interface behind SSE delivery (ADR 19); `visao-geral.md` §8 documents the scale limits 006's follow-up sender inherits. |
| `src/jobs/consumers.ts` registry | Created here if absent | `modelo-de-dados.md` §6 assigns ownership to 005, but 004 needs `unanswered-turns` before 005 lands — it creates the file if missing and 005 adds to it. |
| `lead.status_changed` event | Emitted here for `new → qualifying → qualified` | `modelo-de-dados.md` §4 attributes it to 005/006 (broker, visit outcomes); ADR 19 makes the agent the owner of stage moves up to `scheduled`, so 004 emits its share (FR-051) and 005/006 emit theirs. |
| One migration in this slice | Allowed | A unique index over `messages.metadata->>'clientMessageId'` for idempotency. No column, no table — the data model is untouched. |

## Technical Context

- **Language/Version**: TypeScript 5.x `strict`, Node 24 in containers, as in 001.
- **Primary Dependencies**: `ai` 7.0.93 · `@ai-sdk/openai-compatible` 3.0.44 (the only provider SDK) · `@ai-sdk/react` 4.0.96 · `@langfuse/otel` and `@langfuse/tracing` 5.11.0 · `@opentelemetry/sdk-trace-node` for the tracer registration. `zod`, `pino` and `drizzle-orm` already present. No UI library, no Tailwind — CSS Modules.
- **Storage**: PostgreSQL 17, schema from spec 002; this slice adds one index.
- **Testing**: `node:test`. Unit tests over `domain/` run in `npm test`; scenario tests against the local model and the real database run under `npm run test:integration` with `INTEGRATION=1`, because they take minutes.
- **Target Platform**: Linux containers, provider on the host or hosted (ADR 16), everything driven through `docker compose exec app …`.
- **Performance Goals**: first visible token 300–800 ms after send when the model is faster than that; one model round trip per turn, two when the local model skips the extraction tool (ADR 14).
- **Constraints / Scope**: no Redis in the application stack, no process-local state, every query scoped by `agencyId`, observability capped at 6 GiB (ADR 13). ~33 new files: two route groups (chat, chat events), one service, one orchestrator, five tools, five pure modules, one notifier, one worker consumer.

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
| IX | Resilience | Bounded timeout and retries, generic pt-BR fallback, SQL-backed message budget, idempotent inbound ids, injection refusal, `unanswered-turns` as the crash backstop. | SC-007/8/9 |
| X | User Experience Discipline | The widget names its audience, task and smoothest interaction below; every state — sending, delivered, disconnected, empty — is fed back rather than left silent. | Manual walkthrough, quickstart §2 |

**Who, what, how (Principle X, applied here).** The person on this screen is a lead,
often on a phone, deciding in seconds whether to type into a chatbot. They came to
ask about a property and to find out if a human is behind the reply. The smoothest
interaction is: one bubble at a time, one visible question, a typing indicator
instead of a blank wait, an unmistakable "Aceito" button before anything personal
is asked, honest connection feedback ("Conexão perdida. Reconectando…") instead of
a composer that silently stops working, and property cards scannable at a glance —
photo, price, one line of facts — because the lead is comparing, not reading prose.

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
│   ├── handoff.ts              # the two triggers as one pure decision
│   └── reply-guards.ts         # language · question count · unbacked money/% · leaks
├── agent/
│   ├── orchestrator.ts         # one turn, stateless
│   ├── provider.ts             # only importer of the provider SDK
│   ├── recovery.ts             # single-slot generateObject fallback
│   ├── prompts/{system.ts,fallback.ts}
│   └── tools/{index.ts,update-slots.ts,search-properties.ts,handoff.ts,opt-out.ts,scheduling.stub.ts}
├── channels/{types.ts,web.ts}
├── services/conversation.ts    # loadTurn · findStoredReply · claimTurn · commitTurn
├── core/{security.ts,langfuse.ts,notifier.ts}
├── jobs/{consumers.ts,unanswered-turns.ts}  # registry (§6) + the one entry 004 adds
├── db/migrations/              # one index-only migration
└── app/
    ├── (public)/chat/[agencySlug]/{page.tsx,ChatWidget.tsx,PropertyCard.tsx,*.module.css}
    └── api/chat/
        ├── route.ts                          # POST stores + 202s · GET history
        └── [conversationId]/events/route.ts   # GET — the SSE stream
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
stopword ratio; a question-count check allowing a second question only when it refines
the pending slot or previews the script's next one; a currency-and-percentage scan whose
allowed set is the figures this turn's search returned plus figures the lead already
wrote; and a scrubber for tool syntax and system text — each a string in, a verdict out,
which is why none of it lives in the prompt.

**2 · Config, masking, provider.** New keys land in `core/config.ts` and `.env.example`
in one commit (the 001 gate). `core/security.ts` exports `maskPII`, used in three places
and nowhere else. `agent/provider.ts` builds the model from the four provider variables,
`MODEL_TIMEOUT_MS` as an abort signal and `MODEL_MAX_RETRIES` as the retry bound.

**3 · The turn service.** `services/conversation.ts`: `loadTurn` (agency by slug, lead
by `externalId`, active conversation, last `MODEL_HISTORY_WINDOW` messages, the
session's message-budget count in the current `CHAT_BUDGET_WINDOW_MINUTES`),
`findStoredReply` (idempotency by `clientMessageId`), `claimTurn` (an `UPDATE …
SET processingSince = now() WHERE processingSince IS NULL` that only one caller wins),
and `commitTurn` (one transaction: both messages — every unanswered lead message this
turn answers, `repliesToMessageId` on the agent one — slots, lead fields, events, and a
closing `NOTIFY` carrying only the conversation id). Every query carries `agencyId`;
lead and conversation are created here on first contact, which is why opening the
widget creates nothing.

**4 · Tools.** `updateSlots` takes the Zod slot schema from `domain/` and its result
goes through `mergeSlots`, so never-overwrite and intent-immutability are enforced
after the model rather than requested of it. `searchProperties` calls spec 002's
`services/properties.searchProperties` with the filled slots, caps at three, and returns
the rows the cards render from — never called for `investment`. `requestHandoff(reason)`
covers the two remaining triggers (asked, fallback) and `optOut` sets the flag the
commit reads. `tools/index.ts` is the registry, where the scheduling stubs
(`proposeMeeting`, `bookMeeting`) are declared with their schemas and a
"not yet available" result until 006 fills them in.

**5 · Orchestrator.** Load, compute, prompt, stream, guard, commit. The system prompt
carries the persona, the slot state, the one next question, the consent state and the
refusal rule; tool calling is the AI SDK's own. If no `updateSlots` arrived and the
lead's message plausibly answered the pending slot, `recovery.ts` runs one
`generateObject` for that slot alone. Handoff, opt-out, the hot-lead and investment
`proposeMeeting` calls, and the consent gate are all decided in code after the tools
resolve, never by the model.

**6 · Channel, route and widget.** `channels/types.ts` declares `ChannelAdapter`,
`InboundMessage` and `OutboundMessage`; `channels/web.ts` normalises the request and
implements `send` against whatever transport called it. `POST /api/chat` persists the
lead message and returns `202`; `GET /api/chat` returns history for a session id — what
the widget loads on mount. The client component's first bubble is the consent notice
with its "Aceito" button, rendered locally, never generated; text sent before acceptance
gets the fixed template reply. Once accepted, the widget owns the session id in
`localStorage`, the bubbles with `enviando → recebido` state, the typing indicator, the
cards, the paused badge and the composer, disabled while disconnected.

**7 · Coalescing and delivery.** `services/conversation.claimTurn` is the only way in;
a debounce timer in the route handler (or the `unanswered-turns` consumer) calls the
turn `CHAT_DEBOUNCE_MS` after the last lead message. `core/notifier.ts` wraps a single
`LISTEN` connection per replica and an in-memory map of open streams by conversation id;
`GET /api/chat/[conversationId]/events` authorises against the signed widget session,
re-reads scoped by agency and conversation on every `NOTIFY`, and writes sentence-sized
`chunk` events then a final `message` event, applying the 300–800 ms first-token delay
here rather than in the widget. A pulse every `SSE_PULSE_INTERVAL_MS`, a `goodbye` on
`SIGTERM`, and replay from `Last-Event-ID` on reconnect — the widget shows "Conexão
perdida. Reconectando…" after two missed pulses and disables sending until the next
pulse lands. `src/jobs/consumers.ts` (created here if 005 has not merged it) registers
`unanswered-turns`: conversations with lead messages older than `CHAT_DEBOUNCE_MS` and
no live `processingSince` (stale past `MODEL_TIMEOUT_MS` × 2) get the turn re-run.

**8 · Observability.** `core/langfuse.ts` builds the span processor with `maskPII` as
its mask and registers a Node tracer provider — only when the Langfuse keys are
present, so an unset environment registers nothing at all. `instrumentation.ts` calls it
for the app and the worker entrypoint for the worker; every model call passes the AI SDK
telemetry option with the trace name and the three identifiers. The taxonomy is written
in [contracts/observability.md](contracts/observability.md) before the code.

**9 · Compose profile.** `langfuse-web`, `langfuse-worker`, `clickhouse`, `redis` and
`minio` under `profiles: [observability]`, each with a `mem_limit`, summing to 6 GiB,
ClickHouse capped by `max_server_memory_usage`, Redis by `maxmemory` and the two Node
services by `--max-old-space-size`. Langfuse's Postgres is a second database in the
existing `db` container created by an init script — which only runs on an empty data
volume, so the quickstart says how to create it on a database that already exists.

**10 · Scenario tests.** Cenário 1 and Cenário 2 driven through
`services/conversation.ts`, not over HTTP, against the local model and the seeded
catalog: slot state per turn, one question per agent message, no re-asked slot, every
suggested property a seeded row matching the filters, `proposeMeeting` called at the end
of each — not a handoff.

**Deliberately not built.** No broker UI, summary, dashboard, appointment, follow-up
job, second channel, websocket, eval harness or Langfuse dashboard; no schema beyond one
index; no in-memory cache of anything.

## Complexity Tracking

No constitution violations. Table intentionally empty.
