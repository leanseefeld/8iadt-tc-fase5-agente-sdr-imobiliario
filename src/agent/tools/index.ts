import type { ToolSet } from "ai";
import { updateSlots } from "./update-slots.ts";
import { bookMeeting, proposeMeeting, runProposeMeeting } from "./scheduling.stub.ts";
import { searchPropertiesTool, type SearchContext, type SearchOutcome } from "./search-properties.ts";

/**
 * The tool registry — the one list of what the agent can do.
 *
 * It is deliberately split by *when* a tool is offered rather than being one
 * flat set. A 4-bit model given five tools and asked to write a sentence will
 * pick a tool instead of writing the sentence, so the extraction call sees only
 * `updateSlots` and the phrasing call sees none at all (`agent/orchestrator.ts`
 * explains why phrasing is its own call).
 *
 * `proposeMeeting` and `bookMeeting` are registered here and invoked from code,
 * not by the model: FR-040/041 are deterministic conditions, and ADR 19 puts the
 * decision in `domain/handoff.shouldProposeMeeting`. Spec 006 replaces
 * `scheduling.stub.ts` and touches this file only to drop the word "stub".
 *
 * `searchProperties` is here on the same footing: FR-024 scopes it by agency and
 * forbids it for `investment`, neither of which may come from a tool argument, so
 * it is built from the turn's own context and invoked from code.
 *
 * Spec 004's later phase adds `requestHandoff` and `optOut` (T043).
 */

/** The tools offered during the extraction call. */
export function extractionTools(): ToolSet {
  return { updateSlots };
}

/**
 * Every tool the agent has, whether or not the model may pick it. The scheduling
 * pair is here so that a reader looking for "what can this agent do" finds one
 * answer, and so 006 has one file to edit.
 */
export function conversationTools(context?: SearchContext): ToolSet {
  return {
    updateSlots,
    proposeMeeting,
    bookMeeting,
    // Without a turn there is no agency to scope the search to, and an unscoped
    // catalog search is the one thing this tool must never be able to become.
    ...(context === undefined ? {} : { searchProperties: searchPropertiesTool(context) }),
  };
}

export { updateSlots, proposeMeeting, bookMeeting, runProposeMeeting };
export { runSearchProperties, searchPropertiesTool, MAX_SUGGESTIONS } from "./search-properties.ts";
export type { SearchContext, SearchOutcome };
export { normalizeExtraction, updateSlotsInputSchema } from "./update-slots.ts";
export type { SchedulingResult } from "./scheduling.stub.ts";
