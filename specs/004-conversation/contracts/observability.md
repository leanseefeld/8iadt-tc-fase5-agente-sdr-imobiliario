# Observability contract — span taxonomy

Constitution principle VII assigns the concrete taxonomy to this specification.
This file is that taxonomy. Later slices add spans **to this shape**; they do not
invent a second one.

The path is fixed by ADR 13: the AI SDK's own telemetry option emits OpenTelemetry
spans, `@langfuse/otel`'s span processor exports them, and `src/core/langfuse.ts` is
the only module that knows any of that. If `LANGFUSE_PUBLIC_KEY`,
`LANGFUSE_SECRET_KEY` or `LANGFUSE_BASE_URL` is missing, **no tracer provider is
registered at all** — the cheapest possible form of "absent changes nothing".

## 1. Trace per turn

| | |
|---|---|
| Name | `conversation.turn` |
| Started by | `agent/orchestrator.ts`, around the whole turn |
| Ends | after the transaction commits, whatever the outcome |
| Langfuse session id | `conversation.id` |
| Langfuse user id | masked lead id (principle VIII — never the raw uuid alone) |
| Input | the lead's unanswered message(s), joined |
| Output | the reply, as the lead received it |

**Attributes.** The first four are propagated, so they are on the trace and every
span in it. The `turn.*` rows are set on the `conversation.turn` span itself,
which is where a reader looks for them.

| Attribute | Example | Notes |
|---|---|---|
| `agency.id` | uuid | tenant, always present |
| `lead.id` | uuid | absent only on the very first message, before the lead exists |
| `conversation.id` | uuid | |
| `channel` | `web` | |
| `turn.intent` | `purchase` \| `undefined` | as computed *before* the turn |
| `turn.pending_slot` | `bedrooms` | the slot the deterministic question targets |
| `turn.score` | `55` | recomputed value at the end of the turn |
| `turn.stage` | `new` \| `qualifying` \| `qualified` | the lead's pipeline stage (`modelo-de-dados.md` §7) — `handoff` is never a value here, it is an outcome, not a stage |
| `turn.outcome` | `replied` \| `fallback` \| `handoff` \| `meeting_proposed` \| `opted_out` | set on every turn that commits; a turn that throws before committing has none, and is not a turn the lead saw |

## 2. Child spans

| Span | Kind | When | Attributes beyond the inherited set |
|---|---|---|---|
| `model.extract` | generation | The tool call that reads the lead's message into slots | `model.id`, `provider.base_url` (host only), `latency.ms`, `finish.reason`, and `usage` — input, output, `cache_read`, `reasoning` |
| `model.reply` | generation | The streaming call that produces the reply | as above |
| `model.recover_slot` | generation | Only when the extraction missed the pending slot (FR-011) | as above |
| `tool.updateSlots` | tool | Per invocation | input: the call's arguments, masked |
| `tool.searchProperties` | tool | Per invocation | input: the codes; output: `propertyIds` |
| `tool.recoverSlot` | tool | Per invocation | input: the recovered slot |
| `tool.proposeMeeting` | tool | Per invocation | input: `kind`, `status` |
| `tool.requestHandoff` | tool | Per invocation | input: the call's arguments |
| `tool.optOut` | tool | Per invocation | — |

Tool spans are written by `commitTurn` from the list it is about to persist, not
by the AI SDK, for every tool except `searchProperties`. That one runs inside
the action loop (spec 007): the SDK executes it, and its span is emitted from
the loop with `step.index`. Every other tool is still invoked from code or is
inert, and `commitTurn` records it exactly as before. Both paths carry the same
attribute set. Each carries the call's arguments as its input; only
`searchProperties` has an output worth storing, and it stores ids rather than
catalog rows.

`usage` is reported because the provider is asked for it — a streaming
OpenAI-compatible response carries none unless the request sets
`stream_options.include_usage`. `cache_read` is the prefix-cache hit
(`prompt_tokens_details.cached_tokens`).

**A span name not in this table is a defect, not an extension.** `model.call` in
particular means a model call reached the provider with no telemetry name, which
has meant a registration bug every time it has appeared; it logs a warning.

## 3. Masking

`maskPII` from `src/core/security.ts` is installed as the span processor's mask and
as the logger's serializer — one rule, both sinks, principle VIII. It masks:

| Kind | Rule | Example |
|---|---|---|
| Phone | keep the last two digits, in a fixed shape | `(11) *****-**21` |
| E-mail | keep the first character and the domain | `c***@gmail.com` |
| Person name | first letter of each word, then `***` | `C*** D***` |
| Free text | phone- and e-mail-shaped substrings replaced in place, **and** the lead's own name once the conversation knows it | applies to message bodies, prompts and completions |

The masks are not length-preserving: a six-letter and a three-letter name must not
be distinguishable from the mask alone.

Two things the key-aware rule does **not** cover, by design. Property addresses are
catalog data, not lead data, and stay readable. And keys that end in `name` but hold
no person — `toolName`, `modelName`, `fileName` — are exempt, or a trace reads
`"toolName": "u***"` where `updateSlots` belongs.

The free-text name redaction has one residual: on the turn where a lead first types
their name, the extraction prompt is built before anything knows a name is in it.
Every later turn is covered. Decided by the developer on 09/09/2026, over the
alternative of not recording prompts at all.

## 4. What is not traced

No span for a database query, no span per streamed chunk, no evaluation or scoring
span. Principle VII's stated non-goal — no evals, no scoring harness — holds here.

## 5. Failure behaviour

| Situation | Behaviour |
|---|---|
| Langfuse unreachable | Batches are dropped by the exporter. The turn is unaffected. |
| Export throws | Caught inside `core/langfuse.ts`, logged once at `warn`, never rethrown. |
| Keys unset | No provider registered, no spans created, no overhead. |
| Shutdown | The exporter is flushed with a bounded timeout on `SIGTERM`; a failed flush does not delay shutdown. |

## 6. Events carry the trace

Every row a **turn** writes to `events` sets `actorType = 'agent'`, `actorUserId =
null`, and `traceId` to this turn's Langfuse trace id. Rows written on the inbound
path instead of inside a turn — `lead.created`, `lead.consented` — carry no trace
id, because at that point there is no turn and no trace — the timeline in the lead's
file links straight to the trace from any event, not only from the message. This
holds whether or not a tracer is registered: `traceId` is simply `null` when
Langfuse is unconfigured, same as any other absent value (FR-050).

## 7. Verifying it

SC-011 is the acceptance: one conversation, one trace per turn, model and tool spans
present, and zero unmasked names, phones or e-mail addresses across every trace and
log record. SC-010 is its complement: the same conversation with all three keys
unset produces the same persisted turns.
