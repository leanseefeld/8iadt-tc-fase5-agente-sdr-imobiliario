import { plausiblyAnswers } from "../recovery.ts";

/**
 * How a turn counts: which kind of reply wins (FR-005g), whether a second
 * reading of the pending slot is worth a call (FR-011), and the
 * misunderstanding streak (FR-003). Pure, so each is a table of cases.
 */

export type ReplyKind = "confirmation" | "options" | "search" | "criteria" | "reconfirmation" | "question";

/**
 * FR-005g: when several kinds of reply apply to one turn, exactly one decides
 * what the reply says — what the lead most needs to know first. `options` also
 * covers an answer that there are no times, which answers the same request. A
 * decline acknowledgement is not here: it is a prefix, not a competitor.
 */
export function replyKind(turn: {
  booked: boolean;
  options: boolean;
  searched: boolean;
  askedAboutCriteria: boolean;
  reconfirmation: boolean;
}): ReplyKind {
  if (turn.booked) return "confirmation";
  if (turn.options) return "options";
  if (turn.searched) return "search";
  if (turn.askedAboutCriteria) return "criteria";
  if (turn.reconfirmation) return "reconfirmation";
  return "question";
}

/** When a second, narrow extraction call is worth making for the pending slot. */
export function shouldRecover(input: {
  stillPending: boolean;
  pendingIsIntent: boolean;
  saidSomething: boolean;
  attemptedAnswer: boolean;
  leadText: string;
}): boolean {
  return (
    input.stillPending &&
    input.attemptedAnswer &&
    (input.pendingIsIntent || !input.saidSomething) &&
    plausiblyAnswers(input.leadText)
  );
}

/**
 * The three-state streak (FR-003, FR-003d). Learning resets it. A conversational
 * turn and a failed extraction hold it. An attempt the system could not use
 * advances it. A dropped slot also holds, because it was understood.
 */
export function accountTurn(
  currentStreak: number,
  turn: {
    learnedSomething: boolean;
    extractionFailed: boolean;
    attemptedAnswer: boolean;
    droppedCount: number;
    /** A plain "yes" to the previous reconfirmation. Not a turn that learned nothing. */
    confirming?: boolean;
    /** Asked what the current criteria are. Not a misunderstanding (FR-018). */
    askedAboutCriteria?: boolean;
    /**
     * Spec 006: the lead acted on a meeting — declined it, asked for times,
     * picked one, or pointed at a property. Understood and acted on, so it resets
     * the count like learning a slot does.
     */
    acted?: boolean;
    /**
     * Spec 006 FR-005h/i: the lead asked for something the agency doesn't do.
     * Understood, and still a request the agent can't act on — the streak
     * advances, so a second one in a row hands off.
     */
    refused?: boolean;
    /**
     * Ignored. It used to keep a steering attempt off the streak. That shield
     * is gone (FR-026); the call site still records the attempt as a guard.
     */
    steering?: boolean;
  },
): { notUnderstood: boolean; fallbackStreak: number } {
  // The steering shield is gone. Callers still pass the flag so the call site
  // shows the attempt was recognised; the count does not read it.
  void turn.steering;
  if (turn.refused === true) return { notUnderstood: true, fallbackStreak: currentStreak + 1 };
  if (turn.learnedSomething || turn.acted === true) return { notUnderstood: false, fallbackStreak: 0 };
  // A failed extraction is not consulted for `attemptedAnswer` (FR-003c).
  // A confirmation, or a question about the current criteria, holds the count.
  if (
    turn.extractionFailed ||
    !turn.attemptedAnswer ||
    turn.confirming === true ||
    turn.askedAboutCriteria === true
  ) {
    return { notUnderstood: false, fallbackStreak: currentStreak };
  }
  const notUnderstood = turn.droppedCount === 0;
  return {
    notUnderstood,
    fallbackStreak: notUnderstood ? currentStreak + 1 : currentStreak,
  };
}
