import type { ToolSet } from "ai";
import { updateSlots } from "./update-slots.ts";
import {
  searchPropertiesTool,
  type SearchContext,
  type SearchOutcome,
  type ToolRefusal,
} from "./search-properties.ts";
import { bookMeetingTool, type BookingContext } from "./book-meeting.ts";
import { requestHandoff } from "./handoff.ts";
import { optOut } from "./opt-out.ts";

/**
 * The tool registry — what the model may call, and when.
 *
 * Split by *when* a tool is offered rather than one flat set. A 4-bit model
 * given several tools and asked to write a sentence picks a tool instead, so the
 * extraction call sees none, the phrasing call sees none, and the action loop
 * (`agent/act.ts`) sees only the tools this turn has a reason for:
 *
 * - `searchProperties` when a search criterion was filled or revised (spec 007);
 * - `bookMeeting` when a proposal is open **and** the extraction reports the lead
 *   picked or named a time (spec 006 FR-005f).
 *
 * Proposing a meeting is **not** a tool: code proposes (spec 006 FR-004a) when
 * `shouldProposeMeeting` says the offer is due or the lead asks for times. The
 * name `proposeMeeting` survives only as a transcript and trace label.
 *
 * `requestHandoff` and `optOut` are booleans on the extraction, not tools the
 * model calls; they stay exported because the names are the vocabulary of the
 * transcript and of spec 004's observability contract.
 */
export function actionTools(context: { search?: SearchContext; booking?: BookingContext }): ToolSet {
  return {
    ...(context.search === undefined ? {} : { searchProperties: searchPropertiesTool(context.search) }),
    ...(context.booking === undefined ? {} : { bookMeeting: bookMeetingTool(context.booking) }),
  };
}

export { updateSlots, requestHandoff, optOut, bookMeetingTool };
export { runSearchProperties, searchPropertiesTool, MAX_SUGGESTIONS } from "./search-properties.ts";
export type { SearchContext, SearchOutcome, ToolRefusal, BookingContext };
export { normalizeExtraction, updateSlotsInputSchema } from "./update-slots.ts";
