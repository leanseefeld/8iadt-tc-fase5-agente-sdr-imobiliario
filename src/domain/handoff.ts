import { isFilled, upcomingSlots, type Intent, type Slots } from "./slots.ts";
import { temperature } from "./score.ts";

/**
 * The two ways out of an agent-led conversation, and the one way forward.
 *
 * ADR 19 removed the third handoff trigger: a hot lead with a known contact is
 * *not* handed to a human. It is offered a meeting, and the agent stays in
 * command. Keeping both decisions in one file is what stops that distinction
 * eroding — you cannot add a trigger here without reading the other function.
 *
 * Pure; imports only its siblings in `domain/`.
 */

export const HANDOFF_REASONS = ["asked", "fallback"] as const;
export type HandoffReason = (typeof HANDOFF_REASONS)[number];

/** Two consecutive replies the agent could not understand (FR-027). */
export const FALLBACK_STREAK_LIMIT = 2;

export interface HandoffInput {
  /** The lead asked for a person, in words or by tool call. */
  leadAskedForHuman: boolean;
  /** Consecutive fallback replies, `conversations.fallbackStreak`. */
  fallbackStreak: number;
}

/**
 * `asked` outranks `fallback`: if the lead has just asked for a person, that is
 * the reason to record, whatever the streak says.
 */
export function handoffDecision(input: HandoffInput): HandoffReason | null {
  if (input.leadAskedForHuman) return "asked";
  if (input.fallbackStreak >= FALLBACK_STREAK_LIMIT) return "fallback";
  return null;
}

export type MeetingKind = "viewing" | "call";

/**
 * FR-040: `purchase`/`rental`, script finished, hot score and a known contact —
 * offer a viewing. FR-041: `investment` ends its script with a call with a
 * specialist, and never a property search, so no score gate applies there.
 *
 * `consented` is implicit: `contact` cannot be filled before consent (merge
 * rule 5), and the investment path needs the script finished, which includes it.
 */
export function shouldProposeMeeting(
  intent: Intent,
  slots: Slots,
  score: number,
): MeetingKind | null {
  if (intent === "undefined") return null;
  // The script is finished only when nothing is left to ask, contacts included.
  if (upcomingSlots({ intent, slots }, true).length > 0) return null;

  if (intent === "investment") return "call";
  if (temperature(score) === "hot" && isFilled(slots, "contact")) return "viewing";
  return null;
}
