import type { Preference, MeetingType } from "../../domain/scheduling.ts";
import type { Intent } from "../../domain/slots.ts";
import { lastOfferedOptions, type CommittedToolCall, type LoadedTurn } from "../../services/conversation.ts";
import { assignedBrokerSpecializes, proposeAppointment } from "../../services/scheduling.ts";
import {
  meetingHost,
  NO_OPTIONS_FOR_CONSTRAINT_SENTENCE,
  NO_OPTIONS_SENTENCE,
  optionsSentence,
  stillValidSentence,
} from "../prompts/meeting.ts";

/** A meeting offer: what it is for, and the times with the sentence that presents them. */

/**
 * Who the lead will meet, as the sentences say it: the investment specialist when
 * the lead invests and their broker really is one, the team otherwise. Asked only
 * for investors, so every other offer costs no query.
 */
export async function meetingHostFor(leadId: string, intent: Intent): Promise<string> {
  return meetingHost(intent === "investment" && (await assignedBrokerSpecializes(leadId, intent)));
}

/**
 * Spec 006 FR-004e/f: what a meeting offer is for. An investor always gets a
 * call (FR-003a). Otherwise a visit needs a property: with one in play, it is a
 * visit; asked for the phone — or re-offering phone times already on the table
 * — it is a call; with cards on screen and none pointed at, the lead is asked
 * which one; with nothing ever shown, the phone is what there is. Phone times
 * already on the table stay a call even with a property in play.
 */
export function meetingTarget(input: {
  intent: Intent;
  kind: "visit" | "call" | null;
  property: { id: string; code: string } | null;
  reofferingCall: boolean;
  cardsShown: boolean;
}): "viewing" | "call" | "ask_property" {
  if (input.intent === "investment") return "call";
  if (input.kind === "call") return "call";
  // Before the property: phone times on the table stay phone times when the
  // lead narrows them ("nada na quarta?") with a visit's property in play.
  if (input.kind !== "visit" && input.reofferingCall) return "call";
  if (input.property !== null) return "viewing";
  return input.cardsShown ? "ask_property" : "call";
}

/**
 * Spec 006: propose times and write the sentence that presents them — or the
 * sentence that says there are none. Code throughout (FR-004a, FR-005d); the
 * model never proposes. The broker chosen stays inside the service (FR-005e).
 */
export async function offerTimes(input: {
  turn: LoadedTurn;
  intent: Intent;
  property: { id: string; code: string } | null;
  constraint: Preference;
  proposalOpen: boolean;
  timezone: string;
}): Promise<{ reply: string; options: Date[]; type: MeetingType | null; call: CommittedToolCall }> {
  const result = await proposeAppointment({
    agencyId: input.turn.agency.id,
    leadId: input.turn.lead.id,
    conversationId: input.turn.conversation.id,
    intent: input.intent,
    propertyId: input.property?.id ?? null,
    constraint: input.constraint,
  });
  if (result.ok) {
    const type = result.options[0].type;
    const times = result.options.map((option) => option.scheduledAt);
    const code = type === "viewing" ? (input.property?.code ?? null) : null;
    return {
      reply: optionsSentence(times, type, code, input.timezone, await meetingHostFor(input.turn.lead.id, input.intent)),
      options: times,
      type,
      call: { name: "proposeMeeting", arguments: { kind: type, options: times.length } },
    };
  }
  const call: CommittedToolCall = { name: "proposeMeeting", arguments: { status: result.reason } };
  // FR-005b and FR-001 as amended: nothing matches the constraint — say so and
  // keep the earlier proposal standing. Never an automatic handoff.
  if (result.reason === "no_slots_for_constraint") {
    const earlier = input.proposalOpen ? lastOfferedOptions(input.turn) : [];
    const rest = earlier.length > 0 ? stillValidSentence(earlier, input.timezone) : "Quer tentar outro dia ou horário?";
    return { reply: `${NO_OPTIONS_FOR_CONSTRAINT_SENTENCE} ${rest}`, options: [], type: null, call };
  }
  return { reply: NO_OPTIONS_SENTENCE, options: [], type: null, call };
}
