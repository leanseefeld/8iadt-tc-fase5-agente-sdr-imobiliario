import { shouldProposeMeeting } from "../../domain/handoff.ts";
import type { MeetingType } from "../../domain/scheduling.ts";
import type { Intent, Slots } from "../../domain/slots.ts";
import {
  lastOfferedOptions,
  lastOfferedType,
  offerOutstanding,
  type CommittedToolCall,
  type LoadedTurn,
  type PendingChange,
  type SchedulingRecord,
} from "../../services/conversation.ts";
import { declineProposal, hasConfirmedFutureAppointment, type UpcomingMeeting } from "../../services/scheduling.ts";
import { CANNOT_ACT_REPLY } from "../prompts/fallback.ts";
import {
  ATTENDEE_UNKNOWN_SENTENCE,
  DECLINE_ACKNOWLEDGEMENT,
  DETAILS_FIRST_SENTENCE,
  MEETING_LIMIT_SENTENCE,
  NO_MEETING_TO_CHANGE_SENTENCE,
  NO_PROPERTY_YET_SENTENCE,
  PHONE_OFFER_SENTENCE,
  VISIT_NEEDS_PROPERTY_SENTENCE,
} from "../prompts/meeting.ts";
import { decideChange } from "./change.ts";
import type { Situation } from "./classify.ts";
import { meetingTarget, offerTimes } from "./offer-times.ts";
import type { SchedulingFacts } from "./read.ts";

/**
 * The meeting reply, all decided in code (spec 006 FR-005g, spec 009). A
 * code-written reply — options, no options, a confirmation question, a
 * refusal — wins the turn outright. A decline or "details first" only prefixes
 * whatever else wins. What it sets up for the action step (a meeting to move)
 * travels in the draft too.
 */

export interface Draft {
  /** A reply the code wrote, said verbatim. `null`: the model phrases the turn. */
  written: string | null;
  /** A code-written sentence sent before whatever wins the turn. */
  prefix?: string;
  /** What this reply records on its message's metadata (ADR 22). */
  scheduling: SchedulingRecord;
  /** The meeting kind this reply offered, when it offered one. */
  offeredType: MeetingType | null;
  /** Spec 009: a meeting the action step may move to a time the lead named. */
  rescheduleTarget: { appointmentId: string; offered: Date[] } | null;
}

export interface MeetingReplyInput {
  turn: LoadedTurn;
  situation: Situation;
  facts: SchedulingFacts;
  answer: "yes" | "no" | null;
  waiting: PendingChange;
  booked: UpcomingMeeting[];
  reschedulingId: string | null;
  interest: { id: string; code: string } | null;
  /** The property in play: this turn's interest, else the latest one. */
  property: { id: string; code: string } | null;
  intent: Intent;
  slots: Slots;
  score: number;
  /** FR-005b: the script is complete enough to offer a meeting. */
  scriptComplete: boolean;
  /** A handoff wins the turn: nothing about meetings is written. */
  handingOff: boolean;
  timezone: string;
}

export async function draftMeetingReply(
  input: MeetingReplyInput,
): Promise<{ draft: Draft; calls: CommittedToolCall[] }> {
  const { turn, situation, facts, booked, property, intent, timezone } = input;
  const proposalOpen = turn.proposalOpen;
  const calls: CommittedToolCall[] = [];
  const draft: Draft = {
    written: null,
    scheduling: input.interest === null ? {} : { interestedProperty: input.interest },
    offeredType: null,
    rescheduleTarget: situation.movingPick
      ? { appointmentId: input.reschedulingId as string, offered: lastOfferedOptions(turn) }
      : null,
  };
  if (input.handingOff) return { draft, calls };

  if (situation.refused) {
    // FR-005h: after a format we don't offer, the phone — unless a call is booked.
    const callBooked =
      situation.refusingFormat && (await hasConfirmedFutureAppointment(turn.lead.id, new Date(), undefined, "call"));
    draft.written =
      situation.refusingFormat && !callBooked ? `${CANNOT_ACT_REPLY} ${PHONE_OFFER_SENTENCE}` : CANNOT_ACT_REPLY;
  } else if (situation.askingWhoAttends) {
    draft.written = ATTENDEE_UNKNOWN_SENTENCE;
    // The sentence offers to call a broker: a yes hands off, like 015's offer.
    draft.scheduling = { ...draft.scheduling, humanOffer: { about: "quem vai atender" } };
  } else if (situation.askingAboutMeetings && booked.length === 0) {
    draft.written = NO_MEETING_TO_CHANGE_SENTENCE;
  } else if (situation.changing && !situation.movingPick) {
    const fixedMeeting = situation.narrowingMove
      ? (booked.find((meeting) => meeting.id === input.reschedulingId) ?? null)
      : null;
    const change = await decideChange({
      turn,
      facts: { ...facts, answer: input.answer },
      upcoming: booked,
      waiting: input.waiting,
      confirmingCancel: situation.confirmingCancel,
      answeringWhich: situation.answeringWhich,
      rebooking: situation.rebooking,
      changeAsked: situation.narrowingMove ? "reschedule" : situation.changeAsked,
      answeredMeeting: situation.answeredMeeting,
      fixedMeeting,
      timezone,
    });
    draft.written = change.written === "" ? null : change.written;
    if (change.scheduling !== undefined) draft.scheduling = { ...draft.scheduling, ...change.scheduling };
    if (change.offeredType !== undefined) draft.offeredType = change.offeredType;
    if (change.call !== undefined) calls.push(change.call);
    draft.rescheduleTarget = change.rescheduleTarget ?? null;
  } else if (situation.declining) {
    await declineProposal(turn.conversation.id);
    draft.scheduling = { ...draft.scheduling, declined: true };
    draft.prefix = DECLINE_ACKNOWLEDGEMENT;
  } else if (situation.wantsOffer && !input.scriptComplete) {
    // Said once. The extraction keeps reading the earlier request into the next
    // answers ("até 800 mil" after "quero marcar"), and a repeated promise reads
    // as not listening. FR-004d: an interest alone asked for no times, so it
    // gets no promise of them — the reply acknowledges it and the script goes on.
    const lastAgent = [...turn.history].reverse().find((message) => message.role === "agent");
    if (
      (facts.askedForTimes || facts.meetingKind !== null) &&
      lastAgent?.content.startsWith(DETAILS_FIRST_SENTENCE) !== true
    ) {
      draft.prefix = DETAILS_FIRST_SENTENCE;
    }
  } else if (situation.wantsOffer && situation.atLimit) {
    draft.written = MEETING_LIMIT_SENTENCE;
  } else if (
    situation.wantsOffer ||
    (!proposalOpen &&
      booked.length === 0 &&
      shouldProposeMeeting(intent, input.slots, input.score, offerOutstanding(turn)) !== null)
  ) {
    // FR-004e/f: a visit is about a property; the only other meeting is by phone.
    const target = meetingTarget({
      intent,
      kind: facts.meetingKind,
      property,
      reofferingCall: proposalOpen && lastOfferedType(turn) === "call",
      cardsShown: turn.history.some(
        (message) =>
          message.role === "agent" && Array.isArray(message.metadata.propertyIds) && message.metadata.propertyIds.length > 0,
      ),
    });
    if (target === "ask_property") {
      draft.written = VISIT_NEEDS_PROPERTY_SENTENCE;
      // Counts as the offer (FR-004a's offer-outstanding fact), so it is not repeated.
      draft.offeredType = "viewing";
    } else {
      const offered = await offerTimes({
        turn,
        intent,
        property: target === "call" ? null : property,
        constraint: situation.wantsOffer ? facts.preference : {},
        proposalOpen,
        timezone,
      });
      calls.push(offered.call);
      // A visit asked for before any property was shown: the phone is what there is.
      draft.written =
        target === "call" && facts.meetingKind === "visit" && offered.type === "call"
          ? `${NO_PROPERTY_YET_SENTENCE} ${offered.reply}`
          : offered.reply;
      draft.offeredType = offered.type;
      if (offered.options.length > 0) {
        draft.scheduling = { ...draft.scheduling, options: offered.options.map((at) => at.toISOString()) };
      }
    }
  }

  return { draft, calls };
}
