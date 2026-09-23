# Phase 0 — Research: Revisable Orchestration

Five questions had to be answered before the design could be written. Each was
settled against the code in the repository or against a source the developer
supplied, not from memory.

---

## 1. How much tool calling exists today? — **None**

**Finding.** The turn makes two model calls and **neither passes a tool**:

| Call | How | Tools |
|---|---|---|
| `extract` (`orchestrator.ts`) | `generateText`, JSON asked for in text and parsed by hand | none |
| `phrase` (`orchestrator.ts`) | `streamText`, sentence-guarded | none |

`conversationTools()` in `agent/tools/index.ts` builds a `ToolSet` that **no call
site ever uses** — `grep` finds the definition and a comment referencing it, and
no invocation. The tool bodies (`runSearchProperties`, `runProposeMeeting`) are
called directly from `run()`.

**Why this matters more than it looks.** ADR 14 (05/09) is titled *"Native tool
calling under a deterministic slot machine"* and states the model calls tools.
That is not what was built. Extraction became `generateText` + hand-parsing
because `generateObject` failed schema validation on the 4-bit model (backlog item
17 records the evidence), and the scheduling and search paths were wired
code-first. **This slice therefore introduces model-driven tool calling to the
turn for the first time**, rather than extending something that works.

**Consequence for the plan.** The risk is higher than "add a round trip", and the
incremental bring-up in §3 is not ceremony — it is the whole mitigation. It also
means ADR 14's consequence paragraph is stale; `/speckit-analyze` should catch it
and the implementation should correct the record.

---

## 2. Where does the loop go in a turn? — **Between extraction and phrasing**

**Decision.** Keep the two existing calls and add a third, conditional one:

```
extract (JSON, no tools)  →  act (tools, 0..N steps)  →  phrase (stream, no tools)
```

The action call runs **only when the turn has an action worth considering** — a
search criterion moved, the script just completed, or the lead asked something a
tool answers. A turn that merely answers the pending question skips it entirely
and costs exactly what it costs today.

**Rationale.** Phrasing is sentence-guarded and streamed; mixing tools into it
would mean a tool call arriving mid-stream after guarded sentences have already
reached the lead. Extraction is a narrow JSON contract that took real effort to
stabilise on a 4-bit model, and widening it to carry tools reintroduces exactly
the failure that made it hand-parsed. A third call keeps both intact.

**Cost.** One extra round trip on action turns. On a local model that is real
latency, which is why it is conditional.

**Alternatives considered.** *Tools on the phrasing call* — rejected, see above.
*Merge extraction into the loop as a real `updateSlots` tool* — this was already
tried and reverted (commit `7f2ded0`, "the extraction asks for JSON, not for a
tool call"); repeating it is relitigating a settled, evidence-backed decision.
*Code keeps invoking search, no loop at all* — rejected by ADR 22, and it would
leave US2 with nothing real to exercise.

---

## 3. How should the tool contracts be written? — **Contract-first, brought up incrementally**

**Source.** The Gemma 4 tool-calling playbook the developer supplied
(`gemma4.app/playbooks/tool-calling`), read on 2026-09-22.

**Findings, as they apply here.** The playbook's position is that tool use is a
contract problem: a clear name, a narrow schema, explicit argument meanings,
**usage boundaries stating when to call and when not to call**, and defined error
handling. It names ambiguous schemas, overlapping descriptions, undefined error
handling and prompt-altering runtime wrappers as the failure modes, and calls them
system-design problems rather than model limitations. Its recommended bring-up is
incremental: one tool with one schema on an obvious case, then optional arguments,
then a second tool, then ambiguous requests, then fallback behaviour.

**Honest limit.** The playbook says nothing about quantization. It does not
demonstrate that a 4-bit model will hold a loop; it removes the inference that our
one observed failure proves it cannot. That observed failure — recorded in
`tools/index.ts`, a model handed five tools picking one instead of writing a
sentence — happened with five tools carrying human-facing descriptions and no
stated non-use boundaries, which is the playbook's first failure mode.

**Decision.** Rewrite `searchProperties`'s contract to that standard before
concluding anything about the model, and bring the loop up with **one tool**.
`proposeMeeting`/`bookMeeting` stay inert (FR-015), so the loop's first production
tool set is exactly one — which is the playbook's step 1 by construction rather
than by discipline.

---

## 4. What is the step bound, and what happens at it? — **3 steps, then answer with what you have**

**Decision.** At most **3** tool steps per turn. On reaching the bound the loop
stops offering tools and the turn proceeds to phrasing with whatever results it
holds. The lead always gets a reply.

**Rationale.** The realistic useful loop is *search → read → search again with
relaxed criteria* — two steps, with one spare for a turn that also needs a second
lookup. Beyond that the model is refining rather than answering, and every extra
step is a full local-model round trip the lead waits through. Three is cheap to
raise later and expensive to discover the need for at runtime.

**Why a bound at all.** Without one, a model that keeps calling the same tool with
slightly different arguments never produces a reply: the lead watches a typing
indicator, tokens burn, and the turn never commits. This is a realistic local-model
failure, not a hypothetical.

**Mechanism.** AI SDK v7 (`ai@7.0.93`) expresses this as a stop condition on step
count. The exact call shape is an implementation detail; the requirement is the
bound and the forced reply.

**Alternatives considered.** *Unbounded with a wall-clock timeout* — a timeout
already exists per call (`MODEL_TIMEOUT_MS`), but it bounds one request, not the
loop, so a fast model could loop a long time inside it. *Bound of 1* — forbids the
read-and-retry that is the whole point of US2.

---

## 5. How is a revision recorded? — **The existing event, unchanged**

**Finding.** A first fill writes a durable row to the append-only `events` table:
`slot.filled`, payload `{ slot, value }`, PII-masked under the slot's own key
(`services/conversation.ts`). It is read by the summariser and by the broker's
timeline in the lead drawer. It is not a log line and not a span.

**A revision today writes nothing at all.** `commitTurn` iterates `input.filled`,
which contains only `empty → filled` transitions, so a lead who moves their budget
from 700.000 to 900.000 leaves no trace in the log the broker reads.

**Decision (developer, 22/09).** Emit the **same** `slot.filled` event for a
revision, with the **same payload shape**. No new event type, no `previous` field.
A revision is then distinguishable from a first fill only by comparing against the
prior event for that slot — which is acceptable because no consumer needs the
distinction today. Revisit only when one does.

**Rationale.** It closes the actual gap (a change that leaves no trace) at the
lowest possible cost, and it adds nothing to the event catalogue that would have
to be documented, seeded and kept in step. The constitution's rule against
speculative generality applies directly: a richer scheme has no second consumer.

---

## Resolved, with no research needed

- **Protected state** — `TurnPromptInput` already carries only `intent`, `slots`,
  `filled`, `question`, `consented`, `meeting`, `notUnderstood` and `broker.name`.
  Score, temperature, fallback streak and pipeline stage never reach a prompt.
  FR-019 is a regression guard over an existing property, not new work.
- **The cascade mapping** — decided by the developer on 22/09 and recorded in
  [`data-model.md`](data-model.md) §3, deliberately out of the spec because it is
  data, not a requirement.
- **Working model** — `gemma-4-e4b-it-OptiQ-4bit` **stays**, and
  `gemma-4-12B-it-OptiQ-4bit` is an escalation taken on evidence, not an opening
  move (developer's direction, 22/09). Escalating early would hide whether the
  narrowed tool contract was what fixed the loop — which is the one thing §3 says
  to find out. Whether the larger model sustains four concurrent requests is
  **unmeasured**: the old claim that it does not was never backed by a benchmark,
  and it stays marked open unless the escalation actually happens.
