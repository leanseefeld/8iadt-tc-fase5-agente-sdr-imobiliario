import type { Question, SlotKey } from "../../domain/slots.ts";
import type { SchedulingRecord } from "../../services/conversation.ts";
import type { UpcomingMeeting } from "../../services/scheduling.ts";
import { describeMeeting } from "../prompts/meeting.ts";
import { boundaryOffer } from "./boundary.ts";
import type { Situation } from "./classify.ts";
import type { Reading } from "./read.ts";

/**
 * How a turn with nothing else to say ends — pure.
 *
 * Spec 015: a request, question or piece of information left over that
 * nothing in this turn answers gets the offer to have someone from the team
 * check it. Anything that answers the lead itself — a code-written reply, a
 * search, the criteria, a revision — wins, and the offer waits for a turn that
 * has nothing better to say.
 *
 * Spec 009/015: with nothing pending and nothing asked, the turn closes: the
 * model restates what is booked and says goodbye. A message that asks
 * something, teaches a criterion, wants an action or leaves something for the
 * team is not a goodbye. A "no" to the offer closes too.
 */

export interface Ending {
  teamOffer: { about: string } | null;
  /** `summary`: what is booked, for the reply to restate; null on a second close in a row. */
  closing: { summary: string | null } | null;
  /** What the ending records on the reply's metadata. */
  scheduling: SchedulingRecord;
}

export function decideEnding(input: {
  reading: Reading;
  situation: Situation;
  /** The code already wrote this turn's reply. */
  written: boolean;
  searchDue: boolean;
  searched: boolean;
  /** The script's next question, if the turn would ask one. */
  question: Question | null;
  filled: SlotKey[];
  revised: SlotKey[];
  learnedSomething: boolean;
  proposalOpen: boolean;
  booked: UpcomingMeeting[];
  offerOutstanding: boolean;
  /** The last reply already closed the conversation. */
  closedBefore: boolean;
  leadText: string;
  timezone: string;
}): Ending {
  const { reading, situation } = input;

  const teamOffer = boundaryOffer({
    act: reading.act,
    remainder: reading.remainder,
    phrasedTurn:
      !input.written &&
      !input.searchDue &&
      !input.searched &&
      !reading.askedAboutCriteria &&
      !situation.askingAboutMeetings &&
      // A turn that learned something answered something: the model also hands
      // back the answer itself as "what nothing captured" ("2", "uns 6500"),
      // and an offer to check it with the team made no sense (08/10).
      !input.learnedSomething &&
      situation.offerTaken === null,
  });

  const nothingPending =
    teamOffer === null &&
    reading.act !== "request" &&
    reading.act !== "question" &&
    !input.written &&
    input.question === null &&
    !input.searchDue &&
    !input.proposalOpen &&
    !situation.wantsOffer &&
    !situation.changing &&
    !situation.askingWhoAttends &&
    !situation.askingAboutMeetings &&
    !reading.askedAboutCriteria &&
    input.filled.length === 0 &&
    input.revised.length === 0 &&
    !input.leadText.includes("?") &&
    (input.booked.length > 0 || input.offerOutstanding || situation.offerTaken === "close");

  const closing = nothingPending
    ? {
        summary:
          input.closedBefore || input.booked.length === 0
            ? null
            : input.booked.map((meeting) => describeMeeting(meeting, input.timezone)).join("; "),
      }
    : null;

  return {
    teamOffer,
    closing,
    scheduling: {
      ...(teamOffer === null ? {} : { humanOffer: teamOffer }),
      ...(closing === null ? {} : { closing: true as const }),
    },
  };
}
