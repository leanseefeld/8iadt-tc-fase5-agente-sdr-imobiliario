import type { PendingChange } from "../../services/conversation.ts";
import { MAX_UPCOMING_MEETINGS, type UpcomingMeeting } from "../../services/scheduling.ts";
import { matchAnswer } from "../meeting-change.ts";
import type { MeetingRef } from "../prompts/meeting.ts";
import { offerOutcome } from "./boundary.ts";
import type { Reading } from "./read.ts";

/**
 * What the lead is doing about meetings this turn — pure, decided in code.
 *
 * Every fact here is the model's reading as `readTurn` settled it, weighed
 * against what is open: a proposal on the table, meetings still to come, a
 * question the last reply left pending. The answers are named, so the rest of
 * the turn reads `situation.picking` rather than re-deriving it, and each rule
 * can be checked as a table of cases.
 */

export interface SituationInput {
  reading: Reading;
  /** What the last reply left waiting for an answer. */
  waiting: PendingChange;
  /** A proposal row is open **now** — not "an offer was ever made". */
  proposalOpen: boolean;
  /** The lead's meetings still to come (spec 009). */
  booked: UpcomingMeeting[];
  /** The appointment the latest options would move, when they were offered for a reschedule. */
  reschedulingId: string | null;
  /** The property the lead pointed at this turn, resolved against those already shown (FR-004b). */
  interest: { id: string; code: string } | null;
  leadText: string;
  timeZone: string;
  /** FR-005b: the script is complete enough to offer a meeting. */
  scriptComplete: boolean;
}

export interface Situation {
  /** FR-005a: the lead declined the open proposal. */
  declining: boolean;
  /** FR-005f: the lead picked one of the open options. */
  picking: boolean;
  /** Spec 009: a pick among options offered to move a confirmed meeting. */
  movingPick: boolean;
  /** "Quer mesmo cancelar?" was asked and the lead answered. */
  confirmingCancel: boolean;
  /** A change asked for a meeting still to come. */
  changeAsked: "cancel" | "reschedule" | null;
  /** Options to move a meeting are on the table, and the lead narrows them ("e na quinta?"). */
  narrowingMove: boolean;
  /** The answer to "qual delas?", read against the meetings just listed. */
  answeredMeeting: MeetingRef | null;
  answeringWhich: boolean;
  /** A yes to "quer marcar outro dia?" after a cancel. */
  rebooking: boolean;
  /** Any of the spec 009 changes. */
  changing: boolean;
  /** FR-005h: a meeting in a format the agency doesn't offer. */
  refusingFormat: boolean;
  /** FR-005h/i: a request the agency cannot meet. */
  refused: boolean;
  /** FR-005e: "quem vai me atender?" about a meeting that exists. */
  askingWhoAttends: boolean;
  /** The lead asked for times, a meeting or a property's visit. */
  wantsOffer: boolean;
  /** Spec 015: "a visita continua de pé?" — answered from what is booked. */
  askingAboutMeetings: boolean;
  /** Spec 009: three meetings still to come is the limit. */
  atLimit: boolean;
  /** Spec 015: the lead's answer to the offer to have the team check something. */
  offerTaken: "handoff" | "close" | null;
  /** The lead acted, and was understood: never a misunderstanding. */
  acted: boolean;
  /** The message is about the meeting, so a request for a person in it isn't one. */
  aboutTheMeeting: boolean;
}

export function classify(input: SituationInput): Situation {
  const { reading, waiting, proposalOpen, booked, reschedulingId, interest } = input;
  const facts = reading.facts;
  const answer = reading.answer;

  // FR-005a: a decline counts only while a proposal is open — and a message
  // that asks for or names another day or time is not one: "pode ser domingo
  // às 7?" was read as a decline and heard "sem problema".
  const namesATime = facts.askedForTimes || facts.pickedTime || reading.namesADay;
  const declining = facts.declinedOffer && proposalOpen && !namesATime;
  const picking = facts.pickedTime && proposalOpen && !declining;
  const isBooked = (id: string | null) => id !== null && booked.some((meeting) => meeting.id === id);
  const movingPick = facts.pickedTime && !proposalOpen && isBooked(reschedulingId);
  const confirmingCancel = waiting.pendingCancel !== undefined && answer !== null;

  // With times on the table, "nada na quarta?" is about **them** — unless the
  // message says to move or cancel something ("remarcar a visita").
  const aboutTheOffer = proposalOpen && !picking && !declining && reading.namesADay && !reading.changeVerb;
  // `either` is the model saying "a change" without which: the words decide.
  // "Dá pra passar pra segunda às 10?" with a meeting booked and no times on the
  // table is a reschedule even when the extraction didn't say so, and "não vou
  // mais poder na terça" is a cancel even with nothing still to come (it
  // already passed): the answer then is that nothing is booked.
  const requested =
    facts.changeRequest === "either"
      ? reading.cancelVerb
        ? "cancel"
        : "reschedule"
      : (facts.changeRequest ??
        ((reading.changeVerb || reading.cancelVerb) && !proposalOpen && (booked.length > 0 || reading.cancelVerb)
          ? reading.cancelVerb
            ? "cancel"
            : "reschedule"
          : null));
  // A "no" with nothing open to decline, from a lead with a meeting booked, is
  // a cancel — when it names the day or says so ("não vou mais poder na sexta"),
  // not a bare "não, obrigado" after a close.
  const asked: "cancel" | "reschedule" | null =
    (aboutTheOffer ? null : requested) ??
    (facts.declinedOffer &&
    !proposalOpen &&
    booked.length > 0 &&
    !confirmingCancel &&
    (reading.namesADay || reading.changeVerb)
      ? "cancel"
      : null);
  // Nothing still to come to change, and the lead asked for times: a new
  // booking ("podemos marcar uma nova visita pra quinta?" after the last passed).
  const newInstead =
    asked !== null && booked.length === 0 && (asked === "reschedule" || facts.askedForTimes || facts.meetingKind !== null);
  const changeAsked = newInstead ? null : asked;
  const narrowingMove = !proposalOpen && !movingPick && reading.namesADay && changeAsked === null && isBooked(reschedulingId);

  const choice = waiting.pendingChoice;
  const answeredMeeting =
    choice !== undefined
      ? matchAnswer(
          booked.filter((meeting) => choice.ids.includes(meeting.id)),
          input.leadText,
          input.timeZone,
        )
      : null;
  const answeringWhich =
    choice !== undefined &&
    !confirmingCancel &&
    (answeredMeeting !== null ||
      changeAsked !== null ||
      facts.propertyRef !== null ||
      facts.preference.weekday !== undefined ||
      facts.meetingKind !== null);
  const rebooking = waiting.rebook !== undefined && answer === "yes" && changeAsked === null && !confirmingCancel;
  const changing = confirmingCancel || answeringWhich || changeAsked !== null || movingPick || rebooking || narrowingMove;

  // FR-005h/i: a request the agency cannot meet — a meeting at the office or by
  // video, a ride, a broker chosen by a personal trait. It never proposes or
  // books, and it counts against the handoff streak like any other request the
  // agent can't act on. "Quem vai me atender?" is FR-005e's question, not a
  // request to choose — but "quero que quem me atenda seja uma mulher" is.
  const refusingFormat = facts.unsupportedMeeting && !declining && !picking;
  const askingWho = facts.askedWhoAttends && input.leadText.includes("?");
  const refused = refusingFormat || (facts.outOfScopeRequest && !askingWho && !declining && !picking);

  // FR-005e: "quem vai me atender?" about a meeting that exists gets the
  // code-written answer, and outranks a meeting kind the extraction echoed from
  // the confirmation above it. With nothing proposed or booked, the phrased
  // reply and its system rule answer instead.
  const askingWhoAttends =
    facts.askedWhoAttends &&
    !refused &&
    !declining &&
    !picking &&
    interest === null &&
    !changing &&
    (proposalOpen || booked.length > 0);
  // A pick outranks a request for times on the same message: the extraction
  // often marks both for "a segunda", and only the pick moves the lead forward.
  const wantsOffer =
    !declining &&
    !picking &&
    !refused &&
    !askingWhoAttends &&
    !changing &&
    (facts.askedForTimes || facts.meetingKind !== null || interest !== null || aboutTheOffer || newInstead);
  const askingAboutMeetings =
    facts.askedAboutMeetings && !refused && !picking && !changing && !askingWhoAttends && !wantsOffer;
  const atLimit = wantsOffer && input.scriptComplete && booked.length >= MAX_UPCOMING_MEETINGS;

  // Spec 015: a message that does something the turn already handles — picks a
  // time, changes a meeting, asks for times — is that, not a yes to the offer:
  // "pode ser a primeira opção" after an offer was read as a yes and handed off.
  const offerTaken =
    waiting.humanOffer !== undefined && !confirmingCancel && !picking && !movingPick && !changing && !wantsOffer
      ? offerOutcome(answer)
      : null;
  // A request, question or piece of information left over is understood — it
  // may get the offer — and never a misunderstanding.
  const openRemainder =
    reading.remainder !== null && (reading.act === "request" || reading.act === "question" || reading.act === "inform");
  // A "no" with nothing open to decline was still understood: nothing to act
  // on, but not a misunderstanding to count towards a handoff either.
  const acted =
    !refused &&
    (facts.declinedOffer ||
      picking ||
      askingWhoAttends ||
      changing ||
      (wantsOffer && !atLimit) ||
      offerTaken !== null ||
      askingAboutMeetings ||
      openRemainder);

  // The extraction reads "a segunda" or "quero agendar" as asking for a person,
  // because the meeting is with one; a refused request names a person too. The
  // explicit ask still wins on any other message (spec 004 FR-027).
  const aboutTheMeeting =
    declining || picking || wantsOffer || askingWhoAttends || askingAboutMeetings || refused || changing;

  return {
    declining,
    picking,
    movingPick,
    confirmingCancel,
    changeAsked,
    narrowingMove,
    answeredMeeting,
    answeringWhich,
    rebooking,
    changing,
    refusingFormat,
    refused,
    askingWhoAttends,
    wantsOffer,
    askingAboutMeetings,
    atLimit,
    offerTaken,
    acted,
    aboutTheMeeting,
  };
}
