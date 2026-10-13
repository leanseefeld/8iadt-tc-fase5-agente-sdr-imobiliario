import type { Intent, Slots } from "../../domain/slots.ts";
import {
  lastOfferedOptions,
  lastOfferedType,
  type CommittedToolCall,
  type LoadedTurn,
} from "../../services/conversation.ts";
import {
  computeRescheduleOptions,
  type BookResult,
  type RescheduleResult,
  type UpcomingMeeting,
} from "../../services/scheduling.ts";
import { act } from "../act.ts";
import {
  BOOKING_REFUSED,
  NO_MEETING_TO_CHANGE_SENTENCE,
  NO_OPTIONS_FOR_CONSTRAINT_SENTENCE,
  NO_OPTIONS_SENTENCE,
  bookingBriefing,
  confirmationSentence,
  optionsSentence,
  rescheduleOptionsSentence,
  rescheduledSentence,
} from "../prompts/meeting.ts";
import { actionTools, type SearchOutcome } from "../tools/index.ts";
import type { Draft } from "./meeting-reply.ts";
import { meetingHostFor, offerTimes } from "./offer-times.ts";
import type { SchedulingFacts } from "./read.ts";

/**
 * The action step: the model calls the tools the code offers it — search,
 * book, reschedule — inside `act()`'s bounded loop (spec 007). The code decided
 * *whether* each is due; the model only fills in the arguments. Then the code
 * turns what the tools did into the reply.
 */

export interface ActionPlan {
  /** A search-relevant criterion was filled or revised with the script qualified. */
  searchDue: boolean;
  /** FR-005f: an actual pick of an open proposal. */
  bookingDue: boolean;
  /** Spec 009: a confirmed meeting to move to a picked or named time. */
  rescheduleTarget: { appointmentId: string; offered: Date[] } | null;
}

export interface ActionResults {
  search: SearchOutcome;
  booking: BookResult | undefined;
  move: RescheduleResult | undefined;
  /** The options the pick was made among. */
  offeredTimes: Date[];
  calls: CommittedToolCall[];
}

const NO_SEARCH: SearchOutcome = { properties: [], searched: false, relaxable: null };

export async function runActions(input: {
  turn: LoadedTurn;
  plan: ActionPlan;
  intent: Intent;
  slots: Slots;
  leadText: string;
  timezone: string;
}): Promise<ActionResults> {
  const { turn, plan, timezone } = input;
  const searches: SearchOutcome[] = [];
  const bookings: BookResult[] = [];
  const moves: RescheduleResult[] = [];
  const calls: CommittedToolCall[] = [];
  const offeredTimes = plan.bookingDue ? lastOfferedOptions(turn) : [];
  const move = plan.rescheduleTarget;

  // Whether a step is due only decides whether its tool is offered. The search
  // itself runs inside the loop and may run again before any reply exists (FR-013).
  if (plan.searchDue || plan.bookingDue || move !== null) {
    const briefing = [
      ...(plan.searchDue ? ["Há uma busca a considerar com os critérios já registrados. Chame searchProperties."] : []),
      ...(plan.bookingDue ? [bookingBriefing(offeredTimes, input.leadText, new Date(), timezone)] : []),
      ...(move !== null
        ? [bookingBriefing(move.offered, input.leadText, new Date(), timezone, "rescheduleMeeting")]
        : []),
    ].join("\n\n");
    const result = await act({
      turn,
      briefing,
      tools: actionTools({
        ...(plan.searchDue
          ? {
              search: {
                agencyId: turn.agency.id,
                intent: input.intent,
                slots: input.slots,
                onOutcome: (outcome) => void searches.push(outcome),
              },
            }
          : {}),
        ...(plan.bookingDue
          ? {
              booking: {
                conversationId: turn.conversation.id,
                offered: offeredTimes,
                timezone,
                onBooked: (booked) => void bookings.push(booked),
              },
            }
          : {}),
        ...(move !== null
          ? {
              reschedule: {
                appointmentId: move.appointmentId,
                offered: move.offered,
                timezone,
                onRescheduled: (moved) => void moves.push(moved),
              },
            }
          : {}),
      }),
    });
    for (const step of result.steps) {
      calls.push({
        name: step.name,
        arguments: step.arguments as Record<string, unknown>,
        result: step.result,
        stepIndex: step.index,
        refused: step.refused,
      });
    }
  }

  return { search: searches.at(-1) ?? NO_SEARCH, booking: bookings.at(-1), move: moves.at(-1), offeredTimes, calls };
}

/**
 * What the tools did, as the reply. FR-005/FR-006: booked → the confirmation
 * wins the turn; refused → why, and fresh options replacing the open proposal;
 * picked but nothing booked (the model called nothing) → the same options
 * again, rather than a phrased reply that might claim a booking that never
 * happened. Spec 009 does the same for a move.
 */
export async function applyActionOutcomes(
  draft: Draft,
  input: {
    turn: LoadedTurn;
    plan: ActionPlan;
    results: ActionResults;
    facts: SchedulingFacts;
    booked: UpcomingMeeting[];
    property: { id: string; code: string } | null;
    intent: Intent;
    timezone: string;
  },
): Promise<{ draft: Draft; calls: CommittedToolCall[] }> {
  const { turn, plan, results, timezone } = input;
  const next: Draft = { ...draft };
  const calls: CommittedToolCall[] = [];
  const options = (times: Date[]) => times.map((at) => at.toISOString());

  const booking = results.booking;
  if (booking?.ok) {
    next.written = confirmationSentence(
      booking.scheduledAt,
      booking.type,
      booking.propertyCode,
      timezone,
      await meetingHostFor(turn.lead.id, input.intent),
    );
    next.scheduling = {
      ...next.scheduling,
      booking: {
        appointmentId: booking.appointmentId,
        scheduledAt: booking.scheduledAt.toISOString(),
        type: booking.type,
        propertyCode: booking.propertyCode,
      },
    };
  } else if (booking !== undefined && booking.reason !== "no_proposal") {
    // Re-proposing after a refused booking keeps the kind the lead was offered.
    const offered = await offerTimes({
      turn,
      intent: input.intent,
      property: lastOfferedType(turn) === "call" ? null : input.property,
      constraint: {},
      proposalOpen: turn.proposalOpen,
      timezone,
    });
    calls.push(offered.call);
    next.written = `${BOOKING_REFUSED[booking.reason]} ${offered.reply}`;
    next.offeredType = offered.type;
    if (offered.options.length > 0) next.scheduling = { ...next.scheduling, options: options(offered.options) };
  } else if (plan.bookingDue && results.offeredTimes.length > 0) {
    const type = lastOfferedType(turn) ?? "call";
    next.written = optionsSentence(
      results.offeredTimes,
      type,
      type === "viewing" ? (input.property?.code ?? null) : null,
      timezone,
      await meetingHostFor(turn.lead.id, input.intent),
    );
    next.offeredType = type;
    next.scheduling = { ...next.scheduling, options: options(results.offeredTimes) };
  }

  const target = plan.rescheduleTarget;
  if (target !== null) {
    const moved = results.move;
    const meeting = input.booked.find((item) => item.id === target.appointmentId);
    if (moved?.ok) {
      next.written = rescheduledSentence(
        moved.scheduledAt,
        moved.type,
        moved.propertyCode,
        timezone,
        await meetingHostFor(turn.lead.id, input.intent),
      );
      next.scheduling = {
        ...next.scheduling,
        booking: {
          appointmentId: moved.appointmentId,
          scheduledAt: moved.scheduledAt.toISOString(),
          type: moved.type,
          propertyCode: moved.propertyCode,
        },
      };
    } else if (meeting !== undefined) {
      // Asked to move with no time named ("só de manhã", or nothing): options,
      // narrowed by what was said.
      const fresh = await computeRescheduleOptions(meeting.id, moved === undefined ? input.facts.preference : {});
      const why =
        moved !== undefined && moved.reason !== "gone" && moved.reason in BOOKING_REFUSED
          ? `${BOOKING_REFUSED[moved.reason as keyof typeof BOOKING_REFUSED]} `
          : "";
      if (fresh.ok) {
        next.written = `${why}${rescheduleOptionsSentence(meeting, fresh.options, timezone)}`;
        next.offeredType = fresh.type;
        calls.push({
          name: "proposeMeeting",
          arguments: { kind: fresh.type, options: fresh.options.length, reschedule: true },
        });
        next.scheduling = { ...next.scheduling, options: options(fresh.options), reschedulingId: meeting.id };
      } else {
        next.written = `${why}${
          fresh.reason === "no_slots_for_constraint"
            ? `${NO_OPTIONS_FOR_CONSTRAINT_SENTENCE} Quer tentar outro dia ou horário?`
            : NO_OPTIONS_SENTENCE
        }`;
      }
    } else {
      next.written = NO_MEETING_TO_CHANGE_SENTENCE;
    }
  }

  return { draft: next, calls };
}
