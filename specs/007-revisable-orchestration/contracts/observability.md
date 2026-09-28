# Observability contract — additions for the action loop

**This extends [spec 004's contract](../../004-conversation/contracts/observability.md);
it does not replace it.** Everything there still holds: one trace per turn, the
inherited attribute set, the masking rules, the failure behaviour, and the rule
that a span name not in the table is a defect rather than an extension.

Read §2 of that file alongside this one — the table below adds rows to it and
amends the paragraph underneath it.

---

## 1. One new generation span

| Span | Kind | When | Attributes beyond the inherited set |
|---|---|---|---|
| `model.act` | generation | The conditional third call that carries tools. Absent on turns that take no action. | `model.id`, `provider.base_url` (host only), `latency.ms`, `finish.reason`, `usage`, plus `steps.count` and `steps.bounded` |

`steps.count` is how many tool steps the loop actually ran, zero included.
`steps.bounded` is true when the loop stopped because it reached the bound rather
than because the model was done — the signal that the bound is set too low, and
the thing to look at before raising it blindly.

## 2. Tool spans gain a position, and a real executor

The existing `tool.*` rows keep their names and their inputs. Two things change:

| Attribute | Meaning |
|---|---|
| `step.index` | Position within the turn's loop, from zero. Required on every tool span emitted from the loop. |
| `step.refused` | True when the action declined to act because its preconditions did not hold (FR-013b). The refusal is a result the model reads, not an error. |

**The paragraph under 004's §2 table needs amending.** It reads:

> Tool spans are written by `commitTurn` from the list it is about to persist, not
> by the AI SDK: this agent invokes its tools from code, so the SDK never sees them
> execute.

That stops being wholly true. After this slice:

- `tool.searchProperties` is executed **by the SDK inside the loop**, and its span
  is emitted from there with `step.index`.
- Every other tool span is still written by `commitTurn` from the persisted list,
  exactly as described, because those tools are still invoked from code or are
  inert.

Both kinds must carry the same attribute set, so a reader cannot tell from the
span alone which path produced it — only `step.index`'s presence distinguishes a
loop step, and that is the point.

## 3. What a good trace looks like

*Note, 27/09/2026:* the two-step shape below is **backlog item 010's target**. Since FR-034 the search takes no arguments, so today's shape is one `tool.searchProperties` at `step.index` 0, its result, then `model.reply`.

A turn where the lead moved their budget and the first search came back empty:

```
conversation.turn
├── model.extract            (generation)
├── model.act                (generation)  steps.count=2  steps.bounded=false
│   ├── tool.searchProperties  step.index=0  → 0 results
│   └── tool.searchProperties  step.index=1  → 3 results
└── model.reply              (generation)
```

**SC-007 is exactly this shape**: both calls present, both results present, in
order, with no step missing. A trace showing `model.act` with `steps.count=2` but
only one `tool.*` child is a defect.

## 4. Unchanged

- **Masking.** The revision event reuses `slot.filled`'s existing key-aware
  masking; no new masking path and no new rule.
- **Session and trace naming.** Session id remains the conversation id.
- **Failure behaviour.** Telemetry never blocks or fails a reply. A loop that
  fails to trace still answers the lead.
- **Protected state.** Nothing in this contract causes a lead's score,
  temperature, fallback streak or pipeline stage to be attached to a span. They
  are not in the prompt (FR-019) and they are not in the trace.
