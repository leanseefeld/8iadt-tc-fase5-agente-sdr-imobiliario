import type { MeetingType } from "../../domain/scheduling.ts";
import {
  latestInterestedProperty,
  type CommittedToolCall,
  type LoadedTurn,
  type PendingChange,
  type SchedulingRecord,
} from "../../services/conversation.ts";
import { MAX_UPCOMING_MEETINGS, cancelAppointment, type UpcomingMeeting } from "../../services/scheduling.ts";
import { chooseMeeting } from "../meeting-change.ts";
import {
  MEETING_LIMIT_SENTENCE,
  NO_MEETING_TO_CHANGE_SENTENCE,
  cancelQuestion,
  cancelledSentence,
  keptSentence,
  whichOneSentence,
  type MeetingRef,
} from "../prompts/meeting.ts";
import { offerTimes } from "./offer-times.ts";
import type { SchedulingFacts } from "./read.ts";

/**
 * Spec 009 — the lead changes what was booked. All decided here, in code:
 *
 * - a yes to "quer mesmo cancelar?" cancels; a no keeps it (asked first, 29/09);
 * - a yes to "quer marcar outro dia?" after a cancel offers times again;
 * - a cancel or reschedule request picks the meeting — asking "qual delas?"
 *   when it could be more than one — then asks to confirm the cancel, or offers
 *   times to move it; a time already named goes to the action loop instead.
 *
 * Nothing here names a broker (FR-005e); every sentence is code-written.
 */
export async function decideChange(input: {
  turn: LoadedTurn;
  facts: SchedulingFacts;
  upcoming: UpcomingMeeting[];
  waiting: PendingChange;
  confirmingCancel: boolean;
  answeringWhich: boolean;
  rebooking: boolean;
  changeAsked: "cancel" | "reschedule" | null;
  answeredMeeting: MeetingRef | null;
  /** Options to move this meeting are on the table; the lead is narrowing them. */
  fixedMeeting: MeetingRef | null;
  timezone: string;
}): Promise<{
  written: string;
  scheduling?: SchedulingRecord;
  offeredType?: MeetingType | null;
  call?: CommittedToolCall;
  rescheduleTarget?: { appointmentId: string; offered: Date[] };
}> {
  const { turn, facts, upcoming, waiting, timezone } = input;
  const refs: MeetingRef[] = upcoming;

  if (input.confirmingCancel) {
    const meeting = refs.find((item) => item.id === waiting.pendingCancel);
    if (meeting === undefined) return { written: NO_MEETING_TO_CHANGE_SENTENCE };
    if (facts.answer === "no") return { written: keptSentence(meeting, timezone) };
    const cancelled = await cancelAppointment(meeting.id, turn.lead.id);
    if (!cancelled) return { written: NO_MEETING_TO_CHANGE_SENTENCE };
    const original = upcoming.find((item) => item.id === meeting.id);
    return {
      written: cancelledSentence(meeting, timezone),
      call: { name: "cancelMeeting", arguments: { appointmentId: meeting.id } },
      scheduling: {
        rebook: {
          type: meeting.type,
          propertyId: original?.propertyId ?? null,
          propertyCode: meeting.propertyCode,
        },
      },
    };
  }

  if (input.rebooking && waiting.rebook !== undefined) {
    if (upcoming.length >= MAX_UPCOMING_MEETINGS) return { written: MEETING_LIMIT_SENTENCE };
    const { rebook } = waiting;
    const offered = await offerTimes({
      turn,
      intent: turn.lead.intent,
      property:
        rebook.type === "viewing" && rebook.propertyId !== null && rebook.propertyCode !== null
          ? { id: rebook.propertyId, code: rebook.propertyCode }
          : null,
      constraint: facts.preference,
      proposalOpen: turn.proposalOpen,
      timezone,
    });
    return {
      written: offered.reply,
      offeredType: offered.type,
      call: offered.call,
      ...(offered.options.length > 0 ? { scheduling: { options: offered.options.map((at) => at.toISOString()) } } : {}),
    };
  }

  const choice = input.answeringWhich ? waiting.pendingChoice : undefined;
  const change = choice?.change ?? input.changeAsked;
  if (change === null || change === undefined) return { written: NO_MEETING_TO_CHANGE_SENTENCE };
  const pool = choice !== undefined ? refs.filter((item) => choice.ids.includes(item.id)) : refs;

  // "A primeira" answers "qual delas?" by position; otherwise narrow by what the
  // message names. While answering "qual delas?", a weekday names the meeting.
  const position = facts.propertyRef !== null && "position" in facts.propertyRef ? facts.propertyRef.position : null;
  const chosen =
    input.fixedMeeting !== null
      ? { meeting: input.fixedMeeting }
      : choice !== undefined && input.answeredMeeting !== null
      ? { meeting: input.answeredMeeting }
      : choice !== undefined && position !== null && pool[position - 1] !== undefined
      ? { meeting: pool[position - 1] }
      : chooseMeeting(
          pool,
          {
            code: facts.propertyRef !== null && "code" in facts.propertyRef ? facts.propertyRef.code : null,
            weekday: facts.preference.weekday ?? null,
            kind: facts.meetingKind,
          },
          choice !== undefined ? "cancel" : change,
          timezone,
        );

  if ("none" in chosen) {
    // Nothing still to come (it may have passed): say so, and a yes books a new one.
    const interest = latestInterestedProperty(turn);
    return {
      written: NO_MEETING_TO_CHANGE_SENTENCE,
      scheduling: {
        rebook: interest !== null
          ? { type: "viewing", propertyId: interest.id, propertyCode: interest.code }
          : { type: "call", propertyId: null, propertyCode: null },
      },
    };
  }
  if ("ask" in chosen) {
    return { written: whichOneSentence(chosen.ask, timezone), scheduling: { pendingChoice: { change, ids: chosen.ask.map((item) => item.id) } } };
  }
  const meeting = chosen.meeting;
  if (change === "cancel") {
    return { written: cancelQuestion(meeting, timezone), scheduling: { pendingCancel: meeting.id } };
  }

  // Reschedule: the action loop decides whether a new time was named, as
  // `bookMeeting` does; when the tool isn't called, the lead gets times to pick.
  return { written: "", rescheduleTarget: { appointmentId: meeting.id, offered: [] } };
}
