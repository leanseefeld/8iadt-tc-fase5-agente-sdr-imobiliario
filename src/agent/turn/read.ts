import type { Preference, Weekday } from "../../domain/scheduling.ts";
import type { PropertyRef } from "../../services/conversation.ts";
import { settleAct, type MessageAct } from "./boundary.ts";
import {
  asksAboutBooking,
  asksForMoreProperties,
  mentionsCancel,
  mentionsChange,
  mentionsCode,
  mentionsOutOfScope,
  readAcknowledgement,
  readOptionPick,
  readYesNo,
} from "../lexicon.ts";
import { parseWhen } from "../meeting-change.ts";
import { isTrue } from "../tools/update-slots.ts";

/**
 * The turn's first node: what the lead's message says, settled.
 *
 * The model reads the open-ended part (`extract()` in the orchestrator); this
 * adds what code reads from a closed vocabulary — a weekday, "amanhã", a bare
 * "obrigado", "a primeira", a yes or a no — and lets it win. Everything after
 * this node decides from a `Reading`, never from the raw text, so a turn's
 * decisions can be tested from facts alone (the scripted model does that).
 */

export interface SchedulingFacts {
  declinedOffer: boolean;
  askedForTimes: boolean;
  pickedTime: boolean;
  preference: Preference;
  propertyRef: PropertyRef | null;
  askedWhoAttends: boolean;
  /** Spec 015: a question about a meeting already booked ("continua de pé?"). */
  askedAboutMeetings: boolean;
  /**
   * Spec 009: cancel or move a meeting already confirmed. `either` is the 4-bit
   * model writing `true` instead of which one; the turn decides from the text.
   */
  changeRequest: "cancel" | "reschedule" | "either" | null;
  /** Spec 009: a yes or a no to the confirmation question just asked. */
  answer: "yes" | "no" | null;
  /** FR-004e/f: the lead asked for a visit or for a phone conversation. */
  meetingKind: "visit" | "call" | null;
  /** FR-005h: a meeting in a format the agency doesn't offer (office, video, …). */
  unsupportedMeeting: boolean;
  /** FR-005i: something about a visit the agency doesn't do (a ride, choosing the broker by a trait, …). */
  outOfScopeRequest: boolean;
}

export const NO_SCHEDULING: SchedulingFacts = {
  declinedOffer: false,
  askedForTimes: false,
  pickedTime: false,
  preference: {},
  propertyRef: null,
  askedWhoAttends: false,
  askedAboutMeetings: false,
  changeRequest: null,
  answer: null,
  meetingKind: null,
  unsupportedMeeting: false,
  outOfScopeRequest: false,
};

const WEEKDAYS: readonly Weekday[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

/** Read spec 006's facts off the extraction's JSON. Anything malformed is simply absent. */
export function readSchedulingFacts(object: Record<string, unknown>): SchedulingFacts {
  const preference: Preference = {};
  if (typeof object.preferredWeekday === "string" && (WEEKDAYS as readonly string[]).includes(object.preferredWeekday)) {
    preference.weekday = object.preferredWeekday as Weekday;
  }
  if (object.preferredPeriod === "morning" || object.preferredPeriod === "afternoon") {
    preference.period = object.preferredPeriod;
  }
  const code = typeof object.propertyCode === "string" ? object.propertyCode.trim() : "";
  const position = Number(object.propertyPosition);
  const propertyRef: PropertyRef | null =
    code !== "" ? { code } : Number.isInteger(position) && position > 0 ? { position } : null;
  return {
    declinedOffer: isTrue(object.declinedOffer),
    askedForTimes: isTrue(object.askedForTimes),
    pickedTime: isTrue(object.pickedTime),
    preference,
    propertyRef,
    askedWhoAttends: isTrue(object.askedWhoAttends),
    askedAboutMeetings: isTrue(object.askedAboutMeetings),
    changeRequest:
      object.changeRequest === "cancel" || object.changeRequest === "reschedule"
        ? object.changeRequest
        : isTrue(object.changeRequest)
          ? "either"
          : null,
    answer: object.answer === "yes" || object.answer === "no" ? object.answer : null,
    meetingKind: object.meetingKind === "visit" || object.meetingKind === "call" ? object.meetingKind : null,
    unsupportedMeeting: isTrue(object.unsupportedMeeting),
    outOfScopeRequest: isTrue(object.outOfScopeRequest),
  };
}


/** What the model read, before code settles it. */
export interface ModelReading {
  attemptedAnswer: boolean;
  leadAskedForHuman: boolean;
  optedOut: boolean;
  askedAboutCriteria: boolean;
  scheduling: SchedulingFacts;
  act: MessageAct | null;
  remainder: string | null;
}

export interface Reading {
  /** The lead tried to convey something (an attempt nothing uses is a misunderstanding). */
  attemptedAnswer: boolean;
  leadAskedForHuman: boolean;
  optedOut: boolean;
  askedAboutCriteria: boolean;
  /** The model's meeting facts, with the day, the period and an ordinal pick read by code. */
  facts: SchedulingFacts;
  /** Yes or no to the question the last reply asked, when one is pending. */
  answer: "yes" | "no" | null;
  /** A weekday or a period was named. */
  namesADay: boolean;
  /** The message says to move or cancel something ("remarcar", "desmarcar"). */
  changeVerb: boolean;
  /** …and to cancel ("não vou mais poder"). */
  cancelVerb: boolean;
  /** Spec 015: what the message does, and what no field captured. */
  act: MessageAct | null;
  remainder: string | null;
}

export interface ReadingContext {
  text: string;
  now: Date;
  timeZone: string;
  /** Options were offered and may be picked by number. */
  optionsOnTable: boolean;
  /** The last reply asked a yes/no question (cancel, rebook, the team offer). */
  yesNoPending: boolean;
}

export function readTurn(model: ModelReading, context: ReadingContext): Reading {
  const { text } = context;
  // A bare "valeu!" says nothing new and requests nothing (spec 015).
  const bare = readAcknowledgement(text) !== null;
  // "Outros imóveis" is the criteria question, never something for the team.
  const moreProperties = asksForMoreProperties(text);
  const changeVerb = mentionsChange(text);
  const cancelVerb = mentionsCancel(text);
  const said = model.scheduling;
  // A fact the model claims must be in the words. The 4-bit model echoes what
  // it read earlier in the conversation — the property code on the card above,
  // a refusal from the previous turn — and every echo moved the turn: on 07/10
  // "vou levar meu cachorro" got times again, and "posso levar meu cachorro?" a
  // refusal and a handoff.
  const ref = said.propertyRef;
  const facts: SchedulingFacts = {
    ...said,
    propertyRef: ref !== null && "code" in ref && !mentionsCode(text, ref.code) ? null : ref,
    outOfScopeRequest: said.outOfScopeRequest && !bare && mentionsOutOfScope(text),
    unsupportedMeeting: said.unsupportedMeeting && !bare,
    askedAboutMeetings: (said.askedAboutMeetings && !bare) || asksAboutBooking(text),
    // "Não vou mais poder" with no word about moving it is a cancel, whatever
    // the model called it (e4b read it as a reschedule in 2 of 3 runs, 30/09).
    changeRequest: said.changeRequest === "reschedule" && cancelVerb && !changeVerb ? "cancel" : said.changeRequest,
    // What code finds in the text wins over the model's guess (spec 009).
    preference: { ...said.preference, ...parseWhen(text, context.now, context.timeZone) },
    // With times on the table, "a primeira" is a pick (spec 015).
    pickedTime: said.pickedTime || (context.optionsOnTable && readOptionPick(text) !== null),
  };
  const remainder = moreProperties ? null : model.remainder;
  return {
    // "ok", "beleza" try to say nothing: e4b sometimes called them attempts, and
    // two of them after an offer added up to a handoff (eval, 07/10).
    attemptedAnswer: model.attemptedAnswer && !bare,
    leadAskedForHuman: model.leadAskedForHuman && !bare,
    optedOut: model.optedOut && !bare,
    askedAboutCriteria: model.askedAboutCriteria || moreProperties,
    facts,
    // "Não, deixa" came back as a decline and a cancel: the words decide when
    // the extraction didn't say.
    answer: facts.answer ?? (context.yesNoPending ? readYesNo(text) : null),
    namesADay: facts.preference.weekday !== undefined || facts.preference.period !== undefined,
    changeVerb,
    cancelVerb,
    act: settleAct(model.act, text, remainder),
    remainder,
  };
}
