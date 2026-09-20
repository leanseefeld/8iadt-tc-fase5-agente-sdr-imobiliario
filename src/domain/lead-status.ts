/**
 * The pipeline stage a broker may set, and nothing else (FR-007, ADR 19 §7).
 *
 * One of the three independent axes: this one is the funnel. The conversation's
 * own state (`active · paused · closed` plus `heldByUserId`) and the follow-up
 * state live elsewhere and never move because this did.
 *
 * The agent owns `new → qualifying → qualified` and writes them inside its turn
 * (`services/conversation.commitTurn`). What this module governs is the broker's
 * half: the stages a person may set from the lead panel.
 *
 * Pure; imports nothing (constitution III).
 */

export const LEAD_STAGES = [
  "new",
  "qualifying",
  "qualified",
  "scheduled",
  "visited",
  "won",
  "lost",
] as const;

export type LeadStage = (typeof LEAD_STAGES)[number];

/** Where a stage sits on the funnel. `won`/`lost` are outcomes, not positions. */
const ORDER: Record<LeadStage, number> = {
  new: 0,
  qualifying: 1,
  qualified: 2,
  scheduled: 3,
  visited: 4,
  won: 5,
  lost: 5,
};

/** An outcome may be declared from anywhere: a lead is lost whenever it is lost. */
const OUTCOMES: readonly LeadStage[] = ["won", "lost"];

export function isLeadStage(value: string): value is LeadStage {
  return (LEAD_STAGES as readonly string[]).includes(value);
}

/**
 * Forward only, with two exceptions that are the point of the table rather than
 * holes in it: `won`/`lost` from any stage, because a broker learns the outcome
 * whenever they learn it; and staying put is not a transition, so the panel can
 * refuse a no-op with a sentence instead of writing a row that changes nothing.
 */
export function canTransition(from: LeadStage, to: LeadStage): boolean {
  if (from === to) return false;
  if (OUTCOMES.includes(from)) return false;
  if (OUTCOMES.includes(to)) return true;
  return ORDER[to] > ORDER[from];
}

/** The stages a panel may offer for a lead currently at `from`. */
export function allowedTransitions(from: LeadStage): LeadStage[] {
  return LEAD_STAGES.filter((stage) => canTransition(from, stage));
}

export class IllegalLeadTransition extends Error {
  readonly from: LeadStage;
  readonly to: LeadStage;

  constructor(from: LeadStage, to: LeadStage) {
    super(`illegal lead stage transition: ${from} -> ${to}`);
    this.name = "IllegalLeadTransition";
    this.from = from;
    this.to = to;
  }
}

/**
 * Throws rather than returning false, because a caller that reached this point
 * has already decided to write. The service turns it into the panel's pt-BR
 * message; nothing swallows it.
 */
export function assertTransition(from: LeadStage, to: LeadStage): void {
  if (!canTransition(from, to)) throw new IllegalLeadTransition(from, to);
}
