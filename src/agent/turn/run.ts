import { getConfig } from "../../core/config.ts";
import { createLogger } from "../../core/logging.ts";
import { handoffDecision, shouldProposeMeeting } from "../../domain/handoff.ts";
import { looksLikeInjection, looksLikeSteering } from "../../domain/injection.ts";
import { isQualified, nextQuestion, qualifyingSlots, upcomingSlots } from "../../domain/slots.ts";
import {
  lastOfferedOptions,
  lastReschedulingId,
  lastTurnWasReconfirmation,
  latestInterestedProperty,
  offerOutstanding,
  pendingChange,
  resolvePropertyRef,
  type CommittedToolCall,
  type LoadedTurn,
} from "../../services/conversation.ts";
import { listUpcomingMeetings } from "../../services/scheduling.ts";
import {
  CANNOT_ACT_REPLY,
  EXTRACTION_FAILURE_REPLY,
  OPT_OUT_REPLY,
  handoffReply,
  refusalReply,
} from "../prompts/fallback.ts";
import { accountTurn } from "./accounting.ts";
import { applyActionOutcomes, runActions, type ActionPlan } from "./actions.ts";
import { classify } from "./classify.ts";
import { decideEnding } from "./ending.ts";
import { extract } from "./extract.ts";
import { finish, type TurnBase } from "./finish.ts";
import { learn } from "./learn.ts";
import { draftMeetingReply } from "./meeting-reply.ts";
import { unansweredText } from "./messages.ts";
import { readTurn } from "./read.ts";
import { speak } from "./speak.ts";
import type { RunContext, TurnResult } from "./types.ts";

/**
 * One turn, as a pipeline of nodes. Each takes typed input and returns typed
 * output; only `extract`, `act` and `phrase` call the model, and only the code
 * decides (constitution V):
 *
 *   extract   the model reads the message                (extract.ts)
 *   read      code settles what it says                  (read.ts)
 *   learn     slots merged, the pending slot recovered   (learn.ts)
 *   classify  what the lead is doing about meetings      (classify.ts)
 *   account   the misunderstanding streak, the handoff   (accounting.ts)
 *   draft     the meeting reply the code writes          (meeting-reply.ts)
 *   act       the model calls the tools the code offers  (actions.ts)
 *   end       the offer to check with the team, or a close (ending.ts)
 *   speak     the model phrases what was decided         (speak.ts)
 *
 * The order is the precedence: a step that answers the lead ends the turn,
 * and a later step only runs when nothing before it did.
 */

const log = createLogger("app", { module: "agent/turn/run" });

export async function run(turn: LoadedTurn, context: RunContext): Promise<TurnResult> {
  const consented = turn.lead.consentAt !== null;
  const before = { intent: turn.lead.intent, slots: turn.conversation.slots };
  const pending = nextQuestion(before, consented);
  const leadText = unansweredText(turn);
  const timezone = getConfig().FOLLOWUP_TIMEZONE;
  const unchanged: TurnBase = {
    turn,
    context,
    intent: before.intent,
    slots: before.slots,
    filled: [],
    revised: [],
    score: turn.lead.score,
    qualified: isQualified(before.intent, before.slots),
    fallbackStreak: turn.conversation.fallbackStreak,
  };

  // Layer 2 of `visao-geral.md` §9: the phrasings that are never anything but
  // an override attempt get the written refusal and the script's own question,
  // with no token spent and no slot moved (FR-030). Understood, so the streak holds.
  if (looksLikeInjection(leadText)) {
    log.info({ conversationId: turn.conversation.id }, "input layer refused an override attempt");
    return finish({
      ...unchanged,
      reply: refusalReply(pending),
      speak: true,
      question: pending,
      guard: "injectionInput",
      outcome: "replied",
    });
  }

  // extract — FR-003c: when the provider never answered, hold the streak and
  // say so, rather than ask the model to apologise for a message it never read.
  const extraction = await extract(turn, pending?.slot ?? null);
  const toolCalls: CommittedToolCall[] = [...extraction.calls];
  if (extraction.failed) {
    const held = accountTurn(turn.conversation.fallbackStreak, {
      learnedSomething: false,
      extractionFailed: true,
      attemptedAnswer: false,
      droppedCount: 0,
      steering: false,
    });
    return finish({
      ...unchanged,
      fallbackStreak: held.fallbackStreak,
      reply: EXTRACTION_FAILURE_REPLY,
      speak: true,
      question: pending,
      toolCalls,
      outcome: "replied",
    });
  }

  // read + learn
  const waiting = pendingChange(turn);
  const reading = readTurn(extraction, {
    text: leadText,
    now: new Date(),
    timeZone: timezone,
    optionsOnTable: lastOfferedOptions(turn).length > 0,
    yesNoPending: waiting.pendingCancel !== undefined || waiting.rebook !== undefined || waiting.humanOffer !== undefined,
  });
  const learned = await learn({ extraction, reading, before, pending, consented, leadText });
  toolCalls.push(...learned.calls);
  const { intent, slots, score, qualified } = learned;

  // FR-029: someone who asked to be left alone is not qualified further, not
  // phrased at and not asked one more question.
  if (reading.optedOut) {
    return finish({
      ...unchanged,
      intent,
      slots,
      score,
      qualified,
      fallbackStreak: 0,
      reply: OPT_OUT_REPLY,
      speak: true,
      question: null,
      optedOut: true,
      toolCalls,
      outcome: "opted_out",
    });
  }

  // classify — the facts, against what is open now.
  const booked = await listUpcomingMeetings(turn.lead.id);
  const reschedulingId = lastReschedulingId(turn);
  const facts = reading.facts;
  // FR-004b: only a property already shown here; anything else is ignored.
  const interest = facts.propertyRef === null ? null : await resolvePropertyRef(turn, facts.propertyRef);
  const scriptComplete = shouldProposeMeeting(intent, slots, score, false) !== null;
  const situation = classify({
    reading,
    waiting,
    proposalOpen: turn.proposalOpen,
    booked,
    reschedulingId,
    interest,
    leadText,
    timeZone: timezone,
    scriptComplete,
  });

  // account — a misunderstanding is an attempt the system could not use
  // (FR-003a). The re-entry line is posted on handback, but a turn right after
  // one still greets rather than apologises (FR-022).
  const lastHandover = turn.handovers.at(-1);
  const justReturned =
    lastHandover !== undefined &&
    lastHandover.kind === "returned" &&
    !turn.history.some((message) => message.role === "agent" && message.createdAt > lastHandover.at);
  // An override attempt learns nothing on purpose; it is recorded as a guard.
  const steering = looksLikeSteering(leadText);
  const accounted = accountTurn(turn.conversation.fallbackStreak, {
    learnedSomething: learned.learnedSomething,
    extractionFailed: false,
    attemptedAnswer: reading.attemptedAnswer,
    droppedCount: extraction.dropped.length,
    steering,
    confirming: (lastTurnWasReconfirmation(turn) && !learned.learnedSomething) || justReturned,
    askedAboutCriteria: reading.askedAboutCriteria,
    acted: situation.acted,
    refused: situation.refused,
  });
  const handoffReason = handoffDecision({
    leadAskedForHuman: (reading.leadAskedForHuman && !situation.aboutTheMeeting) || situation.offerTaken === "handoff",
    fallbackStreak: accounted.fallbackStreak,
  });
  const base: TurnBase = {
    ...unchanged,
    intent,
    slots,
    filled: learned.filled,
    revised: learned.revised,
    score,
    qualified,
    fallbackStreak: accounted.fallbackStreak,
  };

  // draft — the meeting reply the code writes, if any.
  const property = interest ?? latestInterestedProperty(turn);
  const drafted = await draftMeetingReply({
    turn,
    situation,
    facts,
    answer: reading.answer,
    waiting,
    booked,
    reschedulingId,
    interest,
    property,
    intent,
    slots,
    score,
    scriptComplete,
    handingOff: handoffReason !== null,
    timezone,
  });
  toolCalls.push(...drafted.calls);
  let draft = drafted.draft;
  const question = draft.written !== null || handoffReason !== null ? null : nextQuestion({ intent, slots }, consented);

  // act — the tools the code offers, when one is due and nothing answered yet.
  const free = handoffReason === null && draft.written === null;
  const plan: ActionPlan = {
    searchDue:
      free && qualified && [...learned.filled, ...learned.revised].some((slot) => qualifyingSlots(intent).includes(slot)),
    bookingDue: free && situation.picking,
    rescheduleTarget: free ? draft.rescheduleTarget : null,
  };
  const results = await runActions({ turn, plan, intent, slots, leadText, timezone });
  toolCalls.push(...results.calls);

  // FR-028: a handoff is terminal for the agent, so it is written, not phrased:
  // the conversation pauses the moment this commits. A question the agent
  // cannot act on is not handed off as if it had not been understood (FR-023).
  if (handoffReason !== null) {
    return finish({
      ...base,
      reply:
        handoffReason === "fallback" && (situation.refused || leadText.includes("?"))
          ? `${CANNOT_ACT_REPLY} Vou chamar um corretor para assumir daqui.`
          : handoffReply(handoffReason),
      speak: true,
      question: null,
      handoffReason,
      toolCalls,
      outcome: "handoff",
    });
  }

  const outcomes = await applyActionOutcomes(draft, {
    turn,
    plan,
    results,
    facts,
    booked,
    property,
    intent,
    timezone,
  });
  toolCalls.push(...outcomes.calls);
  draft = outcomes.draft;

  // end — the offer to check with the team, or a close.
  const ending = decideEnding({
    reading,
    situation,
    written: draft.written !== null,
    searchDue: plan.searchDue,
    searched: results.search.searched,
    question,
    filled: learned.filled,
    revised: learned.revised,
    learnedSomething: learned.learnedSomething,
    proposalOpen: turn.proposalOpen,
    booked,
    offerOutstanding: offerOutstanding(turn),
    closedBefore: waiting.closing === true,
    leadText,
    timezone,
  });
  draft = { ...draft, scheduling: { ...draft.scheduling, ...ending.scheduling } };

  if (draft.written !== null) {
    return finish({
      ...base,
      reply: draft.prefix === undefined ? draft.written : `${draft.prefix} ${draft.written}`,
      speak: true,
      question: null,
      meeting: draft.offeredType,
      scheduling: draft.scheduling,
      toolCalls,
      propertyIds: results.search.properties.map((found) => found.id),
      propertyCodes: results.search.properties.map((found) => found.code),
      outcome: draft.offeredType !== null ? "meeting_proposed" : accounted.notUnderstood ? "fallback" : "replied",
    });
  }

  return speak({
    base,
    leadText,
    consented,
    question,
    upcoming: upcomingSlots({ intent, slots }, consented),
    reading,
    situation,
    intentChanged: learned.intentChanged,
    notUnderstood: accounted.notUnderstood,
    handoffReason,
    waiting,
    draft,
    ending,
    search: results.search,
    booked,
    timezone,
    steering,
    toolCalls,
  });
}
