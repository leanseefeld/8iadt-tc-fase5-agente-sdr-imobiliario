# Phase 1 — Data Model: Revisable Orchestration

**No migration. No new table. No new column.** Everything below is either a shape
in memory, a declared constant, or a fact derived from rows that already exist.

---

## 1. `MergeResult` gains a third set

Today the merge reports two outcomes. A revision falls into neither, which is the
defect.

| Field | Today | After |
|---|---|---|
| `filled` | slots that went `empty → filled` | unchanged |
| `dropped` | values refused: invalid, empty-over-filled, unconsented contact, unknown key | unchanged, minus the intent-change case |
| `revised` | — | **new**: slots that went `value → different value` |

Rules:

- A slot appears in **exactly one** of the three per merge.
- Supplying the value a slot already holds puts it in **none** of them — it is not
  a revision, and it must not trigger a reconfirmation (spec US1 scenario 4).
- `revised` is ordered like `filled`, in script order, so the acknowledgement
  reads in a predictable sequence.

**Merge rule 3 is withdrawn.** `intent` moving between two defined values stops
being dropped and starts being reported. Because `intent` lives on the lead rather
than in `Slots`, it is reported as its own boolean (`intentChanged`) rather than as
a member of `revised`.

## 2. Turn accounting

Three derived values in the orchestrator change meaning:

| Value | Today | After |
|---|---|---|
| `learnedSomething` | `filled.length > 0 \|\| intentChanged` | `filled.length > 0 \|\| revised.length > 0 \|\| intentChanged` |
| `searchDue` | qualified **and** a qualifying slot was filled this turn | a search-relevant criterion was filled **or revised**, and the script is far enough along to search |
| `notUnderstood` | `!learnedSomething && …` | **redefined — see §2a.** Fixing `learnedSomething` is necessary but not sufficient: the gate on it is also wrong. |

`cardsJustShown` and the fallback-shielding half of `looksLikeSteering` are
**deleted** once §2a lands — not before. Both exist to hide the symptom this
fixes, and `cardsJustShown` is currently the only cover for a reaction to a
property.

The turn outcome vocabulary gains `revised` and `reconfirmed` alongside the
existing `replied | fallback | handoff | meeting_proposed | opted_out`.

## 2a. The extraction gains a third fact

The extraction call already returns two booleans the code acts on —
`askedForHuman` and `optOut`. It gains a third: **did the lead attempt to convey
something at all**, as against reacting, greeting, thanking or checking in.

| Fact | Today | After |
|---|---|---|
| `askedForHuman` | boolean on the extraction JSON | unchanged |
| `optOut` | boolean on the extraction JSON | unchanged |
| *attempted an answer* | — | **new**, same call, same JSON, no extra round trip |

`notUnderstood` is then redefined:

| | Today | After |
|---|---|---|
| Condition | `!learnedSomething && dropped.length === 0 && plausiblyAnswers(text) && !cardsJustShown && !steering` | `!learnedSomething && dropped.length === 0 && attemptedAnswer && !steering` |

`plausiblyAnswers` and `cardsJustShown` both leave the expression.
`plausiblyAnswers` keeps its original job — deciding whether a recovery call is
worth making (FR-011) — which is the low bar it was written for. Reusing it to
decide "was this a misunderstanding" is the defect: its `NOISE` set holds 28
tokens, so *"nossa"*, *"isso"*, *"seria"* and *"tá"* all read as attempted
answers.

Three states, not two. A turn is a misunderstanding, or it **holds** the count, or
it **resets** it:

| Turn | Count |
|---|---|
| Learned something — filled, revised, or intent changed | **reset to 0** |
| Conversational — attempted nothing | **hold** |
| Extraction failed outright (`failed === true`) | **hold**, and the reply is technical, not an apology |
| Attempted something the system could not use | **advance**, and two in a row hand off |

**Ordering constraint.** `cardsJustShown` is today the only thing keeping a
reaction to a property out of the count. It may not be deleted until the new fact
is in place (FR-026).

## 3. The dependant table — the cascade

Decided by the developer on 2026-09-22. **Deliberately not in the spec**: this is
data, not a requirement. It lives here so it is not lost, and in code as one
declared constant so it can be changed without reading the orchestrator (FR-007).

| Revised | Restated for confirmation | Reasoning |
|---|---|---|
| `priceMax` | `bedrooms`, `neighborhoods` | budget moves, and size or area usually gives with it |
| `bedrooms` | `priceMax`, `urgency` | a different size implies a different budget, and often a different timeline |
| `neighborhoods` | `priceMax`, `bedrooms` | location is the strongest trigger; a new area reprices everything |
| `urgency` | *none* | a timeline change implies nothing about the criteria |
| `ticket` | `returnExpectation`, `urgency` | the investment mirror of a budget change |
| `returnExpectation` | `ticket` | a different goal implies a different amount |
| `investorProfile` | `ticket`, `returnExpectation` | experience changes what the investor is willing to do |
| `name`, `contact` | **never** | consent-gated; re-asking reads as a data grab |
| `intent` *(script change)* | `priceMax`, `urgency` | a budget stated for a purchase is not a monthly rent |

**Invariants the table must satisfy**, enforced by a test rather than by care:

- No entry lists `name` or `contact`.
- No entry lists the slot being revised.
- Every entry names at most three dependants.
- Every named slot is a real slot key.

**Resolution rules**, applied when building a reconfirmation:

- A dependant that is **not yet filled** is omitted (FR-010) — the restatement
  states facts, it does not fish for new ones.
- Slots orphaned by an intent change are **kept in storage** but never restated as
  current criteria (FR-005).
- Two slots revised in one turn produce **one** reconfirmation over the union of
  their dependants, still capped and still one question.

## 4. Facts derived from existing rows

Both are read through `services/`, never from memory held between turns (ADR 22).

| Fact | Derived from | Used by |
|---|---|---|
| *Was the previous agent turn a reconfirmation?* | the last agent `messages` row's metadata | FR-009 — never two in a row |
| *Is an offer to meet already outstanding?* | the `appointment.proposed` event, and the last agent message's metadata until spec 006 exists | FR-017 — offer once |

**A note on the second one.** Until 006, no `appointment.proposed` event is ever
written, because proposing is inert. Its stand-in is the agent message metadata
that already records a meeting was offered. The read is written so that 006
supplying real appointments requires no change here.

## 5. Events

`slot.filled` is emitted for revisions **exactly as it is for first fills** —
same type, same `{ slot, value }` payload, same key-aware PII masking. No new
event type and no `previous` field.

A revision is therefore distinguishable from a first fill only by comparing
against the previous event for that slot. That is accepted: no consumer needs the
distinction today, and the gap being closed is that a revision currently emits
**nothing**, leaving a changed criterion invisible to the summariser and to the
broker's timeline.

The event catalogue in `docs/arquitetura/modelo-de-dados.md` §4 gains no row. Its
`slot.filled` line should gain a parenthetical saying it covers revisions too.

## 6. Action step — in the trace only

One step of the loop: which action, the arguments it was called with, what it
returned, and its position in the turn. It is **not persisted** — it lives in the
span and in the existing `messages.metadata` tool-call record. Persisting a step
table would be a second source of truth for something the trace already answers,
with no consumer asking for it.

| Field | Meaning |
|---|---|
| `name` | the action called |
| `arguments` | what the model passed, after validation |
| `result` | what came back, including a refusal |
| `index` | position within the turn, from zero |

Bounded at **three** steps per turn. Reaching the bound stops tool offering and
proceeds to phrasing with what is held.
