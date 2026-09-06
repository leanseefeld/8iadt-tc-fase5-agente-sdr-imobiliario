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
| Started by | `services/conversation.ts`, around the whole turn |
| Ends | after the transaction commits, whatever the outcome |

**Attributes** (every span in the trace inherits them):

| Attribute | Example | Notes |
|---|---|---|
| `agency.id` | uuid | tenant, always present |
| `lead.id` | uuid | absent only on the very first message, before the lead exists |
| `conversation.id` | uuid | |
| `channel` | `web` | |
| `turn.intent` | `purchase` \| `undefined` | as computed *before* the turn |
| `turn.pending_slot` | `bedrooms` | the slot the deterministic question targets |
| `turn.score` | `55` | recomputed value at the end of the turn |
| `turn.stage` | `qualifying` \| `qualified` \| `handoff` | |
| `turn.outcome` | `replied` \| `fallback` \| `handoff` \| `opted_out` \| `rate_limited` \| `replayed` | one value, always set |

## 2. Child spans

| Span | Kind | When | Attributes beyond the inherited set |
|---|---|---|---|
| `model.reply` | generation | The streaming call that produces the reply | `model.id`, `provider.base_url` (host only), `usage.input_tokens`, `usage.output_tokens`, `latency.ms`, `retry.count`, `error.code` |
| `model.recover_slot` | generation | Only when the extraction tool was skipped | as above, plus `slot` |
| `tool.updateSlots` | tool | Per invocation | `slots.changed` (key list, values masked) |
| `tool.searchProperties` | tool | Per invocation | `filters` (slot-derived), `results.count`, `results.codes` |
| `tool.requestHandoff` | tool | Per invocation | `reason` |
| `tool.optOut` | tool | Per invocation | — |
| `guard.rejected` | event on the trace | A reply guard replaced or truncated the reply | `guard` (`language` \| `two_questions` \| `unbacked_money` \| `leak`) |

Tool spans are produced by the AI SDK's tool instrumentation; the attribute rows
above are what this project adds to them.

## 3. Masking

`maskPII` from `src/core/security.ts` is installed as the span processor's mask and
as the logger's serializer — one rule, both sinks, principle VIII. It masks:

| Kind | Rule | Example |
|---|---|---|
| Phone | keep the last 4 digits | `(11) 9****-1234` |
| E-mail | keep the first character and the domain | `c***@gmail.com` |
| Person name | keep the first name, mask the rest | `Camila S.` |
| Free text | phone- and e-mail-shaped substrings replaced in place | applies to message bodies |

Property addresses are **not** masked: they are catalog data, not lead data.

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

## 6. Verifying it

SC-011 is the acceptance: one conversation, one trace per turn, model and tool spans
present, and zero unmasked names, phones or e-mail addresses across every trace and
log record. SC-010 is its complement: the same conversation with all three keys
unset produces the same persisted turns.
