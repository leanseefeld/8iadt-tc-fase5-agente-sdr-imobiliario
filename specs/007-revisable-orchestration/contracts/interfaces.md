# Interface contracts — Revisable Orchestration

Signatures the implementation must honour. Shapes, not bodies. Anything not fixed
here is an implementation choice.

---

## 1. The merge, in `domain/slots.ts`

`MergeResult` gains one field. Nothing else in the module's surface changes.

```ts
export interface MergeResult {
  intent: Intent;
  slots: Slots;
  /** Slots that went empty → filled, in script order. */
  filled: SlotKey[];
  /** Slots that went value → different value, in script order. NEW. */
  revised: SlotKey[];
  /** The intent moved between two defined values. NEW. */
  intentChanged: boolean;
  /** Values refused. No longer includes an intent change. */
  dropped: string[];
}
```

Invariants, each of which is a test:

- A slot key appears in at most one of `filled`, `revised`, `dropped`.
- Re-supplying an identical value puts the slot in **none** of them.
- An empty value over a filled slot is still `dropped` — a slot never unfills.
- An unconsented contact slot is still `dropped`.

## 2. The cascade, in `domain/revision.ts` — pure, imports only its siblings

```ts
/** The declared table. One constant, read by everything, written by nobody. */
export const DEPENDANTS: Readonly<Record<Askable, readonly SlotKey[]>>;

/**
 * What a reconfirmation should restate, given what changed and what is known.
 * Returns [] when nothing qualifies — no dependants, or none of them filled.
 */
export function reconfirmationFor(
  changed: { revised: SlotKey[]; intentChanged: boolean },
  slots: Slots,
): SlotKey[];
```

`reconfirmationFor` is a pure function of its arguments — no clock, no database,
no configuration read. Two revisions in one turn yield the **union** of their
dependants, deduplicated, in script order, with unfilled dependants omitted.

## 3. The offer, in `domain/handoff.ts`

`shouldProposeMeeting` stops being a pure function of slot state alone. The fact
it was missing is passed in rather than looked up, so the function stays pure and
`domain/` keeps importing nothing.

```ts
export function shouldProposeMeeting(
  intent: Intent,
  slots: Slots,
  score: number,
  /** NEW — an offer is already outstanding for this conversation. */
  offerOutstanding: boolean,
): MeetingKind | null;
```

Returns `null` whenever `offerOutstanding` is true, before any other rule.

## 4. The action loop, in `agent/act.ts`

```ts
export interface ActInput {
  turn: LoadedTurn;
  briefing: string;
  /** The tools this turn may use. One entry, today. */
  tools: ToolSet;
}

export interface ActResult {
  steps: ActionStep[];
  /** True when the loop stopped at the bound rather than by the model finishing. */
  bounded: boolean;
  /** The loop never throws; a failure is a step with a failed result. */
  failed: boolean;
}

export const MAX_ACTION_STEPS = 3;
```

Rules:

- The loop **never throws**. A provider error, a timeout or a tool exception
  becomes a recorded step and a `failed` flag; the turn continues to phrasing.
- Reaching `MAX_ACTION_STEPS` stops tool offering. The turn phrases with what it
  holds (FR-012).
- The loop is **called conditionally**. A turn with no action worth considering
  does not make this call at all and costs what it costs today.
- Each step emits its span per the [observability contract](observability.md).

## 5. The action contract itself

Every tool offered to the model must satisfy all five, per FR-013a and the Gemma
playbook. This is a checklist the implementation is held to, not prose:

1. **Narrow schema.** Every argument has one meaning and no overlap with another.
2. **When to call**, stated in the description.
3. **When *not* to call**, stated in the description. Its absence is the
   playbook's first-named failure mode and is treated as a defect.
4. **Defined error handling.** Preconditions that do not hold return a refusal the
   model can read and act on — never an exception, never silence (FR-013b).
5. **Nothing security-bearing in the arguments.** Agency scope and the
   no-search-for-`investment` rule are built from turn context, never from what the
   model passes (FR-014).

```ts
/** What a refused action returns. Shaped so the model can act on it. */
export interface ToolRefusal {
  ok: false;
  reason: string;      // machine-readable, e.g. "criteriaUnchanged"
  message: string;     // one pt-BR sentence the model may paraphrase
}
```

## 6. Derived facts, in `services/conversation.ts`

Read through the service layer, never by `agent/` touching `db/`.

```ts
/** FR-009 — the previous agent turn was a reconfirmation. */
export function lastTurnWasReconfirmation(turn: LoadedTurn): boolean;

/** FR-017 — an offer to meet is already outstanding. */
export function offerOutstanding(turn: LoadedTurn): boolean;
```

Both are computed from rows the turn **already loads**. Neither adds a query: if
either would, the loader gains the column rather than the caller gaining a
round trip.

## 7. Unchanged, and deliberately so

- `domain/reply-guards.ts` — every guard, unchanged (FR-024).
- `agent/tools/scheduling.stub.ts` — inert, returns what it returns today (FR-015).
- The extraction call — still `generateText` with JSON in text, still hand-parsed,
  still no tools. Widening it is the reverted decision in commit `7f2ded0`.
- `TurnPromptInput`'s field list — the protected-state boundary. Adding a field
  that carries lead assessment to it violates FR-019.
