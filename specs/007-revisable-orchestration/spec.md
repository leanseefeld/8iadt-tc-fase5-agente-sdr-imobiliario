# Feature Specification: Revisable Orchestration

**Feature Branch**: `007-revisable-orchestration`

**Created**: 2026-09-22

**Status**: Draft

**Input**: Resolves pending decision 6 via [ADR 22](../../docs/arquitetura/adr/decisoes.md#22-revisable-qualification-state-and-actions-as-tool-calls). Every criterion revisable including `intent`; a revision counted as learning rather than as non-comprehension; a *reconfirm* turn that restates known state and invites correction; actions as model tool calls with a round trip before the reply; the meeting offer derived from stored facts instead of recomputed every turn; every step of the loop its own trace span.

**Runs before spec 006, which it unblocks.** Numbering is identity, not order.

## Why this exists

A lead qualified by the agent today has exactly one thing they are allowed to do:
answer the next question. Anything else — changing their mind, reacting to the
properties they were just shown, asking what the agent is filtering by, or
mentioning what a broker arranged ten minutes ago — fills no slot, and a turn that
fills no slot is counted as *not understood*. Two of those in a row hand the lead
to a human.

Three real conversations, recorded in the decision register:

- **16/09** — script finished, score 100, the lead writes *"E na zona norte, tem
  algo?"* and then one more message. The agent apologises twice and raises a
  handoff.
- **16/09** — mid-script, *"Moema ou Vila Mariana"* after *"zona sul"*. Read
  correctly, counted as a misunderstanding.
- **21/09** — a broker takes over, promises a visit, hands back. The lead asks
  *"e a visita de amanhã, continua de pé?"* and is returned to a human for having
  spoken about what the human just arranged.

**The mechanism, stated precisely, because the register had it wrong.** This was
filed as `mergeSlots` discarding a value because the slot was already filled.
That is not what the code does: merge rule 1 already replaces a filled slot with
a different non-empty value. The defect is one layer up, in the turn's
accounting — `MergeResult.filled` counts only `empty → filled`, so a revision is
invisible to `learnedSomething`, `notUnderstood` fires, and the fallback streak
advances. Three symptoms share that single cause:

| Symptom | Where | Why it follows |
|---|---|---|
| A revision reads as non-comprehension | `learnedSomething` | `filled` never contains a revised slot |
| A changed criterion never re-runs the search | `searchDue` | keys off the same set, under a comment that wrongly claims a filled slot is never overwritten |
| The meeting offer repeats every turn | `shouldProposeMeeting` | a pure function of slot state, with no memory of having fired |

Fixing the accounting is therefore the whole feature, and the tool loop is what
makes the fix worth having: once a criterion can change, a search has to be able
to run again.

## Clarifications

### Session 2026-09-22

- Q: Who invokes the property search — the model, or code that notices a criterion changed? → A: The model calls it. Before concluding the local model cannot, the **tool contract** is fixed first: narrow schema, explicit when-to-call *and* when-not-to-call, defined error handling. Today's code-invoked search was a response to a 4-bit model grabbing tools instead of writing sentences, which is a contract problem before it is a model problem.
- Q: Should a turn carry a set of actions the model is not allowed to call? → A: No permitted-set layer. Two fronts instead: each tool's own definition says when it should and should not be called, and a tool invoked when its preconditions do not hold returns a **refusal result to the model** rather than failing the turn.
- Q: How should the reconfirmation elicitation rate be handled? → A: Keep the design, move the rate out of Success Criteria and into Assumptions as the stated hypothesis. Validate with the larger model if the small one cannot carry it; 8 of 10 scripted runs passing is acceptable, with the shortfall recorded as technical debt rather than blocking the slice.
- Q: Cut SC-004's thirty generated states? → A: Yes. FR-019 makes the leak structurally impossible, so one assertion on the briefing payload replaces the generated sweep.
- Q: Cut FR-022's greeting-beats-apology rule? → A: No — the requirement stays. The implementation carries a comment at the point where the collision would occur, so the reasoning is findable from the code.
- Q: What does a slot change record today? → A: A durable row in the append-only `events` table (`slot.filled`, payload `{ slot, value }`, PII-masked), which the summariser and the broker's timeline read — not merely a log line or a span. A **revision currently emits nothing at all**, so FR-029 closes a real gap rather than adding a nicety.
- Q: Should a revision be distinguishable from a first fill by its own event type? → A: No. Reuse `slot.filled` unchanged; a revision is told apart only by comparing against the previous value. Revisit only if a real consumer needs the distinction cheaply.

### Session 2026-09-22 (second pass, after plan)

- Q: Should a failed extraction call — provider down, both attempts timed out — still count as a misunderstanding? → A: No. The reply says something went wrong technically and asks the lead to repeat; the consecutive-misunderstanding count is untouched. Today an outage counts as two misunderstandings and hands **every live conversation** to a broker at the worst possible moment.
- Q: With conversational turns no longer advancing the count, what bounds a lead whose answers are repeatedly misread as chat? → A: Nothing new in this slice. Genuine non-comprehension still advances the existing streak, and a misclassified answer simply gets the question re-asked. The separate, more generous no-progress counter is recorded in the backlog for when a real case appears.
- Q: Does a conversational message after a genuine misunderstanding reset the count or hold it? → A: Hold. The count measures *consecutive failures to understand*, and an interjection is not evidence the confusion cleared: unintelligible → chat → unintelligible still reaches the handoff.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - The lead changes their mind and the conversation carries on (Priority: P1)

A lead who has already answered says something different — a new neighbourhood, a
higher budget, two bedrooms instead of three. The agent treats it as something
learned, not as a sentence it failed to parse: it updates what it knows, says so,
and where the change affects what was already shown, it searches again.

**Why this priority**: It is the defect. Every other story in this spec is either
a consequence of the same accounting gap or an affordance built on top of the fix.

**Independent Test**: Drive a purchase script to completion through the service
layer, then send *"na verdade, e na zona norte?"*. Assert that the slot changed,
that the fallback streak is zero, that a new search ran, and that the reply is not
an apology.

**Acceptance Scenarios**:

1. **Given** a filled slot, **When** the lead supplies a different non-empty value
   for it, **Then** the turn counts as having learned something, the fallback
   streak resets to zero, and no apology is generated.
2. **Given** a criterion that feeds the property search changes after a search has
   already run, **Then** the search runs again with the new criteria and the lead
   sees the new results, not the previous ones.
3. **Given** the lead revises a slot, **When** the turn is composed, **Then** the
   reply acknowledges what changed before anything else.
4. **Given** the lead supplies the *same* value a slot already holds, **Then**
   nothing is treated as revised, no reconfirmation is triggered, and the turn
   proceeds as an ordinary one.
5. **Given** the lead reacts rather than answers — *"Nossa, isso seria bom haha"*
   — **Then** the turn is not a misunderstanding, the streak does not advance, no
   apology is produced, and the reply acknowledges the reaction and continues with
   the pending question.
6. **Given** the lead checks whether anyone is there — *"opa, tá aí?"* — **Then**
   the same holds: no apology, no streak, and the agent answers that it is there
   and repeats what it was waiting on.
7. **Given** two such messages arrive in a row, **Then** no handoff is raised —
   the streak never moved.

---

### User Story 2 - The agent acts, reads what came back, and acts again (Priority: P1)

The agent stops being a thing that fills in a sentence around a result computed
before it was asked. It calls an action, reads the result, may call again with
different parameters, and only then writes the reply. A developer opening the
trace afterwards sees that back-and-forth in order.

**Why this priority**: Revising a criterion is worthless if the consequence of the
revision cannot be acted on in the same turn, and this is the architecture ADR 22
committed to. It is also the seam a specialist agent arrives through later
(backlog item 16).

**Independent Test**: Force a turn whose first search returns nothing, and assert
that a second search ran with relaxed parameters within the same turn, and that
the trace contains both calls with both results, in order.

**Acceptance Scenarios**:

1. **Given** a turn where an action is available, **When** the model calls it,
   **Then** the result is returned to the model and the model may call again
   before any reply text is produced.
2. **Given** a turn that called the same action twice, **Then** the trace shows
   two distinct steps, each naming the action, its arguments, its result and its
   position in the turn.
3. **Given** the model calls an action whose preconditions do not hold, **Then**
   the action does not take effect, the model receives a refusal it can read, and
   the turn still produces a reply. There is no separate per-turn permission
   layer: the same actions are offered every turn and each one guards itself.
4. **Given** an action fails, **Then** the turn still produces a reply and the
   failure appears in the trace rather than reaching the lead as an error.

---

### User Story 3 - The lead asks what the agent is filtering by (Priority: P2)

A lead who is unhappy with what they were shown asks *"desculpa, como você tá
filtrando?"* or *"o que vc tá considerando pra busca?"*. The agent answers plainly
with what it actually holds — *"Entendi que você considera comprar um imóvel de
até 3 quartos em Moema, por até R$ 1,2 milhões. Quer explorar outro cenário?"* —
and invites a change.

**Why this priority**: It converts the most common moment of frustration into the
moment a criterion gets corrected, which is exactly what US1 made possible. P2
because US1 is correct without it.

**Independent Test**: After a completed script, ask the question in three
phrasings and assert each reply names the stored values and nothing else.

**Acceptance Scenarios**:

1. **Given** a lead asks what the agent is considering, **Then** the reply states
   the criteria currently held and ends by inviting a change.
2. **Given** such a question, **Then** the turn is not counted as a
   misunderstanding and the fallback streak does not advance.
3. **Given** such a question, **Then** the reply contains no internal ranking,
   scoring, routing or pipeline information of any kind.
4. **Given** criteria that are only partly filled, **Then** the reply states what
   is known without inventing values for what is not.

---

### User Story 4 - A reconfirmation that invites the corrections nobody volunteered (Priority: P2)

When a lead corrects something they had already settled, the agent takes the
opening: it restates the handful of facts most likely to have moved with it and
asks one question — *"Só pra confirmar: até R$ 1,2 mi, 3 quartos, Moema. Continua
assim?"* People proactively correct a second and third answer when asked to review
one or two, even when the reviewed ones still stand.

**Why this priority**: It is the deliberate elicitation design, and it is what
turns one correction into an up-to-date picture. P2 because revision works without
it; this makes it pay.

**Independent Test**: Revise `priceMax` after qualification and assert the next
reply restates `bedrooms` and `neighborhoods`, asks exactly one question, and that
a second revision in the following turn does **not** trigger another reconfirmation.

**Acceptance Scenarios**:

1. **Given** the lead revises an already-filled slot, **When** that slot has
   dependants, **Then** the next reply restates those dependants and asks a single
   confirmation question.
2. **Given** the previous turn was itself a reconfirmation, **When** the lead
   revises another slot, **Then** no second reconfirmation is produced — the turn
   proceeds normally.
3. **Given** a reconfirmation is produced, **Then** it contains exactly one
   question.
4. **Given** the lead answers a reconfirmation by correcting a restated value,
   **Then** that correction is merged like any other revision.
5. **Given** the lead answers a reconfirmation by confirming, **Then** no slot
   changes and the script continues where it left off.

---

### User Story 5 - The conversation comes back from a broker without an apology (Priority: P2)

A broker finishes with a lead and returns the conversation. A written line marks
the moment, so the lead knows who they are talking to again, and the agent's next
turn is an ordinary one rather than a competition between a greeting and an
apology.

**Why this priority**: It is the third recorded manifestation, and the cheapest of
the three to close. P2 because it is a narrower path than US1.

**Independent Test**: Hand a conversation to a broker and back, then send a lead
message that fills no slot, and assert the re-entry line was already posted and
that the reply is not an apology.

**Acceptance Scenarios**:

1. **Given** a broker returns a conversation to the agent, **Then** a written
   message naming the broker and the agent is posted to the conversation without
   any model call.
2. **Given** that message was posted, **When** the lead writes next, **Then** the
   turn is not treated as the agent's first words since the handback.
3. **Given** the re-entry line and an apology could both apply to one turn,
   **Then** the re-entry line is what the lead sees.

---

### User Story 6 - The meeting offer is made once (Priority: P3)

Once the agent has offered to book, it stops offering on every subsequent turn
until something changes.

**Why this priority**: The same accounting gap, and visible in every completed
demo conversation. P3 because it is cosmetic next to US1.

**Independent Test**: Complete a qualification, then send three unrelated
messages, and assert the offer appears exactly once.

**Acceptance Scenarios**:

1. **Given** an offer to book is already outstanding, **Then** no further offer is
   made on subsequent turns.
2. **Given** the offer state is needed, **Then** it is read from what is stored
   about the conversation, never from anything held in the process between turns.

---

### Edge Cases

- **The model provider is unreachable mid-conversation.** Every turn replies with
  a technical apology and the conversation stays with the agent; brokers are not
  flooded with handoffs because the model is down.
- **Unintelligible, then chatty, then unintelligible.** The count holds through
  the middle turn and reaches the handoff on the third — the interjection neither
  rescues nor accelerates it.
- **A reaction arriving right after property cards.** Not a misunderstanding —
  and it must stay that way once the one-turn card shield is deleted.
- **A message that is both social and substantive** — *"opa! pode ser até 900 mil"*.
  The attempt is what counts: the slot is merged and the turn is ordinary.
- **A message of pure punctuation or emoji.** Attempts nothing; same treatment as
  a reaction, and it must not cost a model call it does not need.
- **The lead revises two slots in one message.** Both changes are merged; at most
  one reconfirmation is produced for the turn.
- **The lead revises a slot the script has not reached.** Treated as an ordinary
  fill, not a revision, and no reconfirmation follows.
- **A revision arrives in the same turn as a brand-new answer.** Both count as
  learning; the reply acknowledges both.
- **A revision that empties a slot** — *"na verdade não sei ainda"*. Out of scope:
  a slot never returns to unfilled, and the value stands until replaced.
- **The lead revises `name` or `contact`.** Merged as usual, never reconfirmed.
- **An action loop that does not terminate.** The number of steps in a turn is
  bounded, and reaching the bound still produces a reply.
- **A search re-run returning the same rows as before.** The lead is not shown a
  second identical set of cards.
- **A lead asking about criteria before answering anything.** Answered with what
  is known, which may be nothing, without inventing values.
- **Two reconfirmations that would chain.** Structurally impossible: a
  reconfirmation never follows a reconfirmation.
- **A broker returns a conversation that has no lead message after it.** The
  re-entry line still posts, and nothing further is sent until the lead writes.

## Requirements *(mandatory)*

### Functional Requirements

**Revisable state**

- **FR-001**: Every qualification criterion MUST be revisable. A filled slot
  receiving a different valid non-empty value MUST be updated, and the change MUST
  be reported by the merge as *revised* — distinct from both *filled* and
  *dropped*, so that a turn can tell the three apart.
- **FR-002**: `intent` MUST be revisable. The rule restricting it to a single
  move out of `undefined` is withdrawn.
- **FR-003**: A turn in which any slot was filled **or revised**, or in which the
  intent changed, MUST count as having learned something, MUST NOT be recorded as
  a misunderstanding, and MUST reset the consecutive-misunderstanding count to
  zero.
- **FR-003a**: A turn MUST be recorded as a misunderstanding only when the lead
  **attempted to convey something** and the system could neither learn from it nor
  act on it. A message that attempts nothing — a reaction (*"Nossa, isso seria bom
  haha"*), a greeting, a check-in (*"opa, tá aí?"*), a thank-you, or any other
  social remark — MUST NOT count as a misunderstanding, MUST NOT advance the
  consecutive-misunderstanding count, and MUST NOT produce an apology. The agent
  acknowledges it and carries on with the pending question.
- **FR-003b**: Whether the lead attempted an answer MUST be decided by the
  **model's reading of the message**, reported alongside the extraction that
  already reports whether the lead asked for a human or opted out — one more
  fact from a call that is already being made. It MUST NOT be decided by a list
  of known-harmless words: a fixed vocabulary cannot cover a language, and the
  one in use today counts *"nossa"*, *"isso"*, *"seria"* and *"tá"* as evidence
  that an answer was attempted.
- **FR-003c**: A turn whose extraction **failed outright** — the provider was
  unreachable or every attempt timed out — MUST NOT be recorded as a
  misunderstanding and MUST NOT advance the consecutive-misunderstanding count.
  The reply MUST say that something went wrong on the system's side and ask the
  lead to repeat, rather than claim not to have understood. The failure is already
  known to the turn; it is simply not read today, which is why a provider outage
  currently walks every live conversation into a handoff in two turns.
- **FR-003d**: A conversational turn and a failed turn both **hold** the
  consecutive-misunderstanding count where it is — neither advancing it nor
  resetting it. Only learning something resets it (FR-003). An interjection
  between two genuine misunderstandings is not evidence the confusion cleared.
- **FR-004**: A slot MUST NOT return to unfilled. An empty value over a filled
  slot is still refused.
- **FR-005**: When the lead's intent changes, slots the previous script filled
  that the new script does not use MUST be **kept, not cleared**. They remain
  available to the rest of the system — broker routing by specialization reads
  them today, and a specialist agent may read them later — and they MUST NOT be
  presented to the lead as current criteria or counted toward the new script's
  completion.
- **FR-005a**: An intent change MUST trigger a reconfirmation, because a value
  carried across scripts can survive with the wrong meaning — a budget stated for
  a purchase is not a monthly rent. The reconfirmation restates the carried
  criteria whose meaning the change puts in doubt, and asks its single question
  like any other.

**Reconfirmation**

- **FR-006**: When a turn revises an already-filled slot that has dependants, and
  the immediately preceding agent turn was not itself a reconfirmation, the system
  MUST produce a reconfirmation: a restatement of the dependants' current values
  followed by exactly one confirmation question.
- **FR-007**: The dependants of each revisable slot — which other criteria a
  change to it puts in doubt — MUST be declared as **data in one place**, a single
  table in code or configuration, never spread through conditional logic, so that
  the mapping can be read and changed without reading the orchestrator. The
  consent-gated contact criteria MUST NOT appear as dependants of anything.

- **FR-008**: A reconfirmation MUST contain exactly one question, satisfying the
  one-question-per-message rule without exception.
- **FR-009**: A reconfirmation MUST NOT follow a reconfirmation. Whether the
  preceding turn was one MUST be derived from what is stored about the
  conversation — never from a value held in the process between turns.
- **FR-010**: A dependant that is not yet filled MUST be omitted from the
  restatement rather than asked about within it.
- **FR-011**: Answering a reconfirmation with a correction MUST merge that
  correction under FR-001; answering by confirming MUST change nothing and return
  the conversation to the pending question.

**Actions**

- **FR-012**: The model MUST be able to call an action, receive its result, and
  call again with different arguments before any reply text is produced. The
  number of steps per turn MUST be bounded, and reaching the bound MUST still
  produce a reply.
- **FR-013**: Property search MUST become a repeatable action **called by the
  model**, not invoked from code on the model's behalf. It MUST be callable more
  than once in a turn and on any turn, not only the one that completes the script.
- **FR-013a**: Every action's definition MUST state, in the definition itself,
  **when it should be called and when it should not** — the tool contract is part
  of the prompt contract. Before any conclusion that the local model cannot drive
  an action reliably, the contract MUST be narrowed and retested: an ambiguous
  schema or an overlapping description is a design defect, not a model limit.
- **FR-013b**: An action called when its preconditions do not hold MUST return a
  **refusal result the model can read and act on** — never an exception, never
  silence, and never a failed turn.
- **FR-014**: The scope of a search — the agency it may read, and the refusal to
  search for an `investment` lead — MUST NOT be derivable from anything the model
  supplies.
- **FR-015**: Scheduling actions MUST remain declared and inert until spec 006
  supplies a calendar. A model calling one MUST receive the same unavailable
  result it receives today, and MUST NOT be able to create a booking.
- **FR-016**: An action that fails MUST NOT fail the turn. The lead MUST receive a
  reply, and the failure MUST be visible in the trace.
- **FR-017**: Whether an offer to meet is already outstanding MUST be read from
  what is stored about the conversation. A further offer MUST NOT be made while
  one is outstanding.

**Saying what is known**

- **FR-018**: When the lead asks what the agent is considering or filtering by,
  the system MUST reply with the criteria currently held, and MUST invite a
  change. The turn MUST NOT count as a misunderstanding.
- **FR-019**: Internal assessment of a lead — ranking score, temperature,
  consecutive-misunderstanding count, pipeline stage, broker assignment and
  routing decisions — MUST NOT be placed in anything sent to the model. The
  protection is structural: such values are withheld rather than sent and then
  filtered out of the reply.
- **FR-020**: A restatement MUST name only values that are actually held, and MUST
  NOT supply a value for an unfilled criterion.

**Coming back from a broker**

- **FR-021**: When a broker returns a conversation to the agent, the system MUST
  post a written message to the conversation naming the departing broker and the
  agent, composed without a model call, delivered on the same path as any other
  agent message.
- **FR-022**: If a re-entry greeting and an apology for not understanding would
  both apply to one turn, the greeting MUST win — the apology is false, since the
  message was understood. FR-021 makes this collision nearly unreachable; the rule
  stays for the conversation handed back before this feature existed and for a
  failed write, and the implementation MUST carry a comment at the point where the
  collision would occur, so a later reader finds the reasoning from the code.
- **FR-023**: A lead question the agent cannot act on because the capability has
  not been built yet MUST advance the consecutive-misunderstanding count like any
  other unanswerable turn — reaching a human is the right outcome for a lead
  asking something this agent genuinely cannot do. The **reply MUST say that**,
  not claim incomprehension: *"ainda não consigo te ajudar com isso"* rather than
  *"desculpa, não entendi"*. The agent understood; it cannot act.

**Guards and what leaves with the rigidity**

- **FR-024**: The output guards MUST remain in force unchanged: leaked syntax,
  language, unbacked figures and question count.
- **FR-025**: The evidence gate over closed-set slots MUST remain in this slice.
  Removing it is a separate decision that requires measuring the new orchestration
  first.
- **FR-026**: Compensations that exist only to soften the rigidity being removed —
  the one-turn shield after property cards, and the part of the steering check
  that exists to stop a steering attempt counting as a misunderstanding — MUST be
  removed once the accounting no longer needs them, and their removal MUST NOT
  reintroduce any behaviour the guards were protecting. The card shield in
  particular is today the **only** thing keeping a reaction to a property
  (*"Nossa, isso seria bom haha"*) out of the misunderstanding count, and it lasts
  exactly one turn: it MUST NOT be removed before FR-003a is in place, or that
  case regresses instead of improving.

- **FR-026a**: The prompt line forbidding the agent from ever raising a filled
  slot again MUST be softened to a discouragement, matching constitution 1.4.0's
  amended principle V. Re-asking stays something the agent avoids by default and
  may do when it has reason — the reconfirmation in US4 is the first such reason.
  No other code change is licensed by that amendment.

**Observability**

- **FR-027**: Every step of a turn's action loop MUST emit its own span, naming
  the action, its arguments, its result and its position in the turn, nested under
  the turn's trace.
- **FR-028**: The span contract MUST extend the existing one rather than
  introduce a parallel vocabulary.
- **FR-029**: A revision MUST be recorded in the append-only event log, using the
  **existing** `slot.filled` event and its existing payload. Today a first fill
  writes a durable row that the summariser and the broker's timeline read, and a
  revision writes **nothing at all** — so a criterion that changed is invisible to
  every consumer of that log. Emitting the same event closes that gap and nothing
  more: a revision is then distinguishable from a first fill only by comparing the
  value against the previous event for that slot. **No new event type and no extra
  payload field.** Revisit only if a concrete consumer needs to tell the two apart
  without that comparison.

**Configuration and measurement**

- **FR-030**: The working model **stays** `gemma-4-e4b-it-OptiQ-4bit` for this
  slice. Moving to the larger local model is an **escalation, taken on evidence**,
  not an opening move: it happens only after the tool contract has been narrowed
  and retested (FR-013a) and the small model has still failed to drive one tool
  reliably. Whenever it happens, it MUST remain a change to configuration only,
  and the observation that triggered it MUST be recorded — otherwise the next
  person inherits a model change with no reason attached.
- **FR-031**: Whether that model sustains four concurrent requests MUST be
  measured and the result recorded, replacing the current unverified claim.
  Per-request latency at one and at four concurrent requests MUST both be
  reported, so that queueing is distinguishable from parallelism.

### Key Entities

- **Qualification state** — the intent plus the nine slots. Gains the property
  that any of it may change after being set, and that a change is distinguishable
  from a first answer and from a rejected value.
- **Turn outcome** — what a turn concluded: learned, revised, reconfirmed,
  misunderstood, offered, handed off. Gains *revised* and *reconfirmed*.
- **Action step** — one call the model made within a turn: which action, with what
  arguments, returning what, in what position. New, and the unit the trace records.
- **Re-entry message** — a written agent message marking a broker's return,
  carrying no generated text.

No new table. Slot state, conversation state and the event log already exist.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Across ten scripted conversations that each revise a criterion after
  qualification, zero end in a handoff and zero produce an apology for not
  understanding — today's rate is the opposite.
- **SC-002**: The three conversations recorded in the decision register replay
  without the failure each one documented. The zona norte question after a
  finished script and *"Moema ou Vila Mariana"* after *"zona sul"* reach **no
  handoff at all** — both are understood, and both were handed off for being
  understood. The question about tomorrow's viewing after a handback **may** reach
  a handoff, because this agent genuinely cannot answer it until spec 006 exists,
  but only by way of FR-023's honest *"ainda não consigo te ajudar com isso"* and
  never by an apology for not understanding. Reaching a human because the agent
  cannot help is correct; reaching one because it pretended not to understand is
  the defect.
- **SC-003**: In ten runs where a criterion changes after properties were shown,
  the lead sees results matching the new criteria in ten of ten.
- **SC-004**: A lead asking what the agent is filtering by receives the held
  criteria. Separately, one assertion proves the briefing payload carries only the
  permitted fields — the leak is prevented by construction (FR-019), so it is
  checked once at the boundary rather than sampled across generated replies.
- **SC-004a**: Across a set of purely conversational messages — reactions,
  greetings, check-ins, thanks — zero produce an apology and zero advance the
  consecutive-misunderstanding count. Two in a row raise no handoff. Today both
  *"Nossa, isso seria bom haha"* and *"opa, tá aí?"* fail this.
- **SC-004b**: With the provider made unreachable, ten consecutive turns produce
  ten technical replies, zero handoffs and a consecutive-misunderstanding count
  that never moves. Today the second turn hands off.
- **SC-005**: A reconfirmation carries exactly one question in one hundred out of
  one hundred generated revision cases, and no reconfirmation ever directly
  follows another.
- **SC-006**: *Withdrawn 2026-09-22.* The reconfirmation elicitation rate moved
  to Assumptions as a stated hypothesis — it cannot be honestly measured with
  scripted leads. The number is not renumbered away, so a reader looking for
  SC-006 finds where it went.
- **SC-007**: A turn that searches, reads the result and searches again produces a
  trace showing both calls, both results, and their order, with no step missing.
- **SC-008**: Following a completed qualification with three unrelated messages
  produces exactly one offer to meet.
- **SC-009**: Every conversation returned by a broker carries the written re-entry
  line before the lead's next message is processed, in ten of ten cases.
- **SC-010**: Per-request latency at one and at four concurrent requests is
  recorded for the working model, and the register's unverified claim is replaced
  by that measurement.
- **SC-011**: The existing conversation test suite passes unchanged except where a
  test asserts the behaviour this spec deliberately changes, and each such change
  is traceable to a requirement here.

## Assumptions

- **Spec 004 owns the turn and the prompt.** This slice changes how a turn
  accounts for what happened and how actions run inside it; it does not rebuild
  persistence, streaming, channels or the widget.
- **Spec 006 owns the calendar.** Scheduling actions stay inert here, and the
  follow-up message composed with no lead message in transit remains 006's, via
  its own writer rather than this slice's reply path.
- **Spec 005 owns the broker surface.** This slice adds the written re-entry
  message to the existing handback path and changes no screen.
- **The reconfirmation rests on a hypothesis, stated rather than measured.**
  People asked to review one or two settled answers tend to proactively correct a
  third that was not mentioned — which is why the cascade restates dependants
  instead of simply acknowledging the change. That rate cannot be honestly
  measured here: a scripted lead corrects exactly what the script says, and a
  second model playing the lead measures that model. It is therefore the design's
  stated expectation, not a gate. **Validation policy:** if the small local model
  cannot carry the reconfirmation, validate with the larger one; 8 of 10 scripted
  runs passing is acceptable to ship, with the shortfall recorded as technical
  debt rather than blocking the slice.
- **Tool contracts are prompt contracts.** An action the model fails to call
  correctly is treated first as an ambiguous schema, an overlapping description or
  undefined error handling — a design defect — and only then as a model
  limitation. This reverses the reflex behind today's code-invoked search.
- **The script still decides what to ask.** Constitution principle V's rule that
  deciding the next question is deterministic code is **unchanged** and honoured:
  the script computes what remains and the briefing states it with emphasis. What
  the model gains is the ability to *act* and the ability to accept a *revision* —
  never the choice of subject. This is stated explicitly because ADR 22 requires
  the spec implementing it to say so rather than pass over it in silence.
- **Principle V's re-asking bullet was amended** to 1.4.0 on 22/09/2026:
  re-asking a filled slot is discouraged in the prompt, not forbidden in code. The
  reconfirmation in US4 does not rely on that amendment — it carries one question.
- **Business behaviour under the score is unchanged.** A completed purchase or
  rental script with a contact already exceeds the hot threshold by a wide margin,
  so the temperature gate on offering a meeting cannot change outcomes here. The
  weights themselves belong to spec 008.
- **Integration tests run inside the container** against the project's Postgres;
  model-dependent tests run against the local model and are tagged so the default
  suite skips them.

## Out of Scope

- **Score weights, temperature bands and the investor signal** — spec 008, after
  spec 006, because "booking raises the score" needs bookings to exist.
- **Rescheduling and cancelling a booked meeting from the conversation** — spec
  009, inside the MVP, after 006.
- **Proposing and booking against a real calendar** — spec 006.
- **Follow-up composition with no lead message in transit** — spec 006.
- **Removing the evidence gate** — a later decision, once this orchestration can
  be measured.
- **A router in front of the orchestrator, or a specialist agent** — backlog item
  16; this decision is its input, not its delivery.
- **Topic-driven questioning, where the model chooses the subject** — explored and
  deliberately parked.
- **The inclusive-language sweep** — backlog item 26, cross-cutting, to be done
  properly rather than folded in here.
- **A slot returning to unfilled**, and any user interface for editing slots — the
  latter is backlog item 20.
