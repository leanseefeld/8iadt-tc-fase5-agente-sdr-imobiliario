import { scoreLead } from "../../domain/score.ts";
import {
  isQualified,
  mergeSlots,
  partitionSlotChanges,
  type Intent,
  type QualificationState,
  type Question,
  type SlotKey,
  type Slots,
} from "../../domain/slots.ts";
import type { CommittedToolCall } from "../../services/conversation.ts";
import { recoverSlot } from "../recovery.ts";
import { normalizeExtraction } from "../tools/update-slots.ts";
import { shouldRecover } from "./accounting.ts";
import type { Extraction } from "./extract.ts";
import type { Reading } from "./read.ts";

/**
 * What the turn learned about the lead: the extraction merged into the
 * qualification state in code (constitution V), plus one narrow second reading
 * of the pending slot when the first came back empty-handed (FR-011).
 */

export interface Learned {
  intent: Intent;
  slots: Slots;
  /** Slots that went empty → value this turn. */
  filled: SlotKey[];
  /** Slots that went value → a different value this turn. */
  revised: SlotKey[];
  /** A known purpose replaced by another (a first identification is not this). */
  intentChanged: boolean;
  learnedSomething: boolean;
  score: number;
  qualified: boolean;
  /** The recovery call, when one ran, for the transcript and the trace. */
  calls: CommittedToolCall[];
}

export async function learn(input: {
  extraction: Extraction;
  reading: Reading;
  before: QualificationState;
  pending: Question | null;
  consented: boolean;
  leadText: string;
}): Promise<Learned> {
  const { extraction, before, pending, consented, leadText } = input;
  const calls: CommittedToolCall[] = [];

  let merged = mergeSlots(before, {}, { consented });
  for (const call of extraction.calls) {
    if (call.name !== "updateSlots") continue;
    merged = mergeSlots(merged, normalizeExtraction(call.arguments), { consented });
  }

  const stillPending =
    pending !== null &&
    (pending.slot === "intent" ? merged.intent === "undefined" : merged.slots[pending.slot] === null);

  // Recovery runs only when the extraction itself came back empty-handed, not
  // merely when the pending slot is still empty. A lead answering the
  // *previous* question again — "Tenho preferência por Moema ou Vila Mariana"
  // while the script is on `urgency` — produced a good `neighborhoods`
  // extraction that merge rule 1 dropped as already filled, and recovery then
  // guessed `urgency: exploring` out of a sentence about bairros. `intent` is
  // the exception: every first message implies one. And an explicit "attempted
  // nothing" ends it ("opa, tá aí?" once became the name "Opa", US1 scenario 6).
  // A slot the lead never spoke about is worse than a question asked once more.
  const recoveryDue = shouldRecover({
    stillPending,
    pendingIsIntent: pending?.slot === "intent",
    saidSomething: extraction.saidSomething,
    attemptedAnswer: input.reading.attemptedAnswer,
    leadText,
  });
  if (recoveryDue && pending !== null) {
    const recovered = await recoverSlot({ slot: pending.slot, text: leadText });
    if (Object.keys(recovered).length > 0) {
      calls.push({ name: "recoverSlot", arguments: recovered });
      merged = mergeSlots(merged, recovered, { consented });
    }
  }

  const { intent, slots } = merged;
  const { filled, revised } = partitionSlotChanges(before.slots, slots);
  const intentChanged = before.intent !== "undefined" && intent !== before.intent;
  return {
    intent,
    slots,
    filled,
    revised,
    intentChanged,
    // A first identification is not `intentChanged`, but it is still something learned.
    learnedSomething: filled.length > 0 || revised.length > 0 || intentChanged || intent !== before.intent,
    score: scoreLead(intent, slots),
    qualified: isQualified(intent, slots),
    calls,
  };
}
