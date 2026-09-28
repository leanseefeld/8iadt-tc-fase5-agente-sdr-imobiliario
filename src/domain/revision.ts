import {
  SCRIPT,
  SLOT_KEYS,
  isFilled,
  type Askable,
  type SlotKey,
  type Slots,
} from "./slots.ts";

/**
 * Which other criteria a change puts in doubt. One constant, read by everything,
 * written by nobody (FR-007). Values decided 2026-09-22.
 *
 * `name` and `contact` are present so every askable has an entry, and their
 * lists are empty: re-asking them reads as a data grab.
 */
export const DEPENDANTS: Readonly<Record<Askable, readonly SlotKey[]>> = {
  priceMax: ["bedrooms", "neighborhoods"],
  bedrooms: ["priceMax", "urgency"],
  neighborhoods: ["priceMax", "bedrooms"],
  urgency: [],
  ticket: ["returnExpectation", "urgency"],
  returnExpectation: ["ticket"],
  investorProfile: ["ticket", "returnExpectation"],
  name: [],
  contact: [],
  intent: ["priceMax", "urgency"],
};

/**
 * What a reconfirmation should restate. Empty when nothing qualifies.
 * Pure: no clock, no database, no configuration.
 */
export function reconfirmationFor(
  changed: { revised: SlotKey[]; intentChanged: boolean },
  slots: Slots,
): SlotKey[] {
  const wanted = new Set<SlotKey>();
  for (const slot of changed.revised) {
    for (const dependant of DEPENDANTS[slot]) wanted.add(dependant);
  }
  if (changed.intentChanged) {
    for (const dependant of DEPENDANTS.intent) wanted.add(dependant);
  }

  // Script order. Unfilled dependants are omitted — the restatement states
  // facts, it does not fish for new ones (FR-010).
  return SLOT_KEYS.filter((slot) => wanted.has(slot) && isFilled(slots, slot));
}

/**
 * Never two reconfirmations in a row (FR-009). The previous-turn fact is passed
 * in; this function does not look it up.
 */
export function reconfirmationKeys(
  changed: { revised: SlotKey[]; intentChanged: boolean },
  slots: Slots,
  previousWasReconfirmation: boolean,
): SlotKey[] {
  if (previousWasReconfirmation) return [];
  return reconfirmationFor(changed, slots);
}

/** Slots the current script does not use. Kept in storage, not current criteria. */
export function orphanedSlots(intent: keyof typeof SCRIPT, slots: Slots): SlotKey[] {
  const used = new Set<SlotKey>(SCRIPT[intent]);
  return SLOT_KEYS.filter((slot) => isFilled(slots, slot) && !used.has(slot));
}
