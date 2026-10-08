import type { HandoffReason } from "../../domain/handoff.ts";
import { figuresIn } from "../../domain/reply-guards.ts";
import { reconfirmationKeys } from "../../domain/revision.ts";
import { CONTACT_SLOTS, type Askable, type Question } from "../../domain/slots.ts";
import {
  lastSearchOutcome,
  lastTurnWasReconfirmation,
  type CommittedToolCall,
  type PendingChange,
} from "../../services/conversation.ts";
import type { UpcomingMeeting } from "../../services/scheduling.ts";
import { CANNOT_ACT_REPLY, SUGGESTION_REPLY, noMatchReply } from "../prompts/fallback.ts";
import {
  BOUNDARY_FALLBACK_SENTENCE,
  BOUNDARY_OFFER_QUESTION,
  DETAILS_FIRST_SENTENCE,
  closingSentence,
  describeMeeting,
} from "../prompts/meeting.ts";
import { reconfirmationSentence } from "../prompts/reconfirm.ts";
import { chooseTask, turnBriefing, type TurnPromptInput } from "../prompts/system.ts";
import type { SearchOutcome } from "../tools/index.ts";
import type { Situation } from "./classify.ts";
import type { Ending } from "./ending.ts";
import { finish, type TurnBase } from "./finish.ts";
import type { Draft } from "./meeting-reply.ts";
import { phrase } from "./phrase.ts";
import type { Reading } from "./read.ts";
import type { TurnResult } from "./types.ts";

/**
 * A turn the model phrases: everything decided is handed over as the briefing
 * — the state, the one task, the caveats — and the reply streams through the
 * guards. The words are the model's; what they may say is not.
 */

export interface SpeakInput {
  base: TurnBase;
  leadText: string;
  consented: boolean;
  /** The script's next question. The offer and the close make it wait a turn. */
  question: Question | null;
  /** The script's slots still to ask, in order. */
  upcoming: Askable[];
  reading: Reading;
  situation: Situation;
  intentChanged: boolean;
  notUnderstood: boolean;
  handoffReason: HandoffReason | null;
  waiting: PendingChange;
  draft: Draft;
  ending: Ending;
  search: SearchOutcome;
  booked: UpcomingMeeting[];
  timezone: string;
  /** An override attempt the structural layer absorbed (recorded as a guard). */
  steering: boolean;
  toolCalls: CommittedToolCall[];
}

export async function speak(input: SpeakInput): Promise<TurnResult> {
  const { base, search, draft, ending, reading, situation, timezone } = input;
  const { turn, slots, intent } = base;
  const propertyIds = search.properties.map((property) => property.id);
  const propertyCodes = search.properties.map((property) => property.code);

  // The allowed figures include the whole history, so a number a broker typed
  // is a number the agent may repeat — which is what makes "como a Ana te
  // falou, R$ 900.000" survive the `unbackedFigure` guard.
  const figures = figuresIn(`${input.leadText} ${turn.history.map((m) => m.content).join(" ")}`);

  // Who, if anyone, has spoken here besides the agent and the lead — and
  // whether this is the first turn since they handed it back. "First turn back"
  // is "no agent message after the return": the rows already say it.
  const lastHandover = turn.handovers.at(-1);
  const brokerContext =
    lastHandover === undefined
      ? undefined
      : {
          name: lastHandover.name,
          justReturned:
            lastHandover.kind === "returned" &&
            !turn.history.some((message) => message.role === "agent" && message.createdAt > lastHandover.at),
        };

  // A search result is the answer to the revision (FR-032), and a decline
  // speaks for itself: neither is followed by "continua assim?". Not computing
  // it here also keeps the turn from being recorded as a reconfirmation it never
  // made, which FR-009's derived fact depends on.
  const reconfirmKeys =
    search.searched || situation.declining
      ? []
      : reconfirmationKeys(
          { revised: base.revised ?? [], intentChanged: input.intentChanged },
          slots,
          lastTurnWasReconfirmation(turn),
        );
  // What changed comes first, then what it puts in doubt (US4's own example).
  // The sentence is said verbatim. Contact slots never appear in a restatement.
  const reconfirmText =
    reconfirmKeys.length === 0
      ? null
      : reconfirmationSentence(slots, [
          ...(base.revised ?? []).filter(
            (slot) => !(CONTACT_SLOTS as readonly string[]).includes(slot) && !reconfirmKeys.includes(slot),
          ),
          ...reconfirmKeys,
        ]);
  // FR-033: what the last search found, for a turn that did not search.
  const lastSearch = search.searched ? null : lastSearchOutcome(turn, intent);

  // A question this agent cannot act on yet still counts toward a handoff,
  // and the reply says so instead of claiming the message was not understood.
  if (input.notUnderstood && input.leadText.includes("?") && reconfirmText === null) {
    return finish({
      ...base,
      reply: CANNOT_ACT_REPLY,
      speak: true,
      question: null,
      handoffReason: input.handoffReason,
      meeting: null,
      toolCalls: input.toolCalls,
      propertyIds,
      propertyCodes,
      outcome: input.handoffReason !== null ? "handoff" : "fallback",
    });
  }

  // The offer and the close are the turn's whole job: the script's question
  // waits for the next turn (one question per message).
  const asking = ending.teamOffer !== null || ending.closing !== null ? null : input.question;
  const briefing: TurnPromptInput = {
    intent,
    slots,
    filled: [...base.filled, ...(base.revised ?? [])],
    question: asking,
    consented: input.consented,
    ...(ending.teamOffer === null ? {} : { boundary: ending.teamOffer }),
    ...(ending.closing === null ? {} : { closing: ending.closing }),
    ...(input.booked.length === 0
      ? {}
      : { booked: input.booked.map((meeting) => describeMeeting(meeting, timezone)) }),
    ...(situation.askingAboutMeetings ? { askedAboutMeetings: true } : {}),
    meeting: null,
    notUnderstood: input.notUnderstood,
    ...(situation.declining ? { declinedOffer: true } : {}),
    // A close answering a close is a goodbye, not a return ("Oi de novo!").
    ...(input.waiting.closing === true && ending.closing === null ? { returning: true } : {}),
    ...(draft.prefix === DETAILS_FIRST_SENTENCE ? { detailsFirst: true } : {}),
    ...(reading.askedAboutCriteria ? { askedAboutCriteria: true } : {}),
    ...(reconfirmText === null ? {} : { reconfirmation: reconfirmText }),
    ...(brokerContext === undefined ? {} : { broker: brokerContext }),
    ...(search.searched
      ? { suggestions: { count: search.properties.length, relaxable: search.relaxable } }
      : lastSearch === null
        ? {}
        : { lastSearch }),
  };
  // The task decides whether a question may be asked at all.
  const taskId = chooseTask(briefing).id;
  const phrased = await phrase({
    turn,
    briefing: turnBriefing(briefing),
    noQuestions: taskId === "nothingToAsk" || taskId === "closing" || taskId === "meetings.status",
    question: asking,
    // On a search turn the script's question waits for the next one, but the
    // guard still has to tolerate a sentence that previews it.
    pendingSlot: search.searched ? (input.upcoming[0] ?? null) : (asking?.slot ?? null),
    nextSlot: input.upcoming[1] ?? null,
    allowedAmounts: [
      ...figures.amounts,
      ...(slots.priceMax === null ? [] : [slots.priceMax]),
      ...(slots.ticket === null ? [] : [slots.ticket]),
      // FR-012: "what a search returned, plus what the lead wrote" — the
      // prices on the cards themselves.
      ...search.properties.map((property) => property.price),
    ],
    allowedPercentages: figures.percentages,
    ...fallbackFor({ search, reconfirmText, ending, booked: input.booked, leadText: input.leadText, timezone }),
    ...(draft.prefix === undefined ? {} : { prefix: draft.prefix }),
    ...(ending.teamOffer === null ? {} : { mustAsk: BOUNDARY_OFFER_QUESTION }),
    sink: base.context.sink,
    startedAt: base.context.startedAt,
  });

  // Which defence answered this turn, for the record (`visao-geral.md` §9): an
  // output guard names itself, and a steering attempt the structural layer
  // simply absorbed is recorded as such, or SC-007 would have nothing to read.
  return finish({
    ...base,
    reply: phrased.chunks.join(" ").trim(),
    question: input.question,
    guard: phrased.guard ?? (input.steering ? "steering" : null),
    handoffReason: input.handoffReason,
    meeting: null,
    reconfirmation: reconfirmText !== null,
    scheduling: draft.scheduling,
    toolCalls: input.toolCalls,
    propertyIds,
    propertyCodes,
    outcome: input.notUnderstood ? "fallback" : "replied",
  });
}

/**
 * What goes out when a guard throws the whole reply away, in FR-032's order:
 * the search first, then the reconfirmation, the offer, the close. Otherwise
 * `phrase()` falls back to the script's question.
 */
function fallbackFor(input: {
  search: SearchOutcome;
  reconfirmText: string | null;
  ending: Ending;
  booked: UpcomingMeeting[];
  leadText: string;
  timezone: string;
}): { fallbackText?: string } {
  const { search, ending } = input;
  if (search.searched) {
    return { fallbackText: search.properties.length > 0 ? SUGGESTION_REPLY : noMatchReply(search.relaxable) };
  }
  if (input.reconfirmText !== null) return { fallbackText: input.reconfirmText };
  if (ending.teamOffer !== null) return { fallbackText: BOUNDARY_FALLBACK_SENTENCE };
  if (ending.closing !== null) {
    const meetings = ending.closing.summary === null ? [] : input.booked;
    return { fallbackText: closingSentence(meetings, input.leadText, input.timezone) };
  }
  return {};
}
