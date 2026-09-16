import { isFilled, qualifyingSlots, type Intent, type Slots } from "./slots.ts";

/**
 * The lead score, recomputed from scratch every turn (FR-005).
 *
 * `modelo-de-dados.md` §3 and ADR 11 fix the weights. They are deliberately not
 * configurable: a tunable score would make the demonstration unreproducible.
 * Pure, and imports only its sibling in `domain/` (constitution III).
 */

const INTENT_IDENTIFIED = 10;
const QUALIFYING_SLOT = 15;
const CONTACT_KNOWN = 15;
const HIGH_COMMITMENT = 15;
const NEAR_TERM = 5;
const MAX_SCORE = 100;

/** The ticket above which a decided investor counts as high commitment. */
const HIGH_TICKET = 1_000_000;

export type Temperature = "cold" | "warm" | "hot";

export function scoreLead(intent: Intent, slots: Slots): number {
  let score = 0;

  if (intent !== "undefined") score += INTENT_IDENTIFIED;

  for (const key of qualifyingSlots(intent)) {
    if (isFilled(slots, key)) score += QUALIFYING_SLOT;
  }

  if (isFilled(slots, "contact")) score += CONTACT_KNOWN;

  // One row of the table, two ways to earn it: an immediate move, or an investor
  // who has decided what they want and is bringing a large ticket.
  const decidedLargeInvestor =
    slots.returnExpectation !== null &&
    slots.returnExpectation !== "undecided" &&
    slots.ticket !== null &&
    slots.ticket >= HIGH_TICKET;
  if (slots.urgency === "immediate" || decidedLargeInvestor) score += HIGH_COMMITMENT;

  if (slots.urgency === "soon") score += NEAR_TERM;

  return Math.min(score, MAX_SCORE);
}

/** `modelo-de-dados.md` §3: cold below 40, warm to 69, hot from 70. */
export function temperature(score: number): Temperature {
  if (score >= 70) return "hot";
  if (score >= 40) return "warm";
  return "cold";
}
